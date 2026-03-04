# klaudio

Add sound effects to your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Plays sounds when Claude finishes a task, sends a notification, and more.

## Quick Start

```bash
npx klaudio
```

The interactive installer walks you through:

1. **Choose scope** — install globally (`~/.claude`) or per-project (`.claude/`), or launch the **Music Player**
2. **Pick a source** — use a built-in preset, OS system sounds, scan your Steam & Epic Games library, or provide custom files
3. **Preview & assign** — listen to sounds and assign them to events (tab to switch between events)
4. **Toggle voice summary** — enable TTS to hear a spoken summary when tasks complete
5. **Install** — writes Claude Code hooks to your `settings.json`

## Sound Sources

### Built-in Presets

Ready-made sound packs (Retro 8-bit, Minimal Zen, Sci-Fi Terminal, Victory Fanfare) that work out of the box.

### System Sounds

Use your OS built-in notification sounds (Windows Media, macOS system sounds, Linux sound themes).

### Game Sound Scanner

Scans your local Steam and Epic Games libraries for audio files:

- Finds loose audio files (`.wav`, `.mp3`, `.ogg`, `.flac`, `.aac`)
- Extracts packed audio (Wwise `.wem`, FMOD `.bank`, `.fsb`) using [vgmstream](https://vgmstream.org/) (downloaded automatically)
- Extracts Unity game audio from `.resource` files (PCM decoded directly, Vorbis converted via vgmstream)
- Parses Wwise metadata (`SoundbanksInfo.json`) for descriptive filenames
- Categorizes sounds (voice, ambient, music, SFX, UI, creature) for easy browsing
- Caches extracted sounds in `~/.klaudio/cache/` for instant reuse

### Custom Files

Point to your own `.wav`/`.mp3` files.

## Music Player

Play longer game tracks (90s–4min) as background music while you code:

- **Shuffle all** — scans all cached game audio, filters by duration, picks random tracks continuously
- **Play songs from game** — pick a specific cached game and play its music
- Controls: `n` next, `space` pause/resume, `esc` back
- Background scanning — starts playing as soon as the first track is found, keeps indexing

Requires previously extracted game audio (use "Scan local games" first).

## Voice Summary (TTS)

When enabled, klaudio speaks a short summary of what Claude did after playing the task-complete sound. Uses [Piper](https://github.com/rhasspy/piper) for fast, offline neural text-to-speech (auto-downloaded on first use, ~40MB total).

- Toggle with `t` on the scope or confirm screen
- Reads the first sentence of Claude's last message
- Uses the `en_GB-alan-medium` voice (British male)
- Hooks receive data via stdin from Claude Code — no extra setup needed

## Features

- **Auto-preview** — sounds play automatically as you browse the list (toggle with `p`)
- **Multi-game selection** — pick sounds from different games, tab between events
- **Category filtering** — drill into voice, ambient, SFX, etc. when a game has enough variety
- **Type-to-filter** — start typing to narrow down long lists
- **Duration filter** — type `<10s`, `>5s`, `<=3s` etc. to filter by audio length
- **10-second clamp** — long sounds are processed with ffmpeg: silence stripped, fade out baked in
- **Background scanning** — game list updates live as directories are scanned
- **Re-apply current sounds** — re-running the installer shows your current selections with a quick re-apply option

## Events

| Event | Triggers when |
|---|---|
| Notification | Claude needs your attention |
| Task Complete | Claude finishes a response |

## Uninstall

```bash
npx klaudio --uninstall
```

## Requirements

- Node.js 18+ (Claude Code already requires this)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- For packed audio extraction: internet connection (vgmstream-cli downloaded automatically)
- For voice summaries: internet connection on first use (Piper TTS downloaded automatically)
- For best playback with fade effects: [ffmpeg/ffplay](https://ffmpeg.org/) on PATH (falls back to native players)

> **Note:** Currently only tested on Windows. macOS and Linux support is planned but not yet verified.
