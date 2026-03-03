/**
 * Generate WAV sound files for built-in presets.
 * Run with: node scripts/generate-sounds.js
 *
 * Generates simple synthesized sounds — no external deps needed.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOUNDS_DIR = join(__dirname, "..", "sounds");

const SAMPLE_RATE = 22050;

/**
 * Create a WAV file buffer from raw PCM samples (16-bit mono).
 */
function createWav(samples) {
  const numSamples = samples.length;
  const byteRate = SAMPLE_RATE * 2; // 16-bit = 2 bytes per sample
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const val = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(val * 32767), 44 + i * 2);
  }

  return buffer;
}

/**
 * Generate a sine wave tone.
 */
function sine(freq, duration, volume = 0.5) {
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    samples[i] = Math.sin(2 * Math.PI * freq * t) * volume;
  }
  return samples;
}

/**
 * Generate a square wave (8-bit style).
 */
function square(freq, duration, volume = 0.3) {
  const numSamples = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const val = Math.sin(2 * Math.PI * freq * t) > 0 ? 1 : -1;
    samples[i] = val * volume;
  }
  return samples;
}

/**
 * Apply an envelope (attack, sustain, release) to samples.
 */
function envelope(samples, attack = 0.01, release = 0.05) {
  const attackSamples = Math.floor(SAMPLE_RATE * attack);
  const releaseSamples = Math.floor(SAMPLE_RATE * release);
  const result = new Float64Array(samples.length);

  for (let i = 0; i < samples.length; i++) {
    let env = 1;
    if (i < attackSamples) {
      env = i / attackSamples;
    } else if (i > samples.length - releaseSamples) {
      env = (samples.length - i) / releaseSamples;
    }
    result[i] = samples[i] * env;
  }
  return result;
}

/**
 * Concatenate multiple sample arrays.
 */
function concat(...arrays) {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Float64Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Mix multiple sample arrays (overlay).
 */
function mix(...arrays) {
  const maxLength = Math.max(...arrays.map((a) => a.length));
  const result = new Float64Array(maxLength);
  for (const arr of arrays) {
    for (let i = 0; i < arr.length; i++) {
      result[i] += arr[i];
    }
  }
  // Normalize
  let max = 0;
  for (let i = 0; i < result.length; i++) {
    max = Math.max(max, Math.abs(result[i]));
  }
  if (max > 1) {
    for (let i = 0; i < result.length; i++) {
      result[i] /= max;
    }
  }
  return result;
}

/**
 * Add silence.
 */
function silence(duration) {
  return new Float64Array(Math.floor(SAMPLE_RATE * duration));
}

// ── Retro 8-bit preset ──────────────────────────────────────────

function retroStop() {
  // Victory jingle: ascending arpeggio (C-E-G-C)
  const notes = [
    envelope(square(523.25, 0.12, 0.35), 0.005, 0.02),  // C5
    envelope(square(659.25, 0.12, 0.35), 0.005, 0.02),  // E5
    envelope(square(783.99, 0.12, 0.35), 0.005, 0.02),  // G5
    envelope(square(1046.5, 0.25, 0.4), 0.005, 0.08),   // C6 (longer)
  ];

  return concat(
    notes[0], silence(0.02),
    notes[1], silence(0.02),
    notes[2], silence(0.02),
    notes[3]
  );
}

function retroNotification() {
  // Alert: two quick ascending beeps
  const beep1 = envelope(square(880, 0.08, 0.3), 0.005, 0.02);
  const beep2 = envelope(square(1175, 0.12, 0.35), 0.005, 0.03);

  return concat(beep1, silence(0.06), beep2);
}

// ── Minimal Zen preset ──────────────────────────────────────────

function zenStop() {
  // Gentle two-tone chime (like a singing bowl)
  const tone1 = envelope(sine(880, 0.8, 0.4), 0.05, 0.4);
  const tone2 = envelope(sine(1320, 0.6, 0.2), 0.08, 0.3);
  const harmonics = envelope(sine(1760, 0.4, 0.1), 0.05, 0.2);

  return mix(tone1, tone2, harmonics);
}

function zenNotification() {
  // Single soft bell tap
  const fundamental = envelope(sine(1046.5, 0.5, 0.35), 0.005, 0.3);
  const harmonic = envelope(sine(2093, 0.3, 0.15), 0.005, 0.2);

  return mix(fundamental, harmonic);
}

// ── Generate all sounds ─────────────────────────────────────────

async function main() {
  console.log("Generating sounds...\n");

  const sounds = [
    { path: "retro-8bit/stop.wav", generator: retroStop, name: "Retro 8-bit: Task Complete" },
    { path: "retro-8bit/notification.wav", generator: retroNotification, name: "Retro 8-bit: Notification" },
    { path: "minimal-zen/stop.wav", generator: zenStop, name: "Minimal Zen: Task Complete" },
    { path: "minimal-zen/notification.wav", generator: zenNotification, name: "Minimal Zen: Notification" },
  ];

  for (const { path, generator, name } of sounds) {
    const fullPath = join(SOUNDS_DIR, path);
    await mkdir(dirname(fullPath), { recursive: true });

    const samples = generator();
    const wav = createWav(samples);
    await writeFile(fullPath, wav);

    const duration = (samples.length / SAMPLE_RATE).toFixed(2);
    const size = (wav.length / 1024).toFixed(1);
    console.log(`  ✓ ${name} → ${path} (${duration}s, ${size}KB)`);
  }

  console.log("\nDone!");
}

main().catch(console.error);
