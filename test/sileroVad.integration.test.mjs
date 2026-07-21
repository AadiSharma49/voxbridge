/**
 * Integration test: real speech through the real Silero model.
 *
 * This exists because a unit test could not have caught the bug it guards.
 * Feeding Silero bare 512-sample windows (no context) raises no error and
 * returns ~0.07 for clear speech, which is indistinguishable from a dead
 * microphone. Only running actual audio through the actual model reveals it.
 *
 * The fixture is Windows TTS output at 16 kHz mono. Regenerate with:
 *   node scripts/make-speech-fixture.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildVadInput,
  createEmptyContext,
  VAD_INPUT_SIZE
} from '../src/modules/audio/vadInput.js';
import { VAD_SAMPLE_RATE, VAD_WINDOW_SIZE } from '../src/modules/audio/vadConstants.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'speech-16k-mono.wav');
const modelPath = join(here, '..', 'assets', 'vad', 'silero_vad.onnx');

/** Minimal 16-bit PCM WAV reader. Returns Float32 samples in [-1, 1]. */
function readWav(path) {
  const buf = readFileSync(path);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', 'fixture is not a RIFF file');

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }

  assert.ok(fmt && data, 'fixture is missing fmt/data chunks');
  assert.equal(fmt.bits, 16, 'fixture must be 16-bit PCM');

  const samples = new Float32Array(data.length / 2 / fmt.channels);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  }

  return { samples, ...fmt };
}

async function scoreFixture(session, ort, samples, { useContext }) {
  let state = new Float32Array(256);
  let context = createEmptyContext();
  const probabilities = [];

  const windows = Math.floor(samples.length / VAD_WINDOW_SIZE);
  for (let w = 0; w < windows; w += 1) {
    const window = samples.slice(w * VAD_WINDOW_SIZE, (w + 1) * VAD_WINDOW_SIZE);

    let inputData;
    if (useContext) {
      const built = buildVadInput(context, window);
      inputData = built.input;
      context = built.nextContext;
    } else {
      inputData = window;
    }

    const results = await session.run({
      input: new ort.Tensor('float32', inputData, [1, inputData.length]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [])
    });

    probabilities.push(results.output.data[0]);
    state = new Float32Array(results.stateN.data);
  }

  return probabilities;
}

const canRun = existsSync(fixturePath) && existsSync(modelPath);

test(
  'Silero detects real speech, and does not without context',
  { skip: canRun ? false : 'fixture or model missing' },
  async () => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';

    const wav = readWav(fixturePath);
    assert.equal(wav.sampleRate, VAD_SAMPLE_RATE, 'fixture must be 16 kHz');

    const session = await ort.InferenceSession.create(
      new Uint8Array(readFileSync(modelPath))
    );

    const withContext = await scoreFixture(session, ort, wav.samples, {
      useContext: true
    });
    const peak = Math.max(...withContext);
    const detected = withContext.filter((p) => p >= 0.5).length;

    assert.ok(
      peak >= 0.9,
      `expected peak speech probability >= 0.9 on real speech, got ${peak.toFixed(3)}`
    );
    assert.ok(
      detected / withContext.length >= 0.2,
      `expected >=20% of windows to register speech, got ${
        ((detected / withContext.length) * 100).toFixed(0)
      }%`
    );

    // Guards the regression directly: without context the same audio scores
    // near zero, which is why the failure was invisible.
    const withoutContext = await scoreFixture(session, ort, wav.samples, {
      useContext: false
    });
    assert.ok(
      Math.max(...withoutContext) < 0.5,
      'sanity check failed: omitting context should score near zero'
    );
  }
);
