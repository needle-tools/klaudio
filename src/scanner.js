import { readdir, readFile, stat, open } from "node:fs/promises";
import { join, extname } from "node:path";
import { platform, homedir } from "node:os";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".aac"]);
const PACKED_EXTENSIONS = new Set([".wem", ".bnk", ".bank", ".fsb", ".pck", ".bun"]);
const UNITY_RESOURCE_EXTENSIONS = new Set([".resource", ".ress"]);
const MAX_DEPTH = 5;
const MAX_FILES = 200;

/** Yield to the event loop so the UI stays responsive. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Check if a directory exists and is accessible.
 */
async function dirExists(dirPath) {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover available drive letters on Windows (C-Z).
 */
async function getWindowsDrives() {
  const drives = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (await dirExists(`${letter}:/`)) {
      drives.push(`${letter}:`);
    }
  }
  return drives;
}

/**
 * Parse Steam's libraryfolders.vdf to find all Steam library paths.
 */
async function getSteamLibraryPaths() {
  const os = platform();
  const home = homedir();
  const paths = [];

  // Known default Steam install locations to find the vdf
  const steamRoots = [];
  if (os === "win32") {
    steamRoots.push(
      "C:/Program Files (x86)/Steam",
      "C:/Program Files/Steam",
    );
  } else if (os === "darwin") {
    steamRoots.push(join(home, "Library/Application Support/Steam"));
  } else {
    steamRoots.push(
      join(home, ".steam/steam"),
      join(home, ".local/share/Steam"),
    );
  }

  for (const root of steamRoots) {
    const vdfPath = join(root, "steamapps", "libraryfolders.vdf");
    try {
      const content = await readFile(vdfPath, "utf-8");
      // Parse "path" values from the VDF file (simple regex — VDF is not JSON)
      const pathRegex = /"path"\s+"([^"]+)"/g;
      let match;
      while ((match = pathRegex.exec(content)) !== null) {
        const libPath = match[1].replace(/\\\\/g, "/");
        const commonPath = join(libPath, "steamapps", "common");
        if (await dirExists(commonPath)) {
          paths.push(commonPath);
        }
      }
      if (paths.length > 0) break; // Found a valid vdf, stop looking
    } catch {
      // vdf not found here, try next
    }
  }

  return paths;
}

/**
 * Parse Epic Games launcher manifests to find actual install locations.
 * These .item files are JSON with an InstallLocation field.
 */
async function getEpicInstallPaths() {
  const os = platform();
  const paths = [];

  const manifestDirs = [];
  if (os === "win32") {
    manifestDirs.push("C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests");
  } else if (os === "darwin") {
    const home = homedir();
    manifestDirs.push(join(home, "Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests"));
  }

  for (const manifestDir of manifestDirs) {
    if (!(await dirExists(manifestDir))) continue;
    try {
      const entries = await readdir(manifestDir);
      for (const entry of entries) {
        if (!entry.endsWith(".item")) continue;
        try {
          const content = await readFile(join(manifestDir, entry), "utf-8");
          const data = JSON.parse(content);
          if (data.InstallLocation && data.bIsApplication !== false) {
            const installPath = data.InstallLocation.replace(/\\\\/g, "/").replace(/\\/g, "/");
            if (await dirExists(installPath)) {
              paths.push({ path: installPath, name: data.DisplayName || null });
            }
          }
        } catch { /* skip malformed manifests */ }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  return paths;
}

/**
 * Find Epic Games install directories by scanning drives (fallback)
 * and parsing launcher manifests (primary).
 */
async function getEpicGamesPaths() {
  const os = platform();
  const home = homedir();
  const paths = [];

  // Primary: parse manifests for exact install locations
  const epicInstalls = await getEpicInstallPaths();
  // These are individual game paths, not parent dirs — we'll handle them separately
  // For now return parent dirs found by scanning

  if (os === "win32") {
    const drives = await getWindowsDrives();
    const epicDirNames = [
      "Epic Games",
      "Program Files/Epic Games",
      "Program Files (x86)/Epic Games",
      "Games/EpicGames",
      "Games/Epic Games",
    ];

    for (const drive of drives) {
      for (const dirName of epicDirNames) {
        const fullPath = `${drive}/${dirName}`;
        if (await dirExists(fullPath)) {
          paths.push(fullPath);
        }
      }
    }
  } else if (os === "darwin") {
    const macPaths = [
      "/Applications/Epic Games",
      join(home, "Library/Application Support/Epic"),
    ];
    for (const p of macPaths) {
      if (await dirExists(p)) paths.push(p);
    }
  }

  return { parentDirs: paths, individualGames: epicInstalls };
}

/**
 * Get all game sources.
 * Returns { parentDirs: string[], individualGames: {path, name}[] }
 */
async function getGameSources() {
  const os = platform();
  const home = homedir();
  const parentDirs = [];
  const individualGames = [];

  // Steam libraries (from config file)
  const steamPaths = await getSteamLibraryPaths();
  parentDirs.push(...steamPaths);

  // Epic Games (manifests + scanned dirs)
  const epic = await getEpicGamesPaths();
  parentDirs.push(...epic.parentDirs);
  individualGames.push(...epic.individualGames);

  // Additional common locations
  if (os === "win32") {
    const drives = await getWindowsDrives();
    for (const drive of drives) {
      for (const dir of ["Games", "SteamLibrary/steamapps/common"]) {
        const fullPath = `${drive}/${dir}`;
        if (await dirExists(fullPath)) {
          parentDirs.push(fullPath);
        }
      }
    }
    const homeGames = join(home, "Games");
    if (await dirExists(homeGames)) parentDirs.push(homeGames);
  } else if (os === "darwin") {
    for (const d of ["/Applications/Games", join(home, "Games")]) {
      if (await dirExists(d)) parentDirs.push(d);
    }
  } else {
    for (const d of [join(home, "Games"), join(home, ".local/share/lutris/games")]) {
      if (await dirExists(d)) parentDirs.push(d);
    }
  }

  // Deduplicate parent dirs
  const seen = new Set();
  const dedupedDirs = parentDirs.filter((d) => {
    const n = d.replace(/\\/g, "/").toLowerCase();
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  // Deduplicate individual games (by path, avoid overlap with parent dirs)
  const dedupedGames = individualGames.filter((g) => {
    const n = g.path.replace(/\\/g, "/").toLowerCase();
    // Skip if this game's parent is already in parentDirs
    for (const pd of dedupedDirs) {
      const pdn = pd.replace(/\\/g, "/").toLowerCase();
      if (n.startsWith(pdn + "/") || n.startsWith(pdn + "\\")) return false;
    }
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  return { parentDirs: dedupedDirs, individualGames: dedupedGames };
}

/**
 * Recursively find audio files in a directory.
 */
async function findAudioFiles(dir, depth = 0, results = [], packedCount = { n: 0 }, unityResources = []) {
  if (depth > MAX_DEPTH || results.length >= MAX_FILES) return results;

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (["__pycache__", "node_modules", ".git", "shader", "texture"].some(s => lower.includes(s))) {
          continue;
        }
        await findAudioFiles(fullPath, depth + 1, results, packedCount, unityResources);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          results.push({ path: fullPath, name: entry.name, dir });
        } else if (PACKED_EXTENSIONS.has(ext)) {
          packedCount.n++;
        } else if (UNITY_RESOURCE_EXTENSIONS.has(ext)) {
          unityResources.push(fullPath);
        }
      }
    }
  } catch { /* skip */ }

  return results;
}

/**
 * Scan for installed games and their sound files.
 * Returns a map of game name -> audio files.
 */
const SKIP_DIRS = new Set([
  "launcher", "directxredist", "steamworks shared",
  "steam controller configs", "epic online services",
]);

/**
 * Quick check if a file starts with FSB5 magic (Unity .resource with audio).
 */
async function hasFSB5Magic(filePath) {
  try {
    const fh = await open(filePath, "r");
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    await fh.close();
    return buf[0] === 0x46 && buf[1] === 0x53 && buf[2] === 0x42 && buf[3] === 0x35; // "FSB5"
  } catch {
    return false;
  }
}

async function scanGameDir(gamePath, gameName, games, onProgress) {
  if (onProgress) onProgress({ phase: "scanning", game: gameName });
  await tick();

  const packedCount = { n: 0 };
  const unityResources = [];
  let audioFiles = await findAudioFiles(gamePath, 0, [], packedCount, unityResources);

  const seen = new Set();
  audioFiles = audioFiles.filter((f) => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });

  // Check Unity .resource files for FSB5 audio
  let unityAudioCount = 0;
  const validUnityResources = [];
  for (const resPath of unityResources) {
    if (await hasFSB5Magic(resPath)) {
      unityAudioCount++;
      validUnityResources.push(resPath);
    }
  }

  games.set(gameName, {
    path: gamePath,
    files: audioFiles.slice(0, 50),
    packedAudioCount: packedCount.n,
    unityAudioCount,
    unityResources: validUnityResources,
  });
}

export async function scanForGames(onProgress, onGameFound) {
  const { parentDirs, individualGames } = await getGameSources();
  const games = new Map();

  const allDirs = [...parentDirs, ...individualGames.map((g) => `${g.path} (Epic)`)];
  if (onProgress) onProgress({ phase: "dirs", dirs: allDirs });

  function emitGame(name, data) {
    if (onGameFound) {
      onGameFound({
        name,
        path: data.path,
        fileCount: data.files.length,
        files: data.files,
        hasAudio: data.files.length > 0,
        packedAudioCount: data.packedAudioCount || 0,
        canExtract: (data.packedAudioCount || 0) > 0 || (data.unityAudioCount || 0) > 0,
        unityAudioCount: data.unityAudioCount || 0,
        unityResources: data.unityResources || [],
      });
    }
  }

  // Scan parent directories (Steam libraries, Epic Games folders, etc.)
  for (const baseDir of parentDirs) {
    try {
      const entries = await readdir(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;

        await scanGameDir(join(baseDir, entry.name), entry.name, games, onProgress);
        emitGame(entry.name, games.get(entry.name));
      }
    } catch {
      // Skip inaccessible dirs
    }
  }

  // Scan individual game install paths (from Epic manifests, etc.)
  for (const { path: gamePath, name: displayName } of individualGames) {
    const gameName = displayName || gamePath.split(/[\\/]/).pop();
    if (games.has(gameName)) continue; // Already found via parent dir scan
    await scanGameDir(gamePath, gameName, games, onProgress);
    emitGame(gameName, games.get(gameName));
  }

  return games;
}

/**
 * Discover system sounds (Windows Media, macOS system sounds, Linux sound themes).
 * Returns an array of { path, name, dir } matching the game file format.
 */
export async function getSystemSounds() {
  const os = platform();
  const results = [];

  const dirs = [];
  if (os === "win32") {
    dirs.push("C:/Windows/Media", "C:/Windows/Media/dm");
  } else if (os === "darwin") {
    dirs.push("/System/Library/Sounds");
  } else {
    // Linux: common sound theme locations
    dirs.push(
      "/usr/share/sounds/freedesktop/stereo",
      "/usr/share/sounds/gnome/default/alerts",
      "/usr/share/sounds/ubuntu/stereo",
      "/usr/share/sounds",
    );
  }

  for (const dir of dirs) {
    if (!(await dirExists(dir))) continue;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          results.push({ path: join(dir, entry.name), name: entry.name, dir });
        }
      }
    } catch { /* skip */ }
  }

  return results;
}

/**
 * Get a flat list of all found game directories.
 */
export async function getAvailableGames(onProgress, onGameFound) {
  const games = await scanForGames(onProgress, onGameFound);
  return Array.from(games.entries())
    .map(([name, data]) => ({
      name,
      path: data.path,
      fileCount: data.files.length,
      files: data.files,
      hasAudio: data.files.length > 0,
      packedAudioCount: data.packedAudioCount || 0,
      canExtract: (data.packedAudioCount || 0) > 0 || (data.unityAudioCount || 0) > 0,
      unityAudioCount: data.unityAudioCount || 0,
      unityResources: data.unityResources || [],
    }))
    // Games with audio first, then extractable, then others
    .sort((a, b) => {
      if (a.hasAudio !== b.hasAudio) return a.hasAudio ? -1 : 1;
      if (a.canExtract !== b.canExtract) return a.canExtract ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
