#!/usr/bin/env node
/**
 * Build standalone binaries for clonk using bun compile.
 *
 * Usage:
 *   bun run build.js              # build for current platform
 *   bun run build.js --all        # build for Windows, macOS, Linux
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dirname, "dist");
const SOUNDS_SRC = join(import.meta.dirname, "sounds");
const ENTRY = join(import.meta.dirname, "bin", "cli.js");

const TARGETS = {
  "windows-x64": { target: "bun-windows-x64", ext: ".exe" },
  "macos-x64": { target: "bun-darwin-x64", ext: "" },
  "macos-arm64": { target: "bun-darwin-arm64", ext: "" },
  "linux-x64": { target: "bun-linux-x64", ext: "" },
  "linux-arm64": { target: "bun-linux-arm64", ext: "" },
};

const buildAll = process.argv.includes("--all");

// Detect current platform target
function getCurrentTarget() {
  const os = process.platform;
  const arch = process.arch;
  if (os === "win32") return "windows-x64";
  if (os === "darwin") return arch === "arm64" ? "macos-arm64" : "macos-x64";
  return arch === "arm64" ? "linux-arm64" : "linux-x64";
}

function build(name) {
  const { target, ext } = TARGETS[name];
  const outDir = join(DIST, `clonk-${name}`);
  const outFile = join(outDir, `clonk${ext}`);

  console.log(`\n  Building ${name}...`);

  // Clean and create output dir
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Compile
  execSync(
    `bun build --compile --target=${target} "${ENTRY}" --outfile "${outFile}"`,
    { stdio: "inherit" },
  );

  // Copy sounds alongside binary
  cpSync(SOUNDS_SRC, join(outDir, "sounds"), { recursive: true });

  console.log(`  ✓ ${outFile}`);
  return outDir;
}

// Stub react-devtools-core if not installed
const stubDir = join(import.meta.dirname, "node_modules", "react-devtools-core");
try {
  mkdirSync(stubDir, { recursive: true });
  const pkg = join(stubDir, "package.json");
  const idx = join(stubDir, "index.js");
  const { writeFileSync, existsSync } = await import("node:fs");
  if (!existsSync(pkg)) {
    writeFileSync(pkg, '{"name":"react-devtools-core","version":"0.0.0","main":"index.js","type":"module"}');
    writeFileSync(idx, "export default {};");
  }
} catch { /* already exists */ }

console.log("🔊 Building clonk standalone binaries\n");

if (buildAll) {
  for (const name of Object.keys(TARGETS)) {
    build(name);
  }
} else {
  build(getCurrentTarget());
}

console.log("\n✓ Done! Distribute the folder contents together (binary + sounds/).");
