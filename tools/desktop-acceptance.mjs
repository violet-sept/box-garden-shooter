/**
 * Desktop acceptance harness (`npm run desktop:accept`).
 *
 * Turns the desktop half of the acceptance list in the technical plan (§1.9)
 * into readings instead of opinions. It launches the real app, attaches to the
 * renderer over the Chrome DevTools Protocol, and checks:
 *
 *   - the window and its renderer actually came up (no crash, no early exit)
 *   - the game booted: canvas present, WebGL2 context alive, HUD revealed
 *   - pointer lock is acquired by a plain click (the core input mechanism)
 *   - the frame clock is really running (rAF measured over 1.5 s)
 *   - zero console errors, zero uncaught exceptions, zero failed loads
 *   - zero non-`file://` requests — i.e. no CDN dependency at runtime
 *   - the *screenshot* has a real picture in it (see "Picture evidence" below)
 *
 * ## Picture evidence: why the screenshot, not the canvas
 *
 * "Is anything actually on screen" cannot be answered by the DOM: an opaque veil
 * left over the canvas reports every element as healthy while the player sees
 * nothing, which is exactly how the boot-veil defect once passed a green run
 * (technical plan section 5.6.7). The first attempt to fix that read pixels back
 * by drawing the WebGL canvas into a 2D scratch canvas — and could never pass,
 * because the renderer runs with `preserveDrawingBuffer: false` (`src/main.ts`),
 * so the drawing buffer is already cleared by the time anything reads it. A run
 * whose screenshot plainly showed the arena, the HUD and the enemies still
 * reported `spread 0 / mean 0 / opaque 0` and failed on "the canvas is a flat
 * colour".
 *
 * So the pixel evidence is taken from `Page.captureScreenshot` instead: the
 * composited frame, i.e. literally what the player sees. Two measurements are
 * asserted, because they are different claims:
 *
 *   whole frame   a frame was composited at all (and is opaque, not a clear)
 *   scene band    the 3D scene inside that frame was drawn — the band is chosen
 *                 to contain no HUD element, so HUD chrome alone cannot satisfy it
 *
 * ## Failed loads and log errors are allow-lists, not deleted assertions
 *
 * "Zero failed loads" is the evidence for "no CDN dependency at runtime", so it
 * must not be weakened. But the player character model is an **optional** asset by
 * contract: `public/assets/models/player/player.glb` is delivered by a third party,
 * `loadCharacter()` deliberately resolves to a procedural stand-in when it is
 * absent, and the game is fully playable without it. Before delivery that path
 * 404s, and an unfiltered count reported it as a failure of the CDN check — a
 * false positive that made every run up to that point need a human re-triage
 * (technical plan section 5.8.1 / decision D12).
 *
 * The fix is a whitelist **plus** an assertion that nothing outside it failed.
 * Deleting the check, or filtering by scheme, would both have hidden a genuine
 * regression — a real CDN import or a broken `dist/` asset would simply stop being
 * reported.
 *
 * A missing resource surfaces through **two** independent channels, and D12 only
 * covered the first: `Network.loadingFailed` (collected with a `requestId -> url`
 * map) and `Log.entryAdded` with `level: 'error'` (Chromium logs the same failure
 * as "Failed to load resource: net::ERR_FILE_NOT_FOUND"). The `logErrors` check
 * was still unfiltered, so the optional asset still failed the gate — the same
 * false positive through the other door. Both channels are now classified the same
 * way, and the exemption is bounded on both: an entry is only ever exempted when it
 * *names* `player.glb`, whether in its URL or in its text.
 *
 * ## The performance scene (`--scene perf`)
 *
 * Two of the phase-4 acceptance targets — "120 entities at 60 FPS" and "a simulation
 * tick at or under 2 ms" — had no way of being measured: the director caps the field
 * at 18 bodies and the debug formation was deleted in phase 3. `--scene perf` sets
 * `DSH_GAME_SCENE=perf`, the shell turns that into `?scene=perf`, and the page then
 * runs `src/debug/perfScene.ts`: it holds `PERF.entityCount` bodies alive and fires
 * the weapon at full rate while sweeping the aim.
 *
 * The scene exposes one read-only window, `window.__bgsPerf.snapshot()`, carrying the
 * same `LoopMetrics` the F3 panel shows plus the live body count. The check is that
 * this reading meets the brief's numbers, so the claim stops being a paper target.
 * The entity count is read out of `src/core/config.ts` rather than duplicated here,
 * because a number in the documentation and a different number in the script is two
 * sources of truth for the same claim.
 *
 * Two targets:
 *   shell     `electron electron/main.cjs`  — the dev shell against `dist/`
 *   packaged  `release/win-unpacked/*.exe`  — the artifact `desktop:build` makes
 *
 * Usage:
 *   npm run desktop:accept                     # both, if the packaged app exists
 *   npm run desktop:accept -- --target shell
 *   npm run desktop:accept -- --scene perf     # the performance scene
 *   npm run desktop:accept -- --exe "path/to/app.exe"
 *
 * Requires a shell that permits Chromium's named-pipe IPC. Under a locked-down
 * sandbox Electron cannot start at all (see the note printed on that failure).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { cropRgba, decodePng, imageStats } from './lib/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT_DIR = path.join(ROOT, '.tmp-accept');

/** Chromium's own words when the platform channel cannot be created. */
const PIPE_FAILURE = 'platform_channel.cc';

/**
 * The only request whose failure is not a failure.
 *
 * An optional, third-party-delivered asset that the loader is contractually
 * required to survive. Everything else — including any other asset under
 * `dist/`, and *especially* anything off-origin — still counts.
 *
 * ⚠️ This is a suffix of the **resolved** URL that Chromium reports, not a copy
 * of the source-level `PLAYER_MODEL_URL`. The source value is relative
 * (`./assets/models/player/player.glb`) and lands at
 * `…/dist/assets/models/player/player.glb` (desktop) or
 * `…/<repo>/assets/models/player/player.glb` (a Pages project site). Dropping the
 * leading `/` here to "match the source" would make every one of those fail the
 * suffix test — i.e. take a known-optional asset back to a hard failure.
 */
const OPTIONAL_ASSET_PATH = '/assets/models/player/player.glb';

/**
 * The same asset referred to by name, for the one channel that does not always
 * carry a URL: `Log.entryAdded` entries may arrive with the failure text only.
 * An exemption always has to name the asset, so a bare error code can never be
 * waved through.
 */
const OPTIONAL_ASSET_NAME = /player\.glb/;

/**
 * Lower bound on luma spread. A frame that is a flat colour (a clear, a veil, a
 * dead canvas) sits near 0; a rendered arena sits above 100.
 */
export const MIN_SPREAD = 12;

/**
 * The part of the frame that no HUD element occupies, as fractions of the frame.
 *
 * Measured against a real acceptance screenshot (2379x1296, arena with enemies and
 * HUD): spread 104.45 in this band versus 241.16 for the whole frame, so the
 * threshold keeps an 8x margin. Asserting here as well as on the whole frame is
 * what separates "a frame was composited" from "the 3D scene was drawn".
 */
export const SCENE_BAND = { x0: 0.15, y0: 0.12, x1: 0.85, y1: 0.42 };

/**
 * Acceptance thresholds for the performance scene.
 *
 * Both are the brief's own numbers: 60 FPS at 120 entities, and a 2 ms simulation
 * tick. The frame-rate check allows one frame of slack because a 60 Hz panel
 * reports ~59.9 through `requestAnimationFrame` gaps, and failing on that would
 * make the check about measurement noise rather than about performance.
 */
const PERF_MIN_FPS = 59;
const PERF_MAX_STEP_MS = 2;

/** How long the performance measurement runs, in milliseconds. */
const PERF_DURATION_MS = 8000;

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`bad JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForDevtools(port, deadlineMs) {
  const started = Date.now();
  let lastError = 'not tried';
  while (Date.now() - started < deadlineMs) {
    try {
      return await getJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error.message;
      await wait(250);
    }
  }
  throw new Error(`devtools endpoint never came up (${lastError})`);
}

/**
 * Polls `document.readyState` until the page reports `complete`.
 *
 * Used after the forced reload below: the reload is what makes the network
 * evidence real, so waiting for it to settle is part of taking the measurement,
 * not a convenience.
 */
async function waitForDocumentReady(cdp, deadlineMs) {
  const started = Date.now();
  let state = 'never evaluated';
  while (Date.now() - started < deadlineMs) {
    try {
      state = await cdp.evaluate('document.readyState');
    } catch (error) {
      state = `evaluate failed: ${error.message}`;
    }
    if (state === 'complete') return state;
    await wait(250);
  }
  return state;
}

/** Minimal CDP client over the Node global WebSocket. */
class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve());
      this.socket.addEventListener('error', (event) => reject(new Error(`ws error ${event.message ?? ''}`)));
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
        else entry.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`evaluate threw: ${result.exceptionDetails.text}`);
    return result.result.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
  }
}

/** Reads only what the page exposes; no game internals are reached into. */
const PROBE = `(() => {
  const canvas = document.querySelector('canvas#app');
  const hud = document.getElementById('hud');
  const veil = document.getElementById('boot-veil');
  const warn = document.getElementById('boot-warn');
  const gl = canvas ? (canvas.getContext('webgl2') || canvas.getContext('webgl')) : null;
  return {
    readyState: document.readyState,
    canvas: !!canvas,
    canvasWidth: canvas ? canvas.width : 0,
    canvasHeight: canvas ? canvas.height : 0,
    glContext: gl ? (gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl1') : null,
    contextLost: gl ? gl.isContextLost() : null,
    hudHidden: hud ? hud.hidden : null,
    veilHidden: veil ? veil.hidden : null,
    veilCovers: veil ? getComputedStyle(veil).display !== 'none' : null,
    bootWarnHidden: warn ? warn.hidden : null,
    ctaText: (document.getElementById('boot-cta') || {}).textContent,
    health: (document.getElementById('health-text') || {}).textContent,
    ammo: (document.getElementById('ammo-magazine') || {}).textContent,
    pointerLock: document.pointerLockElement ? (document.pointerLockElement.id || 'yes') : null,
    errorBanner: document.body ? document.body.innerText.slice(0, 200) : '',
    inner: [window.innerWidth, window.innerHeight],
  };
})()`;

/**
 * The veil's call to action exactly as it is written in the markup.
 *
 * The veil is static HTML, so this text is on screen before a successful boot *and*
 * forever after a failed one. Keeping the two states distinguishable is what makes
 * "the script never executed" observable at all — see technical plan §5.13.
 */
export const STATIC_BOOT_CTA = '正在载入…';

/**
 * Did the boot module actually execute?
 *
 * True once the veil's call to action is no longer the static placeholder. A page whose
 * script never ran shows the *same* blue veil, the same title and the same volume slider,
 * and ignores every click — the one failure mode that leaves no trace any other check in
 * this file can see. Pure so it can be unit-tested: this machine cannot launch Chromium
 * (section 5.3.1), so a unit test is the only evidence this assertion can have.
 */
export function bootScriptRan(ctaText) {
  if (typeof ctaText !== 'string') return false;
  return ctaText.trim() !== '' && !ctaText.includes(STATIC_BOOT_CTA);
}

/**
 * Is this URL the optional, third-party-delivered character model?
 *
 * Matching on the path suffix rather than on a full URL keeps this working for
 * both targets: the shell loads `dist/` over `file://`, a packaged build over
 * `file://` from inside the asar, and a served build over `http://`.
 */
export function isOptionalAssetUrl(url) {
  const withoutQuery = url.split('?')[0].split('#')[0];
  return withoutQuery.endsWith(OPTIONAL_ASSET_PATH);
}

/**
 * Classifies a log-level error entry into "the optional asset" or "everything else".
 *
 * The URL is authoritative when Chromium records one. When it does not, the text
 * has to name the asset file itself — "it was only a loading error" is not a
 * category, so a bare failure can never slip into the whitelist. Exported so the
 * exemption can be unit-tested without launching Chromium, which matters because
 * this is the check that decides whether the release gate is green.
 */
export function isOptionalAssetLogEntry(entry) {
  return entry.url ? isOptionalAssetUrl(entry.url) : OPTIONAL_ASSET_NAME.test(entry.text ?? '');
}

/**
 * Measures a captured screenshot.
 *
 * Returns the whole-frame statistics plus the HUD-free scene band. See the file
 * header: the pixel evidence has to come from the composited frame, because a
 * `preserveDrawingBuffer: false` WebGL canvas reads back blank.
 *
 * Never throws: a decode failure is reported as data so the caller can turn it
 * into a named failure instead of an unhandled rejection that loses the report.
 */
export function measureScreenshot(pngBuffer) {
  try {
    const { width, height, rgba } = decodePng(pngBuffer);
    const whole = imageStats(rgba, width, height);
    const band = cropRgba(rgba, width, height, SCENE_BAND.x0, SCENE_BAND.y0, SCENE_BAND.x1, SCENE_BAND.y1);
    return { ok: true, ...whole, sceneBand: imageStats(band.rgba, band.width, band.height) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}


const FRAME_COUNT = `new Promise((resolve) => {
  let frames = 0;
  let longestGapMs = 0;
  let previous = performance.now();
  const start = previous;
  function tick() {
    const now = performance.now();
    longestGapMs = Math.max(longestGapMs, now - previous);
    previous = now;
    frames += 1;
    const elapsed = now - start;
    if (elapsed < 1500) requestAnimationFrame(tick);
    else resolve({ frames, elapsed, fps: (frames / elapsed) * 1000, longestGapMs });
  }
  requestAnimationFrame(tick);
})`;

/**
 * The performance measurement.
 *
 * Frame timing comes from `requestAnimationFrame` gaps rather than from the page's
 * own smoothed `fps`, because the gaps are the raw evidence and the smoothing hides
 * exactly the spikes that matter. The `LoopMetrics` snapshot is sampled every fifth
 * frame — often enough to catch a worst-case `stepMs`, rare enough that the probe
 * itself does not measurably load the frame it is measuring.
 */
const PERF_PROBE = (durationMs) => `new Promise((resolve) => {
  const bridge = window.__bgsPerf;
  if (!bridge || typeof bridge.snapshot !== 'function') {
    resolve({ ok: false, reason: 'window.__bgsPerf is missing: the page was not loaded with ?scene=perf' });
    return;
  }
  const start = performance.now();
  let previous = start;
  let frames = 0;
  let longestGapMs = 0;
  let stepSum = 0;
  let stepMax = 0;
  let renderSum = 0;
  let renderMax = 0;
  let samples = 0;
  let worstFrame = null;
  function tick() {
    const now = performance.now();
    const gap = now - previous;
    previous = now;
    if (gap > longestGapMs) longestGapMs = gap;
    frames += 1;
    if (frames % 5 === 0) {
      const s = bridge.snapshot();
      stepSum += s.stepMs;
      renderSum += s.renderMs;
      samples += 1;
      if (s.stepMs > stepMax) { stepMax = s.stepMs; worstFrame = s; }
      if (s.renderMs > renderMax) renderMax = s.renderMs;
    }
    if (now - start < ${durationMs}) {
      requestAnimationFrame(tick);
      return;
    }
    const elapsed = Math.max(1, now - start);
    const last = bridge.snapshot();
    resolve({
      ok: true,
      frames,
      elapsed,
      fps: (frames / elapsed) * 1000,
      longestGapMs,
      stepMeanMs: samples > 0 ? stepSum / samples : null,
      stepMaxMs: samples > 0 ? stepMax : null,
      renderMeanMs: samples > 0 ? renderSum / samples : null,
      renderMaxMs: samples > 0 ? renderMax : null,
      worstStepFrame: worstFrame,
      snapshot: last,
    });
  }
  requestAnimationFrame(tick);
})`;

/**
 * Reads `PERF.entityCount` out of the tuning table.
 *
 * A text match rather than an import: the table is TypeScript and this script is a
 * plain ES module run by Node with no bundler in the loop. Scanning the one exported
 * object block keeps the number in exactly one place, which is the point — a
 * hard-coded 120 here would silently disagree with the documentation the moment
 * either changed.
 */
function readPerfEntityCount() {
  try {
    const text = readFileSync(path.join(ROOT, 'src', 'core', 'config.ts'), 'utf8');
    const block = text.match(/export const PERF = \{[\s\S]*?\n\} as const;/);
    const value = block ? block[0].match(/entityCount:\s*(\d+)/) : null;
    return value ? Number(value[1]) : 0;
  } catch {
    return 0;
  }
}

function findPackagedExe() {
  const dir = path.join(ROOT, 'release', 'win-unpacked');
  if (!existsSync(dir)) return null;
  const exe = readdirSync(dir).find((name) => name.toLowerCase().endsWith('.exe'));
  return exe ? path.join(dir, exe) : null;
}

/**
 * Is this actually a packaged app, or a bare Electron distribution?
 *
 * `electron-builder` copies the Electron framework into `release/win-unpacked/`
 * *before* it collects node modules, so a build interrupted at that step (which is
 * what happens under a locked-down shell — `spawn EPERM`) leaves a directory that
 * holds `electron.exe` and `resources/default_app.asar`. Launching that would test
 * Electron's own demo app: the run would fail with "no <canvas id=\"app\">" and read
 * like a game defect rather than a half-finished build.
 *
 * This does not change which executable is chosen (a renamed or relocated output
 * should still be pointed at with `--exe`); it refuses to treat an app payload
 * that is not there as a package.
 */
export function hasAppPayload(exePath) {  const resources = path.join(path.dirname(exePath), 'resources');
  return (
    existsSync(path.join(resources, 'app.asar')) || existsSync(path.join(resources, 'app', 'package.json'))
  );
}

async function run(label, exePath, appEntry, port, scene) {
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `stdout-${label}.log`);
  const errFile = path.join(OUT_DIR, `stderr-${label}.log`);
  const shotFile = path.join(OUT_DIR, `screenshot-${label}.png`);
  const reportFile = path.join(OUT_DIR, `report-${label}.json`);
  const perfShotFile = path.join(OUT_DIR, `screenshot-${label}-perf.png`);

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    // Isolated profile: the run must not read or write the machine's real app
    // data, and Chromium needs a profile directory it is actually allowed to
    // create.
    `--user-data-dir=${path.join(OUT_DIR, 'userdata')}`,
    // Makes Chromium's own startup failures land in the stderr log instead of
    // vanishing, which is the difference between "it crashed" and "here is why".
    '--enable-logging=stderr',
  ];
  if (appEntry) args.push(appEntry);

  const child = spawn(exePath, args, {
    cwd: ROOT,
    // Real file descriptors, not pipes: piped stdio is denied in locked-down shells.
    // stdout and stderr get separate handles — one file opened twice truncates itself.
    stdio: ['ignore', openSync(outFile, 'w'), openSync(errFile, 'w')],
    // The shell reads this and loads the page with `?scene=<name>`. Going through the
    // environment rather than a navigation keeps the shell's own "no in-app
    // navigation" guard intact, and works for the packaged executable too.
    env: scene ? { ...process.env, DSH_GAME_SCENE: scene } : { ...process.env },
  });

  const report = {
    label,
    exe: exePath,
    args,
    scene: scene ?? null,
    launched: false,
    exitCode: null,
    probe: null,
    /** Whether the forced post-attach reload ran, and what it settled to. */
    reloaded: false,
    reloadReadyState: null,
    afterClick: null,
    frames: null,
    /** Whole-frame + HUD-free-band statistics of the captured screenshot. */
    screenshotStats: null,
    screenshot: shotFile,
    perfScreenshot: scene ? perfShotFile : null,
    perfScreenshotStats: null,
    /** Performance-scene reading, when `--scene perf` was asked for. */
    perf: null,
    consoleErrors: [],
    consoleWarnings: [],
    exceptions: [],
    /** Every level=error log entry, with the URL when Chromium supplied one. */
    logErrors: [],
    /** Subset of `logErrors` that is the optional character asset. */
    logOptionalErrors: [],
    /** Subset of `logErrors` that is not: these are real failures. */
    logRequiredErrors: [],
    /** Every failed request, with its URL, so the allow-list can be applied. */
    failedLoads: [],
    /** Subset of `failedLoads` that is the optional character asset. */
    failedOptionalLoads: [],
    /** Subset of `failedLoads` that is not: these are real failures. */
    failedRequiredLoads: [],
    externalRequests: [],
    requestCount: 0,
    stderr: '',
    ok: false,
    failures: [],
  };

  child.on('exit', (code) => {
    report.exitCode = code;
  });

  /**
   * requestId → URL.
   *
   * `Network.loadingFailed` carries the id but *not* the URL, so without this map
   * the failure list can only report the error text and the resource type — which
   * is exactly why the optional-asset false positive could not be told apart from a
   * real CDN failure.
   */
  const requestUrls = new Map();

  let cdp;
  try {
    await waitForDevtools(port, 25000);
    report.launched = true;

    let page = null;
    for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
      const list = await getJson(`http://127.0.0.1:${port}/json/list`);
      page = list.find((target) => target.type === 'page');
      if (!page) await wait(250);
    }
    if (!page) throw new Error('no page target appeared');

    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');

    /**
     * Reload once, now that the domains are enabled.
     *
     * Three reasons, all about the evidence being real rather than vacuous:
     *   - `Network.requestWillBeSent` is what backs "zero non-`file://` requests".
     *     A page that finished loading before the harness attached produces
     *     `requestCount: 0`, which makes that check observe *nothing* and pass
     *     regardless of what the page imports.
     *   - the `requestId -> url` map is only populated for requests seen live, and
     *     that map is how a failed load is told apart from the optional asset.
     *   - it restores the genuine pre-click state (boot veil up, pointer lock
     *     released), which is what the veil assertions describe. Attaching to a
     *     page that a human had already clicked made those assertions describe a
     *     page state the harness never created.
     */
    await cdp.send('Page.reload');
    report.reloaded = true;
    report.reloadReadyState = await waitForDocumentReady(cdp, 20000);

    await wait(2000);
    report.probe = await cdp.evaluate(PROBE);

    // A plain click on the canvas: the gesture pointer lock requires.
    const [cx, cy] = report.probe.inner;
    const click = { x: Math.round(cx / 2), y: Math.round(cy / 2), button: 'left', clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...click });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click });
    await wait(1000);
    report.afterClick = await cdp.evaluate(PROBE);
    report.frames = await cdp.evaluate(FRAME_COUNT);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const shotBuffer = Buffer.from(shot.data, 'base64');
    writeFileSync(shotFile, shotBuffer);
    report.screenshotStats = measureScreenshot(shotBuffer);

    // The performance measurement runs last, so its window is not polluted by the
    // boot work above and its screenshot shows the settled scene rather than the
    // first frame in which the crowd appeared.
    if (scene) {
      report.perf = await cdp.evaluate(PERF_PROBE(PERF_DURATION_MS));
      const perfShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const perfShotBuffer = Buffer.from(perfShot.data, 'base64');
      writeFileSync(perfShotFile, perfShotBuffer);
      report.perfScreenshotStats = measureScreenshot(perfShotBuffer);
    }
  } catch (error) {
    report.failures.push(`launch: ${error.message}`);
  }

  if (cdp) {
    for (const event of cdp.events) {
      if (event.method === 'Runtime.consoleAPICalled') {
        const text = (event.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        if (event.params.type === 'error' || event.params.type === 'assert') report.consoleErrors.push(text);
        else if (event.params.type === 'warning') report.consoleWarnings.push(text);
      } else if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params.exceptionDetails;
        report.exceptions.push(details?.exception?.description ?? details?.text ?? 'unknown');
      } else if (event.method === 'Log.entryAdded') {
        const entry = event.params.entry;
        if (entry.level === 'error') {
          // Keep the URL: it is what lets this channel be classified exactly like
          // `Network.loadingFailed`, instead of being an all-or-nothing count.
          report.logErrors.push({ source: entry.source, text: entry.text, url: entry.url ?? '' });
        }
      } else if (event.method === 'Network.loadingFailed') {
        const url = requestUrls.get(event.params.requestId) ?? '';
        report.failedLoads.push({
          url,
          errorText: event.params.errorText,
          type: event.params.type,
        });
      } else if (event.method === 'Network.requestWillBeSent') {
        const url = event.params.request.url;
        requestUrls.set(event.params.requestId, url);
        report.requestCount += 1;
        const local = ['file:', 'data:', 'blob:', 'devtools:', 'chrome-extension:'].some((scheme) => url.startsWith(scheme));
        if (!local) report.externalRequests.push(url);
      }
    }
    cdp.close();
  }

  /**
   * Splits the failures into "the optional asset we already know about" and
   * "everything else", on both channels. See the file header for why the second
   * channel exists at all.
   */
  report.failedOptionalLoads = report.failedLoads.filter((entry) => isOptionalAssetUrl(entry.url));
  report.failedRequiredLoads = report.failedLoads.filter((entry) => !isOptionalAssetUrl(entry.url));
  report.logOptionalErrors = report.logErrors.filter(isOptionalAssetLogEntry);
  report.logRequiredErrors = report.logErrors.filter((entry) => !isOptionalAssetLogEntry(entry));

  const describeLogEntry = (entry) => `${entry.source}: ${entry.text}${entry.url ? ` [${entry.url}]` : ''}`;

  try {
    child.kill();
  } catch {
    /* already dead */
  }
  await wait(300);
  report.stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8').slice(0, 4000) : '';

  const check = (condition, message) => {
    if (!condition) report.failures.push(message);
  };

  // Only the launch failure is meaningful before the app is up: reporting
  // "no WebGL context" when nothing ever started is noise, not information.
  check(report.launched, 'the app never exposed a devtools endpoint');
  if (report.launched) {
    check(report.probe?.readyState === 'complete', 'the document did not finish loading');
    check(
      report.reloadReadyState === 'complete',
      `the page did not finish loading after the forced reload (${report.reloadReadyState})`,
    );
    // Without observed requests, "zero non-file:// requests" is not evidence of
    // anything. Say so instead of reporting a green check that measured nothing.
    check(
      report.requestCount > 0,
      'no requests were observed after the reload, so the "no CDN" check would be vacuous',
    );
    check(report.probe?.canvas === true, 'no <canvas id="app"> in the document');
    check(report.probe?.glContext === 'webgl2', `no WebGL2 context (got ${report.probe?.glContext})`);
    check(report.probe?.contextLost === false, 'the WebGL context was lost');
    // Before the click the veil *must* be up: it is the click-to-start affordance
    // pointer lock requires, and the HUD must stay out of the way behind it.
    check(report.probe?.veilHidden === false, 'the boot veil was already hidden before the click');
    check(report.probe?.veilCovers === true, 'the boot veil was not actually painted over the canvas');
    check(report.probe?.hudHidden === true, 'the HUD was visible while the veil was still up');
    check(report.probe?.bootWarnHidden === true, 'the boot warning banner is showing');
    // The veil's text is static markup until the module boots, so a page whose script
    // never executed is pixel-for-pixel a normal boot screen that ignores clicks. Every
    // other assertion here is blind to that: the DOM is intact, WebGL is available, the
    // veil is up and the HUD is hidden — all of it true of a dead page too (plan §5.13).
    check(
      bootScriptRan(report.probe?.ctaText),
      `the boot script never executed: the call to action still reads "${report.probe?.ctaText}"`,
    );
    // After the click the two layers swap. Asserting the swap (rather than a
    // single state) is what would have caught the shipped defect, where the
    // expectation and the implementation were both reversed.
    check(
      report.afterClick?.pointerLock === 'app',
      `pointer lock not acquired (got ${report.afterClick?.pointerLock})`,
    );
    check(report.afterClick?.veilHidden === true, 'the boot veil is STILL covering the canvas after the click');
    check(report.afterClick?.hudHidden === false, 'the HUD stayed hidden, so boot never completed');
    check((report.frames?.fps ?? 0) > 30, `frame clock too slow: ${report.frames?.fps?.toFixed(1)} fps`);
    // The picture, not the DOM. A veil over the canvas leaves every element above
    // reporting healthy, so this is the only assertion that fails when the player
    // can see nothing at all. Measured on the composited screenshot — see the file
    // header for why the WebGL canvas cannot be read back here.
    check(report.screenshotStats?.ok === true, `could not measure the screenshot: ${report.screenshotStats?.reason}`);
    check(
      (report.screenshotStats?.spread ?? 0) > MIN_SPREAD,
      `the frame is a flat colour (spread ${report.screenshotStats?.spread}), so nothing was drawn`,
    );
    check(
      (report.screenshotStats?.opaqueFraction ?? 0) > 0.9,
      `the frame is mostly transparent (opaque ${report.screenshotStats?.opaqueFraction})`,
    );
    // And the 3D scene specifically, in the band the HUD never covers.
    check(
      (report.screenshotStats?.sceneBand?.spread ?? 0) > MIN_SPREAD,
      `the scene band is a flat colour (spread ${report.screenshotStats?.sceneBand?.spread}),` +
        ` so the HUD drew but the 3D scene did not`,
    );
    check(report.consoleErrors.length === 0, `console errors: ${report.consoleErrors.length}`);
    check(report.exceptions.length === 0, `uncaught exceptions: ${report.exceptions.length}`);
    // The allow-list for both channels, each in two halves. Neither half alone is
    // enough: the first would pass if a CDN import also failed, the second would
    // pass if a required asset were missing. Together they say "the only thing that
    // failed is the optional character asset".
    check(
      report.failedRequiredLoads.length === 0,
      `failed loads (only the optional character asset may fail): ` +
        `${report.failedRequiredLoads.map((entry) => `${entry.errorText} ${entry.url || entry.type}`).join(', ')}`,
    );
    check(
      report.failedOptionalLoads.every((entry) => entry.url !== ''),
      'a load failed with no recorded URL, so it could not be classified as the optional asset',
    );
    check(
      report.logRequiredErrors.length === 0,
      `log errors (only the optional character asset may fail): ` +
        `${report.logRequiredErrors.map(describeLogEntry).join(', ')}`,
    );
    check(
      report.logOptionalErrors.every((entry) => entry.url !== '' || OPTIONAL_ASSET_NAME.test(entry.text)),
      'a log error was exempted without naming the optional asset',
    );
    check(
      report.externalRequests.length === 0,
      `external requests (CDN dependency?): ${report.externalRequests.join(', ')}`,
    );
    check(existsSync(shotFile), 'no screenshot was captured');

    // --- Performance scene ---------------------------------------------------
    // Only when it was asked for: the scene is what makes these numbers exist, and
    // asserting on a reading that was never taken would be worse than not asserting.
    if (scene) {
      const entityTarget = readPerfEntityCount();
      check(entityTarget > 0, 'could not read PERF.entityCount out of src/core/config.ts');
      const perf = report.perf;
      check(perf?.ok === true, `the performance probe did not finish: ${perf?.reason ?? 'unknown'}`);
      if (perf?.ok) {
        check(
          (perf.snapshot?.entitiesAlive ?? 0) >= entityTarget,
          `only ${perf.snapshot?.entitiesAlive} entities were alive, wanted ${entityTarget}`,
        );
        check(
          perf.fps >= PERF_MIN_FPS,
          `frame rate ${perf.fps.toFixed(1)} fps is below the ${PERF_MIN_FPS} fps floor`,
        );
        check(
          (perf.stepMeanMs ?? Number.POSITIVE_INFINITY) <= PERF_MAX_STEP_MS,
          `mean simulation step ${perf.stepMeanMs?.toFixed(2)} ms exceeds the ${PERF_MAX_STEP_MS} ms budget`,
        );
        // The scene keeps the magazine full, so the run cannot be a "held the
        // trigger and nothing happened" measurement.
        check((perf.snapshot?.shotsFired ?? 0) > 0, 'the scene never fired a shot');
        check(existsSync(perfShotFile), 'no performance screenshot was captured');
      }
    }
  }
  report.ok = report.failures.length === 0;

  writeFileSync(reportFile, JSON.stringify(report, null, 2));

  const verdict = report.ok ? 'PASS' : 'FAIL';
  console.log(`\n=== ${label}: ${verdict} ===`);
  if (report.probe) {
    console.log(
      `  boot      : ${report.probe.glContext} ${report.probe.canvasWidth}x${report.probe.canvasHeight}` +
        ` | veil ${report.probe.veilHidden ? 'hidden' : 'SHOWN'} | HUD ${report.probe.hudHidden ? 'hidden' : 'shown'}` +
        ` | health ${report.probe.health} | ammo ${report.probe.ammo}`,
    );
  }
  if (report.afterClick) {
    console.log(
      `  after click: veil ${report.afterClick.veilHidden ? 'hidden' : 'SHOWN'}` +
        ` | HUD ${report.afterClick.hudHidden ? 'hidden' : 'shown'}` +
        ` | lock ${report.afterClick.pointerLock}`,
    );
  }
  if (report.screenshotStats?.ok) {
    console.log(
      `  picture   : luma ${report.screenshotStats.mean} (${report.screenshotStats.min}..${report.screenshotStats.max},` +
        ` spread ${report.screenshotStats.spread}) | scene band spread ${report.screenshotStats.sceneBand.spread}`,
    );
  }
  if (report.frames) console.log(`  frame clock: ${report.frames.fps.toFixed(1)} fps, worst gap ${report.frames.longestGapMs.toFixed(1)} ms`);
  if (report.perf?.ok) {
    const p = report.perf;
    const s = p.snapshot;
    console.log(
      `  perf scene: ${s.entitiesAlive} entities (target ${s.entityCountTarget}) · ${p.fps.toFixed(1)} fps` +
        ` · worst gap ${p.longestGapMs.toFixed(1)} ms over ${(p.elapsed / 1000).toFixed(1)} s`,
    );
    console.log(
      `  perf tick : step mean ${p.stepMeanMs?.toFixed(2)} ms / max ${p.stepMaxMs?.toFixed(2)} ms` +
        ` · draw mean ${p.renderMeanMs?.toFixed(2)} ms / max ${p.renderMaxMs?.toFixed(2)} ms` +
        ` · dropped ${s.droppedStepFrames}`,
    );
    console.log(
      `  perf load : ${s.shotsFired} shots, ${s.kills} kills, ${s.ticks} ticks, store ${s.storeEntries} entries`,
    );
  } else if (report.perf && !report.perf.ok) {
    console.log(`  perf scene: FAILED — ${report.perf.reason}`);
  }
  console.log(
    `  feedback  : ${report.consoleErrors.length} console errors, ${report.exceptions.length} exceptions,` +
      ` ${report.failedRequiredLoads.length} failed loads` +
      ` (+${report.failedOptionalLoads.length} optional-asset misses),` +
      ` ${report.logRequiredErrors.length} log errors` +
      ` (+${report.logOptionalErrors.length} optional-asset logs),` +
      ` ${report.requestCount} requests (${report.externalRequests.length} external)`,
  );
  for (const failure of report.failures) console.log(`  FAIL: ${failure}`);

  if (!report.ok && report.stderr.includes(PIPE_FAILURE)) {
    console.log(
      '\n  This is the sandbox boundary, not an app bug: Chromium cannot create the named pipe\n' +
        '  its browser<->renderer IPC needs, so no Electron app of any kind can start here.\n' +
        '  Run this script from a normal (unsandboxed) shell on the machine.',
    );
  }
  console.log(`  report    : ${path.relative(ROOT, reportFile)}`);
  console.log(`  screenshot: ${path.relative(ROOT, shotFile)}`);
  if (report.perfScreenshot) console.log(`  perf shot : ${path.relative(ROOT, perfShotFile)}`);

  return report.ok;
}

/**
 * Driver.
 *
 * Guarded so that the pure helpers above (`measureScreenshot`,
 * `isOptionalAssetLogEntry`, `hasAppPayload`) can be imported by the test suite
 * without launching anything: this gate decides whether the release is green, and
 * it is the one part of the acceptance path that cannot be exercised in a locked
 * down shell.
 */
async function main() {
  const target = argOf('target', 'auto');
  const explicitExe = argOf('exe', '');
  const scene = argOf('scene', '');
  let port = Number(argOf('port', '9333'));
  let allOk = true;
  let ran = 0;

  if (target === 'shell' || target === 'auto') {
    const label = scene ? `shell-${scene}` : 'shell';
    allOk = (await run(label, ELECTRON, path.join(ROOT, 'electron', 'main.cjs'), port, scene)) && allOk;
    port += 1;
    ran += 1;
  }

  if (target === 'packaged' || target === 'auto') {
    const packaged = explicitExe ? path.resolve(explicitExe) : findPackagedExe();
    const label = scene ? `packaged-${scene}` : 'packaged';
    const complete = packaged && existsSync(packaged) && hasAppPayload(packaged);
    if (complete) {
      allOk = (await run(label, packaged, null, port, scene)) && allOk;
      ran += 1;
    } else if (target === 'packaged') {
      if (packaged && existsSync(packaged)) {
        console.log(
          `\n=== packaged: FAIL ===\n  found ${path.relative(ROOT, packaged)} but it has no app payload` +
            ` (resources/app.asar or resources/app/package.json).\n` +
            '  This is an interrupted build, not a packaged app: electron-builder copies the Electron\n' +
            '  framework before it collects modules, so a failure at that step leaves electron.exe\n' +
            '  behind. Delete release/win-unpacked and run "npm run desktop:build" to completion.',
        );
      } else {
        console.log(`\n=== packaged: FAIL ===\n  no .exe found. Run "npm run desktop:build" first.`);
      }
      allOk = false;
    } else if (packaged && existsSync(packaged)) {
      console.log(
        '\n=== packaged: SKIPPED ===\n  the exe in release/win-unpacked has no app payload,' +
          ' i.e. the last build was interrupted.',
      );
    } else {
      console.log('\n=== packaged: SKIPPED ===\n  no release/win-unpacked/*.exe yet (run "npm run desktop:build").');
    }
  }

  if (ran === 0) {
    console.log('\nnothing was launched.');
    process.exit(2);
  }

  console.log(`\n${allOk ? 'ALL TARGETS PASSED' : 'ACCEPTANCE FAILED'}`);
  process.exit(allOk ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
