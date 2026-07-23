/**
 * Persisted user preferences.
 *
 * Re-picking your languages and audio source on every launch is the kind of
 * friction that stops people using a tool daily, so choices are remembered.
 *
 * Stored in localStorage: it is per-user, survives restarts, and needs no IPC.
 * Reads are defensive because a corrupt or partial entry must never prevent
 * the app from starting.
 */

// Bumped to v2 when the defaults changed (English target + voice on by
// default). Bumping resets stored preferences to the new defaults, which is
// what makes those defaults reach people who already ran an earlier build.
const STORAGE_KEY = 'voxbridge.settings.v2';

export const DEFAULT_SETTINGS = {
  sourceLanguage: 'auto',
  // English by default: it is the one voice every OS ships with, so the spoken
  // dub works out of the box. Other targets need their voice installed first.
  targetLanguage: 'en',
  captionScale: 1,
  speakTranslation: true
};

/** Guards against a stored value that is no longer valid in this build. */
const VALIDATORS = {
  sourceLanguage: (v) => typeof v === 'string' && v.length > 0 && v.length <= 8,
  targetLanguage: (v) => typeof v === 'string' && v.length > 0 && v.length <= 8,
  captionScale: (v) => typeof v === 'number' && v >= 0.75 && v <= 2,
  speakTranslation: (v) => typeof v === 'boolean'
};

export function loadSettings() {
  let stored = null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn('[Settings] Could not read stored settings:', error.message);
  }

  const settings = { ...DEFAULT_SETTINGS };
  if (!stored || typeof stored !== 'object') {
    return settings;
  }

  for (const [key, validate] of Object.entries(VALIDATORS)) {
    if (key in stored && validate(stored[key])) {
      settings[key] = stored[key];
    }
  }

  return settings;
}

export function saveSettings(settings) {
  try {
    const toStore = {};
    for (const key of Object.keys(VALIDATORS)) {
      if (key in settings) toStore[key] = settings[key];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch (error) {
    // A full or blocked store must not break captioning.
    console.warn('[Settings] Could not persist settings:', error.message);
  }
}
