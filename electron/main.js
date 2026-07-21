const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = '127.0.0.1';
const DEFAULT_TRANSLATION_ENDPOINT = 'https://translate.argosopentech.com/translate';
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

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setContentProtection(true);

  await mainWindow.loadURL(`http://${HOST}:${port}`);
}

function getOverlayBounds(state) {
  const { screen } = require('electron');
  const { workArea } = screen.getPrimaryDisplay();

  if (state === 'compact') {
    const width = 320;
    const height = 88;

    return {
      width,
      height,
      x: workArea.x + workArea.width - width - 28,
      y: workArea.y + 92
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
  mainWindow.setResizable(state === 'expanded');
  mainWindow.setMinimumSize(state === 'expanded' ? 640 : 320, state === 'expanded' ? 460 : 88);
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

  // Keep these aligned with the renderer's local handlers and the README:
  // M toggles capture, S toggles mute. Registering M as mute here previously
  // meant the documented start/stop shortcut could never fire.
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    sendOverlayCommand('toggle-listen');
  });

  globalShortcut.register('CommandOrControl+Shift+S', () => {
    sendOverlayCommand('toggle-mute');
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
ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
    return { ok: true };
  }
  return { ok: false };
});
ipcMain.handle('overlay:set-state', (_, state) => applyOverlayState(state));
ipcMain.handle('translation:get-languages', async (_, { endpoint } = {}) => {
  const activeEndpoint = endpoint || DEFAULT_TRANSLATION_ENDPOINT;
  const languagesUrl = activeEndpoint.replace(/\/translate$/, '/languages');

  try {
    const response = await fetch(languagesUrl, {
      headers: {
        Accept: 'application/json'
      }
    });

    const rawBody = await response.text();
    let parsedBody = null;

    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch (error) {
      parsedBody = rawBody;
    }

    console.info('[Main] Translation languages response', {
      endpoint: activeEndpoint,
      status: response.status,
      body: parsedBody
    });

    if (!response.ok) {
      return {
        ok: false,
        endpoint: activeEndpoint,
        error: `Languages request failed with ${response.status}`,
        data: parsedBody
      };
    }

    return {
      ok: true,
      endpoint: activeEndpoint,
      data: parsedBody
    };
  } catch (error) {
    console.error('[Main] Translation languages request failed', {
      endpoint: activeEndpoint,
      error
    });

    return {
      ok: false,
      endpoint: activeEndpoint,
      error: error.message
    };
  }
});
ipcMain.handle('translation:request', async (_, payload = {}) => {
  const endpoint = payload.endpoint || DEFAULT_TRANSLATION_ENDPOINT;
  const requestBody = {
    q: payload.q || '',
    source: payload.source || 'en',
    target: payload.target || 'hi',
    format: payload.format || 'text'
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const rawBody = await response.text();
    let parsedBody = null;

    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch (error) {
      parsedBody = rawBody;
    }

    console.info('[Main] Translation API response', {
      endpoint,
      status: response.status,
      body: parsedBody
    });

    if (!response.ok) {
      return {
        ok: false,
        endpoint,
        error: `Translation failed with ${response.status}`,
        data: parsedBody
      };
    }

    return {
      ok: true,
      endpoint,
      data: parsedBody
    };
  } catch (error) {
    console.error('[Main] Translation request failed', {
      endpoint,
      requestBody,
      error
    });

    return {
      ok: false,
      endpoint,
      error: error.message
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

const BASE_MODEL_PATH = path.join(__dirname, "../assets/models");
const MODEL_PATHS = {
  en: "vosk-model-small-en-us-0.15",
  hi: "vosk-model-small-hi-0.22",
  de: "vosk-model-small-de-0.15",
  fr: "vosk-model-small-fr-0.22",
  zh: "vosk-model-small-cn-0.22",
  es: "vosk-model-small-es-0.42"
};

function resolveModelPaths(langCode) {
  const modelName = MODEL_PATHS[langCode];

  if (!modelName) {
    return null;
  }

  return {
    folderPath: path.join(BASE_MODEL_PATH, modelName),
    archivePath: path.join(BASE_MODEL_PATH, `${modelName}.tar.gz`)
  };
}

ipcMain.handle('models:check-availability', async (_, langCode) => {
  const modelPaths = resolveModelPaths(langCode);
  
  console.log('[Main] Checking model path:', modelPaths?.archivePath || modelPaths?.folderPath);
  
  if (!modelPaths) {
    console.log('[Main] Unknown language code:', langCode);
    return { available: false, path: null };
  }

  try {
    const exists = fs.existsSync(modelPaths.archivePath) || fs.existsSync(modelPaths.folderPath);
    console.log('[Main] Model existence result:', exists, 'for', langCode);
    return {
      available: exists,
      path: fs.existsSync(modelPaths.archivePath) ? modelPaths.archivePath : modelPaths.folderPath
    };
  } catch (error) {
    console.error('[Main] Error checking model existence:', error);
    return { available: false, path: modelPaths.archivePath };
  }
});

ipcMain.handle('models:get-path', async (_, langCode) => {
  console.log("Selected language:", langCode);
  
  // Step 1: Validate language exists in mapping
  if (!resolveModelPaths(langCode)) {
    console.warn("Invalid language:", langCode, "falling back to English");
    langCode = "en";
  }
  
  // Step 2: Validate model file exists
  let modelPaths = resolveModelPaths(langCode);
  if (!fs.existsSync(modelPaths.archivePath) && !fs.existsSync(modelPaths.folderPath)) {
    console.warn("Model not found for:", langCode, "falling back to English");
    langCode = "en";
    modelPaths = resolveModelPaths(langCode);
  }
  
  // Step 3: Final validation
  if (!modelPaths) {
    throw new Error("Model path is undefined even after fallback");
  }
  
  const modelPath = fs.existsSync(modelPaths.archivePath) ? modelPaths.archivePath : modelPaths.folderPath;
  console.log("Final language used:", langCode);
  console.log("Resolved model path:", modelPath);
  
  return modelPath;
});

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

