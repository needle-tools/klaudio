import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { getHookPlayCommand, processSound } from "./player.js";
import { EVENTS } from "./presets.js";

/**
 * Get the target directory based on install scope.
 */
function getTargetDir(scope) {
  if (scope === "global") {
    return join(homedir(), ".claude");
  }
  return join(process.cwd(), ".claude");
}

/**
 * Install sounds and configure hooks.
 *
 * @param {object} options
 * @param {string} options.scope - "global" or "project"
 * @param {Record<string, string>} options.sounds - Map of event ID -> source sound file path
 */
export async function install({ scope, sounds }) {
  const claudeDir = getTargetDir(scope);
  const soundsDir = join(claudeDir, "sounds");
  const settingsFile = join(claudeDir, "settings.json");

  // Create sounds directory
  await mkdir(soundsDir, { recursive: true });

  // Process and copy sound files (clamp to 10s with fadeout via ffmpeg)
  const installedSounds = {};
  for (const [eventId, sourcePath] of Object.entries(sounds)) {
    const processedPath = await processSound(sourcePath);
    const srcName = basename(sourcePath, extname(sourcePath));
    const outExt = extname(processedPath) || ".wav";
    const fileName = `${eventId}-${srcName}${outExt}`;
    const destPath = join(soundsDir, fileName);
    await copyFile(processedPath, destPath);
    installedSounds[eventId] = destPath;
  }

  // Read existing settings
  let settings = {};
  try {
    const existing = await readFile(settingsFile, "utf-8");
    settings = JSON.parse(existing);
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  // Build hooks config
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [eventId, soundPath] of Object.entries(installedSounds)) {
    const event = EVENTS[eventId];
    if (!event) continue;

    const hookEvent = event.hookEvent;
    const playCommand = getHookPlayCommand(soundPath);

    // Check if there's already a claude-sounds hook for this event
    if (!settings.hooks[hookEvent]) {
      settings.hooks[hookEvent] = [];
    }

    // Remove any existing claude-sounds entries
    settings.hooks[hookEvent] = settings.hooks[hookEvent].filter(
      (entry) => !entry._claude_sounds
    );

    // Add our hook
    settings.hooks[hookEvent].push({
      _claude_sounds: true,
      matcher: "",
      hooks: [
        {
          type: "command",
          command: playCommand,
        },
      ],
    });
  }

  // Write settings
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");

  return {
    soundsDir,
    settingsFile,
    installedSounds,
  };
}

/**
 * Uninstall claude-sounds hooks from settings.
 */
export async function uninstall(scope) {
  const claudeDir = getTargetDir(scope);
  const settingsFile = join(claudeDir, "settings.json");

  try {
    const existing = await readFile(settingsFile, "utf-8");
    const settings = JSON.parse(existing);

    if (settings.hooks) {
      for (const [event, entries] of Object.entries(settings.hooks)) {
        settings.hooks[event] = entries.filter(
          (entry) => !entry._claude_sounds
        );
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    await writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}
