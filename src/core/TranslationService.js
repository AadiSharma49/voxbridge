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
export class GoogleTranslateService extends TranslationService {
  constructor() {
    super();
    this.cache = new Map();
    this.inFlight = new Map();
    this.endpoint = 'https://translate.googleapis.com/translate_a/single';
    this.supportedLanguages = new Set(['en', 'hi', 'de', 'fr', 'zh', 'es', 'pt', 'ja', 'ko', 'ar']);
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
      this.cache.set(cacheKey, result);
      return result;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  async _performTranslation(text, sourceLanguage, targetLanguage) {
    try {
      const params = new URLSearchParams({
        client: 'gtx',
        sl: sourceLanguage,
        tl: targetLanguage,
        dt: 't',
        q: text
      });

      const response = await fetch(`${this.endpoint}?${params}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      if (!response.ok) {
        console.error('[GoogleTranslateService] API error:', response.status);
        return text;
      }

      const data = await response.json();
      const translated = data[0]?.[0]?.[0];

      if (!translated) {
        console.warn('[GoogleTranslateService] Empty translation result');
        return text;
      }

      console.log('[GoogleTranslateService] Translated:', { sourceLanguage, targetLanguage });
      return translated;
    } catch (error) {
      console.error('[GoogleTranslateService] Translation failed:', error);
      return text;
    }
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
