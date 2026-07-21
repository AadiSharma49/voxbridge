/**
 * VoxBridge - Renderer Process
 *
 * Live speech translation overlay.
 * - Audio capture (Web Audio API)
 * - Speech recognition behind the SpeechEngine interface
 * - Translation behind the TranslationService interface
 */

// Imported first: patches console so objects are readable in the terminal.
import '/src/modules/logging/consoleBridge.js';

import { AudioCapture } from '/src/modules/audio/audioCapture.js';
import { translationService } from '/src/core/TranslationService.js';
import { WhisperEngine } from '/src/core/WhisperEngine.js';

// ============ CONSTANTS ============

const DEFAULT_SOURCE_LANGUAGE = 'auto';
const DEFAULT_TARGET_LANGUAGE = 'hi';

// ============ LANGUAGE CONFIGURATION ============

const LANGUAGES = {
  auto: { code: 'auto', label: 'Auto-detect' },
  en: { code: 'en', label: 'English' },
  hi: { code: 'hi', label: 'Hindi' },
  de: { code: 'de', label: 'German' },
  fr: { code: 'fr', label: 'French' },
  zh: { code: 'zh', label: 'Chinese' },
  es: { code: 'es', label: 'Spanish' }
};

function getLanguageLabel(code) {
  return LANGUAGES[code]?.label ?? code.toUpperCase();
}

// ============ UI ELEMENTS ============

const ui = {
  overlayRoot: document.getElementById('overlayRoot'),
  statusText: document.getElementById('statusText'),
  statusDot: document.getElementById('statusDot'),
  modelText: document.getElementById('modelText'),
  liveOriginal: document.getElementById('liveOriginal'),
  liveTranslation: document.getElementById('liveTranslation'),
  historyOriginal: document.getElementById('historyOriginal'),
  historyTranslation: document.getElementById('historyTranslation'),
  micBadge: document.getElementById('micBadge'),
  startButton: document.getElementById('startButton'),
  stopButton: document.getElementById('stopButton'),
  clearButton: document.getElementById('clearButton'),
  sourceLanguageSelect: document.getElementById('sourceLanguageSelect'),
  targetLanguageSelect: document.getElementById('targetLanguageSelect'),
  audioSourceSelect: document.getElementById('audioSourceSelect'),
  audioNotice: document.getElementById('audioNotice'),
  levelRow: document.getElementById('levelRow'),
  levelFill: document.getElementById('levelFill'),
  levelValue: document.getElementById('levelValue'),
  compactPill: document.getElementById('compactPill'),
  expandToggle: document.getElementById('expandToggle'),
  compactToggle: document.getElementById('compactToggle'),
  hideButton: document.getElementById('hideButton'),
  quitButton: document.getElementById('quitButton'),
  muteButton: document.getElementById('muteButton'),
  languageSummary: document.getElementById('languageSummary'),
  pillStatusText: document.getElementById('pillStatusText')
};

// ============ APPLICATION STATE ============

const appState = {
  isListening: false,
  isMuted: false,
  overlayMode: 'expanded',
  sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  audioSource: 'system',
  audioCapabilities: null,
  audioCapture: new AudioCapture(),
  speechEngine: new WhisperEngine({
    // 'auto' lets Whisper detect the spoken language, which is the point when
    // you do not know what the other person speaks. The From selector narrows
    // it when the user does know.
    language: 'auto',
    onProgress: (progress) => reportModelProgress(progress)
  }),
  modelReady: false,
  translationCache: new Map(),
  inFlightTranslations: new Map()
};

// ============ UI UPDATE FUNCTIONS ============

function setStatus(text) {
  if (ui.statusText) ui.statusText.textContent = text;
  if (ui.pillStatusText) ui.pillStatusText.textContent = text;
}

function setModelStatus(text) {
  if (ui.modelText) ui.modelText.textContent = text;
}

function setMicActive(active) {
  const badge = ui.micBadge;
  if (!badge) return;

  badge.textContent = appState.isMuted ? 'Muted' : active ? 'Live' : 'Off';
  badge.classList.toggle('live', active && !appState.isMuted);
  badge.classList.toggle('muted', appState.isMuted);

  if (ui.statusDot) {
    ui.statusDot.classList.toggle('live', active && !appState.isMuted);
    ui.statusDot.classList.toggle('muted', appState.isMuted);
  }
}

async function setOverlayMode(mode) {
  appState.overlayMode = mode;
  if (ui.overlayRoot) {
    ui.overlayRoot.classList.toggle('is-expanded', mode === 'expanded');
    ui.overlayRoot.classList.toggle('is-compact', mode === 'compact');
  }

  if (ui.expandToggle) {
    ui.expandToggle.classList.toggle('is-active', mode === 'expanded');
  }
  if (ui.compactToggle) {
    ui.compactToggle.classList.toggle('is-active', mode === 'compact');
  }

  try {
    await window.desktopApp.setOverlayState(mode);
  } catch (error) {
    console.error('[Renderer] Failed to set overlay state:', error);
  }
}

function updateLiveDisplay(original, translated) {
  if (ui.liveOriginal) {
    ui.liveOriginal.textContent = original || 'Waiting for speech...';
  }
  if (ui.liveTranslation) {
    ui.liveTranslation.textContent = translated || 'Ready to translate';
  }
}

// ============ LANGUAGE MANAGEMENT ============

function updateLanguageLabels() {
  if (ui.languageSummary) {
    ui.languageSummary.textContent =
      `${getLanguageLabel(appState.sourceLanguage)} to ${getLanguageLabel(appState.targetLanguage)}`;
  }
}

function handleSourceLanguageChange() {
  appState.sourceLanguage = ui.sourceLanguageSelect.value;
  // Keep transcription and translation in agreement about the source language.
  appState.speechEngine.setLanguage?.(appState.sourceLanguage);
  updateLanguageLabels();
  console.log('[Renderer] Source language changed to:', appState.sourceLanguage);
}

function handleTargetLanguageChange() {
  appState.targetLanguage = ui.targetLanguageSelect.value;
  updateLanguageLabels();
  console.log('[Renderer] Target language changed to:', appState.targetLanguage);
}

// ============ INPUT LEVEL ============

/** RMS below this is treated as silence. Matches AudioCapture's threshold. */
const SILENT_RMS = 0.0008;

/** How long the input must stay silent before we explain why. */
const SILENCE_WARNING_MS = 4000;

let silenceStartedAt = null;
let silenceWarningShown = false;

function updateLevelMeter(level) {
  if (!ui.levelFill || !ui.levelValue) return;

  // RMS is tiny for speech, so a linear bar would barely move.
  const normalized = Math.min(1, Math.sqrt(level / 0.15));
  ui.levelFill.style.width = `${Math.round(normalized * 100)}%`;
  ui.levelFill.classList.toggle('is-speech', level >= SILENT_RMS * 8);

  const now = performance.now();

  if (level < SILENT_RMS) {
    ui.levelValue.textContent = 'silent';
    silenceStartedAt ??= now;

    if (!silenceWarningShown && now - silenceStartedAt >= SILENCE_WARNING_MS) {
      silenceWarningShown = true;
      warnAboutSilence();
    }
    return;
  }

  ui.levelValue.textContent = `${Math.round(normalized * 100)}%`;
  silenceStartedAt = null;

  if (silenceWarningShown) {
    silenceWarningShown = false;
    showAudioNotice('');
  }
}

function resetSilenceTracking() {
  silenceStartedAt = null;
  silenceWarningShown = false;
}

/**
 * The most common setup mistake: speaking into the mic while the app is
 * capturing system audio. Both produce "nothing happens", so say which.
 */
function warnAboutSilence() {
  if (appState.audioSource === 'system') {
    showAudioNotice(
      'No sound is reaching VoxBridge. System audio captures what your ' +
      'SPEAKERS are playing — not your microphone. Play a video, or switch ' +
      '"Listen to" to Microphone (me) to caption your own voice.'
    );
  } else {
    showAudioNotice(
      'No sound is reaching VoxBridge. Check the microphone is not muted ' +
      'and is selected as the default input device.'
    );
  }
}

// ============ MODEL LOADING ============

/**
 * The speech model is ~80MB on first run. Without visible progress the app
 * looks frozen, so surface it and keep Start disabled until it is ready.
 */
function reportModelProgress(progress) {
  if (!progress?.total) return;

  const percent = Math.round(progress.percent ?? (progress.loaded / progress.total) * 100);
  const mb = (progress.total / 1024 / 1024).toFixed(0);
  setModelStatus(`Downloading ${percent}% (${mb}MB)`);
}

async function prepareSpeechEngine() {
  setModelStatus('Loading model...');
  setStatus('Preparing');
  if (ui.startButton) ui.startButton.disabled = true;

  try {
    await appState.speechEngine.init();
    appState.modelReady = true;
    setModelStatus('Whisper ready');
    setStatus('Ready');
    if (ui.startButton) ui.startButton.disabled = appState.isMuted;
  } catch (error) {
    console.error('[Renderer] Speech engine failed to load:', error);
    appState.modelReady = false;
    setModelStatus('Model failed');
    setStatus('Error');
    showAudioNotice(
      `Speech model could not load: ${error.message}. ` +
      'The first run needs internet access to download it.'
    );
  }
}

// ============ AUDIO SOURCE ============

function showAudioNotice(message) {
  if (!ui.audioNotice) return;
  ui.audioNotice.textContent = message || '';
  ui.audioNotice.hidden = !message;
}

/**
 * System audio is the source that makes this app useful, but macOS does not
 * expose it. Surface that up front rather than letting Start fail silently.
 */
function refreshAudioNotice() {
  const capabilities = appState.audioCapabilities;
  if (!capabilities) return;

  if (appState.audioSource === 'system' && capabilities.loopback === 'unsupported') {
    showAudioNotice(capabilities.note);
  } else {
    showAudioNotice('');
  }
}

function handleAudioSourceChange() {
  appState.audioSource = ui.audioSourceSelect.value;
  refreshAudioNotice();
  console.log('[Renderer] Audio source changed to:', appState.audioSource);
}

// ============ TRANSLATION ============

async function translateText(text, sourceLanguage, targetLanguage) {
  if (!text?.trim()) return '';

  const normalizedText = text.trim();
  const cacheKey = `${sourceLanguage}:${targetLanguage}:${normalizedText}`;

  if (appState.translationCache.has(cacheKey)) {
    return appState.translationCache.get(cacheKey);
  }

  // Deduplicate in-flight requests for the same line.
  if (appState.inFlightTranslations.has(cacheKey)) {
    return appState.inFlightTranslations.get(cacheKey);
  }

  const promise = translationService.translate(
    normalizedText,
    sourceLanguage,
    targetLanguage
  ).then(result => {
    appState.translationCache.set(cacheKey, result);
    appState.inFlightTranslations.delete(cacheKey);
    return result;
  }).catch(error => {
    console.error('[Renderer] Translation error:', error);
    appState.inFlightTranslations.delete(cacheKey);
    return normalizedText;
  });

  appState.inFlightTranslations.set(cacheKey, promise);
  return promise;
}

// ============ TRANSCRIPT HANDLING ============

function handlePartialTranscript(text) {
  const normalizedText = text?.trim() || '';
  if (!normalizedText) return;

  // Partials update the live line only; they are never translated or stored.
  updateLiveDisplay(normalizedText, 'Listening...');
}

async function handleFinalTranscript(originalText) {
  const normalizedText = originalText?.trim() || '';
  if (!normalizedText) return;

  console.log('[Renderer] Final transcript:', normalizedText);

  updateLiveDisplay(normalizedText, 'Translating...');

  try {
    const translatedText = await translateText(
      normalizedText,
      appState.sourceLanguage,
      appState.targetLanguage
    );

    updateLiveDisplay(normalizedText, translatedText);
    addToHistory(normalizedText, translatedText);
  } catch (error) {
    console.error('[Renderer] Failed to handle transcript:', error);
    updateLiveDisplay(normalizedText, 'Translation error');
  }
}

function addToHistory(originalText, translatedText) {
  const originalEntry = document.createElement('div');
  originalEntry.className = 'history-item';
  const originalP = document.createElement('p');
  originalP.className = 'history-original';
  originalP.textContent = originalText;
  originalEntry.appendChild(originalP);
  ui.historyOriginal.appendChild(originalEntry);

  const translatedEntry = document.createElement('div');
  translatedEntry.className = 'history-item';
  const translatedP = document.createElement('p');
  translatedP.className = 'history-translation';
  translatedP.textContent = translatedText;
  translatedEntry.appendChild(translatedP);
  ui.historyTranslation.appendChild(translatedEntry);

  scrollHistoryToBottom();
}

function scrollHistoryToBottom() {
  for (const column of [ui.historyOriginal, ui.historyTranslation]) {
    const scroller = column?.parentElement;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }
}

// ============ SPEECH ENGINE CONTROL ============

async function startListening() {
  if (appState.isListening || appState.isMuted) {
    return;
  }

  if (!appState.modelReady) {
    showAudioNotice('Speech model is still loading. Give it a moment.');
    return;
  }

  console.log('[Renderer] Starting listening...');
  if (ui.startButton) ui.startButton.disabled = true;
  if (ui.sourceLanguageSelect) ui.sourceLanguageSelect.disabled = true;
  if (ui.audioSourceSelect) ui.audioSourceSelect.disabled = true;
  setStatus('Listening');
  updateLiveDisplay('Listening for speech...', '');
  showAudioNotice('');

  try {
    await appState.speechEngine.start(
      handlePartialTranscript,
      (text) => { handleFinalTranscript(text).catch(console.error); }
    );

    resetSilenceTracking();
    appState.audioCapture.onLevel = updateLevelMeter;
    if (ui.levelRow) ui.levelRow.hidden = false;

    await appState.audioCapture.start(
      (audioFrame) => { appState.speechEngine.processAudio(audioFrame); },
      { sourceType: appState.audioSource }
    );

    appState.isListening = true;
    if (ui.stopButton) ui.stopButton.disabled = false;
    setMicActive(true);
  } catch (error) {
    console.error('[Renderer] Failed to start listening:', error);
    // Leave any partially-opened stream or engine behind us before retrying.
    await appState.audioCapture.stop().catch(() => {});
    await appState.speechEngine.stop().catch(() => {});
    setStatus('Error');
    updateLiveDisplay('Could not start capture', '');
    showAudioNotice(error.message);
    if (ui.startButton) ui.startButton.disabled = false;
    if (ui.sourceLanguageSelect) ui.sourceLanguageSelect.disabled = false;
    if (ui.audioSourceSelect) ui.audioSourceSelect.disabled = false;
  }
}

async function stopListening() {
  if (!appState.isListening) {
    return;
  }

  console.log('[Renderer] Stopping listening...');
  await appState.audioCapture.stop();
  await appState.speechEngine.stop();

  if (ui.levelRow) ui.levelRow.hidden = true;
  resetSilenceTracking();

  appState.isListening = false;
  if (ui.startButton) ui.startButton.disabled = appState.isMuted;
  if (ui.stopButton) ui.stopButton.disabled = true;
  if (ui.sourceLanguageSelect) ui.sourceLanguageSelect.disabled = false;
  if (ui.audioSourceSelect) ui.audioSourceSelect.disabled = false;
  setStatus(appState.isMuted ? 'Muted' : 'Ready');
  setMicActive(false);
}

async function toggleListening() {
  if (appState.isListening) {
    await stopListening();
  } else {
    await startListening();
  }
}

async function toggleMute() {
  appState.isMuted = !appState.isMuted;
  if (ui.muteButton) {
    ui.muteButton.classList.toggle('is-active', appState.isMuted);
    ui.muteButton.setAttribute('aria-label', appState.isMuted ? 'Unmute' : 'Mute');
  }

  if (appState.isMuted) {
    await stopListening();
    if (ui.startButton) ui.startButton.disabled = true;
    setStatus('Muted');
    updateLiveDisplay('Muted', '');
  } else {
    if (ui.startButton) ui.startButton.disabled = false;
    setStatus('Ready');
    updateLiveDisplay('Ready to listen', '');
  }
  setMicActive(appState.isListening);
}

function clearHistory() {
  if (ui.historyOriginal) ui.historyOriginal.innerHTML = '';
  if (ui.historyTranslation) ui.historyTranslation.innerHTML = '';
  updateLiveDisplay('Ready to listen', '');
  appState.translationCache.clear();
  appState.inFlightTranslations.clear();
}

async function hideOverlay() {
  try {
    await window.desktopApp.setOverlayState('hidden');
  } catch (error) {
    console.error('[Renderer] Failed to hide overlay:', error);
  }
}

async function quitApp() {
  // Release the mic/loopback stream before the process goes away, so the OS
  // capture indicator does not linger.
  await appState.audioCapture.stop().catch(() => {});
  try {
    await window.desktopApp.quitApp();
  } catch (error) {
    console.error('[Renderer] Failed to quit:', error);
  }
}

function cycleOverlayMode() {
  const modes = ['expanded', 'compact'];
  const nextIndex = (modes.indexOf(appState.overlayMode) + 1) % modes.length;
  setOverlayMode(modes[nextIndex]).catch(console.error);
}

// ============ KEYBOARD SHORTCUTS ============
// Note: these only fire when the overlay has focus. The global (system-wide)
// equivalents are registered in electron/main.js and take precedence.

document.addEventListener('keydown', (e) => {
  // Esc hides the overlay. It is frameless and skips the taskbar, so without
  // an obvious way out the window can feel stuck.
  if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey) {
    hideOverlay();
    return;
  }

  // Ctrl+Q quits, but only while the overlay has focus. Registering it
  // globally would hijack the shortcut from every other app.
  if (e.ctrlKey && !e.shiftKey && e.key.toUpperCase() === 'Q') {
    e.preventDefault();
    quitApp().catch(console.error);
    return;
  }

  if (!e.ctrlKey || !e.shiftKey) return;

  switch (e.key.toUpperCase()) {
    case 'M':
      toggleListening().catch(console.error);
      break;
    case 'S':
      toggleMute().catch(console.error);
      break;
    case 'O':
      cycleOverlayMode();
      break;
    case 'V':
      hideOverlay();
      break;
    default:
      break;
  }
});

// ============ EVENT LISTENERS ============

ui.startButton?.addEventListener('click', () => startListening().catch(console.error));
ui.stopButton?.addEventListener('click', () => stopListening().catch(console.error));
ui.muteButton?.addEventListener('click', () => toggleMute().catch(console.error));
ui.clearButton?.addEventListener('click', clearHistory);
ui.hideButton?.addEventListener('click', hideOverlay);
ui.quitButton?.addEventListener('click', () => quitApp().catch(console.error));

ui.expandToggle?.addEventListener('click', () => {
  setOverlayMode('expanded').catch(console.error);
});

ui.compactToggle?.addEventListener('click', () => {
  setOverlayMode('compact').catch(console.error);
});

ui.compactPill?.addEventListener('click', () => {
  setOverlayMode('expanded').catch(console.error);
});

ui.sourceLanguageSelect?.addEventListener('change', handleSourceLanguageChange);
ui.targetLanguageSelect?.addEventListener('change', handleTargetLanguageChange);
ui.audioSourceSelect?.addEventListener('change', handleAudioSourceChange);

window.desktopApp.onOverlayShortcut((command) => {
  switch (command) {
    case 'toggle-compact':
      cycleOverlayMode();
      break;
    case 'show-expanded':
      setOverlayMode('expanded').catch(console.error);
      break;
    case 'toggle-listen':
      toggleListening().catch(console.error);
      break;
    case 'hidden':
      appState.overlayMode = 'hidden';
      ui.overlayRoot?.classList.remove('is-expanded', 'is-compact');
      break;
    case 'toggle-mute':
      toggleMute().catch(console.error);
      break;
    default:
      break;
  }
});

window.addEventListener('beforeunload', () => {
  appState.audioCapture.stop().catch(console.error);
  appState.speechEngine.destroy().catch(console.error);
});

// ============ INITIALIZATION ============

async function init() {
  console.log('[Renderer] VoxBridge initializing...');

  updateLanguageLabels();
  setStatus('Starting');
  setModelStatus('Loading model...');
  updateLiveDisplay('Waiting for speech...', 'Ready to translate');
  setMicActive(false);

  try {
    const version = await window.desktopApp.getVersion();
    console.log('[Renderer] App version:', version);
  } catch (error) {
    console.error('[Renderer] Failed to get app version:', error);
  }

  try {
    appState.audioCapabilities = await window.desktopApp.getAudioCapabilities();
    console.log('[Renderer] Audio capabilities:', appState.audioCapabilities);
    refreshAudioNotice();
  } catch (error) {
    console.error('[Renderer] Failed to read audio capabilities:', error);
  }

  try {
    await setOverlayMode('expanded');
  } catch (error) {
    console.error('[Renderer] Failed to set initial overlay mode:', error);
  }

  // Loaded up front rather than on first Start, so the download happens while
  // the user is still reading the UI instead of after they ask for captions.
  await prepareSpeechEngine();
}

init().catch(console.error);
