/**
 * SileroVad
 *
 * Thin wrapper around the Silero VAD v5 ONNX model. Given a 512-sample window
 * of 16 kHz audio, returns the probability that it contains speech.
 *
 * The model is recurrent in two ways, and both must be carried between calls:
 *   - a state tensor, and
 *   - 64 samples of audio context prepended to each window.
 *
 * Verified signature (v5):
 *   inputs   input [1,576] float32, state [2,1,128] float32, sr int64 scalar
 *   outputs  output [1,1] float32 (speech probability), stateN [2,1,128]
 */

import * as ort from '/node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs';
import { VAD_SAMPLE_RATE, VAD_WINDOW_SIZE } from './vadConstants.js';
import { buildVadInput, createEmptyContext, VAD_INPUT_SIZE } from './vadInput.js';

const STATE_DIMS = [2, 1, 128];
const STATE_LENGTH = 2 * 1 * 128;

const MODEL_URL = '/assets/vad/silero_vad.onnx';
const WASM_DIR = '/node_modules/onnxruntime-web/dist/';

export class SileroVad {
  constructor() {
    this.session = null;
    this.state = null;
    this.context = null;
  }

  get isLoaded() {
    return this.session !== null;
  }

  async load() {
    if (this.session) {
      return;
    }

    ort.env.wasm.wasmPaths = WASM_DIR;
    // Single-threaded avoids needing cross-origin isolation headers on the
    // internal static server. The model is tiny; threading buys nothing here.
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';

    console.info('[SileroVad] Loading model...');
    this.session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm']
    });

    this.reset();
    console.info('[SileroVad] Model ready');
  }

  /** Clears recurrent state and audio context. Call between capture sessions. */
  reset() {
    this.state = new Float32Array(STATE_LENGTH);
    this.context = createEmptyContext();
  }

  /**
   * @param {Float32Array} window Exactly VAD_WINDOW_SIZE samples
   * @returns {Promise<number>} Speech probability in [0, 1]
   */
  async probability(window) {
    if (!this.session) {
      throw new Error('SileroVad.load() must be called before probability()');
    }

    if (window.length !== VAD_WINDOW_SIZE) {
      throw new Error(
        `SileroVad expects ${VAD_WINDOW_SIZE}-sample windows, received ${window.length}`
      );
    }

    const { input, nextContext } = buildVadInput(this.context, window);

    const results = await this.session.run({
      input: new ort.Tensor('float32', input, [1, VAD_INPUT_SIZE]),
      state: new ort.Tensor('float32', this.state, STATE_DIMS),
      // Rebuilt per call: reusing a tensor across runs is not guaranteed safe.
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [])
    });

    // Copied out: the returned buffer may alias runtime memory reused next run.
    this.state = new Float32Array(results.stateN.data);
    this.context = nextContext;

    return results.output.data[0];
  }

  async destroy() {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
    this.state = null;
    this.context = null;
  }
}
