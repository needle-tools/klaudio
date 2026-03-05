import { execFile, spawn } from "node:child_process";
import { mkdir, stat, rename, chmod } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, basename } from "node:path";
import { homedir, platform, arch, tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

const PIPER_VERSION = "2023.11.14-2";
const VOICE_NAME = "en_GB-alan-medium";
const VOICE_SAMPLE_RATE = 22050;

const PIPER_DIR = join(homedir(), ".klaudio", "piper");

/**
 * Get the piper release asset name for the current platform.
 */
function getPiperAssetName() {
  const os = platform();
  const a = arch();

  if (os === "win32") return "piper_windows_amd64.zip";
  if (os === "darwin") return a === "arm64" ? "piper_macos_aarch64.tar.gz" : "piper_macos_x64.tar.gz";
  // Linux
  if (a === "arm64" || a === "aarch64") return "piper_linux_aarch64.tar.gz";
  return "piper_linux_x86_64.tar.gz";
}

/**
 * Get the piper binary path.
 */
function getPiperBinPath() {
  const bin = platform() === "win32" ? "piper.exe" : "piper";
  return join(PIPER_DIR, "piper", bin);
}

/**
 * Get the voice model path.
 */
function getVoiceModelPath() {
  return join(PIPER_DIR, `${VOICE_NAME}.onnx`);
}

/**
 * Download a file from a URL to a local path.
 */
async function downloadFile(url, destPath, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const total = parseInt(res.headers.get("content-length") || "0", 10);
  let downloaded = 0;

  const fileStream = createWriteStream(destPath);
  const reader = res.body.getReader();

  // Manual stream piping with progress
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
    downloaded += value.length;
    if (onProgress && total > 0) {
      onProgress(Math.round((downloaded / total) * 100));
    }
  }

  fileStream.end();
  await new Promise((resolve, reject) => {
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });
}

/**
 * Extract a .tar.gz or .zip archive.
 */
async function extractArchive(archivePath, destDir) {
  const os = platform();

  if (archivePath.endsWith(".zip")) {
    if (os === "win32") {
      // Use PowerShell to extract on Windows
      await new Promise((resolve, reject) => {
        execFile("powershell.exe", [
          "-NoProfile", "-Command",
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ], { windowsHide: true, timeout: 60000 }, (err) => err ? reject(err) : resolve());
      });
    } else {
      await new Promise((resolve, reject) => {
        execFile("unzip", ["-o", archivePath, "-d", destDir], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
      });
    }
  } else {
    // tar.gz
    await new Promise((resolve, reject) => {
      execFile("tar", ["xzf", archivePath, "-C", destDir], { timeout: 60000 }, (err) => err ? reject(err) : resolve());
    });
  }
}

/**
 * Ensure piper binary is available, downloading if needed.
 * Returns the path to the piper executable.
 */
export async function ensurePiper(onProgress) {
  const binPath = getPiperBinPath();

  // Check if already downloaded
  try {
    await stat(binPath);
    return binPath;
  } catch { /* needs download */ }

  try {
    await mkdir(PIPER_DIR, { recursive: true });

    const asset = getPiperAssetName();
    const url = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${asset}`;
    const archivePath = join(PIPER_DIR, asset);

    if (onProgress) onProgress(`Downloading piper TTS...`);
    await downloadFile(url, archivePath, (pct) => {
      if (onProgress) onProgress(`Downloading piper TTS... ${pct}%`);
    });

    if (onProgress) onProgress("Extracting piper...");
    await extractArchive(archivePath, PIPER_DIR);

    // Make executable on Unix
    if (platform() !== "win32") {
      try { await chmod(binPath, 0o755); } catch { /* ignore */ }
    }

    return binPath;
  } catch (err) {
    // Clean up partial downloads
    try { const { unlink } = await import("node:fs/promises"); await unlink(join(PIPER_DIR, getPiperAssetName())); } catch { /* ignore */ }
    throw new Error(`Failed to download piper: ${err.message}`);
  }
}

/**
 * Ensure voice model is available, downloading if needed.
 * Returns the path to the .onnx model file.
 */
export async function ensureVoiceModel(onProgress) {
  const modelPath = getVoiceModelPath();
  const configPath = modelPath + ".json";

  // Check if already downloaded
  try {
    await stat(modelPath);
    await stat(configPath);
    return modelPath;
  } catch { /* needs download */ }

  try {
    await mkdir(PIPER_DIR, { recursive: true });

    const baseUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium`;

    if (onProgress) onProgress("Downloading voice model...");
    await downloadFile(`${baseUrl}/${VOICE_NAME}.onnx`, modelPath, (pct) => {
      if (onProgress) onProgress(`Downloading voice model... ${pct}%`);
    });

    if (onProgress) onProgress("Downloading voice config...");
    await downloadFile(`${baseUrl}/${VOICE_NAME}.onnx.json`, configPath);

    return modelPath;
  } catch (err) {
    // Clean up partial downloads
    const { unlink } = await import("node:fs/promises");
    try { await unlink(modelPath); } catch { /* ignore */ }
    try { await unlink(configPath); } catch { /* ignore */ }
    throw new Error(`Failed to download voice model: ${err.message}`);
  }
}

/**
 * Speak text using macOS `say` command (built-in, good quality).
 */
function speakMacOS(text) {
  return new Promise((resolve) => {
    execFile("say", ["-v", "Daniel", text], { timeout: 15000 }, () => resolve());
  });
}

/**
 * Speak text using Piper TTS, with macOS `say` fallback.
 * Auto-downloads piper and voice model on first use.
 * Returns a promise that resolves when speech is done.
 */
export async function speak(text, onProgress) {
  if (!text) return;

  // macOS: use built-in `say` — better compatibility, no dylib issues
  if (platform() === "darwin") {
    return speakMacOS(text);
  }

  let piperBin, modelPath;
  try {
    [piperBin, modelPath] = await Promise.all([
      ensurePiper(onProgress),
      ensureVoiceModel(onProgress),
    ]);
  } catch {
    // TTS unavailable (download failed, offline, etc.) — skip silently
    return;
  }

  // Generate to temp wav file
  const hash = createHash("md5").update(text).digest("hex").slice(0, 8);
  const outPath = join(tmpdir(), `klaudio-tts-${hash}.wav`);

  try {
    await new Promise((resolve, reject) => {
      const child = execFile(piperBin, [
        "--model", modelPath,
        "--output_file", outPath,
        "--sentence_silence", "0.5",
      ], { windowsHide: true, timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
      // Feed text via stdin
      child.stdin.write(text);
      child.stdin.end();
    });

    // Play the generated wav
    const { playSoundWithCancel } = await import("./player.js");
    await playSoundWithCancel(outPath, { maxSeconds: 0 }).promise.catch(() => {});
  } catch {
    // Piper failed (dylib error, etc.) — skip silently
  }
}
