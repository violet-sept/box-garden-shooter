/**
 * Preload bridge — deliberately almost empty.
 *
 * The game needs no privileged capability from the desktop shell: input is
 * pointer lock + DOM events, persistence is `localStorage` (identical in
 * Chromium and in a browser tab), and there is no filesystem access. So the
 * only thing exposed is a read-only marker the platform layer uses to report
 * "we are running in a desktop shell", kept to a single frozen boolean.
 *
 * Anything added here increases the attack surface of a WebGL app that loads no
 * remote content; keep it at zero unless a documented feature requires it.
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld(
  'dshShell',
  Object.freeze({
    isDesktop: true,
    electron: process.versions.electron,
  }),
);
