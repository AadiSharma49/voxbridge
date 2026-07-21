# VoxBridge VoiceLayer

A live speech translation overlay. It captures the audio coming out of your
speakers, transcribes it, and shows translated captions on top of whatever app
you are using — a video call, a video, or a phone on speaker.

The goal is to make cross-language conversation work without paying for a
Workspace/Zoom/Teams tier, and without your conversations leaving your machine.

## Status

This project is mid-build. What works today:

| Area | Status |
|---|---|
| Electron overlay shell, hotkeys, compact/expanded/hidden modes | ✅ Working |
| System audio (loopback) capture on Windows / Linux | ✅ Working |
| Microphone capture | ✅ Working |
| Speech-to-text | ❌ **Not implemented** — `NoOpSpeechEngine` is a placeholder |
| Translation | ⚠️ Works, but via an unofficial endpoint that will rate-limit |
| macOS system audio | ⚠️ Requires a virtual audio device (BlackHole) |

**Speech recognition is the next milestone.** Until `WhisperEngine` lands, the
app captures audio and displays placeholder text.

## Architecture

```
System audio (loopback) ──┐
                          ├─> 16kHz mono ─> VAD ─> Whisper ─> Translation ─> Overlay
Microphone ───────────────┘
```

Two interfaces keep the pieces swappable:

- `SpeechEngine` (`src/core/SpeechEngine.js`) — `init / start / processAudio / stop / destroy`
- `TranslationService` (`src/core/TranslationService.js`) — `translate / isSupported`

Swapping an implementation means changing one line in `appState`. See
`ARCHITECTURE.md`.

## Why system audio, not the microphone

To understand someone who speaks another language, you need to hear *them*.
The microphone captures *your* voice. So the default source is loopback audio —
the sound your speakers are playing. This is what makes the app work over any
call software rather than being locked to one vendor.

Platform support:

| Platform | System audio | Notes |
|---|---|---|
| Windows | ✅ Native | WASAPI loopback |
| Linux | ✅ Native | PipeWire; on PulseAudio pick a `.monitor` input |
| macOS | ❌ | Needs [BlackHole](https://github.com/ExistentialAudio/BlackHole) or ScreenCaptureKit |

## Privacy

Speech-to-text is intended to run **locally** — audio never leaves the machine.

**Translation currently does not.** Finalized transcript lines are sent to
Google's public translate endpoint. Until local translation lands (see roadmap),
treat transcribed text as leaving your device. This is the single biggest gap
between what this app should be and what it is.

## Install

Requires Node.js 18+.

```bash
npm install
npm start
```

On first start, allow the screen-capture and microphone permissions when
prompted. Screen capture permission is what grants access to system audio; the
video track is requested and immediately discarded.

## Shortcuts

Global (work from any app):

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+Shift+M` | Start / stop capture |
| `Ctrl/Cmd+Shift+S` | Toggle mute |
| `Ctrl/Cmd+Shift+C` | Toggle compact mode |
| `Ctrl/Cmd+Shift+V` | Show / hide overlay |
| `Ctrl/Cmd+Enter` | Show / hide overlay (recreates window if closed) |
| `Ctrl/Cmd+Shift+Q` | **Quit** |

While the overlay has focus:

| Shortcut | Action |
|---|---|
| `Esc` | Hide overlay |
| `Ctrl/Cmd+Q` | Quit |
| `Ctrl/Cmd+Shift+I` | Toggle DevTools |

The overlay is frameless and hidden from the taskbar, so use the **Quit**
button or `Ctrl+Shift+Q` to close it. (`Ctrl+Esc` is not used — Windows
reserves it for the Start menu.)

## Roadmap

1. **Silero VAD** — segment audio into utterances (also gates Whisper's
   tendency to hallucinate text during silence).
2. **`WhisperEngine`** — whisper.cpp sidecar. `tiny` for fast partials, `small`
   for accurate finals. Auto-detects the spoken language, which matters when you
   don't know what language the other person will use.
3. **Local translation** — CTranslate2 + NLLB-200, replacing the Google
   endpoint. Makes the app genuinely offline and private.
4. **Packaging** — electron-builder, models downloaded on first run rather than
   bundled.

## Note on Vosk

Earlier versions used Vosk for offline speech-to-text. It was dropped because it
requires one model per language chosen in advance, which conflicts with
auto-detecting an unknown speaker's language, and it does not scale past a
handful of languages. If `assets/models/` still contains `vosk-model-*`
directories from a previous checkout, they are unused and can be deleted
(~613 MB).
