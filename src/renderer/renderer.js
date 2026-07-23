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
import { loadSettings, saveSettings } from '/src/modules/settings/settings.js';
import { FileCaptionSource } from '/src/modules/audio/fileCaptionSource.js';

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
  captionScroll: document.getElementById('captionScroll'),
  captionStream: document.getElementById('captionStream'),
  captionPlaceholder: document.getElementById('captionPlaceholder'),
  autoscrollToggle: document.getElementById('autoscrollToggle'),
  micBadge: document.getElementById('micBadge'),
  startButton: document.getElementById('startButton'),
  stopButton: document.getElementById('stopButton'),
  clearButton: document.getElementById('clearButton'),
  copyButton: document.getElementById('copyButton'),
  testFileButton: document.getElementById('testFileButton'),
  testFileInput: document.getElementById('testFileInput'),
  captionSmaller: document.getElementById('captionSmaller'),
  captionLarger: document.getElementById('captionLarger'),
  captionScaleValue: document.getElementById('captionScaleValue'),
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

const settings = loadSettings();

const appState = {
  isListening: false,
  isMuted: false,
  overlayMode: 'expanded',
  sourceLanguage: settings.sourceLanguage,
  targetLanguage: settings.targetLanguage,
  audioSource: settings.audioSource,
  captionScale: settings.captionScale,
  audioCapabilities: null,
  isTesting: false,
  audioCapture: new AudioCapture(),
  fileSource: new FileCaptionSource(),
  speechEngine: new WhisperEngine({
    // 'auto' lets Whisper detect the spoken language, which is the point when
    // you do not know what the other person speaks. The From selector narrows
    // it when the user does know.
    language: settings.sourceLanguage,
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

// ============ CAPTION STREAM ============
//
// Captions render as one continuous ribbon rather than discrete records:
// settled lines flow upward, and the line currently being spoken stays at the
// bottom, updating in place until it settles.

/** Lines kept in the DOM. Older ones are dropped so the app can run for hours. */
const MAX_CAPTION_LINES = 200;

/** The in-progress line, or null when nobody is speaking. */
let partialLine = null;

/** Auto-follow pauses when the user scrolls up to read something. */
let followTail = true;

function setPlaceholder(text) {
  if (!ui.captionPlaceholder) return;
  const hasLines = ui.captionStream?.childElementCount > 0;
  ui.captionPlaceholder.hidden = hasLines || !text;
  if (text) ui.captionPlaceholder.textContent = text;
}

function createCaptionLine({ primary, secondary, isPartial }) {
  const line = document.createElement('div');
  line.className = isPartial ? 'caption-line is-partial' : 'caption-line';

  const primaryEl = document.createElement('p');
  primaryEl.className = 'caption-primary';
  primaryEl.textContent = primary;
  line.appendChild(primaryEl);

  const secondaryEl = document.createElement('p');
  secondaryEl.className = 'caption-secondary';
  secondaryEl.textContent = secondary || '';
  secondaryEl.hidden = !secondary;
  line.appendChild(secondaryEl);

  return line;
}

function scrollToTail() {
  if (!followTail || !ui.captionScroll) return;
  ui.captionScroll.scrollTop = ui.captionScroll.scrollHeight;
}

function trimCaptionHistory() {
  while (ui.captionStream.childElementCount > MAX_CAPTION_LINES) {
    ui.captionStream.removeChild(ui.captionStream.firstElementChild);
  }
}

/**
 * Updates the line being spoken, creating it on first sight. Editing in place
 * rather than appending is what makes the caption read as one evolving line
 * instead of a stream of near-duplicate fragments.
 */
function showPartialCaption(text) {
  if (!ui.captionStream) return;

  if (!text) {
    clearPartialCaption();
    return;
  }

  if (!partialLine) {
    partialLine = createCaptionLine({ primary: text, isPartial: true });
    ui.captionStream.appendChild(partialLine);
  } else {
    partialLine.querySelector('.caption-primary').textContent = text;
  }

  setPlaceholder('');
  scrollToTail();
}

function clearPartialCaption() {
  partialLine?.remove();
  partialLine = null;
}

/**
 * Commits a settled line. The translation is the primary text because that is
 * what the user is here to read; the original sits beneath it for reference.
 */
function commitCaption(originalText, translatedText) {
  if (!ui.captionStream) return;

  clearPartialCaption();

  const sameLanguage = !translatedText || translatedText === originalText;
  const line = createCaptionLine({
    primary: translatedText || originalText,
    secondary: sameLanguage ? '' : originalText,
    isPartial: false
  });

  ui.captionStream.appendChild(line);
  trimCaptionHistory();
  setPlaceholder('');
  scrollToTail();

  return line;
}

function clearCaptions() {
  if (ui.captionStream) ui.captionStream.innerHTML = '';
  partialLine = null;
  followTail = true;
  updateFollowButton();
  setPlaceholder('Waiting for speech…');
}

/**
 * Copies the session as plain text. Without this a conversation is lost the
 * moment the window closes, which makes the app useless for the obvious
 * follow-on job of writing up what was said.
 */
async function copyTranscript() {
  const lines = [...ui.captionStream.querySelectorAll('.caption-line')]
    .filter((line) => !line.classList.contains('is-partial'))
    .map((line) => {
      const primary = line.querySelector('.caption-primary')?.textContent?.trim() || '';
      const secondary = line.querySelector('.caption-secondary');
      const original = secondary?.hidden ? '' : secondary?.textContent?.trim() || '';
      return original ? `${primary}\n  (${original})` : primary;
    })
    .filter(Boolean);

  if (!lines.length) {
    flashButton(ui.copyButton, 'Nothing yet');
    return;
  }

  try {
    await navigator.clipboard.writeText(lines.join('\n\n'));
    flashButton(ui.copyButton, `Copied ${lines.length} lines`);
  } catch (error) {
    console.error('[Renderer] Copy failed:', error);
    flashButton(ui.copyButton, 'Copy failed');
  }
}

/** Momentary button feedback; a silent copy leaves the user unsure it worked. */
function flashButton(button, message) {
  if (!button) return;
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = message;
  clearTimeout(button.__flashTimer);
  button.__flashTimer = setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1600);
}

function updateFollowButton() {
  if (!ui.autoscrollToggle) return;
  ui.autoscrollToggle.textContent = followTail ? 'Following' : 'Paused';
  ui.autoscrollToggle.classList.toggle('is-active', followTail);
}

// ============ LANGUAGE MANAGEMENT ============

function updateLanguageLabels() {
  if (ui.languageSummary) {
    ui.languageSummary.textContent =
      `${getLanguageLabel(appState.sourceLanguage)} to ${getLanguageLabel(appState.targetLanguage)}`;
  }
}

function persistSettings() {
  saveSettings({
    sourceLanguage: appState.sourceLanguage,
    targetLanguage: appState.targetLanguage,
    audioSource: appState.audioSource,
    captionScale: appState.captionScale
  });
}

function handleSourceLanguageChange() {
  appState.sourceLanguage = ui.sourceLanguageSelect.value;
  // Keep transcription and translation in agreement about the source language.
  appState.speechEngine.setLanguage?.(appState.sourceLanguage);
  updateLanguageLabels();
  persistSettings();
  console.log('[Renderer] Source language changed to:', appState.sourceLanguage);
}

function handleTargetLanguageChange() {
  appState.targetLanguage = ui.targetLanguageSelect.value;
  updateLanguageLabels();
  persistSettings();
  console.log('[Renderer] Target language changed to:', appState.targetLanguage);
}

/** Caption size is a readability setting, so it scales only the caption text. */
function applyCaptionScale(scale) {
  appState.captionScale = Math.min(2, Math.max(0.75, scale));
  document.documentElement.style.setProperty(
    '--caption-scale',
    String(appState.captionScale)
  );
  if (ui.captionScaleValue) {
    ui.captionScaleValue.textContent = `${Math.round(appState.captionScale * 100)}%`;
  }
  persistSettings();
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
  persistSettings();
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

/** Partials are shown untranslated: they change every few hundred ms, and
 *  translating text that is about to be replaced wastes the rate limit. */
function handlePartialTranscript(text) {
  showPartialCaption(text?.trim() || '');
}

async function handleFinalTranscript(originalText) {
  const normalizedText = originalText?.trim() || '';
  if (!normalizedText) return;

  console.log('[Renderer] Final transcript:', normalizedText);

  // Commit the original immediately so the caption never stalls waiting on the
  // network, then fill in the translation when it lands.
  const line = commitCaption(normalizedText, '');

  try {
    const translatedText = await translateText(
      normalizedText,
      appState.sourceLanguage,
      appState.targetLanguage
    );

    applyTranslation(line, normalizedText, translatedText);
  } catch (error) {
    console.error('[Renderer] Failed to translate transcript:', error);
  }
}

/** Promotes the translation to primary once it arrives. */
function applyTranslation(line, originalText, translatedText) {
  if (!line || !translatedText || translatedText === originalText) {
    return;
  }

  line.querySelector('.caption-primary').textContent = translatedText;

  const secondary = line.querySelector('.caption-secondary');
  secondary.textContent = originalText;
  secondary.hidden = false;

  scrollToTail();
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
  setPlaceholder('Listening…');
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
    setPlaceholder('Could not start capture.');
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

// ============ FILE TEST MODE ============
//
// Play a file aloud AND caption it through the real pipeline, so the app can
// be tested without any system-audio routing.

async function runFileTest(file) {
  if (appState.isTesting) return;

  if (!appState.modelReady) {
    showAudioNotice('Speech model is still loading. Give it a moment, then try the file again.');
    return;
  }

  // A running live capture would fight the file for the pipeline.
  if (appState.isListening) {
    await stopListening();
  }

  appState.isTesting = true;
  setTestingUi(true);
  setStatus('Loading file…');
  setPlaceholder('Decoding audio…');
  showAudioNotice('');

  try {
    const info = await appState.fileSource.load(file);
    console.log('[Renderer] File loaded for test', info);

    await appState.speechEngine.start(
      handlePartialTranscript,
      (text) => { handleFinalTranscript(text).catch(console.error); }
    );

    if (ui.levelRow) ui.levelRow.hidden = false;
    setStatus(`Testing: ${info.name}`);
    setPlaceholder('Listening to the file…');
    setMicActive(true);

    await appState.fileSource.start(
      (frame) => appState.speechEngine.processAudio(frame),
      {
        onLevel: updateLevelMeter,
        onEnded: () => { finishFileTest('Test finished'); }
      }
    );
  } catch (error) {
    console.error('[Renderer] File test failed:', error);
    showAudioNotice(error.message);
    await finishFileTest('Ready');
  }
}

async function finishFileTest(status) {
  if (!appState.isTesting) return;

  await appState.fileSource.stop().catch(() => {});
  await appState.speechEngine.stop().catch(() => {}); // flush the last line

  appState.isTesting = false;
  setTestingUi(false);
  if (ui.levelRow) ui.levelRow.hidden = true;
  setMicActive(false);
  setStatus(status);
}

function setTestingUi(testing) {
  if (ui.testFileButton) {
    ui.testFileButton.textContent = testing ? 'Stop test' : 'Test with a file';
    ui.testFileButton.classList.toggle('is-active', testing);
  }
  // Live controls make no sense mid-test.
  if (ui.startButton) ui.startButton.disabled = testing || appState.isMuted;
  if (ui.audioSourceSelect) ui.audioSourceSelect.disabled = testing;
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
    setPlaceholder('Muted.');
  } else {
    if (ui.startButton) ui.startButton.disabled = false;
    setStatus('Ready');
    setPlaceholder('Ready to listen.');
  }
  setMicActive(appState.isListening);
}

function clearHistory() {
  clearCaptions();
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
ui.copyButton?.addEventListener('click', () => copyTranscript().catch(console.error));

ui.testFileButton?.addEventListener('click', () => {
  if (appState.isTesting) {
    finishFileTest('Ready').catch(console.error);
  } else {
    ui.testFileInput?.click();
  }
});
ui.testFileInput?.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (file) runFileTest(file).catch(console.error);
});
ui.captionSmaller?.addEventListener('click', () => applyCaptionScale(appState.captionScale - 0.15));
ui.captionLarger?.addEventListener('click', () => applyCaptionScale(appState.captionScale + 0.15));
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

// Stop auto-following when the user scrolls up to read; resume at the bottom.
ui.captionScroll?.addEventListener('scroll', () => {
  const el = ui.captionScroll;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  if (atBottom !== followTail) {
    followTail = atBottom;
    updateFollowButton();
  }
});

ui.autoscrollToggle?.addEventListener('click', () => {
  followTail = !followTail;
  updateFollowButton();
  scrollToTail();
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

  // Reflect persisted choices in the controls before anything else, so the UI
  // never disagrees with the state the app is actually running with.
  if (ui.sourceLanguageSelect) ui.sourceLanguageSelect.value = appState.sourceLanguage;
  if (ui.targetLanguageSelect) ui.targetLanguageSelect.value = appState.targetLanguage;
  if (ui.audioSourceSelect) ui.audioSourceSelect.value = appState.audioSource;
  applyCaptionScale(appState.captionScale);

  updateLanguageLabels();
  updateFollowButton();
  setStatus('Starting');
  setModelStatus('Loading model...');
  setPlaceholder('Waiting for speech…');
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
