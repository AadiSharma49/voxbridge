/**
 * TranslationService Abstract Base Class
 * 
 * Defines the interface for translation services.
 * Implementations: Google Translate, etc.
 */
export class TranslationService {
  constructor() {
    if (new.target === TranslationService) {
      throw new Error('TranslationService is abstract and cannot be instantiated directly');
    }
  }

  /**
   * Translate text from source language to target language
   * @param {string} text Text to translate
   * @param {string} sourceLanguage Language code (e.g., 'en')
   * @param {string} targetLanguage Language code (e.g., 'hi')
   * @returns {Promise<string>} Translated text
   */
  async translate(text, sourceLanguage, targetLanguage) {
    throw new Error('translate() must be implemented by subclass');
  }

  /**
   * Check if translation is supported for language pair
   * @param {string} sourceLanguage Language code
   * @param {string} targetLanguage Language code
   * @returns {Promise<boolean>} True if supported
   */
  async isSupported(sourceLanguage, targetLanguage) {
    throw new Error('isSupported() must be implemented by subclass');
  }
}

/**
 * Google Translate Service Implementation
 * 
 * Uses Google Translate API endpoint for translation.
 */
/** Bounds cache growth; captions repeat often but the stream is unbounded. */
const MAX_CACHE_ENTRIES = 500;

export class GoogleTranslateService extends TranslationService {
  constructor() {
    super();
    this.cache = new Map();
    this.inFlight = new Map();
    this.supportedLanguages = new Set([
      'auto', 'en', 'hi', 'de', 'fr', 'zh', 'es', 'pt', 'ja', 'ko', 'ar'
    ]);
    this.lastError = null;
  }

  async translate(text, sourceLanguage, targetLanguage) {
    if (!text?.trim()) {
      return '';
    }

    // Same language: no translation needed
    if (sourceLanguage === targetLanguage) {
      return text;
    }

    const normalizedText = text.trim();
    const cacheKey = `${sourceLanguage}:${targetLanguage}:${normalizedText}`;

    // Check cache
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Deduplicate in-flight requests
    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey);
    }

    const translationPromise = this._performTranslation(normalizedText, sourceLanguage, targetLanguage);
    this.inFlight.set(cacheKey, translationPromise);

    try {
      const result = await translationPromise;

      // Only cache real translations; caching a failure would make one blip
      // permanent for that line.
      if (result.ok) {
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
          this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(cacheKey, result.text);
      }

      return result.text;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /**
   * Delegates to the main process. The renderer's origin is the internal HTTP
   * server, so translating from here directly would be a cross-origin request
   * the provider does not allow.
   */
  async _performTranslation(text, sourceLanguage, targetLanguage) {
    const response = await window.desktopApp.translate({
      text,
      source: sourceLanguage,
      target: targetLanguage
    });

    if (response?.ok) {
      this.lastError = null;
      return { ok: true, text: response.text };
    }

    this.lastError = response?.error || 'Translation failed';
    console.warn('[Translation]', this.lastError);

    // Falling back to the original text keeps captions flowing: seeing the
    // source language beats seeing nothing.
    return { ok: false, text };
  }

  async isSupported(sourceLanguage, targetLanguage) {
    return this.supportedLanguages.has(sourceLanguage) && 
           this.supportedLanguages.has(targetLanguage);
  }

  clearCache() {
    this.cache.clear();
  }
}

// Create singleton instance
export const translationService = new GoogleTranslateService();
