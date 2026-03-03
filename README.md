# clonk

Add sound effects to your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Plays sounds when Claude finishes a task, sends a notification, and more.

## Quick Start

```bash
npx clonk
```

The interactive installer walks you through:

1. **Choose scope** — install globally (`~/.claude`) or per-project (`.claude/`)
2. **Pick a source** — use a built-in preset, scan your local games for sounds, or provide custom files
3. **Preview & assign** — listen to sounds and assign them to events
4. **Install** — writes Claude Code hooks to your `settings.json`

## Sound Sources

### Built-in Presets

Ready-made sound packs (Retro 8-bit, Minimal Zen, Sci-Fi Terminal, Victory Fanfare) that work out of the box.

### Game Sound Scanner

Scans your Steam and Epic Games libraries for audio files:

- Finds loose audio files (`.wav`, `.mp3`, `.ogg`, `.flac`, `.aac`)
- Extracts packed audio (Wwise `.wem`, FMOD `.bank`, `.fsb`) using [vgmstream](https://vgmstream.org/) (downloaded automatically)
- Parses Wwise metadata (`SoundbanksInfo.json`) for descriptive filenames
- Categorizes sounds (voice, ambient, music, SFX, UI, creature) for easy browsing
- Caches extracted sounds in `~/.clonk/cache/` for instant reuse

### Custom Files

Point to your own `.wav`/`.mp3` files.

## Features

- **Auto-preview** — sounds play automatically as you browse the list (toggle with `p`)
- **Category filtering** — drill into voice, ambient, SFX, etc. when a game has enough variety
- **Type-to-filter** — start typing to narrow down long lists
- **10-second clamp** — long sounds are processed with ffmpeg: silence stripped, fade out baked in
- **Background scanning** — game list updates live as directories are scanned
- **Cross-platform** — Windows (PowerShell/ffplay), macOS (afplay/ffplay), Linux (aplay/ffplay)

## Events

| Event | Triggers when |
|---|---|
| Task Complete | Claude finishes a response |
| Notification | Claude needs your attention |

## Uninstall

```bash
npx clonk --uninstall
```

## Building Standalone Binaries

Requires [Bun](https://bun.sh/):

```bash
bun run build          # build for current platform
bun run build:all      # build for Windows, macOS (x64+ARM), Linux (x64+ARM)
```

Output goes to `dist/clonk-{platform}/` — distribute the whole folder (binary + `sounds/`).

## Requirements

- Node.js 18+ (Claude Code already requires this)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- For packed audio extraction: internet connection (vgmstream-cli is downloaded automatically)
- For best playback with fade effects: [ffmpeg/ffplay](https://ffmpeg.org/) on PATH (falls back to native players)
