import { readdir, mkdir, readFile, writeFile, stat, copyFile } from "node:fs/promises";
import { join, extname, basename, dirname } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = join(homedir(), ".clonk", "cache");

/**
 * Category keywords to match against folder names, filenames, and Wwise event names.
 */
const CATEGORY_PATTERNS = {
  ambient: [
    "ambient", "ambience", "ambi_", "amb_", "atmosphere", "atmos",
    "environment", "nature", "wind", "rain", "river", "ocean",
    "forest", "weather", "background_loop", "room_tone",
  ],
  music: [
    "music", "mus_", "soundtrack", "bgm", "score", "theme",
    "menu_music", "mainmenu", "background_music", "level_music",
    "snippet",
  ],
  sfx: [
    "sfx", "effect", "impact", "explosion", "hit", "slash",
    "swing", "shoot", "weapon", "combat", "fight", "footstep",
    "step", "walk", "jump", "land", "collect", "pickup", "drop",
    "build", "craft", "deposit", "chop", "mine", "hammer",
    "saw", "axe", "click", "whoosh", "swoosh",
  ],
  ui: [
    "ui_", "/ui/", "gui_", "/gui/", "menu", "button", "hover",
    "confirm", "cancel", "popup", "notification", "alert",
    "interface", "hud", "tab", "scroll",
  ],
  voice: [
    "voice", "vocal", "vox", "dialogue", "dialog", "speech",
    "narrat", "speak", "talk", "grunt", "shout", "scream",
    "laugh", "cry", "cheer",
  ],
  creature: [
    "creature", "animal", "monster", "enemy", "npc",
    "cow", "horse", "bird", "dog", "cat", "wolf", "bear",
    "chicken", "sheep", "pig",
  ],
};

/**
 * Infer a category from a filename, its parent folder path, and optional metadata name.
 */
export function inferCategory(filePath, metadataName) {
  const name = (metadataName || basename(filePath)).toLowerCase();
  const dirPath = dirname(filePath).toLowerCase().replace(/\\/g, "/");
  const combined = `${dirPath}/${name}`;

  // Check each category's patterns against the combined path+name
  const scores = {};
  for (const [cat, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    scores[cat] = 0;
    for (const p of patterns) {
      if (combined.includes(p)) scores[cat]++;
    }
  }

  // Return the best match, or "other" if nothing matched
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : "other";
}

/**
 * Parse Wwise SoundbanksInfo.json to build a map of WEM ID -> { name, category }.
 */
export async function parseWwiseSoundbanksInfo(gamePath) {
  const map = new Map(); // wemId -> { name, category }

  // Try to find SoundbanksInfo.json
  const searchDirs = [
    join(gamePath, "audio"),
    join(gamePath, "Audio"),
    join(gamePath, "sound"),
    join(gamePath, "Sound"),
    gamePath,
  ];

  let soundbanksData = null;
  for (const dir of searchDirs) {
    try {
      const content = await readFile(join(dir, "SoundbanksInfo.json"), "utf-8");
      soundbanksData = JSON.parse(content);
      break;
    } catch { /* try next */ }
  }

  if (soundbanksData?.SoundBanksInfo?.SoundBanks) {
    for (const bank of soundbanksData.SoundBanksInfo.SoundBanks) {
      if (!bank.Media) continue;
      for (const media of bank.Media) {
        if (media.Id && media.ShortName) {
          const name = basename(media.ShortName, extname(media.ShortName));
          map.set(String(media.Id), {
            name,
            category: inferCategory(media.ShortName, name),
          });
        }
      }
    }
  }

  // Also parse Wwise_IDs.h for event name categories
  const eventCategories = new Map(); // maps lowered keyword -> category
  for (const dir of searchDirs) {
    try {
      const content = await readFile(join(dir, "Wwise_IDs.h"), "utf-8");
      const eventRegex = /PLAY_(\w+)\s*=/g;
      let match;
      while ((match = eventRegex.exec(content)) !== null) {
        const eventName = match[1].toLowerCase();
        const cat = inferCategory("", eventName);
        if (cat !== "other") {
          // Extract keywords from event name to help tag related files
          const parts = eventName.split("_").filter(p => p.length > 2);
          for (const part of parts) {
            if (!["play", "sfx", "music", "pause", "stop", "switch"].includes(part)) {
              eventCategories.set(part, cat);
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  return { mediaMap: map, eventCategories };
}

/**
 * Get the cache directory for a game.
 */
function gameCacheDir(gameName) {
  return join(CACHE_DIR, gameName.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/**
 * Check if we have a cached extraction for a game.
 * Returns the manifest if cached, null otherwise.
 */
export async function getCachedExtraction(gameName) {
  const cacheDir = gameCacheDir(gameName);
  try {
    const manifest = JSON.parse(
      await readFile(join(cacheDir, "manifest.json"), "utf-8")
    );
    // Verify at least some files still exist
    if (manifest.files?.length > 0) {
      try {
        await stat(join(cacheDir, manifest.files[0].name));
        return manifest;
      } catch {
        return null; // files were cleaned up
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save extracted files to cache with metadata.
 * @param {string} gameName
 * @param {Array<{path: string, name: string}>} files - extracted WAV files
 * @param {string} gamePath - original game directory (for metadata lookup)
 * @returns {object} manifest with categorized files
 */
export async function cacheExtraction(gameName, files, gamePath) {
  const cacheDir = gameCacheDir(gameName);
  await mkdir(cacheDir, { recursive: true });

  // Parse Wwise metadata if available
  const { mediaMap } = await parseWwiseSoundbanksInfo(gamePath);

  const cachedFiles = [];
  for (const file of files) {
    const destPath = join(cacheDir, file.name);

    // Copy to cache if not already there
    try {
      await stat(destPath);
    } catch {
      try {
        await copyFile(file.path, destPath);
      } catch { continue; }
    }

    // Try to find metadata name from WEM ID
    const wemId = basename(file.name, ".wav").replace(/_\d{3}$/, "");
    const meta = mediaMap.get(wemId);

    const displayName = meta?.name || basename(file.name, ".wav");
    const category = meta?.category || inferCategory(file.path, file.name);

    cachedFiles.push({
      name: file.name,
      path: destPath,
      displayName,
      category,
    });
  }

  const manifest = {
    gameName,
    gamePath,
    extractedAt: new Date().toISOString(),
    fileCount: cachedFiles.length,
    files: cachedFiles,
    categories: [...new Set(cachedFiles.map((f) => f.category))].sort(),
  };

  await writeFile(join(cacheDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Enrich loose audio files (not extracted) with category info.
 * Uses folder structure and filename heuristics.
 */
export function categorizeLooseFiles(files) {
  return files.map((f) => ({
    ...f,
    displayName: basename(f.name, extname(f.name)),
    category: inferCategory(f.path, f.name),
  }));
}

/** Priority order for sorting — voice first, then interactive, then ambient. */
const CATEGORY_PRIORITY = {
  voice: 0, creature: 1, ui: 2, sfx: 3, ambient: 4, music: 5, other: 6,
};

/**
 * Get all available categories from a list of categorized files,
 * with counts, sorted by priority.
 */
export function getCategories(files) {
  const counts = {};
  for (const f of files) {
    const cat = f.category || "other";
    counts[cat] = (counts[cat] || 0) + 1;
  }
  const sorted = Object.keys(counts).sort(
    (a, b) => (CATEGORY_PRIORITY[a] ?? 99) - (CATEGORY_PRIORITY[b] ?? 99)
  );
  return { categories: ["all", ...sorted], counts };
}

/**
 * Sort files with voice/creature first, then by category priority.
 */
export function sortFilesByPriority(files) {
  return [...files].sort((a, b) => {
    const pa = CATEGORY_PRIORITY[a.category] ?? 99;
    const pb = CATEGORY_PRIORITY[b.category] ?? 99;
    if (pa !== pb) return pa - pb;
    return (a.displayName || a.name).localeCompare(b.displayName || b.name);
  });
}
