/**
 * End-to-end pipeline test: audio in, transcript out.
 *
 * Runs real speech through the real VAD segmentation logic and the real
 * Whisper model, with no microphone and no UI. This is the test that proves
 * the product works; everything else verifies a single link in the chain.
 *
 * Deliberately mirrors what the renderer does:
 *   frames -> Silero scoring -> VadSegmenter -> utterance -> Whisper -> text
 *
 * Slow (loads a speech model) and network-dependent on first run, so it is
 * opt-in: RUN_PIPELINE_TEST=1 npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { VadSegmenter } from '../src/modules/audio/vadSegmenter.js';
import { buildVadInput, createEmptyContext } from '../src/modules/audio/vadInput.js';
import { VAD_SAMPLE_RATE, VAD_WINDOW_SIZE } from '../src/modules/audio/vadConstants.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'speech-16k-mono.wav');
const vadModelPath = join(here, '..', 'assets', 'vad', 'silero_vad.onnx');

/** The phrase spoken in the fixture, used to score transcription accuracy. */
const EXPECTED_WORDS = [
  'hello', 'this', 'is', 'a', 'test', 'of', 'the', 'voice', 'activity', 'detector'
];

function readWav(path) {
  const buf = readFileSync(path);
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

  const samples = new Float32Array(data.length / 2 / fmt.channels);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  }
  return { samples, ...fmt };
}

const enabled = process.env.RUN_PIPELINE_TEST === '1';
const ready = existsSync(fixturePath) && existsSync(vadModelPath);

test(
  'speech audio produces a transcript through the full pipeline',
  {
    skip: !enabled
      ? 'set RUN_PIPELINE_TEST=1 to run (loads a speech model)'
      : !ready
        ? 'fixture or VAD model missing'
        : false
  },
  async (t) => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';

    const { pipeline } = await import('@huggingface/transformers');

    const wav = readWav(fixturePath);
    assert.equal(wav.sampleRate, VAD_SAMPLE_RATE);

    // ---- Stage 1: VAD segmentation -------------------------------------
    const session = await ort.InferenceSession.create(
      new Uint8Array(readFileSync(vadModelPath))
    );

    const segmenter = new VadSegmenter();
    let state = new Float32Array(256);
    let context = createEmptyContext();
    const utterances = [];

    // Feed in 4096-sample frames, exactly as AudioCapture delivers them.
    const FRAME = 4096;
    let pending = new Float32Array(0);

    for (let f = 0; f < wav.samples.length; f += FRAME) {
      const frame = wav.samples.slice(f, f + FRAME);
      const combined = new Float32Array(pending.length + frame.length);
      combined.set(pending, 0);
      combined.set(frame, pending.length);

      let offset = 0;
      while (combined.length - offset >= VAD_WINDOW_SIZE) {
        const window = combined.slice(offset, offset + VAD_WINDOW_SIZE);
        offset += VAD_WINDOW_SIZE;

        const built = buildVadInput(context, window);
        context = built.nextContext;

        const results = await session.run({
          input: new ort.Tensor('float32', built.input, [1, built.input.length]),
          state: new ort.Tensor('float32', state, [2, 1, 128]),
          sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [])
        });

        state = new Float32Array(results.stateN.data);
        utterances.push(...segmenter.accept(window, results.output.data[0]));
      }
      pending = combined.slice(offset);
    }
    utterances.push(...segmenter.flush());

    t.diagnostic(`VAD produced ${utterances.length} utterance(s)`);
    assert.ok(utterances.length > 0, 'VAD produced no utterances from real speech');

    const totalSeconds = utterances.reduce(
      (sum, u) => sum + u.length / VAD_SAMPLE_RATE, 0
    );
    assert.ok(
      totalSeconds > 0.5,
      `expected >0.5s of speech audio, got ${totalSeconds.toFixed(2)}s`
    );

    // ---- Stage 2: transcription ----------------------------------------
    const transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny',
      { dtype: { encoder_model: 'q8', decoder_model_merged: 'fp32' } }
    );

    const transcripts = [];
    for (const utterance of utterances) {
      const result = await transcriber(utterance, {
        task: 'transcribe',
        language: 'en',
        no_repeat_ngram_size: 3,
        condition_on_previous_text: false
      });
      const text = (result?.text || '').trim();
      if (text) transcripts.push(text);
    }

    const combined = transcripts.join(' ').toLowerCase();
    t.diagnostic(`transcript: ${JSON.stringify(combined)}`);

    assert.ok(combined.length > 0, 'pipeline produced no transcript text');

    // Whisper-tiny is not exact, so require most of the phrase rather than all.
    const found = EXPECTED_WORDS.filter((word) =>
      new RegExp(`\\b${word}\\b`).test(combined)
    );
    t.diagnostic(`matched ${found.length}/${EXPECTED_WORDS.length}: ${found.join(', ')}`);

    assert.ok(
      found.length >= EXPECTED_WORDS.length * 0.5,
      `transcript matched only ${found.length}/${EXPECTED_WORDS.length} expected ` +
      `words. Got: ${JSON.stringify(combined)}`
    );
  }
);
