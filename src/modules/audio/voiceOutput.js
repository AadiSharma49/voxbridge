/**
 * VoiceOutput
 *
 * Speaks the translated line aloud, so you HEAR the new language instead of
 * only reading it. This is the "voice, not just captions" layer.
 *
 * It uses the browser's built-in speech synthesis (Web Speech API): no model
 * to download, no network, and it runs in real time on any machine — which is
 * exactly why it works on this laptop when voice CLONING does not.
 *
 * Honest limitation: this is a synthetic narrator voice, NOT the original
 * speaker's own voice. Making the original person's voice speak the new
 * language (voice cloning) needs a GPU and is a separate, heavier path.
 *
 * Whether a given language can actually be spoken depends on the voices the
 * operating system has installed. On Windows, extra languages (e.g. Hindi) may
 * need to be added under Settings › Time & Language › Speech. `hasVoiceFor`
 * lets the UI warn instead of emitting garbled output.
 */

// Our short language codes → the BCP-47 tags speech engines expect.
const BCP47 = {
  hi: 'hi-IN',
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  zh: 'zh-CN',
  es: 'es-ES',
  ru: 'ru-RU',
  auto: 'en-US'
};

/** Maps a VoxBridge language code to a BCP-47 tag. Pure, so it is testable. */
export function toBcp47(lang) {
  return BCP47[lang] || lang;
}

/**
 * Picks the best installed voice for a language code from a list of voices.
 * Prefers an exact tag match (hi-IN), then any voice whose primary subtag
 * matches (hi-*), then null. Pure, so it is testable without a browser.
 * @param {Array<{lang?: string, default?: boolean}>} voices
 * @param {string} lang - VoxBridge code like 'hi'
 */
export function pickVoice(voices, lang) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const tag = toBcp47(lang).toLowerCase();
  const primary = tag.split('-')[0];

  const exact = voices.find((v) => v.lang?.toLowerCase() === tag);
  if (exact) return exact;

  const sameLanguage = voices.filter(
    (v) => v.lang?.toLowerCase().split('-')[0] === primary
  );
  if (sameLanguage.length) {
    // A voice the OS marks default for that language is the safest pick.
    return sameLanguage.find((v) => v.default) || sameLanguage[0];
  }
  return null;
}

export class VoiceOutput {
  constructor({ enabled = false, lang = 'hi', rate = 1 } = {}) {
    this.enabled = enabled;
    this.lang = lang;
    this.rate = rate;

    this.supported =
      typeof window !== 'undefined' && 'speechSynthesis' in window;
    this.synth = this.supported ? window.speechSynthesis : null;
    this.voices = [];

    // Fires (true) when speech begins and (false) when the queue drains, so the
    // caller can duck the original audio while the dub is talking.
    this.onSpeakingChange = null;
    this._speaking = false;
    this._outstanding = 0;

    if (this.supported) {
      this._loadVoices();
      // Chromium loads voices asynchronously; refresh when they arrive.
      this.synth.addEventListener?.('voiceschanged', () => this._loadVoices());
    }
  }

  get isSupported() {
    return this.supported;
  }

  _loadVoices() {
    this.voices = this.synth?.getVoices?.() || [];
  }

  /** True if the OS has a voice that can speak this language. */
  hasVoiceFor(lang) {
    if (!this.supported) return false;
    if (!this.voices.length) this._loadVoices();
    return pickVoice(this.voices, lang) !== null;
  }

  setLang(lang) {
    this.lang = lang;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  /** Queues a line to be spoken. No-op when disabled or unsupported. */
  speak(text) {
    if (!this.enabled || !this.supported) return;
    const clean = text?.trim();
    if (!clean) return;

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = toBcp47(this.lang);
    const voice = pickVoice(this.voices, this.lang);
    if (voice) utterance.voice = voice;
    utterance.rate = this.rate;

    utterance.onstart = () => this._setSpeaking(true);
    utterance.onend = () => this._release();
    utterance.onerror = () => this._release();

    this._outstanding += 1;
    // Multiple speak() calls queue naturally; the engine plays them in order.
    this.synth.speak(utterance);
  }

  _release() {
    this._outstanding = Math.max(0, this._outstanding - 1);
    if (this._outstanding === 0) this._setSpeaking(false);
  }

  _setSpeaking(value) {
    if (value === this._speaking) return;
    this._speaking = value;
    this.onSpeakingChange?.(value);
  }

  /** Drops anything queued or in progress (e.g. when the user hits Stop). */
  cancel() {
    if (this.supported) this.synth.cancel();
    this._outstanding = 0;
    this._setSpeaking(false);
  }
}
