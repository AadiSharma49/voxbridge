/**
 * Unit tests for the VAD segmentation state machine.
 *
 * Run: node --test test/
 *
 * These drive the segmenter with synthetic probability sequences rather than
 * real audio, so the boundary logic is verified deterministically without
 * loading the ONNX model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { VadSegmenter, msToWindows } from '../src/modules/audio/vadSegmenter.js';
import { VAD_WINDOW_SIZE } from '../src/modules/audio/vadConstants.js';

const WINDOW_MS = 32; // 512 samples at 16 kHz

/** A window whose samples carry a marker value, so ordering can be asserted. */
function markedWindow(marker) {
  return new Float32Array(VAD_WINDOW_SIZE).fill(marker);
}

/**
 * Feeds a script of [probability, count] pairs and collects emitted utterances.
 * Each window is marked with its global index.
 */
function drive(segmenter, script) {
  const emitted = [];
  let index = 0;

  for (const [probability, count] of script) {
    for (let i = 0; i < count; i += 1) {
      const results = segmenter.accept(markedWindow(index), probability);
      emitted.push(...results);
      index += 1;
    }
  }

  return { emitted, totalWindows: index };
}

const windowsFor = (ms) => Math.ceil(ms / WINDOW_MS);

test('emits nothing while the input is pure silence', () => {
  const segmenter = new VadSegmenter();
  const { emitted } = drive(segmenter, [[0.01, windowsFor(5000)]]);

  assert.equal(emitted.length, 0);
});

test('emits one utterance for a single speech burst followed by silence', () => {
  const segmenter = new VadSegmenter();
  const { emitted } = drive(segmenter, [
    [0.01, windowsFor(1000)],
    [0.9, windowsFor(1500)],
    [0.01, windowsFor(1500)]
  ]);

  assert.equal(emitted.length, 1);
  assert.ok(emitted[0] instanceof Float32Array);
});

test('separates two bursts split by a long pause into two utterances', () => {
  const segmenter = new VadSegmenter();
  const { emitted } = drive(segmenter, [
    [0.9, windowsFor(1000)],
    [0.01, windowsFor(1500)],
    [0.9, windowsFor(1000)],
    [0.01, windowsFor(1500)]
  ]);

  assert.equal(emitted.length, 2);
});

test('does not split on a short mid-sentence pause', () => {
  // 300ms gap is below the 600ms silence threshold, so this is one utterance.
  const segmenter = new VadSegmenter();
  const { emitted } = drive(segmenter, [
    [0.9, windowsFor(800)],
    [0.01, windowsFor(300)],
    [0.9, windowsFor(800)],
    [0.01, windowsFor(1500)]
  ]);

  assert.equal(emitted.length, 1);
});

test('rejects a burst too short to be speech', () => {
  // ~100ms of voiced content is below the 250ms minimum: a click, not a word.
  const segmenter = new VadSegmenter();
  const { emitted } = drive(segmenter, [
    [0.01, windowsFor(500)],
    [0.9, windowsFor(100)],
    [0.01, windowsFor(1500)]
  ]);

  assert.equal(emitted.length, 0);
});

test('includes pre-roll so the speech onset is not clipped', () => {
  const segmenter = new VadSegmenter({ preRollMs: 250 });
  const silenceWindows = windowsFor(1000);

  const { emitted } = drive(segmenter, [
    [0.01, silenceWindows],
    [0.9, windowsFor(1000)],
    [0.01, windowsFor(1500)]
  ]);

  assert.equal(emitted.length, 1);

  // Windows are marked with their index; the first sample of the utterance
  // should predate the first speech window by the pre-roll length.
  const firstMarker = emitted[0][0];
  const expectedPreRoll = msToWindows(250);
  assert.equal(firstMarker, silenceWindows - expectedPreRoll);
});

test('trims trailing silence but keeps a short post-roll', () => {
  const segmenter = new VadSegmenter({ silenceMs: 600, postRollMs: 150 });
  const speechWindows = windowsFor(1000);

  const { emitted } = drive(segmenter, [
    [0.9, speechWindows],
    [0.01, windowsFor(3000)]
  ]);

  assert.equal(emitted.length, 1);

  const lengthWindows = emitted[0].length / VAD_WINDOW_SIZE;
  // Speech plus post-roll, not the full 3s of silence that followed.
  const expected = speechWindows + msToWindows(150);
  assert.ok(
    Math.abs(lengthWindows - expected) <= 1,
    `expected ~${expected} windows, got ${lengthWindows}`
  );
});

test('force-flushes a monologue that never pauses', () => {
  const segmenter = new VadSegmenter({ maxUtteranceMs: 2000 });
  const { emitted } = drive(segmenter, [[0.9, windowsFor(7000)]]);

  // 7s of unbroken speech with a 2s cap must produce multiple utterances
  // rather than buffering forever.
  assert.ok(emitted.length >= 3, `expected >= 3 utterances, got ${emitted.length}`);
});

test('hysteresis keeps an utterance open through a probability dip', () => {
  // 0.4 sits between negativeThreshold (0.35) and positiveThreshold (0.5):
  // enough to stay in speech, not enough to start it.
  const segmenter = new VadSegmenter();
  const { emitted } = drive(segmenter, [
    [0.9, windowsFor(500)],
    [0.4, windowsFor(1000)],
    [0.9, windowsFor(500)],
    [0.01, windowsFor(1500)]
  ]);

  assert.equal(emitted.length, 1);
});

test('a dip below negativeThreshold does not start an utterance', () => {
  const segmenter = new VadSegmenter();
  const { emitted } = drive(segmenter, [[0.4, windowsFor(5000)]]);

  assert.equal(emitted.length, 0);
});

test('flush emits an utterance still in progress', () => {
  const segmenter = new VadSegmenter();
  drive(segmenter, [[0.9, windowsFor(1000)]]);

  const flushed = segmenter.flush();
  assert.equal(flushed.length, 1);

  // Flushing twice must not emit the same audio again.
  assert.equal(segmenter.flush().length, 0);
});

test('flush during silence emits nothing', () => {
  const segmenter = new VadSegmenter();
  drive(segmenter, [[0.01, windowsFor(1000)]]);

  assert.equal(segmenter.flush().length, 0);
});

test('default silence gate tolerates a natural speaking pause', () => {
  // Regression guard. Lowering silenceMs to chase latency once dropped it
  // below a normal mid-sentence pause, which split sentences into fragments
  // and made the captions read worse despite arriving sooner.
  const segmenter = new VadSegmenter();

  for (const pauseMs of [200, 300, 400]) {
    segmenter.reset();
    const { emitted } = drive(segmenter, [
      [0.9, windowsFor(700)],
      [0.01, windowsFor(pauseMs)],
      [0.9, windowsFor(700)],
      [0.01, windowsFor(1500)]
    ]);

    assert.equal(
      emitted.length,
      1,
      `a ${pauseMs}ms pause should not end an utterance, got ${emitted.length} lines`
    );
  }
});

test('peek returns nothing during silence', () => {
  const segmenter = new VadSegmenter();
  drive(segmenter, [[0.01, windowsFor(1000)]]);

  assert.equal(segmenter.peek(), null);
});

test('peek exposes the utterance in progress without ending it', () => {
  const segmenter = new VadSegmenter();
  drive(segmenter, [[0.9, windowsFor(800)]]);

  const partial = segmenter.peek();
  assert.ok(partial instanceof Float32Array);
  assert.ok(partial.length > 0);

  // Peeking must not consume: the final result still arrives on flush.
  assert.equal(segmenter.flush().length, 1);
});

test('peek grows as speech continues', () => {
  const segmenter = new VadSegmenter();

  drive(segmenter, [[0.9, windowsFor(500)]]);
  const first = segmenter.peek().length;

  drive(segmenter, [[0.9, windowsFor(500)]]);
  const second = segmenter.peek().length;

  assert.ok(second > first, `expected growth, got ${first} then ${second}`);
});

test('peek stays null until there is enough voiced content', () => {
  // Below the 200ms minimum, so there is nothing worth transcribing yet.
  const segmenter = new VadSegmenter({ minSpeechMs: 500 });
  drive(segmenter, [[0.9, windowsFor(100)]]);

  assert.equal(segmenter.peek(), null);
});

test('reset clears in-progress state', () => {
  const segmenter = new VadSegmenter();
  drive(segmenter, [[0.9, windowsFor(1000)]]);

  segmenter.reset();
  assert.equal(segmenter.flush().length, 0);
});

test('utterance audio preserves window order', () => {
  const segmenter = new VadSegmenter({ preRollMs: 0, postRollMs: 0 });
  const { emitted } = drive(segmenter, [
    [0.9, windowsFor(1000)],
    [0.01, windowsFor(1500)]
  ]);

  assert.equal(emitted.length, 1);

  const utterance = emitted[0];
  const markers = [];
  for (let i = 0; i < utterance.length; i += VAD_WINDOW_SIZE) {
    markers.push(utterance[i]);
  }

  const ascending = markers.every((m, i) => i === 0 || m === markers[i - 1] + 1);
  assert.ok(ascending, `markers not contiguous/ascending: ${markers.slice(0, 10)}`);
});
