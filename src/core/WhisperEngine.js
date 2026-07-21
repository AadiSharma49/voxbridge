/**
 * WhisperEngine
 *
 * SpeechEngine implementation backed by Whisper running as WASM in the
 * renderer via transformers.js.
 *
 * Why WASM instead of a native whisper.cpp sidecar: this app targets Windows,
 * macOS and Linux. A native sidecar means building, signing and shipping a
 * binary per platform. WASM is one code path everywhere, with no build step.
 * It is slower than native on CPU, but the SpeechEngine interface means a
 * native backend can replace this later without touching the renderer.
 *
 * Whisper is a batch model, so it cannot consume a raw stream. Audio arrives
 * as VAD-segmented utterances (see modules/audio/speechSegmenter.js) and each
 * complete utterance is transcribed in one shot.
 */

import { SpeechEngine } from './SpeechEngine.js';
import { SpeechSegmenter } from '../modules/audio/speechSegmenter.js';
// Bundled by scripts/build-vendor.js: the published ES module contains bare
// specifiers that browsers cannot resolve.
import { pipeline, env } from '/src/vendor/transformers.bundle.mjs';

// transformers.js bundles its own onnxruntime build, which is a different
// version from the one SileroVad uses. Each must point at its own wasm files.
const TRANSFORMERS_WASM_DIR =
  '/node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/';

/**
 * Model/precision combinations to try, cheapest first.
 *
 * Fully-q8 whisper-base fails to load on some onnxruntime builds: the decoder's
 * embed_tokens quantization is missing a scale tensor
 * ("Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale").
 * Keeping the encoder quantized while running the decoder at fp32 avoids that
 * while still saving most of the download, and full fp32 is the safe fallback.
 */
const MODEL_CANDIDATES = [
  {
    model: 'onnx-community/whisper-base',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'fp32' }
  },
  { model: 'onnx-community/whisper-base', dtype: 'fp32' },
  { model: 'Xenova/whisper-base', dtype: 'fp32' }
];

/** Whisper emits these when handed silence or noise. Never show them. */
const HALLUCINATION_PATTERNS = [
  /^\s*$/,
  /^[\s.,!?\-–—…]*$/,
  /^\s*\[.*\]\s*$/,          // [BLANK_AUDIO], [MUSIC], [Applause]
  /^\s*\(.*\)\s*$/,          // (upbeat music)
  /^\s*♪.*♪?\s*$/,
  /thank you( very much)?[.!]?$/i,
  /thanks for watching[.!]?$/i,
  /^\s*subscribe/i,
  /^\s*you\s*$/i,
  /^\s*bye[.!]?\s*$/i
];

function isHallucination(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export class WhisperEngine extends SpeechEngine {
  /**
   * @param {{ model?: string, dtype?: string, language?: string }} options
   */
  constructor(options = {}) {
    super();

    // An explicit model/dtype overrides the fallback chain entirely.
    this.candidates = options.model
      ? [{ model: options.model, dtype: options.dtype || 'fp32' }]
      : MODEL_CANDIDATES;
    this.activeConfig = null;
    this.language = options.language || 'auto';

    this.state = 'idle';
    this.transcriber = null;
    this.segmenter = new SpeechSegmenter(options.vad);

    this.onPartial = null;
    this.onFinal = null;

    // Utterances are transcribed one at a time; running several Whisper passes
    // concurrently on CPU makes every one of them slower.
    this.transcribeQueue = Promise.resolve();
    this.onProgress = options.onProgress || null;
  }

  getState() {
    return this.state;
  }

  async init() {
    if (this.transcriber) {
      return;
    }

    this.state = 'loading';

    env.backends.onnx.wasm.wasmPaths = TRANSFORMERS_WASM_DIR;
    env.backends.onnx.wasm.numThreads = 1;
    // Models come from the Hugging Face hub on first run and are then served
    // from the browser cache, so later runs work offline.
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    try {
      await this.segmenter.load();
    } catch (error) {
      this.state = 'error';
      throw new Error(`Could not load voice detector: ${error.message}`);
    }

    const failures = [];

    for (const candidate of this.candidates) {
      const label = `${candidate.model} (${JSON.stringify(candidate.dtype)})`;
      console.info('[WhisperEngine] Loading', label);

      try {
        this.transcriber = await pipeline(
          'automatic-speech-recognition',
          candidate.model,
          {
            dtype: candidate.dtype,
            device: 'wasm',
            progress_callback: (progress) => {
              if (progress?.status === 'progress' && progress.file) {
                this.onProgress?.({
                  file: progress.file,
                  loaded: progress.loaded,
                  total: progress.total,
                  percent: progress.progress
                });
              }
            }
          }
        );

        this.activeConfig = candidate;
        this.state = 'idle';
        console.info('[WhisperEngine] Ready:', label);
        return;
      } catch (error) {
        console.warn(`[WhisperEngine] ${label} failed: ${error.message}`);
        failures.push(`${label}: ${error.message}`);
        this.transcriber = null;
      }
    }

    this.state = 'error';
    console.error('[WhisperEngine] All model candidates failed', failures);
    throw new Error(`Could not load any speech model. Tried ${failures.length} configurations.`);
  }

  async start(onPartial, onFinal) {
    if (!this.transcriber) {
      throw new Error('WhisperEngine.init() must be called before start()');
    }

    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.segmenter.reset();
    this.state = 'listening';
  }

  /**
   * @param {Float32Array} frame 16 kHz mono audio
   */
  processAudio(frame) {
    if (this.state !== 'listening') {
      return;
    }

    this.segmenter.accept(frame, (utterance) => {
      this.#enqueueTranscription(utterance);
    });
  }

  #enqueueTranscription(utterance) {
    const seconds = (utterance.length / 16000).toFixed(1);
    this.onPartial?.(`Transcribing ${seconds}s...`);

    this.transcribeQueue = this.transcribeQueue
      .then(() => this.#transcribe(utterance))
      .catch((error) => console.error('[WhisperEngine] Transcription failed', error));
  }

  async #transcribe(utterance) {
    const startedAt = performance.now();

    const options = {
      task: 'transcribe',
      // Omitting the language lets Whisper detect it, which matters when you
      // do not know what language the other person will speak.
      ...(this.language !== 'auto' ? { language: this.language } : {}),
      // Whisper repeats itself when it loses the thread; this bounds the damage.
      no_repeat_ngram_size: 3,
      condition_on_previous_text: false
    };

    const result = await this.transcriber(utterance, options);
    const text = (result?.text || '').trim();
    const elapsed = Math.round(performance.now() - startedAt);

    if (isHallucination(text)) {
      console.debug('[WhisperEngine] Discarded hallucination:', JSON.stringify(text));
      this.onPartial?.('');
      return;
    }

    console.info('[WhisperEngine] Transcribed', {
      ms: elapsed,
      audioSeconds: +(utterance.length / 16000).toFixed(1),
      text
    });

    this.onFinal?.(text);
  }

  setLanguage(language) {
    this.language = language || 'auto';
  }

  async stop() {
    if (this.state !== 'listening') {
      return;
    }

    this.state = 'processing';
    // Emit whatever was mid-utterance when capture stopped, then drain.
    await this.segmenter.flush();
    await this.transcribeQueue.catch(() => {});
    this.state = 'idle';
  }

  async destroy() {
    await this.stop().catch(() => {});
    await this.segmenter.destroy().catch(() => {});

    if (this.transcriber?.dispose) {
      await this.transcriber.dispose().catch(() => {});
    }

    this.transcriber = null;
    this.state = 'idle';
  }
}
