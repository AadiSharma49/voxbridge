/**
 * VoxBridge V2 Core Architecture
 * 
 * Clean, modular foundation for speech-to-text + translation
 * Ready for Faster-Whisper integration
 * 
 * No Vosk. No tar.gz. No legacy baggage.
 */

// ============ CORE LAYER ============
// /src/core/SpeechEngine.js
//   - SpeechEngine (abstract base)
//   - NoOpSpeechEngine (placeholder for Faster-Whisper)
//   
// /src/core/TranslationService.js
//   - TranslationService (abstract base)
//   - GoogleTranslateService (implementation)

// ============ MODULE LAYER ============
// /src/modules/audio/audioCapture.js
//   - AudioCapture class (Web Audio API)
//   - Captures microphone input at 16kHz mono

// ============ RENDERER LAYER ============
// /src/renderer/renderer.js
//   - UI event handling
//   - State management (appState)
//   - Transcript processing
//   - Translation integration
//   - Keyboard shortcuts

// ============ HOW TO INTEGRATE FASTER-WHISPER ============

/*
1. Create new file: /src/core/FastWhisperEngine.js

   export class FastWhisperEngine extends SpeechEngine {
     constructor() {
       super();
       this.worker = null; // Web Worker or native module
       this.model = null;
     }

     async init(options = {}) {
       // Load Faster-Whisper model
       // Setup worker/thread
     }

     async start(onPartial, onFinal) {
       this.onPartial = onPartial;
       this.onFinal = onFinal;
     }

     async stop() {
       // Stop listening
     }

     processAudio(audioFrame) {
       // Send audio to Whisper worker
       // Emit partials and finals via callbacks
     }

     async destroy() {
       // Cleanup worker/resources
     }

     getState() {
       return this.state; // 'idle' | 'listening' | 'processing' | 'error'
     }
   }

2. Update renderer.js line 72:
   
   // OLD:
   speechEngine: new NoOpSpeechEngine(),
   
   // NEW:
   speechEngine: new FastWhisperEngine(),

3. That's it! Everything else works unchanged.
*/

// ============ LANGUAGE SUPPORT ============
// English, Hindi, German, French, Chinese, Spanish
// (Easily extensible)

// ============ TRANSLATION SUPPORT ============
// Google Translate (via unauthenticated endpoint)
// Caching, deduplication, error handling built-in

// ============ OVERLAY MODES ============
// - expanded: Full UI with history
// - compact: Minimized pill view
// - hidden: Overlay is hidden

// ============ KEYBOARD SHORTCUTS ============
// Ctrl+Shift+M - Start/Stop microphone
// Ctrl+Shift+S - Toggle mute
// Ctrl+Shift+O - Cycle overlay modes
// Ctrl+Shift+V - Hide overlay

console.log('[VoxBridge V2] Architecture loaded');
console.log('[SpeechEngine] Current: NoOp (placeholder)');
console.log('[TranslationService] Current: Google Translate');
console.log('[Ready for Faster-Whisper integration]');
