/**
 * SpeechEngine Abstract Base Class
 * 
 * Defines the interface for speech recognition engines.
 * Implementations: Vosk (deprecated), Faster-Whisper (planned), etc.
 */
export class SpeechEngine {
  constructor() {
    if (new.target === SpeechEngine) {
      throw new Error('SpeechEngine is abstract and cannot be instantiated directly');
    }
  }

  /**
   * Initialize the speech engine
   * @param {Object} options Configuration options
   * @returns {Promise<void>}
   */
  async init(options = {}) {
    throw new Error('init() must be implemented by subclass');
  }

  /**
   * Start listening to audio input
   * @param {Function} onPartial Callback for partial results: (text) => void
   * @param {Function} onFinal Callback for final results: (text) => void
   * @returns {Promise<void>}
   */
  async start(onPartial, onFinal) {
    throw new Error('start() must be implemented by subclass');
  }

  /**
   * Stop listening to audio input
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('stop() must be implemented by subclass');
  }

  /**
   * Process audio frame for transcription
   * @param {Float32Array} audioFrame Audio data
   * @returns {void}
   */
  processAudio(audioFrame) {
    throw new Error('processAudio() must be implemented by subclass');
  }

  /**
   * Cleanup and destroy the engine
   * @returns {Promise<void>}
   */
  async destroy() {
    throw new Error('destroy() must be implemented by subclass');
  }

  /**
   * Get the current state of the engine
   * @returns {string} 'idle' | 'listening' | 'processing' | 'error'
   */
  getState() {
    throw new Error('getState() must be implemented by subclass');
  }
}

/**
 * No-Op Speech Engine (Placeholder for Faster-Whisper)
 * 
 * Serves as a placeholder until Faster-Whisper is integrated.
 * Returns mock transcriptions for testing.
 */
export class NoOpSpeechEngine extends SpeechEngine {
  constructor() {
    super();
    this.state = 'idle';
    this.onPartial = null;
    this.onFinal = null;
  }

  async init(options = {}) {
    console.log('[NoOpSpeechEngine] Initialized (placeholder for Faster-Whisper)');
    this.state = 'idle';
  }

  async start(onPartial, onFinal) {
    console.log('[NoOpSpeechEngine] Starting transcription (placeholder)');
    this.state = 'listening';
    this.onPartial = onPartial;
    this.onFinal = onFinal;
  }

  async stop() {
    console.log('[NoOpSpeechEngine] Stopped');
    this.state = 'idle';
  }

  processAudio(audioFrame) {
    // Placeholder: In real implementation, send to Faster-Whisper
    if (this.state === 'listening') {
      // Simulate partial result every 500ms
      if (Math.random() > 0.95) {
        this.onPartial?.('Listening...');
      }
    }
  }

  async destroy() {
    console.log('[NoOpSpeechEngine] Destroyed');
    this.state = 'idle';
  }

  getState() {
    return this.state;
  }
}
