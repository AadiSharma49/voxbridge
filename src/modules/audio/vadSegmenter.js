/**
 * VadSegmenter - pure utterance segmentation state machine.
 *
 * Whisper is a batch model: it wants a complete spoken phrase, not a stream.
 * Worse, when fed silence it hallucinates confident nonsense ("Thank you.",
 * "Subscribe to my channel!"). So audio must be cut into utterances, and
 * silence must never reach the model.
 *
 * This file holds only the decision logic over (window, probability) pairs.
 * No ONNX, no async, no audio APIs — so it can be unit-tested in plain Node.
 * See speechSegmenter.js for the piece that produces the probabilities.
 */

import { VAD_SAMPLE_RATE, VAD_WINDOW_SIZE } from './vadConstants.js';

export const DEFAULT_VAD_OPTIONS = {
  // Hysteresis: entering speech is deliberately harder than staying in it,
  // which stops brief dips mid-word from splitting an utterance.
  positiveThreshold: 0.5,
  negativeThreshold: 0.35,
  // Utterances with less voiced content than this are noise (a cough, a click).
  // Kept low enough that a single short word like "hello" still registers.
  minSpeechMs: 200,
  // Trailing silence that ends an utterance. Too short chops mid-sentence
  // pauses; too long makes captions lag behind the speaker. This is the
  // single biggest contributor to perceived latency.
  silenceMs: 420,
  // Audio retained before speech onset, so the first phoneme is not clipped.
  preRollMs: 250,
  // Silence kept at the end so the final word is not cut short.
  postRollMs: 150,
  // A monologue would otherwise never flush. Force a cut and keep going.
  maxUtteranceMs: 25000
};

export function msToWindows(ms) {
  return Math.max(1, Math.round((ms * VAD_SAMPLE_RATE) / 1000 / VAD_WINDOW_SIZE));
}

function concatWindows(windows) {
  const merged = new Float32Array(windows.length * VAD_WINDOW_SIZE);
  windows.forEach((w, i) => merged.set(w, i * VAD_WINDOW_SIZE));
  return merged;
}

export class VadSegmenter {
  constructor(options = {}) {
    this.config = { ...DEFAULT_VAD_OPTIONS, ...options };

    this.minSpeechWindows = msToWindows(this.config.minSpeechMs);
    this.silenceWindows = msToWindows(this.config.silenceMs);
    this.preRollWindows = msToWindows(this.config.preRollMs);
    this.postRollWindows = msToWindows(this.config.postRollMs);
    this.maxWindows = msToWindows(this.config.maxUtteranceMs);

    this.reset();
  }

  reset() {
    this.inSpeech = false;
    this.collected = [];
    this.preRoll = [];
    this.trailingSilence = 0;
    this.speechWindows = 0;
  }

  /**
   * Feed one window and its speech probability.
   *
   * @param {Float32Array} window VAD_WINDOW_SIZE samples
   * @param {number} probability Speech probability in [0, 1]
   * @returns {Float32Array[]} Completed utterances (usually empty)
   */
  accept(window, probability) {
    const utterances = [];

    if (!this.inSpeech) {
      if (probability >= this.config.positiveThreshold) {
        // Open the utterance with the buffered pre-roll so the onset survives.
        this.inSpeech = true;
        this.collected = [...this.preRoll, window];
        this.preRoll = [];
        this.trailingSilence = 0;
        this.speechWindows = 1;
      } else {
        this.preRoll.push(window);
        if (this.preRoll.length > this.preRollWindows) {
          this.preRoll.shift();
        }
      }
      return utterances;
    }

    this.collected.push(window);

    if (probability >= this.config.negativeThreshold) {
      this.trailingSilence = 0;
      this.speechWindows += 1;
    } else {
      this.trailingSilence += 1;
    }

    if (this.trailingSilence >= this.silenceWindows) {
      const utterance = this.#closeUtterance();
      if (utterance) utterances.push(utterance);
      return utterances;
    }

    if (this.collected.length >= this.maxWindows) {
      // Long monologue: emit what we have and stay in speech so the next
      // chunk is not treated as a fresh onset.
      const utterance = this.#emit(this.collected);
      if (utterance) utterances.push(utterance);
      this.collected = [];
      this.speechWindows = 0;
      this.trailingSilence = 0;
    }

    return utterances;
  }

  /** Ends the stream, emitting any in-progress utterance. */
  flush() {
    if (!this.inSpeech) {
      this.preRoll = [];
      return [];
    }
    const utterance = this.#closeUtterance();
    return utterance ? [utterance] : [];
  }

  #closeUtterance() {
    // Drop most of the trailing silence, keeping a short post-roll.
    const keep = Math.min(
      this.collected.length,
      Math.max(0, this.collected.length - this.trailingSilence + this.postRollWindows)
    );
    const utterance = this.#emit(this.collected.slice(0, keep));

    this.inSpeech = false;
    this.collected = [];
    this.preRoll = [];
    this.trailingSilence = 0;
    this.speechWindows = 0;

    return utterance;
  }

  #emit(windows) {
    // Judge length by actual voiced content, not total buffered audio:
    // pre-roll and trailing silence must not make a cough look like a word.
    if (this.speechWindows < this.minSpeechWindows || windows.length === 0) {
      return null;
    }
    return concatWindows(windows);
  }
}
