# VoxBridge

A desktop overlay that listens to the audio playing on your computer,
transcribes it locally, and shows translated captions on top of any
application — a video call, a lecture recording, a video.

Live translated captions exist in Google Meet, Zoom and Teams, but each is
locked to a paid tier and to that vendor's own product. VoxBridge captures at
the operating-system level instead, so it works over anything that makes
sound, and the speech recognition runs on your machine rather than in someone
else's cloud.

```
System audio (loopback) ─┐
                         ├─> 16 kHz mono ─> Silero VAD ─> Whisper ─> translate ─> overlay
Microphone ──────────────┘
```

## Status

| Component | State |
|---|---|
| Electron overlay, hotkeys, compact/expanded/hidden modes | Working |
| System audio (loopback) capture — Windows, Linux | Working |
| Microphone capture | Working |
| Voice activity detection (Silero VAD v5, ONNX) | Working, tested |
| Speech recognition (Whisper via transformers.js) | Working, tested |
| Streaming partial transcripts | Working |
| Translation | Working, but via an unofficial endpoint — see Limitations |
| macOS system audio | Not supported — see Platforms |
| Packaged installer | Not built yet |

Verified end to end: `RUN_PIPELINE_TEST=1 npm test` feeds real speech through
the real VAD and the real model and asserts the transcript.

## Quick start

Requires Node.js 18+.

```bash
npm install
npm start
```

On first launch the speech model (~80 MB) downloads and is cached; later runs
work offline. Grant the screen-capture permission when prompted — that is what
gives access to system audio. The video track is requested because the API
requires it, and discarded immediately.

To caption something, play audio, then click **Start Listening**. To caption
your own voice instead, switch **Listen to** to **Microphone**.

```bash
npm test                      # unit + VAD integration tests
RUN_PIPELINE_TEST=1 npm test  # adds full audio-to-transcript test (slow)
```

## Why system audio rather than the microphone

To understand someone who speaks another language, you have to hear *them*.
The microphone captures *you*. So the default source is loopback audio — what
your speakers are playing. This is the design decision that makes the tool
work over any conferencing software instead of being tied to one.

## Platforms

| Platform | System audio | Notes |
|---|---|---|
| Windows | Supported | WASAPI loopback via Electron's display-media handler |
| Linux | Supported | PipeWire; on PulseAudio, select a `.monitor` input |
| macOS | **Not supported** | The OS exposes no loopback audio to applications. Requires a virtual device such as [BlackHole](https://github.com/ExistentialAudio/BlackHole), selected as the input source |

The capture layer reports platform capability to the UI, so macOS users are
told this up front rather than discovering it when Start silently fails.

## Shortcuts

Global:

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+Shift+M` | Start / stop capture |
| `Ctrl/Cmd+Shift+S` | Toggle mute |
| `Ctrl/Cmd+Shift+C` | Toggle compact mode |
| `Ctrl/Cmd+Shift+V` | Show / hide overlay |
| `Ctrl/Cmd+Shift+Q` | Quit |

While the overlay has focus: `Esc` hides, `Ctrl+Q` quits, `Ctrl+Shift+I`
opens DevTools.

## Privacy

**Speech recognition is local.** Audio never leaves the machine. The model
runs as WebAssembly in the app.

**Translation is not.** Transcribed text is sent to Google's public translate
endpoint. If you are captioning something sensitive, that text leaves your
device. Replacing this with a local model is the main outstanding work.

**Content protection is off by default.** Electron can hide a window from
screen capture, and the setting exists behind `VOXBRIDGE_PRIVATE_OVERLAY=1`.
It is not the default: a captioning overlay that is deliberately invisible to
the other party in a call is indistinguishable from tooling built to deceive
them, and this is an accessibility tool.

## Limitations

- **Latency.** Whisper is a batch model: it transcribes complete phrases, not
  a live stream. Streaming partials hide most of this, but final text still
  lands roughly a second after a sentence ends. Word-by-word output would
  require a different class of model.
- **Accuracy.** Ships with `whisper-tiny` for speed. `whisper-base` is in the
  fallback chain and is noticeably more accurate but slower.
- **Translation provider.** The endpoint used is unofficial and undocumented.
  It will rate-limit under sustained use, and it is not a basis for anything
  production.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the pipeline in detail, the
extension points, and the reasoning behind the main technical decisions.

## License

MIT
