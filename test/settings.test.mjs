/**
 * Settings persistence tests.
 *
 * The important property is not that values round-trip — it is that nothing
 * stored on disk can stop the app starting. A corrupt, partial, or outdated
 * entry must degrade to defaults rather than throw.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// localStorage does not exist in Node; the module only needs get/set/remove.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

globalThis.localStorage = new MemoryStorage();

const { loadSettings, saveSettings, DEFAULT_SETTINGS } = await import(
  '../src/modules/settings/settings.js'
);

const KEY = 'voxbridge.settings.v1';

function reset() {
  globalThis.localStorage = new MemoryStorage();
}

test('returns defaults when nothing is stored', () => {
  reset();
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

test('round-trips saved settings', () => {
  reset();
  saveSettings({
    sourceLanguage: 'fr',
    targetLanguage: 'en',
    audioSource: 'mic',
    captionScale: 1.3
  });

  const loaded = loadSettings();
  assert.equal(loaded.sourceLanguage, 'fr');
  assert.equal(loaded.targetLanguage, 'en');
  assert.equal(loaded.audioSource, 'mic');
  assert.equal(loaded.captionScale, 1.3);
});

test('corrupt JSON falls back to defaults instead of throwing', () => {
  reset();
  globalThis.localStorage.setItem(KEY, '{not valid json');

  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

test('invalid values are rejected per-field, valid ones kept', () => {
  reset();
  globalThis.localStorage.setItem(KEY, JSON.stringify({
    sourceLanguage: 'de',
    audioSource: 'telepathy',   // not a real source
    captionScale: 99            // outside the allowed range
  }));

  const loaded = loadSettings();
  assert.equal(loaded.sourceLanguage, 'de', 'valid field should survive');
  assert.equal(loaded.audioSource, DEFAULT_SETTINGS.audioSource);
  assert.equal(loaded.captionScale, DEFAULT_SETTINGS.captionScale);
});

test('a stored non-object is ignored', () => {
  reset();
  globalThis.localStorage.setItem(KEY, '"just a string"');

  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

test('unknown keys are not persisted', () => {
  reset();
  saveSettings({ sourceLanguage: 'es', somethingElse: 'should not persist' });

  const stored = JSON.parse(globalThis.localStorage.getItem(KEY));
  assert.equal(stored.sourceLanguage, 'es');
  assert.ok(!('somethingElse' in stored));
});

test('a failing storage backend does not throw', () => {
  reset();
  globalThis.localStorage.setItem = () => {
    throw new Error('QuotaExceededError');
  };

  // Saving must not break captioning just because storage is unavailable.
  assert.doesNotThrow(() => saveSettings({ sourceLanguage: 'hi' }));
});
