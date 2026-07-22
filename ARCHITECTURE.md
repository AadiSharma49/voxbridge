# Architecture

## The pipeline

```
┌──────────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Node)                                                  │
│   • frameless always-on-top overlay window                           │
│   • internal HTTP server (renderer assets, models, wasm)             │
│   • loopback audio grant via setDisplayMediaRequestHandler           │
│   • translation egress (keeps renderer CSP at 'self')                │
│   • global shortcuts                                                 │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ contextBridge (no node integration)
┌───────────────────────────────┴──────────────────────────────────────┐
│ RENDERER                                                             │
│                                                                      │
│  AudioCapture ──── Float32Array frames, 16 kHz mono                  │
│    system loopback or microphone                                     │
│    resampling handled by AudioContext                                │
│    RMS metering for diagnostics                                      │
│         │                                                            │
│         ▼                                                            │
│  SpeechSegmenter ─── reframes to 512-sample windows                  │
│    ├─ SileroVad ──── ONNX inference, speech probability              │
│    └─ VadSegmenter ─ pure state machine, emits utterances            │
│         │                                                            │
│         ▼                                                            │
│  WhisperEngine ──── batch transcription per utterance                │
│                     + streaming partials on an interval              │
│         │                                                            │
│         ▼                                                            │
│  TranslationService ──── cache, dedupe, IPC to main                  │
│         │                                                            │
│         ▼                                                            │
│  Overlay UI ──── live captions + history                             │
└──────────────────────────────────────────────────────────────────────┘
```

## Key decisions

### Loopback audio, not the microphone

The product goal is understanding *another* person. `getUserMedia` returns
your own voice, which is the wrong signal entirely. Electron 30's
`setDisplayMediaRequestHandler` can grant `audio: 'loopback'`, which is the
audio the system is playing. A video track must be requested alongside it
because the API requires one; it is stopped and removed immediately, since
encoding screen frames nobody looks at is pure cost.

### WASM inference instead of a native sidecar

`whisper.cpp` is faster on CPU. It also means building, signing and shipping a
binary for Windows, macOS Intel, macOS ARM and Linux. For a cross-platform
target, transformers.js running as WebAssembly is one code path everywhere
with no build step. The `SpeechEngine` interface exists so a native backend
can replace it later without the renderer knowing.

### VAD is mandatory, not an optimisation

Whisper hallucinates on silence — it emits `"Thank you."`,
`"Subscribe to my channel!"`, `"[BLANK_AUDIO]"` with full confidence. Silence
must never reach it. Silero VAD gates the input, and the engine additionally
filters known hallucination patterns.

### Decision logic separated from inference

`VadSegmenter` is a pure state machine over `(window, probability)` pairs: no
ONNX, no async, no audio APIs. That makes onset padding, trailing-silence
trimming, hysteresis and force-flush unit-testable in milliseconds.
`SileroVad` handles inference. `SpeechSegmenter` composes them.

### Streaming partials over a batch model

Whisper cannot stream. To avoid a second of dead air mid-sentence, the engine
re-transcribes the in-progress utterance on an interval and emits it as a
partial, replaced by the accurate result when the phrase ends. Partials are
dropped whenever a transcription is already running — they are disposable, and
queueing them would delay the final result that actually matters.

### Ordered async over a real-time source

Audio frames arrive on the audio thread's schedule; inference is async and
slower. Frames are serialised through a promise chain, because Silero is
recurrent and out-of-order windows corrupt its state. Leftover samples that do
not fill a 512-sample window carry into the next frame.

## Extension points

Both are one-line swaps in `appState`:

```js
// src/core/SpeechEngine.js
class SpeechEngine {
  async init()
  async start(onPartial, onFinal)
  processAudio(frame)      // Float32Array, 16 kHz mono
  async stop()
  async destroy()
  getState()               // 'idle' | 'listening' | 'processing' | 'error'
}

// src/core/TranslationService.js
class TranslationService {
  async translate(text, sourceLanguage, targetLanguage)
  async isSupported(sourceLanguage, targetLanguage)
}
```

## Security

- `contextIsolation: true`, `nodeIntegration: false`; the renderer reaches the
  main process only through an explicit `contextBridge` surface.
- CSP restricts the renderer to `'self'`, plus `wasm-unsafe-eval` for the two
  WebAssembly runtimes and the Hugging Face hosts for first-run model download.
- Network egress for translation lives in the main process, so the renderer
  needs no third-party `connect-src` and cannot be turned into a request proxy
  by injected content.
- The internal HTTP server normalises and containment-checks every path
  (verified against `../`, percent-encoded, and mixed-separator traversal).

## Testing

| Layer | Approach |
|---|---|
| Segmentation logic | Unit tests over synthetic probability sequences |
| VAD input construction | Unit tests on tensor layout and context chaining |
| Silero model | Integration test: real speech, asserts detection |
| Full pipeline | Integration test: audio file to transcript, asserts words |

The Silero integration test exists because of a specific failure. Feeding the
model bare 512-sample windows — omitting the 64 samples of context v5 expects
— raises no error and returns ~0.07 for clear speech instead of ~1.0. The ONNX
input axis is dynamic, so the wrong shape is silently accepted, and the
symptom is identical to a dead microphone. No unit test would have caught it;
only real audio through the real model does. The test asserts both directions:
that speech is detected, and that removing the context breaks it.

Speech fixtures are generated from the OS text-to-speech engine
(`scripts/make-speech-fixture.js`) rather than committed recordings.

## Known gaps

- Translation depends on an unofficial endpoint. A local model (CTranslate2 +
  NLLB, or bundled LibreTranslate) would make the app genuinely offline.
- macOS system audio needs ScreenCaptureKit or a virtual audio device.
- No packaged installer yet (electron-builder).
- Electron 30 has an outstanding advisory; upgrading may also bring macOS
  system-audio support.
- `ScriptProcessorNode` is deprecated in favour of `AudioWorklet`. It is used
  because the worklet would need a separately served module and a message port
  per frame; the migration is straightforward but not free.
