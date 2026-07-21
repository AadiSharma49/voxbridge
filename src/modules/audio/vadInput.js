/**
 * Builds the input tensor data for Silero VAD v5.
 *
 * Kept separate and dependency-free so it can be unit-tested without ONNX.
 * The context handling here is what makes the model work at all: omitting it
 * produces near-zero scores for real speech with no error raised.
 */

import { VAD_CONTEXT_SIZE, VAD_WINDOW_SIZE } from './vadConstants.js';

export const VAD_INPUT_SIZE = VAD_CONTEXT_SIZE + VAD_WINDOW_SIZE;

/**
 * @param {Float32Array} context Tail of the previous input (VAD_CONTEXT_SIZE)
 * @param {Float32Array} window Current audio window (VAD_WINDOW_SIZE)
 * @returns {{ input: Float32Array, nextContext: Float32Array }}
 */
export function buildVadInput(context, window) {
  if (window.length !== VAD_WINDOW_SIZE) {
    throw new Error(
      `VAD window must be ${VAD_WINDOW_SIZE} samples, received ${window.length}`
    );
  }
  if (context.length !== VAD_CONTEXT_SIZE) {
    throw new Error(
      `VAD context must be ${VAD_CONTEXT_SIZE} samples, received ${context.length}`
    );
  }

  const input = new Float32Array(VAD_INPUT_SIZE);
  input.set(context, 0);
  input.set(window, VAD_CONTEXT_SIZE);

  return {
    input,
    nextContext: input.slice(VAD_INPUT_SIZE - VAD_CONTEXT_SIZE)
  };
}

export function createEmptyContext() {
  return new Float32Array(VAD_CONTEXT_SIZE);
}
