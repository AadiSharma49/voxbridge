/**
 * Unit tests for Silero VAD input construction.
 *
 * The context handling verified here is what makes the model work at all.
 * Omitting it scores real speech at ~0.07 instead of ~1.0, with no error
 * raised, because the ONNX input axis is dynamic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVadInput,
  createEmptyContext,
  VAD_INPUT_SIZE
} from '../src/modules/audio/vadInput.js';
import {
  VAD_CONTEXT_SIZE,
  VAD_WINDOW_SIZE
} from '../src/modules/audio/vadConstants.js';

const filled = (length, value) => new Float32Array(length).fill(value);

test('input is context + window, not the window alone', () => {
  const { input } = buildVadInput(createEmptyContext(), filled(VAD_WINDOW_SIZE, 1));

  assert.equal(VAD_INPUT_SIZE, VAD_CONTEXT_SIZE + VAD_WINDOW_SIZE);
  assert.equal(input.length, VAD_INPUT_SIZE);
  assert.notEqual(input.length, VAD_WINDOW_SIZE);
});

test('context occupies the head and the window follows it', () => {
  const { input } = buildVadInput(
    filled(VAD_CONTEXT_SIZE, 0.5),
    filled(VAD_WINDOW_SIZE, -0.25)
  );

  assert.equal(input[0], 0.5);
  assert.equal(input[VAD_CONTEXT_SIZE - 1], 0.5);
  assert.equal(input[VAD_CONTEXT_SIZE], -0.25);
  assert.equal(input[VAD_INPUT_SIZE - 1], -0.25);
});

test('next context is the tail of the current window', () => {
  const window = new Float32Array(VAD_WINDOW_SIZE);
  window.forEach((_, i) => { window[i] = i; });

  const { nextContext } = buildVadInput(createEmptyContext(), window);

  assert.equal(nextContext.length, VAD_CONTEXT_SIZE);
  assert.equal(nextContext[0], VAD_WINDOW_SIZE - VAD_CONTEXT_SIZE);
  assert.equal(nextContext[VAD_CONTEXT_SIZE - 1], VAD_WINDOW_SIZE - 1);
});

test('context chains across successive windows', () => {
  const first = filled(VAD_WINDOW_SIZE, 7);
  const second = filled(VAD_WINDOW_SIZE, 9);

  const step1 = buildVadInput(createEmptyContext(), first);
  const step2 = buildVadInput(step1.nextContext, second);

  // The second input must open with audio carried over from the first window.
  assert.equal(step2.input[0], 7);
  assert.equal(step2.input[VAD_CONTEXT_SIZE], 9);
});

test('the first window sees zeroed context', () => {
  const { input } = buildVadInput(createEmptyContext(), filled(VAD_WINDOW_SIZE, 1));
  assert.equal(input[0], 0);
  assert.equal(input[VAD_CONTEXT_SIZE - 1], 0);
});

test('rejects a wrongly sized window', () => {
  assert.throws(
    () => buildVadInput(createEmptyContext(), filled(256, 0)),
    /512 samples, received 256/
  );
});

test('rejects a wrongly sized context', () => {
  assert.throws(
    () => buildVadInput(filled(32, 0), filled(VAD_WINDOW_SIZE, 0)),
    /64 samples, received 32/
  );
});
