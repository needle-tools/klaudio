import { execFile, spawn } from "node:child_process";
import { platform } from "node:os";
import { resolve, extname, basename, join } from "node:path";
import { open, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const MAX_PLAY_SECONDS = 10;
const FADE_SECONDS = 2; // fade out over last 2 seconds

// Formats that Windows MediaPlayer (PresentationCore) can play natively
const MEDIA_PLAYER_FORMATS = new Set([".wav", ".mp3", ".wma", ".aac"]);

/**
 * Determine the best playback strategy for a file on the current OS.
 */
function getPlaybackCommand(absPath, { withFade = false } = {}) {
  const os = platform();
  const ext = extname(absPath).toLowerCase();

  // ffplay args with optional fade-out and silence-skip
  const ffplayArgs = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
  if (withFade) {
    // silenceremove strips leading silence (below -50dB threshold)
    // afade fades out over last FADE_SECONDS before the MAX_PLAY_SECONDS cut
    const fadeStart = MAX_PLAY_SECONDS - FADE_SECONDS;
    const filters = [
      "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB",
      `afade=t=out:st=${fadeStart}:d=${FADE_SECONDS}`,
    ];
    ffplayArgs.push("-af", filters.join(","));
    ffplayArgs.push("-t", String(MAX_PLAY_SECONDS));
  }
  ffplayArgs.push(absPath);

  if (os === "darwin") {
    // afplay doesn't support filters — use ffplay if fade needed, fall back to afplay
    if (withFade) {
      return { type: "exec", cmd: "ffplay", args: ffplayArgs, fallback: "afplay" };
    }
    return { type: "exec", cmd: "afplay", args: [absPath] };
  }

  if (os === "win32") {
    if (withFade || !MEDIA_PLAYER_FORMATS.has(ext)) {
      // Prefer ffplay for fade support and non-native formats; fall back to PowerShell
      return {
        type: "exec",
        cmd: "ffplay",
        args: ffplayArgs,
        fallback: "powershell",
      };
    }
    return { type: "powershell", absPath };
  }

  // Linux
  if (ext === ".wav" && !withFade) {
    return { type: "exec", cmd: "aplay", args: [absPath] };
  }
  return {
    type: "exec",
    cmd: "ffplay",
    args: ffplayArgs,
  };
}

function buildPsCommand(absPath, maxSeconds = 0) {
  const limit = maxSeconds > 0 ? maxSeconds : 30;
  const fadeStart = (limit - FADE_SECONDS) * 10; // in 100ms ticks
  return `
    Add-Type -AssemblyName PresentationCore
    $player = New-Object System.Windows.Media.MediaPlayer
    $player.Open([System.Uri]::new("${absPath.replace(/\\/g, "/")}"))
    Start-Sleep -Milliseconds 300
    $player.Play()
    $player.Volume = 1.0
    $elapsed = 0
    while ($player.Position -lt $player.NaturalDuration.TimeSpan -and $player.NaturalDuration.HasTimeSpan -and $elapsed -lt ${limit * 10}) {
      Start-Sleep -Milliseconds 100
      $elapsed++
      if ($elapsed -gt ${fadeStart} -and ${limit * 10} -gt ${fadeStart}) {
        $remaining = ${limit * 10} - $elapsed
        $total = ${FADE_SECONDS * 10}
        if ($total -gt 0) { $player.Volume = [Math]::Max(0, [double]$remaining / [double]$total) }
      }
    }
    $player.Stop()
    $player.Close()
  `.trim();
}

/**
 * Get the duration of a WAV file in seconds by reading its header.
 * Returns null if unable to determine.
 */
export async function getWavDuration(filePath) {
  const absPath = resolve(filePath);
  const ext = extname(absPath).toLowerCase();

  // Try ffprobe first (handles all formats and non-standard WAV headers)
  const ffDuration = await getFFprobeDuration(absPath);
  if (ffDuration != null) return ffDuration;

  // Fallback: parse WAV header directly
  if (ext === ".wav") {
    return getWavDurationFromHeader(absPath);
  }

  return null;
}

async function getWavDurationFromHeader(absPath) {
  let fh;
  try {
    fh = await open(absPath, "r");
    const header = Buffer.alloc(44);
    await fh.read(header, 0, 44, 0);

    // Verify RIFF/WAVE
    if (header.toString("ascii", 0, 4) !== "RIFF") return null;
    if (header.toString("ascii", 8, 12) !== "WAVE") return null;

    // Read fmt chunk (assuming standard PCM at offset 20)
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);

    if (sampleRate === 0 || channels === 0 || bitsPerSample === 0) return null;

    // Data chunk size is at offset 40 in standard WAV
    const dataSize = header.readUInt32LE(40);
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);

    if (bytesPerSecond === 0) return null;
    return Math.round((dataSize / bytesPerSecond) * 10) / 10;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close();
  }
}

function getFFprobeDuration(absPath) {
  return new Promise((res) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", absPath],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return res(null);
        const val = parseFloat(stdout.trim());
        if (isNaN(val)) return res(null);
        res(Math.round(val * 10) / 10);
      }
    );
  });
}

/**
 * Play a sound file. Returns a promise that resolves when playback starts
 * (not when it finishes — we don't want to block).
 */
export function playSound(filePath) {
  const absPath = resolve(filePath);
  const strategy = getPlaybackCommand(absPath);

  return new Promise((resolvePromise) => {
    if (strategy.type === "exec") {
      const child = spawn(strategy.cmd, strategy.args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.unref();
      resolvePromise();
      child.on("error", () => {
        if (strategy.fallback === "powershell") {
          const ps = spawn("powershell.exe", ["-NoProfile", "-Command", buildPsCommand(absPath)], {
            stdio: "ignore", detached: true, windowsHide: true,
          });
          ps.unref();
        }
      });
    } else if (strategy.type === "powershell") {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", buildPsCommand(absPath)], {
        stdio: "ignore", detached: true, windowsHide: true,
      });
      child.unref();
      resolvePromise();
    }
  });
}

/**
 * Play a sound and wait for it to finish (for preview mode).
 * Returns { promise, cancel } — call cancel() to stop playback immediately.
 * Playback is clamped to MAX_PLAY_SECONDS.
 */
export function playSoundWithCancel(filePath) {
  const absPath = resolve(filePath);
  const strategy = getPlaybackCommand(absPath, { withFade: true });
  let childProcess = null;
  let timer = null;
  let cancelled = false;

  function killChild() {
    if (childProcess && !childProcess.killed) {
      try {
        // On Windows, spawned processes need taskkill for the process tree
        if (platform() === "win32") {
          spawn("taskkill", ["/pid", String(childProcess.pid), "/f", "/t"], {
            stdio: "ignore", windowsHide: true,
          });
        } else {
          childProcess.kill("SIGTERM");
        }
      } catch { /* ignore */ }
    }
    if (timer) clearTimeout(timer);
  }

  const cancel = () => {
    cancelled = true;
    killChild();
  };

  const promise = new Promise((resolvePromise, reject) => {
    function onDone(err) {
      if (timer) clearTimeout(timer);
      if (cancelled) return resolvePromise(); // cancelled — resolve, don't reject
      if (err) reject(err);
      else resolvePromise();
    }

    function startExec(cmd, args) {
      childProcess = execFile(cmd, args, { windowsHide: true, timeout: (MAX_PLAY_SECONDS + 2) * 1000 }, (err) => {
        if (err && strategy.fallback && !cancelled) {
          if (strategy.fallback === "powershell") {
            childProcess = execFile(
              "powershell.exe",
              ["-NoProfile", "-Command", buildPsCommand(absPath, MAX_PLAY_SECONDS)],
              { windowsHide: true, timeout: (MAX_PLAY_SECONDS + 2) * 1000 },
              (psErr) => onDone(psErr)
            );
          } else if (strategy.fallback === "afplay") {
            // macOS: ffplay not available, fall back to afplay (no fade)
            childProcess = execFile("afplay", [absPath], { timeout: (MAX_PLAY_SECONDS + 2) * 1000 }, (afErr) => onDone(afErr));
          }
        } else {
          onDone(err);
        }
      });

      // Set a hard timeout to kill after MAX_PLAY_SECONDS
      timer = setTimeout(() => {
        killChild();
        resolvePromise();
      }, MAX_PLAY_SECONDS * 1000);
    }

    if (strategy.type === "exec") {
      startExec(strategy.cmd, strategy.args);
    } else if (strategy.type === "powershell") {
      childProcess = execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", buildPsCommand(absPath, MAX_PLAY_SECONDS)],
        { windowsHide: true, timeout: (MAX_PLAY_SECONDS + 2) * 1000 },
        (err) => onDone(err)
      );
      timer = setTimeout(() => {
        killChild();
        resolvePromise();
      }, MAX_PLAY_SECONDS * 1000);
    }
  });

  return { promise, cancel };
}

/**
 * Play a sound and wait for it to finish (legacy — no cancel support).
 */
export function playSoundSync(filePath) {
  return playSoundWithCancel(filePath).promise;
}

/**
 * Process a sound file with ffmpeg: strip leading silence, clamp to MAX_PLAY_SECONDS,
 * and fade out over the last FADE_SECONDS. Returns the path to the processed WAV file.
 * If ffmpeg is not available or the file is already short enough, returns the original path.
 */
export async function processSound(filePath) {
  const absPath = resolve(filePath);

  // First check duration — skip processing if already short
  const duration = await getWavDuration(absPath);
  if (duration != null && duration <= MAX_PLAY_SECONDS) {
    return absPath; // Already short enough, no processing needed
  }

  // Build a deterministic output path based on input file hash
  const hash = createHash("md5").update(absPath).digest("hex").slice(0, 12);
  const outDir = join(tmpdir(), "clonk-processed");
  const outName = `${basename(absPath, extname(absPath))}_${hash}.wav`;
  const outPath = join(outDir, outName);

  // Check if already processed
  try {
    await stat(outPath);
    return outPath; // Already exists
  } catch { /* needs processing */ }

  await mkdir(outDir, { recursive: true });

  // Build ffmpeg filter chain: silence strip → fade out → clamp duration
  const fadeStart = MAX_PLAY_SECONDS - FADE_SECONDS;
  const filters = [
    "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-50dB",
    `afade=t=out:st=${fadeStart}:d=${FADE_SECONDS}`,
  ].join(",");

  return new Promise((res) => {
    execFile(
      "ffmpeg",
      [
        "-y", "-i", absPath,
        "-af", filters,
        "-t", String(MAX_PLAY_SECONDS),
        "-ar", "44100", "-ac", "2",
        outPath,
      ],
      { windowsHide: true, timeout: 30000 },
      (err) => {
        if (err) {
          // ffmpeg not available or failed — return original
          res(absPath);
        } else {
          res(outPath);
        }
      },
    );
  });
}

/**
 * Generate the shell command string for use in Claude Code hooks.
 */
export function getHookPlayCommand(soundFilePath) {
  const normalized = soundFilePath.replace(/\\/g, "/");
  const ext = extname(normalized).toLowerCase();
  const needsFfplay = !MEDIA_PLAYER_FORMATS.has(ext);

  if (needsFfplay) {
    return `if command -v ffplay &>/dev/null; then ffplay -nodisp -autoexit -loglevel quiet "${normalized}" & elif [[ "$OSTYPE" == "darwin"* ]]; then afplay "${normalized}" & elif [[ "$OSTYPE" == "msys"* ]] || [[ "$OSTYPE" == "cygwin"* ]]; then powershell.exe -NoProfile -Command "Add-Type -AssemblyName PresentationCore; \\$p = New-Object System.Windows.Media.MediaPlayer; \\$p.Open([System.Uri]::new('$(cygpath -w "${normalized}")')); Start-Sleep -Milliseconds 200; \\$p.Play(); Start-Sleep -Seconds 2" & else aplay "${normalized}" & fi`;
  }

  return `if [[ "$OSTYPE" == "darwin"* ]]; then afplay "${normalized}" & elif [[ "$OSTYPE" == "msys"* ]] || [[ "$OSTYPE" == "cygwin"* ]]; then powershell.exe -NoProfile -Command "Add-Type -AssemblyName PresentationCore; \\$p = New-Object System.Windows.Media.MediaPlayer; \\$p.Open([System.Uri]::new('$(cygpath -w "${normalized}")')); Start-Sleep -Milliseconds 200; \\$p.Play(); Start-Sleep -Seconds 2" & else aplay "${normalized}" & fi`;
}
