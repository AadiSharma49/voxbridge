export class VoskTranscriber {
  constructor(options = {}) {
    this.modelPath = options.modelPath;
    this.sampleRate = options.sampleRate ?? 16000;
    this.model = null;
    this.recognizer = null;
    this.audioChunkCount = 0;
  }

  async verifyModelAsset() {
    const result = await window.desktopApp.checkModelAvailability(this.modelPath);
    if (!result.available) {
      throw new Error(`Model asset not found at ${this.modelPath}`);
    }
  }

  async load() {
    if (!window.Vosk) {
      throw new Error('vosk-browser is not available in the renderer.');
    }

    if (this.model) {
      return;
    }

    console.info('[VoskTranscriber] Loading model', { modelPath: this.modelPath });
    
    // vosk-browser requires web URL path, not filesystem path
    // Use HTTP path through internal static server
    console.log("Loading model via HTTP server path:", this.modelPath);
    
    this.model = await window.Vosk.createModel(this.modelPath);
    // Pass the expected sample rate explicitly so the recognizer is configured for microphone input.
    this.recognizer = new this.model.KaldiRecognizer(this.sampleRate);
    this.audioChunkCount = 0;

    console.info('[VoskTranscriber] Model loaded and recognizer created', {
      sampleRate: this.sampleRate
    });
  }

  bindEvents({ onPartialResult, onFinalResult }) {
    if (!this.recognizer) {
      throw new Error('Recognizer is not ready yet.');
    }

    this.recognizer.on('partialresult', (message) => {
      const partialText = message.result.partial || '';
      console.debug('[VoskTranscriber] Partial result', { text: partialText });
      onPartialResult?.(partialText);
    });

    this.recognizer.on('result', (message) => {
      const finalText = message.result.text || '';
      console.info('[VoskTranscriber] Final result', { text: finalText });
      onFinalResult?.(finalText);
    });
  }

  acceptAudio(inputBuffer) {
    if (!this.recognizer) {
      console.warn('[VoskTranscriber] Audio chunk dropped because recognizer is not ready');
      return;
    }

    this.audioChunkCount += 1;
    console.debug('[VoskTranscriber] Audio chunk passed to recognizer', {
      chunkNumber: this.audioChunkCount,
      sampleRate: inputBuffer.sampleRate,
      duration: inputBuffer.duration,
      frameLength: inputBuffer.length
    });

    try {
      this.recognizer.acceptWaveform(inputBuffer);
      console.debug('[VoskTranscriber] Recognizer processed audio chunk', {
        chunkNumber: this.audioChunkCount
      });
    } catch (error) {
      console.error('[VoskTranscriber] Recognizer failed to process audio chunk', {
        chunkNumber: this.audioChunkCount,
        error
      });
      throw error;
    }
  }

  async destroy() {
    if (this.recognizer) {
      await this.recognizer.remove();
      this.recognizer = null;
    }

    if (this.model) {
      await this.model.terminate();
      this.model = null;
    }

    this.audioChunkCount = 0;
  }
}
