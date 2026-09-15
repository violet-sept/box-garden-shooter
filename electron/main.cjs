/**
 * Electron main process — the desktop shell.
 *
 * Responsibility boundary: this file creates a window and points it at the
 * build output. It contains no game logic and no platform branching that could
 * drift from the web build, because both shells load the exact same `dist/`.
 *
 * Two load modes:
 *   dev  — set DSH_GAME_DEV_SERVER to a running `npm run dev` origin.
 *   prod — load `dist/index.html` over `file://`. `vite.config.ts` sets
 *          `base: './'` precisely so every emitted asset path is relative and
 *          therefore valid under `file://`; without it the window stays black.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, shell } = require('electron');

/** Window geometry. The game's HUD layout is designed for 16:9 at these sizes. */
const WINDOW_DEFAULT = { width: 1600, height: 900 };
const WINDOW_MIN = { width: 1280, height: 720 };

/** Set by `npm run desktop:dev`; empty or absent means "load from disk". */
const devServerUrl = process.env.DSH_GAME_DEV_SERVER || '';
const isDev = devServerUrl.length > 0;

/**
 * Optional scene selector, used by the acceptance harness.
 *
 * `tools/desktop-acceptance.mjs --scene perf` sets `DSH_GAME_SCENE=perf`, which
 * reaches the page as `?scene=perf`. It goes through the shell rather than through a
 * navigation because the shell denies in-app navigation on purpose (see the
 * `will-navigate` guard below) — and an environment variable works identically for
 * the dev shell and for the packaged executable.
 */
const sceneName = process.env.DSH_GAME_SCENE || '';

/** Absolute path to the Vite build output. */
const distIndex = path.join(__dirname, '..', 'dist', 'index.html');

/** Creates the single game window and wires its navigation guards. */
function createWindow() {
  const win = new BrowserWindow({
    ...WINDOW_DEFAULT,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    // The renderer paints the whole surface; a native background colour only
    // shows for the handful of frames before the first WebGL present.
    backgroundColor: '#0b0d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // Minimum exposure surface: no Node in the renderer, isolated world.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Pointer lock is the core input mechanism and must never be gated by a
      // permission prompt inside the app.
      // (`setPermissionRequestHandler` below is the belt to this suspender.)
      backgroundThrottling: false,
    },
  });

  // Only paint once the first frame is ready: avoids a white flash on launch.
  win.once('ready-to-show', () => win.show());

  // No in-app navigation. External links go to the OS browser instead, so a
  // stray target="_blank" can never replace the game surface.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && url.startsWith(devServerUrl);
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    const devUrl = sceneName
      ? `${devServerUrl}${devServerUrl.includes('?') ? '&' : '?'}scene=${encodeURIComponent(sceneName)}`
      : devServerUrl;
    win.loadURL(devUrl).catch((error) => {
      console.error('[shell] failed to load dev server', devUrl, error);
    });
    win.webContents.openDevTools({ mode: 'detach' });
  } else if (fs.existsSync(distIndex)) {
    win.loadFile(distIndex, sceneName ? { query: { scene: sceneName } } : {}).catch((error) => {
      console.error('[shell] failed to load build output', distIndex, error);
    });
  } else {
    // A clear, actionable failure beats a silent black window.
    const message = `Build output not found at ${distIndex}. Run "npm run build" first.`;
    console.error(`[shell] ${message}`);
    void win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        `<body style="font:15px system-ui;background:#0b0d12;color:#e7ecf5;padding:2rem">
           <h2>箱庭射击 · 启动失败</h2><p>${message}</p></body>`,
      )}`,
    );
  }

  return win;
}

// Pointer lock and fullscreen are approval-free; everything else (camera, mic,
// geolocation) is denied outright. The game never requests any of them.
app.whenReady().then(() => {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'pointerLock' || permission === 'fullscreen');
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error('[shell] startup failed', error);
  app.quit();
});

// Windows/Linux convention: closing the last window quits. macOS keeps the app
// alive in the dock, which is what `activate` above is for.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
