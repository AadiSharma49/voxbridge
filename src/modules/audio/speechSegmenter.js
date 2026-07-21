/**
 * SpeechSegmenter
 *
 * Connects the Silero model to the segmentation state machine: reframes
 * arbitrary capture frames into the fixed 512-sample windows Silero requires,
 * scores each one, and emits complete utterances.
 */

import { SileroVad } from './sileroVad.js';
import { VadSegmenter } from './vadSegmenter.js';
import { VAD_WINDOW_SIZE } from './vadConstants.js';

export class SpeechSegmenter {
  constructor(options = {}) {
    this.vad = new SileroVad();
    this.segmenter = new VadSegmenter(options);
    this.pending = new Float32Array(0);
    this.queue = Promise.resolve();
    this.onUtterance = null;
  }

  async load() {
    await this.vad.load();
  }

  /**
   * @param {Float32Array} frame Any length, 16 kHz mono
   * @param {(utterance: Float32Array) => void} [onUtterance]
   */
  accept(frame, onUtterance) {
    if (onUtterance) {
      this.onUtterance = onUtterance;
    }

    // Inference is async but frames arrive on the audio thread's schedule.
    // Serialising through a promise chain keeps windows strictly ordered,
    // which the recurrent model requires.
    this.queue = this.queue
      .then(() => this.#processFrame(frame))
      .catch((error) => console.error('[SpeechSegmenter] Frame failed', error));
  }

  async #processFrame(frame) {
    const combined = new Float32Array(this.pending.length + frame.length);
    combined.set(this.pending, 0);
    combined.set(frame, this.pending.length);

    let offset = 0;
    while (combined.length - offset >= VAD_WINDOW_SIZE) {
      const window = combined.slice(offset, offset + VAD_WINDOW_SIZE);
      offset += VAD_WINDOW_SIZE;

      const probability = await this.vad.probability(window);
      for (const utterance of this.segmenter.accept(window, probability)) {
        this.onUtterance?.(utterance);
      }
    }

    // Samples that did not fill a window carry over to the next frame.
    this.pending = combined.slice(offset);
  }

  /** Waits for queued frames, then emits any in-progress utterance. */
  async flush() {
    await this.queue;
    for (const utterance of this.segmenter.flush()) {
      this.onUtterance?.(utterance);
    }
    this.pending = new Float32Array(0);
  }

  reset() {
    this.segmenter.reset();
    this.vad.reset();
    this.pending = new Float32Array(0);
  }

  async destroy() {
    await this.queue.catch(() => {});
    await this.vad.destroy();
    this.reset();
  }
}
