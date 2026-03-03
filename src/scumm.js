/**
 * SCUMM engine .BUN audio extractor.
 *
 * Extracts audio resources from LucasArts SCUMM engine bundle files
 * (Curse of Monkey Island, The Dig, Full Throttle, etc.).
 *
 * BUN files contain compressed iMUS audio resources. Each resource is
 * decompressed block-by-block using LZ77 and/or IMA ADPCM codecs,
 * producing raw PCM data that is written out as WAV files.
 *
 * Format details derived from the publicly documented ScummVM specifications.
 */

import { open, mkdir, writeFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";

const CHUNK_SIZE = 0x2000; // 8192 bytes — standard decompressed block size

// ── IMA Step Table (public domain, 89 values) ──────────────────
const IMA_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14,
  16, 17, 19, 21, 23, 25, 28, 31,
  34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658,
  724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024,
  3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];

// ── Step adjustment table indexed by [bitCount-2][data] ─────────
const IMX_OTHER_TABLE = [
  // bitcount=2 (2 entries)
  [-1, 4],
  // bitcount=3 (4 entries)
  [-1, -1, 2, 8],
  // bitcount=4 (8 entries)
  [-1, -1, -1, -1, 1, 2, 4, 6],
  // bitcount=5 (16 entries)
  [-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 12, 16, 32],
  // bitcount=6 (32 entries)
  [
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32,
  ],
  // bitcount=7 (64 entries)
  [
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  ],
];

// ── Precomputed tables (built once at module load) ──────────────

// _destImcTable[pos]: how many bits to read per IMA position (2-7)
const DEST_IMC_TABLE = new Uint8Array(89);

// _destImcTable2[pos*64 + n]: precomputed delta contribution
const DEST_IMC_TABLE2 = new Int32Array(89 * 64);

(function initTables() {
  // Build _destImcTable
  for (let pos = 0; pos <= 88; pos++) {
    let put = 1;
    let val = Math.trunc(Math.trunc(IMA_TABLE[pos] * 4 / 7) / 2);
    while (val !== 0) {
      val = Math.trunc(val / 2);
      put++;
    }
    if (put < 3) put = 3;
    if (put > 8) put = 8;
    DEST_IMC_TABLE[pos] = put - 1;
  }

  // Build _destImcTable2
  for (let n = 0; n < 64; n++) {
    for (let pos = 0; pos <= 88; pos++) {
      let count = 32;
      let put = 0;
      let tableValue = IMA_TABLE[pos];
      do {
        if ((count & n) !== 0) {
          put += tableValue;
        }
        count = Math.trunc(count / 2);
        tableValue = Math.trunc(tableValue / 2);
      } while (count !== 0);
      DEST_IMC_TABLE2[n + pos * 64] = put;
    }
  }
})();

// ── LZ77 decompressor ──────────────────────────────────────────

function compDecode(src, dst) {
  let sp = 0; // source pointer
  let dp = 0; // dest pointer
  let mask = src[sp] | (src[sp + 1] << 8); // LE uint16
  sp += 2;
  let bitsLeft = 16;

  function nextBit() {
    const bit = mask & 1;
    mask >>>= 1;
    bitsLeft--;
    if (bitsLeft === 0) {
      mask = src[sp] | (src[sp + 1] << 8);
      sp += 2;
      bitsLeft = 16;
    }
    return bit;
  }

  for (;;) {
    if (nextBit()) {
      // Literal byte
      dst[dp++] = src[sp++];
    } else {
      let size, data;
      if (!nextBit()) {
        // Short back-reference
        size = nextBit() << 1;
        size = (size | nextBit()) + 3; // 3..6
        data = src[sp++] | 0xffffff00; // sign-extend byte to negative offset
      } else {
        // Long back-reference
        data = src[sp++];
        size = src[sp++];
        data |= 0xfffff000 + ((size & 0xf0) << 4); // 12-bit negative offset
        size = (size & 0x0f) + 3; // 3..18

        if (size === 3) {
          // Size field was 0 — check terminator
          if ((src[sp++] + 1) === 1) {
            return dp; // done
          }
        }
      }
      // data is a negative offset (as signed 32-bit)
      let refPos = dp + (data | 0); // ensure signed
      for (let i = 0; i < size; i++) {
        dst[dp++] = dst[refPos++];
      }
    }
  }
}

// ── ADPCM decompressor ─────────────────────────────────────────

function decompressADPCM(src, dst, channels) {
  let sp = 0;
  const firstWord = (src[sp] << 8) | src[sp + 1]; // BE uint16
  sp += 2;

  let dp = 0;
  let outputSamplesLeft = 0x1000; // 4096 samples = 8192 bytes

  if (firstWord !== 0) {
    // Copy raw bytes
    for (let i = 0; i < firstWord; i++) {
      dst[dp++] = src[sp++];
    }
    outputSamplesLeft -= Math.trunc(firstWord / 2);
  }

  // Read seed values per channel
  const initialTablePos = [];
  const initialOutputWord = [];
  if (firstWord === 0) {
    for (let ch = 0; ch < channels; ch++) {
      initialTablePos.push(src[sp]);
      sp += 1;
      sp += 4; // skip 4 bytes
      initialOutputWord.push(
        ((src[sp] << 24) | (src[sp + 1] << 16) | (src[sp + 2] << 8) | src[sp + 3]) | 0,
      ); // BE int32
      sp += 4;
    }
  }

  let totalBitOffset = 0;
  const bitStreamStart = sp;

  for (let ch = 0; ch < channels; ch++) {
    let curTablePos = initialTablePos[ch] || 0;
    let outputWord = initialOutputWord[ch] || 0;
    let destPos = dp + ch * 2;

    let bound;
    if (channels === 1) {
      bound = outputSamplesLeft;
    } else if (ch === 0) {
      bound = Math.trunc((outputSamplesLeft + 1) / 2);
    } else {
      bound = Math.trunc(outputSamplesLeft / 2);
    }

    for (let i = 0; i < bound; i++) {
      const curTableEntryBitCount = DEST_IMC_TABLE[curTablePos];

      // Read variable-width packet from bitstream (big-endian)
      const bytePos = bitStreamStart + (totalBitOffset >>> 3);
      const bitShift = totalBitOffset & 7;
      const readWord = ((src[bytePos] << 8) | (src[bytePos + 1] || 0)) << bitShift;
      const packet = (readWord >>> (16 - curTableEntryBitCount)) & ((1 << curTableEntryBitCount) - 1);
      totalBitOffset += curTableEntryBitCount;

      // Extract sign and data
      const signBitMask = 1 << (curTableEntryBitCount - 1);
      const data = packet & (signBitMask - 1);

      // Compute delta
      const tmpA = data << (7 - curTableEntryBitCount);
      const imcTableEntry = IMA_TABLE[curTablePos] >>> (curTableEntryBitCount - 1);
      let delta = imcTableEntry + DEST_IMC_TABLE2[tmpA + curTablePos * 64];

      if (packet & signBitMask) delta = -delta;

      outputWord += delta;
      if (outputWord < -0x8000) outputWord = -0x8000;
      if (outputWord > 0x7fff) outputWord = 0x7fff;

      // Write 16-bit LE
      const uval = outputWord & 0xffff;
      dst[destPos] = uval & 0xff;
      dst[destPos + 1] = (uval >>> 8) & 0xff;
      destPos += channels * 2;

      // Adjust table position
      const adj = IMX_OTHER_TABLE[curTableEntryBitCount - 2]?.[data] ?? -1;
      curTablePos += adj;
      if (curTablePos < 0) curTablePos = 0;
      if (curTablePos > 88) curTablePos = 88;
    }
  }

  return CHUNK_SIZE;
}

// ── Codec dispatcher ────────────────────────────────────────────

function decompressCodec(codec, input, inputSize) {
  const output = Buffer.alloc(CHUNK_SIZE);

  if (codec === 0) {
    // Raw copy
    input.copy(output, 0, 0, Math.min(inputSize, CHUNK_SIZE));
    return output;
  }

  if (codec === 1) {
    compDecode(input, output);
    return output;
  }

  if (codec === 2) {
    // LZ77 + single delta
    const size = compDecode(input, output);
    for (let z = 1; z < size; z++) {
      output[z] = (output[z] + output[z - 1]) & 0xff;
    }
    return output;
  }

  if (codec === 3) {
    // LZ77 + double delta
    const size = compDecode(input, output);
    for (let z = 2; z < size; z++) {
      output[z] = (output[z] + output[z - 1]) & 0xff;
    }
    for (let z = 1; z < size; z++) {
      output[z] = (output[z] + output[z - 1]) & 0xff;
    }
    return output;
  }

  if (codec === 13) {
    decompressADPCM(input, output, 1);
    return output;
  }

  if (codec === 15) {
    decompressADPCM(input, output, 2);
    return output;
  }

  // Unsupported codec — return silence
  return output;
}

// ── BUN directory parsing ───────────────────────────────────────

async function readBE32(fh, offset) {
  const buf = Buffer.alloc(4);
  await fh.read(buf, 0, 4, offset);
  return buf.readUInt32BE(0);
}

/**
 * Parse the BUN file header and directory.
 */
export async function parseBunDirectory(fh) {
  const tagBuf = Buffer.alloc(4);
  await fh.read(tagBuf, 0, 4, 0);
  const tag = tagBuf.toString("ascii");
  const isCompressed = tag === "LB23";

  const dirOffset = await readBE32(fh, 4);
  const numFiles = await readBE32(fh, 8);

  const entries = [];

  if (isCompressed) {
    // LB23 format: 24-byte filename + 4-byte offset + 4-byte size = 32 bytes per entry
    const dirBuf = Buffer.alloc(numFiles * 32);
    await fh.read(dirBuf, 0, dirBuf.length, dirOffset);

    for (let i = 0; i < numFiles; i++) {
      const base = i * 32;
      const nameBuf = dirBuf.subarray(base, base + 24);
      const nullIdx = nameBuf.indexOf(0);
      const filename = nameBuf.subarray(0, nullIdx >= 0 ? nullIdx : 24).toString("ascii");
      const offset = dirBuf.readUInt32BE(base + 24);
      const size = dirBuf.readUInt32BE(base + 28);
      entries.push({ filename, offset, size });
    }
  } else {
    // Legacy format: 8-byte name + 4-byte ext + 4-byte offset + 4-byte size = 20 bytes
    const dirBuf = Buffer.alloc(numFiles * 20);
    await fh.read(dirBuf, 0, dirBuf.length, dirOffset);

    for (let i = 0; i < numFiles; i++) {
      const base = i * 20;
      let name = "";
      for (let j = 0; j < 8; j++) {
        const ch = dirBuf[base + j];
        if (ch === 0) break;
        name += String.fromCharCode(ch);
      }
      let ext = "";
      for (let j = 0; j < 4; j++) {
        const ch = dirBuf[base + 8 + j];
        if (ch === 0) break;
        ext += String.fromCharCode(ch);
      }
      const filename = ext ? `${name}.${ext}` : name;
      const offset = dirBuf.readUInt32BE(base + 12);
      const size = dirBuf.readUInt32BE(base + 16);
      entries.push({ filename, offset, size });
    }
  }

  return { isCompressed, entries };
}

// ── COMP table loading ──────────────────────────────────────────

/**
 * Load the COMP block table for a resource at the given offset.
 * Returns { isUncompressed, blocks[], lastBlockSize }
 */
async function loadCompTable(fh, offset) {
  const tagBuf = Buffer.alloc(4);
  await fh.read(tagBuf, 0, 4, offset);
  const tag = tagBuf.toString("ascii");

  if (tag !== "COMP") {
    // Raw iMUS — not compressed
    return { isUncompressed: true, blocks: [], lastBlockSize: 0 };
  }

  const numBlocks = await readBE32(fh, offset + 4);
  // Skip 4 bytes at offset+8
  const lastBlockSize = await readBE32(fh, offset + 12);

  const blocks = [];
  const tableBuf = Buffer.alloc(numBlocks * 16);
  await fh.read(tableBuf, 0, tableBuf.length, offset + 16);

  for (let i = 0; i < numBlocks; i++) {
    const base = i * 16;
    blocks.push({
      offset: tableBuf.readUInt32BE(base),
      size: tableBuf.readUInt32BE(base + 4),
      codec: tableBuf.readUInt32BE(base + 8),
      // skip 4 bytes at base+12
    });
  }

  return { isUncompressed: false, blocks, lastBlockSize };
}

// ── iMUS resource parsing ───────────────────────────────────────

/**
 * Scan a decompressed buffer for FRMT and DATA chunks.
 * Returns { sampleRate, bitsPerSample, channels, pcmData }
 */
function parseImusResource(buf) {
  let sampleRate = 22050;
  let bitsPerSample = 16;
  let channels = 1;
  let pcmData = null;

  let pos = 0;
  while (pos + 8 <= buf.length) {
    const tag = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32BE(pos + 4);
    const chunkStart = pos + 8;

    if (tag === "FRMT" && chunkStart + 20 <= buf.length) {
      // Skip 8 bytes, then read bits, rate, channels
      bitsPerSample = buf.readUInt32BE(chunkStart + 8);
      sampleRate = buf.readUInt32BE(chunkStart + 12);
      channels = buf.readUInt32BE(chunkStart + 16);
    } else if (tag === "DATA") {
      pcmData = buf.subarray(chunkStart, chunkStart + size);
      break; // DATA is the last meaningful chunk
    }

    // For container tags (iMUS, MAP), descend into them
    if (tag === "iMUS" || tag === "MAP\u0020" || tag === "MAP ") {
      pos += 8; // descend
    } else {
      pos += 8 + size; // skip payload
    }
  }

  return { sampleRate, bitsPerSample, channels, pcmData };
}

// ── WAV writer ──────────────────────────────────────────────────

function createWav(pcmData, sampleRate, channels, bitsPerSample) {
  const bytesPerSample = Math.trunc(bitsPerSample / 8);
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcmData.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(headerSize + dataSize - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20);  // PCM format
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmData.copy(wav, 44);

  return wav;
}

// ── Main extraction entry point ─────────────────────────────────

/**
 * Extract all audio resources from a BUN file to WAV files.
 *
 * @param {string} bunPath - Path to the .BUN file
 * @param {string} outputDir - Directory to write WAV files
 * @param {(msg: string) => void} [onProgress] - Progress callback
 * @returns {Promise<string[]>} Array of output WAV file paths
 */
export async function extractBunFile(bunPath, outputDir, onProgress) {
  await mkdir(outputDir, { recursive: true });

  const fh = await open(bunPath, "r");
  const outputs = [];

  try {
    const { entries } = await parseBunDirectory(fh);

    for (let ei = 0; ei < entries.length; ei++) {
      const entry = entries[ei];
      if (onProgress) onProgress(`Extracting ${ei + 1}/${entries.length}: ${entry.filename}`);

      try {
        const comp = await loadCompTable(fh, entry.offset);

        let fullBuf;
        if (comp.isUncompressed) {
          // Read raw iMUS data
          fullBuf = Buffer.alloc(entry.size);
          await fh.read(fullBuf, 0, entry.size, entry.offset);
        } else {
          // Decompress all blocks
          const totalSize = (comp.blocks.length - 1) * CHUNK_SIZE + comp.lastBlockSize;
          fullBuf = Buffer.alloc(totalSize);
          let outPos = 0;

          for (let i = 0; i < comp.blocks.length; i++) {
            const block = comp.blocks[i];
            const inputBuf = Buffer.alloc(block.size + 1); // +1 CMI hack
            await fh.read(inputBuf, 0, block.size, entry.offset + block.offset);
            inputBuf[block.size] = 0; // zero padding

            const decompressed = decompressCodec(block.codec, inputBuf, block.size);
            const blockOutSize = i === comp.blocks.length - 1 ? comp.lastBlockSize : CHUNK_SIZE;
            decompressed.copy(fullBuf, outPos, 0, blockOutSize);
            outPos += blockOutSize;
          }
        }

        // Parse the iMUS structure
        const { sampleRate, bitsPerSample, channels, pcmData } = parseImusResource(fullBuf);
        if (!pcmData || pcmData.length === 0) continue;

        // Write WAV
        const wav = createWav(pcmData, sampleRate, channels, bitsPerSample);
        const safeName = entry.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const outName = safeName.replace(/\.[^.]+$/, "") + ".wav";
        const outPath = join(outputDir, outName);
        await writeFile(outPath, wav);
        outputs.push(outPath);
      } catch {
        // Skip entries that fail to decompress
      }
    }
  } finally {
    await fh.close();
  }

  return outputs;
}

/**
 * Quick magic-byte check for BUN files.
 * Returns true if the file starts with 'LB23'.
 */
export async function isBunFile(filePath) {
  try {
    const fh = await open(filePath, "r");
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    await fh.close();
    const tag = buf.toString("ascii");
    return tag === "LB23";
  } catch {
    return false;
  }
}
