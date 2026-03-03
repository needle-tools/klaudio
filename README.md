# claude-sounds

Add sound effects to your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Plays sounds when Claude starts working, finishes a task, encounters an error, and more.

## Quick Start

**With Node.js:**

```bash
npx claude-sounds
```

**Standalone binary (no Node.js needed):**

Download the latest release for your platform from [Releases](https://github.com/user/claude-sounds/releases), extract, and run:

```bash
./claude-sounds        # macOS / Linux
claude-sounds.exe      # Windows
```

The interactive installer walks you through:

1. **Choose scope** — install globally (`~/.claude`) or per-project (`.claude/`)
2. **Pick a source** — use a built-in preset, scan your local games for sounds, or provide custom files
3. **Preview & assign** — listen to sounds and assign them to events (task start, task end, error, etc.)
4. **Install** — writes Claude Code hooks to your `settings.json`

## Sound Sources

### Built-in Presets

Ready-made sound packs (Retro 8-bit, Minimal Zen, etc.) that work out of the box.

### Game Sound Scanner

Scans your Steam and Epic Games libraries for audio files:

- Finds loose audio files (`.wav`, `.mp3`, `.ogg`, `.flac`, `.aac`)
- Extracts packed audio (Wwise `.wem`, FMOD `.bank`, `.fsb`) using [vgmstream](https://vgmstream.org/) (downloaded automatically)
- Parses Wwise metadata (`SoundbanksInfo.json`) for descriptive filenames
- Categorizes sounds (voice, ambient, music, SFX, UI, creature) for easy browsing
- Caches extracted sounds in `~/.claude-sounds/cache/` for instant reuse

### Custom Files

Point to your own `.wav`/`.mp3` files.

## Features

- **Auto-preview** — sounds play automatically as you browse the list (toggle with `p`)
- **Category filtering** — drill into voice, ambient, SFX, etc. when a game has enough variety
- **Type-to-filter** — start typing to narrow down long lists
- **10-second clamp** — long sounds fade out gracefully (skips leading silence too)
- **Background scanning** — game list updates live as directories are scanned
- **Cross-platform** — Windows (PowerShell/ffplay), macOS (afplay/ffplay), Linux (aplay/ffplay)

## Events

| Event | Triggers when |
|---|---|
| Task Start | Claude begins working |
| Task End | Claude finishes successfully |
| Error | A tool call fails |
| Notification | Claude needs your attention |
| Stop | Session ends |

## Uninstall

```bash
npx claude-sounds --uninstall
```

## Building Standalone Binaries

Requires [Bun](https://bun.sh/) installed:

```bash
bun run build          # build for current platform
bun run build:all      # build for Windows, macOS (x64+ARM), Linux (x64+ARM)
```

Output goes to `dist/claude-sounds-{platform}/` — distribute the whole folder (binary + `sounds/`).

## Requirements

- **npx**: Node.js 18+
- **Standalone binary**: nothing — just download and run
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- For packed audio extraction: internet connection (vgmstream-cli is downloaded automatically)
- For best playback with fade effects: [ffmpeg/ffplay](https://ffmpeg.org/) on PATH (falls back to native players)
