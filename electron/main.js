const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = '127.0.0.1';
let mainWindow;
let staticServer;
let overlayState = 'expanded';
let isQuitting = false;

// Minimal content types so the local renderer can load HTML, CSS, JS and model files.
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  // Browsers refuse to evaluate an ES module served as octet-stream, which is
  // how onnxruntime-web's .mjs bundles would otherwise arrive.
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.gz': 'application/gzip'
};

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function createStaticServer() {
  const projectRoot = path.join(__dirname, '..');

  return new Promise((resolve, reject) => {
    staticServer = http.createServer((request, response) => {
      const requestPath = request.url === '/' ? '/src/renderer/index.html' : request.url;
      const safePath = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(projectRoot, safePath);

      // Keep the internal server constrained to the app directory.
      if (!filePath.startsWith(projectRoot)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }

      fs.readFile(filePath, (error, data) => {
        if (error) {
          response.writeHead(error.code === 'ENOENT' ? 404 : 500);
          response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
          return;
        }

        response.writeHead(200, { 'Content-Type': getMimeType(filePath) });
        response.end(data);
      });
    });

    staticServer.once('error', reject);
    staticServer.listen(0, HOST, () => {
      const { port } = staticServer.address();
      resolve(port);
    });
  });
}

async function createWindow() {
  const port = await createStaticServer();
  const windowBounds = getOverlayBounds('expanded');

  // Create a full‑screen, frameless overlay window.
  mainWindow = new BrowserWindow({
    ...windowBounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // When the window is closed (e.g., user clicks the X), clear the reference so a new one can be created later.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Forward renderer logs to the terminal. Model loading and transcription all
  // happen in the renderer, so without this a failure is invisible unless
  // DevTools happens to be open. Set VOXBRIDGE_QUIET=1 to silence.
  if (!process.env.VOXBRIDGE_QUIET) {
    const levels = ['debug', 'info', 'warn', 'error'];
    mainWindow.webContents.on('console-message', (_event, level, message) => {
      console.log(`[renderer:${levels[level] || level}] ${message}`);
    });
  }

  // The menu bar is hidden, so there is otherwise no way to open DevTools.
  // Scoped to the focused window rather than a global shortcut.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isToggle =
      input.type === 'keyDown' &&
      input.control &&
      input.shift &&
      input.key.toUpperCase() === 'I';

    if (isToggle) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setMenuBarVisibility(false);

  // Content protection hides the window from screen capture and screen sharing.
  // It is off by default: this is an accessibility tool, and a captioning
  // overlay that is deliberately invisible to the other party in a call is
  // indistinguishable from tooling built to deceive them. Opt in explicitly
  // with VOXBRIDGE_PRIVATE_OVERLAY=1 if you need it for your own privacy.
  if (process.env.VOXBRIDGE_PRIVATE_OVERLAY === '1') {
    mainWindow.setContentProtection(true);
    console.log('[Main] Content protection enabled: window hidden from screen capture');
  }

  await mainWindow.loadURL(`http://${HOST}:${port}`);
}

function getOverlayBounds(state) {
  const { screen } = require('electron');
  const { workArea } = screen.getPrimaryDisplay();

  if (state === 'compact') {
    // A subtitle bar across the bottom of the screen, where captions belong
    // and where they cover the least of whatever you are watching. The old
    // 320x88 corner pill had no room for text, which made the one mode you
    // would actually use during a call the one mode that showed nothing.
    const width = Math.round(Math.min(Math.max(workArea.width * 0.62, 640), 1180));
    const height = 170;

    return {
      width,
      height,
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + workArea.height - height - 56
    };
  }

  const width = Math.round(Math.min(Math.max(workArea.width * 0.52, 760), 1120));
  const height = Math.round(Math.min(Math.max(workArea.height * 0.74, 620), workArea.height - 80));

  return {
    width,
    height,
    x: workArea.x + workArea.width - width - 32,
    y: workArea.y + Math.max(32, Math.round((workArea.height - height) * 0.18))
  };
}

function applyOverlayState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, state: overlayState };
  }

  overlayState = state;

  if (state === 'hidden') {
    mainWindow.hide();
    return { ok: true, state };
  }

  const bounds = getOverlayBounds(state);
  mainWindow.setResizable(true);
  mainWindow.setMinimumSize(state === 'expanded' ? 640 : 420, state === 'expanded' ? 460 : 120);
  mainWindow.setBounds(bounds, true);
  mainWindow.showInactive();
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  return { ok: true, state };
}

function sendOverlayCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay:shortcut', command);
  }
}

/**
 * Quits, falling back to a hard exit if the renderer will not shut down.
 * Without the fallback a stuck renderer leaves an invisible, frameless,
 * taskbar-less window the user cannot close by any normal means.
 */
function quitApplication() {
  isQuitting = true;

  const forceExit = setTimeout(() => {
    console.warn('[Main] Graceful quit timed out, forcing exit');
    app.exit(0);
  }, 3000);
  forceExit.unref?.();

  app.quit();
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+V', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    if (!mainWindow.isVisible() || overlayState === 'hidden') {
      applyOverlayState('expanded');
      sendOverlayCommand('show-expanded');
    } else {
      applyOverlayState('hidden');
      sendOverlayCommand('hidden');
    }
  });

  globalShortcut.register('CommandOrControl+Shift+C', () => {
    sendOverlayCommand('toggle-compact');
  });

  // Ctrl/Cmd+Shift+M toggles capture (start/stop listening).
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    sendOverlayCommand('toggle-listen');
  });

  // Shortcut: Ctrl/Cmd+Enter toggles the overlay visibility.
  // - If the window does not exist (closed), it creates a new one.
  // - If the overlay is hidden, it shows it (expanded).
  // - If the overlay is visible, it hides it.
  globalShortcut.register('CommandOrControl+Enter', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      // Re‑create the window when it was closed.
      await createWindow();
      return;
    }

    if (overlayState === 'hidden' || !mainWindow.isVisible()) {
      // Show the overlay in expanded mode.
      applyOverlayState('expanded');
      sendOverlayCommand('show-expanded');
    } else {
      // Hide the overlay.
      applyOverlayState('hidden');
      sendOverlayCommand('hidden');
    }
  });

  // Shortcut to quit the application (Ctrl+Shift+Q / Cmd+Shift+Q).
  // The window is frameless and skips the taskbar, so this is the escape
  // hatch when the overlay is hidden or unresponsive.
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    console.log('[Main] Quit shortcut pressed');
    quitApplication();
  });

  // Shortcut to minimize the overlay window (Ctrl+Shift+N / Cmd+Shift+N).
  globalShortcut.register('CommandOrControl+Shift+N', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  // Additional example shortcut: Ctrl+Shift+R to reload the renderer (useful during development).
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
  });
}

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:quit', () => quitApplication());
ipcMain.handle('overlay:set-state', (_, state) => applyOverlayState(state));
/**
 * Translation runs in the main process, not the renderer.
 *
 * Two reasons: the renderer's origin is the internal HTTP server, so a direct
 * fetch to a translation host is a cross-origin request the provider does not
 * permit; and keeping network egress here lets the renderer's CSP stay locked
 * to 'self'.
 */
ipcMain.handle('translation:translate', async (_, payload = {}) => {
  const text = (payload.text || '').trim();
  const source = payload.source || 'auto';
  const target = payload.target || 'en';

  if (!text) {
    return { ok: true, text: '' };
  }

  if (source === target) {
    return { ok: true, text, provider: 'passthrough' };
  }

  const params = new URLSearchParams({
    client: 'gtx',
    sl: source,
    tl: target,
    dt: 't',
    q: text
  });

  try {
    const response = await fetch(
      `https://translate.googleapis.com/translate_a/single?${params}`,
      { signal: AbortSignal.timeout(8000) }
    );

    if (!response.ok) {
      return {
        ok: false,
        error: `Translation service returned ${response.status}`,
        retryable: response.status === 429 || response.status >= 500
      };
    }

    const data = await response.json();

    // The response splits long input into sentence chunks. Taking only
    // data[0][0][0] silently truncates everything after the first sentence.
    const segments = Array.isArray(data?.[0]) ? data[0] : [];
    const translated = segments
      .map((segment) => segment?.[0] || '')
      .join('')
      .trim();

    if (!translated) {
      return { ok: false, error: 'Empty translation result', retryable: false };
    }

    return { ok: true, text: translated, provider: 'google-gtx' };
  } catch (error) {
    const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    return {
      ok: false,
      error: isTimeout ? 'Translation timed out' : error.message,
      retryable: true
    };
  }
});

// ============ SYSTEM AUDIO (LOOPBACK) CAPTURE ============
//
// To caption a call, we need the audio coming OUT of the speakers (what the
// other person says), not the microphone (which is our own voice). Electron
// grants this through setDisplayMediaRequestHandler with audio: 'loopback'.
//
// Platform support differs and the renderer needs to know which mode it can use:
//   win32  - WASAPI loopback, works directly.
//   linux  - works under PipeWire; older PulseAudio-only systems fall back to
//            selecting a ".monitor" input device as a regular microphone.
//   darwin - macOS gives no loopback audio through this API. It requires either
//            ScreenCaptureKit (macOS 13+) or a virtual device such as BlackHole.

const AUDIO_CAPABILITIES = {
  win32: {
    loopback: 'native',
    note: 'System audio is captured directly via WASAPI loopback.'
  },
  linux: {
    loopback: 'native',
    note: 'System audio uses PipeWire. On PulseAudio-only systems, pick a ".monitor" device instead.'
  },
  darwin: {
    loopback: 'unsupported',
    note: 'macOS does not expose system audio to apps. Install a virtual audio device (e.g. BlackHole) and select it as the input source.'
  }
};

function getAudioCapabilities() {
  const capability = AUDIO_CAPABILITIES[process.platform] || {
    loopback: 'unsupported',
    note: 'System audio capture is not supported on this platform.'
  };

  return { platform: process.platform, ...capability };
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) {
            console.error('[Main] No screen sources available for loopback capture');
            callback({});
            return;
          }

          // A video track must be granted alongside the audio track; the
          // renderer discards it immediately and only keeps the audio.
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch((error) => {
          console.error('[Main] desktopCapturer.getSources failed', error);
          callback({});
        });
    },
    { useSystemPicker: false }
  );

  // getUserMedia for the microphone still needs the media permission granted.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
}

ipcMain.handle('audio:get-capabilities', () => getAudioCapabilities());

app.whenReady().then(async () => {
  registerDisplayMediaHandler();
  await createWindow();
  registerShortcuts();

  // globalShortcut.register returns false when another application already
  // owns the combination. Silent failure here looks like a broken app.
  const quitShortcut = 'CommandOrControl+Shift+Q';
  if (!globalShortcut.isRegistered(quitShortcut)) {
    console.warn(
      `[Main] ${quitShortcut} could not be registered (another app may own it). ` +
      'Use the Quit button in the overlay, or Ctrl+Q while it is focused.'
    );
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (staticServer) {
    staticServer.close();
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

