/**
 * VoiceOutput helper tests.
 *
 * The speaking itself lives in the browser (Web Speech API) and cannot run in
 * Node, so the class is not exercised here. What IS pure and worth pinning is
 * how a target language maps to a BCP-47 tag and how the best installed voice
 * is chosen — the logic that decides whether Hindi output comes out as Hindi
 * or as garbled English.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { toBcp47, pickVoice } = await import(
  '../src/modules/audio/voiceOutput.js'
);

test('maps known language codes to BCP-47 tags', () => {
  assert.equal(toBcp47('hi'), 'hi-IN');
  assert.equal(toBcp47('en'), 'en-US');
  assert.equal(toBcp47('zh'), 'zh-CN');
});

test('passes through an unknown code unchanged', () => {
  assert.equal(toBcp47('ja'), 'ja');
});

test('picks an exact tag match first', () => {
  const voices = [
    { lang: 'en-US' },
    { lang: 'hi-IN', name: 'Hemant' },
    { lang: 'hi-Latn' }
  ];
  assert.equal(pickVoice(voices, 'hi').name, 'Hemant');
});

test('falls back to the primary subtag when no exact tag exists', () => {
  const voices = [{ lang: 'en-GB' }, { lang: 'hi-Latn', name: 'Approx' }];
  assert.equal(pickVoice(voices, 'hi').name, 'Approx');
});

test('prefers the OS-default voice among same-language options', () => {
  const voices = [
    { lang: 'en-GB', name: 'British' },
    { lang: 'en-US', name: 'American', default: true }
  ];
  // Target 'en' → en-US exists exactly, so that wins regardless of default.
  assert.equal(pickVoice(voices, 'en').name, 'American');

  // With no exact tag, the default among the language group wins.
  const noExact = [
    { lang: 'de-AT', name: 'Austrian' },
    { lang: 'de-CH', name: 'Swiss', default: true }
  ];
  assert.equal(pickVoice(noExact, 'de').name, 'Swiss');
});

test('returns null when no voice can speak the language', () => {
  const voices = [{ lang: 'en-US' }, { lang: 'fr-FR' }];
  assert.equal(pickVoice(voices, 'hi'), null);
});

test('handles an empty or missing voice list', () => {
  assert.equal(pickVoice([], 'en'), null);
  assert.equal(pickVoice(undefined, 'en'), null);
});
