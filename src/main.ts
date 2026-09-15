/**
 * Composition root.
 *
 * The only module that knows about every subsystem, and the only one allowed to
 * reach for `document` or `window`. It wires the renderer, the world, the input
 * layer, the loop and the HUD together, and it owns the frame order:
 *
 *   requestAnimationFrame
 *     └─ GameLoop
 *          ├─ step(fixedDt) × N  → world.tick(fixedDt, intent)   [fixed timestep]
 *          └─ render(alpha)      → world.updateCamera(rtt)        [interpolated]
 *                                   renderer.render(scene, camera)
 *
 * Three rules this file exists to keep:
 *
 *   1. **Gameplay never happens here.** If this file grows beyond wiring,
 *      something wants to move into `src/game/**`.
 *   2. **The simulation never learns about pixels.** Effects subscribe to events,
 *      the HUD is fed plain numbers, and the world→screen projector is a callback
 *      supplied *here* rather than imported by the render layer.
 *   3. **Simulation time and render time are different clocks.** The camera,
 *      effects and HUD all advance on real time so hitstop does not slow them
 *      down; only `world.tick` sees scaled time.
 */

import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GameLoop, type LoopHooks } from '@/core/loop';
import { InputState } from '@/core/input';
import { EventBus } from '@/core/events';
import { AUDIO, PERF, PLAYER, RENDER, SIM } from '@/core/config';
import {
  detectPlatform,
  readFlag,
  readQueryParam,
  readVolume,
  SETTING_KEYS,
  writeFlag,
  writeVolume,
} from '@/platform/Platform';
import { createAudioMixer } from '@/platform/audio/mixer';
import { attachAudio } from '@/platform/audio/attach';
import { createWorld, type World } from '@/game/World';
import { createSceneRig, syncCameraProjection } from '@/render/scene/sceneRig';
import { createLevelView } from '@/render/scene/levelView';
import { applyCameraState } from '@/render/camera/cameraRig';
import { createEffects } from '@/render/fx/effects';
import { createTelegraphView, type ImpactMarker } from '@/render/fx/telegraph';
import { createSpawnWarnings } from '@/render/fx/spawnWarnings';
import { createThrowableView } from '@/render/fx/throwableView';
import { createEnemyView } from '@/render/models/enemyView';
import {
  loadCharacter,
  PLAYER_MODEL_HEIGHT,
  PLAYER_MODEL_URL,
} from '@/render/models/CharacterLoader';
import { createCharacterRig, type CharacterRig } from '@/render/models/characterRig';
import { barrageRadius } from '@/game/enemies/largeWarden';
import { createHud, type HudElements } from '@/render/hud/hud';
import { createHitLog } from '@/debug/hitlog';
import { createPerfScene, type PerfScene, type PerfSnapshot } from '@/debug/perfScene';

/** What `bootGame` hands back to the page. */
interface BootedGame {
  start(): void;
  dispose(): void;
}

/** Everything the game needs for a frame in which the player is not in control. */
const IDLE_INTENT = {
  move: { forward: 0, right: 0 },
  sprint: false,
  jump: false,
  fire: false,
  aim: false,
  reload: false,
  throwItem: false,
  lookDeltaX: 0,
  lookDeltaY: 0,
} as const;

/** Looks up an element by id and fails loudly if the markup is out of sync. */
function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(
      `Boot failed: #${id} is missing from index.html. The HUD markup and the composition root must stay in sync.`,
    );
  }
  return element as T;
}

/**
 * Puts a problem on the veil, where the player is already looking.
 *
 * Every failure this page can suffer — no WebGL context, an element missing from the
 * markup, a refused pointer lock, an unhandled rejection — used to be *silent*. The
 * veil is static HTML, so "the script never executed", "the renderer could not be
 * built" and "the browser refused the mouse lock" all looked like the very same blue
 * screen that ignores clicks. A player cannot report that, and neither can a
 * screenshot-driven assertion, because in all three cases the picture is identical.
 *
 * That is why the veil's call to action is `正在载入…` in the markup and is only
 * replaced by the module once it actually boots: the static text must never promise
 * something the page has not done yet. See technical plan §5.13.
 */
function showBootProblem(message: string): void {
  const warn = document.getElementById('boot-warn');
  if (!warn) return;
  warn.hidden = false;
  warn.textContent = message;
}

/** One-line reason out of anything that can be thrown. */
function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    // Antialiasing off: the shadow-mapped box-garden reads fine without MSAA, and
    // a second resolve every frame is not worth the fill rate at this art style.
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    stencil: false,
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER.toneMappingExposure;
  renderer.shadowMap.enabled = true;
  return renderer;
}

function createCamera(): PerspectiveCamera {
  return new PerspectiveCamera(
    PLAYER.fovHip,
    window.innerWidth / Math.max(window.innerHeight, 1),
    0.1,
    // Far plane clears the fog range with room to spare. `syncCameraProjection`
    // owns the rule after the first resize; this only has to be a sane start.
    Math.max(SIM.arenaHalfSize * 6, RENDER.cameraFar),
  );
}

/** Boots the game on the given canvas. */
export function bootGame(canvas: HTMLCanvasElement): BootedGame {
  const platform = detectPlatform();

  // --- DOM ------------------------------------------------------------------
  const veil = requireElement('boot-veil');
  const bootCta = requireElement('boot-cta');
  const bootWarn = requireElement('boot-warn');
  const hudRoot = requireElement('hud');
  const numberLayer = requireElement('damage-numbers');
  const statsElement = requireElement('stats');
  const hitLogElement = requireElement('hitlog');

  if (platform.isTouchOnly) {
    // A one-line, actionable message beats a game that silently cannot be played.
    bootWarn.hidden = false;
    bootWarn.textContent = '检测到触屏设备：本版本只支持键鼠操作，请在桌面浏览器或桌面端运行。';
  }

  const hudElements: HudElements = {
    root: hudRoot,
    veil,
    crosshair: requireElement('crosshair'),
    healthFill: requireElement('health-fill'),
    healthText: requireElement('health-text'),
    ammoMagazine: requireElement('ammo-magazine'),
    ammoReserve: requireElement('ammo-reserve'),
    ammoState: requireElement('ammo-state'),
    chargeCount: requireElement('charge-count'),
    spreadHint: requireElement('spread-hint'),
    stats: statsElement,
    hint: bootCta,
    damageFlash: requireElement('damage-flash'),
  };
  const hud = createHud(hudElements);

  // --- Engine ---------------------------------------------------------------
  const renderer = createRenderer(canvas);
  const camera = createCamera();
  const scene = new Scene();
  const rig = createSceneRig(scene);
  const events = new EventBus();
  /**
   * One seed per run, generated here and shown on the debug panel.
   *
   * `Rng` itself stays perfectly seedable — this only changes where the seed *comes
   * from*. A constant seed meant every launch produced an identical run, which is
   * fine for a deterministic test and useless for playing: the wave layouts, the
   * spawn positions and the spread pattern were all the same script. Showing it
   * means a bug report can name the run that produced it.
   */
  const runSeed = Date.now() >>> 0;
  const world: World = createWorld({ events, seed: runSeed });
  const levelView = createLevelView(world.level);
  scene.add(levelView.root);

  const enemyView = createEnemyView();
  scene.add(enemyView.root);

  const telegraph = createTelegraphView();
  scene.add(telegraph.root);

  /**
   * Ground markers for incoming spawns.
   *
   * Separate from the barrage markers on purpose: this one is information ("something
   * is arriving over there"), that one is a reaction window ("this patch is about to
   * hurt"). Same visual language, different size and colour, because they are often
   * on screen at the same time.
   */
  const spawnWarnings = createSpawnWarnings();
  spawnWarnings.attach(events);
  scene.add(spawnWarnings.root);

  /** The thrown items themselves. Poses come from the simulation every frame. */
  const throwable = createThrowableView();
  scene.add(throwable.root);

  /**
   * The player's body, and the rig that places and turns it.
   *
   * Loaded **after** the first frame is already scheduled, so a slow or missing
   * asset can never delay boot: `loadCharacter` resolves to a procedural stand-in
   * when the file is absent, and the real model replaces it once it arrives. That is
   * the whole "drop the .glb in and it works with no code change" contract, and it
   * is why nothing above this line awaits anything.
   */
  let character: CharacterRig | null = null;
  /** Set by `dispose()` so a load that lands after teardown is not leaked. */
  let disposed = false;

  void loadCharacter(PLAYER_MODEL_URL, { height: PLAYER_MODEL_HEIGHT }).then((loaded) => {
    if (disposed) {
      loaded.dispose();
      return;
    }
    character = createCharacterRig(loaded);
    scene.add(loaded.root);
  });

  const effects = createEffects({ scene, numberLayer });
  effects.attach(events);

  const hitLog = createHitLog();
  hitLog.attach(events);

  // --- Audio ----------------------------------------------------------------
  /**
   * The mixer, and the panel that controls it.
   *
   * Constructed before anything can make a noise and *before the first gesture*:
   * it holds no `AudioContext` until `unlock()` runs inside a click, so a shell that
   * has never been clicked logs nothing and plays nothing. Every request made before
   * then is dropped rather than queued — replaying a backlog the moment the player
   * clicks in would be a burst of noise describing events that are already over.
   *
   * The panel lives inside the veil rather than in `#hud` because `#hud` is
   * `pointer-events: none` (the canvas has to keep receiving the mouse), so a slider
   * placed there could not be dragged. See `index.html` for the same note.
   */
  const mixer = createAudioMixer({
    masterVolume: readVolume(platform, SETTING_KEYS.masterVolume, AUDIO.masterVolume),
    muted: readFlag(platform, SETTING_KEYS.muted, AUDIO.muted),
  });
  const muteButton = requireElement<HTMLButtonElement>('audio-mute');
  const volumeSlider = requireElement<HTMLInputElement>('audio-volume');
  const volumeLabel = requireElement('audio-volume-text');

  /** Writes the mixer's state into the panel. Called on every change, never per frame. */
  const syncAudioPanel = (): void => {
    const percent = Math.round(mixer.masterVolume() * 100);
    volumeSlider.value = String(percent);
    volumeLabel.textContent = mixer.isMuted() ? '静音' : `${percent}%`;
    muteButton.setAttribute('aria-pressed', mixer.isMuted() ? 'true' : 'false');
    volumeSlider.disabled = mixer.isMuted();
  };

  const toggleMute = (): void => {
    // Unlocking here as well as on the veil click: the keyboard gesture is a user
    // gesture too, and a player who mutes before clicking in should not have to
    // click twice to get sound.
    mixer.unlock();
    mixer.setMuted(!mixer.isMuted());
    writeFlag(platform, SETTING_KEYS.muted, mixer.isMuted());
    syncAudioPanel();
    // Feedback for the in-game case. Under the veil this banner is simply behind it,
    // which is fine: there the button's own state is the feedback.
    hud.banner(mixer.isMuted() ? '已静音' : '声音已恢复', mixer.isMuted() ? 'warn' : 'neutral');
  };

  volumeSlider.addEventListener('input', () => {
    mixer.unlock();
    mixer.setMasterVolume(Number(volumeSlider.value) / 100);
    writeVolume(platform, SETTING_KEYS.masterVolume, mixer.masterVolume());
    syncAudioPanel();
  });
  muteButton.addEventListener('click', (event) => {
    // The veil's click handler requests pointer lock; a button press is not that.
    event.stopPropagation();
    toggleMute();
  });
  syncAudioPanel();

  /**
   * Event → sound, on the tick that produced the event.
   *
   * `onSound` is the `[HITLOG]` sfx channel: it records the *simulation tick the
   * event carried*, so the reported frame delta answers "was the sound decided on
   * the frame of the event" rather than "how long did the audio driver take".
   * Because the mixer is fed from inside the event callback — and not from the
   * render pass — that delta is structurally zero, which is what the technical
   * plan's ±1 frame SFX tolerance asks for.
   */
  const detachAudio = attachAudio({
    events,
    mixer,
    onSound: (tick) => hitLog.mark('sfx', tick / SIM.tickHz),
  });

  // --- Performance scene ----------------------------------------------------
  /**
   * `?scene=perf` only.
   *
   * The scene drives the world from outside the input layer and keeps 120 bodies on
   * the field, so it must not be reachable by accident. It lives in `src/debug/`
   * and calls only public world methods — the simulation gains no branch for it.
   */
  const perfScene: PerfScene | null = readQueryParam('scene') === PERF.sceneName ? createPerfScene() : null;

  // --- Debug toggles --------------------------------------------------------
  // Persisted, because a debug panel that resets on every reload is not usable
  // for the tuning sessions it exists for.
  let showStats = readFlag(platform, SETTING_KEYS.showStats, false) || perfScene !== null;
  let showHitLog = readFlag(platform, SETTING_KEYS.showHitLog, false);
  hitLog.enabled = showHitLog;
  document.body.classList.toggle('show-stats', showStats);
  document.body.classList.toggle('show-hitlog', showHitLog);

  // --- World → screen projection -------------------------------------------
  // Owned here rather than inside the FX layer: the FX layer must not know about
  // cameras, and the camera must not know about damage numbers.
  const projectScratch = new Vector3();
  // A plain `{x, y, z}` carrying the simulation's coordinates. The simulation does
  // not import `three`, so the boundary between the two is these three numbers.
  const worldPoint = { x: 0, y: 0, z: 0 };
  effects.setProjector((point) => {
    worldPoint.x = point.x;
    worldPoint.y = point.y;
    worldPoint.z = point.z;
    projectScratch.set(point.x, point.y, point.z);
    projectScratch.project(camera);
    return {
      x: (projectScratch.x * 0.5 + 0.5) * window.innerWidth,
      y: (-projectScratch.y * 0.5 + 0.5) * window.innerHeight,
      // Reject anything behind the camera or well off-screen: a damage number
      // that flies in from the corner is worse than no number at all.
      visible:
        projectScratch.z <= 1 && Math.abs(projectScratch.x) < 1.1 && Math.abs(projectScratch.y) < 1.1,
    };
  });

  // --- Frame bookkeeping ----------------------------------------------------
  /** Wall-clock time of the previous rendered frame, for render-time deltas. */
  let lastRenderMs = 0;
  /** Muzzle flash timer, in seconds of *render* time. */
  let muzzleTimer = 0;
  /** Set while the pointer is locked. */
  let locked = false;
  /** Scratch for reading the shot frame out of the world without allocating. */
  const muzzleScratch = new Vector3();
  const aimScratch = new Vector3();
  /**
   * Ground markers for the incoming barrage.
   *
   * Rebuilt every frame from the live Warden state rather than pushed by an event:
   * the fuse is a countdown, so the marker has to be re-read each frame anyway, and
   * a pushed marker would need its own timer that could drift out of step with the
   * blast it is warning about.
   */
  /**
   * Mutable form of {@link ImpactMarker}.
   *
   * The render layer's interface is readonly because it only ever reads; the pooled
   * scratch objects here have to be written in place, which is the whole reason the
   * allocation is gone.
   */
  type MutableImpactMarker = { -readonly [K in keyof ImpactMarker]: ImpactMarker[K] };
  const impactMarkers: MutableImpactMarker[] = [];

  /**
   * Collects the ground markers for every Warden that has locked its impacts.
   *
   * The marker objects are **pooled**, not rebuilt. `showBarrageMarkers` copies the
   * values it needs, so one mutable object per slot is enough — and the earlier
   * version pushed a fresh `{...}` literal per marker per frame, which is the phase-4
   * pool audit's exact definition of a per-frame allocation: three markers times 60
   * frames a second, allocated and thrown away while a barrage is in flight.
   */
  const collectImpactMarkers = (): void => {
    let used = 0;
    for (const enemy of world.enemies.targets) {
      if (!enemy.alive || enemy.kind !== 'large' || enemy.impactPoints.length === 0) continue;
      const total = Math.max(enemy.barrageTotalFuse, 0.001);
      for (let i = 0; i < enemy.impactPoints.length; i += 1) {
        const point = enemy.impactPoints[i];
        const fuse = enemy.blastTimers[i];
        if (!point || fuse === undefined || fuse < 0) continue;
        let slot = impactMarkers[used];
        if (!slot) {
          slot = { position: point, radius: 0, fuse: 0, total: 0 };
          impactMarkers.push(slot);
        }
        slot.position = point;
        slot.radius = barrageRadius(enemy);
        slot.fuse = fuse;
        slot.total = total;
        used += 1;
      }
    }
    impactMarkers.length = used;
  };

  /**
   * Places and animates the player's body.
   *
   * All of it now lives in `render/models/characterRig.ts` — the position, the turn toward
   * the direction of travel, the lean into that turn and the clip choice. It is a module
   * rather than four lines here because each of those is a presentation rule that needs to
   * be assertable without a canvas; see that file's header.
   */
  const syncCharacter = (dt: number): void => {
    character?.sync(world.player, dt);
  };

  const hooks: LoopHooks = {
    step(dt) {
      // The performance scene replaces the input intent rather than feeding it: it
      // has to hold full fire rate and a sweeping aim regardless of what the input
      // layer sees, and it must keep the population at the configured count.
      const intent = perfScene ? perfScene.intent() : locked ? input.sample() : IDLE_INTENT;
      perfScene?.beforeTick(world);
      world.tick(dt, intent);
      // Consume edge-triggered actions after the step that used them, so a single
      // press can never be seen by two ticks.
      input.endTick();

      if (locked) {
        if (input.wasPressed('stats')) toggleStats();
        if (input.wasPressed('hitlog')) toggleLog();
        if (input.wasPressed('mute')) toggleMute();
      }
    },

    render(alpha) {
      const nowMs = performance.now();
      // Render time, deliberately unscaled by hitstop: the camera, the effects and
      // the flash must keep moving at full speed while the simulation is frozen.
      const rtt = lastRenderMs === 0 ? 1 / 60 : Math.min((nowMs - lastRenderMs) / 1000, SIM.maxFrameDelta);
      lastRenderMs = nowMs;

      // Advancing the mixer's own clock, and reaping finished voices. Render time,
      // not simulation time: a sound must not be stretched by hitstop, or a shot's
      // noise outlives the impact it belongs to.
      mixer.update(rtt);

      world.updateCamera(rtt);
      applyCameraState(camera, world.camera);
      rig.follow(world.camera.position);
      levelView.update(world.time);
      syncCharacter(rtt);
      // The view interpolates from the world's own tick-to-tick positions, so a
      // 60 Hz simulation reads smoothly on a 144 Hz display.
      enemyView.update(world.enemies.targets, alpha, rtt);

      collectImpactMarkers();
      telegraph.showBarrageMarkers(impactMarkers);
      telegraph.update(rtt);
      spawnWarnings.update(rtt);
      throwable.update(world.items.throwables, rtt);

      if (muzzleTimer > 0) muzzleTimer = Math.max(0, muzzleTimer - rtt);
      world.muzzlePosition(muzzleScratch);
      world.aimDirection(aimScratch);
      effects.setMuzzle(muzzleScratch, aimScratch, muzzleTimer > 0);
      effects.update(rtt);

      renderer.render(scene, camera);

      hud.update({
        weapon: world.player.weapon,
        health: world.player.health,
        maxHealth: world.player.maxHealth,
        charges: world.charges,
        spreadDeg: world.player.weapon.spreadDeg,
        fovDeg: camera.fov,
        viewportHeight: window.innerHeight,
        metrics: loop.getMetrics(),
        bannerRemaining: 0,
        enemiesAlive: world.enemies.liveCount(),
        dead: world.player.dead,
        wave: world.director.status.wave,
        totalWaves: world.director.status.totalWaves,
        seed: world.seed,
      });

      if (hitLogActive()) hitLogElement.textContent = hitLog.render(8);
    },
  };

  const loop = new GameLoop(hooks);

  // --- Acceptance bridge ----------------------------------------------------
  /**
   * A read-only window for the desktop acceptance harness.
   *
   * Registered **only** in the performance scene, so a normal run exposes nothing.
   * It is not an internals back door: the harness gets the same `LoopMetrics` the F3
   * panel shows, plus the live body count, which is what turns "120 entities at
   * 60 FPS" from a claim into a reading. The alternative — scraping the stats panel's
   * text — would make the reading depend on HUD formatting.
   *
   * This is a property of the page, not a game object: `window` is touched here and
   * nowhere else, which is the composition root's standing privilege.
   */
  if (perfScene) {
    (window as unknown as { __bgsPerf?: { snapshot(): PerfSnapshot } }).__bgsPerf = {
      snapshot: () => perfScene.snapshot(world, loop.getMetrics()),
    };
  }

  // --- Veil state -----------------------------------------------------------
  /**
   * Which of the three overlays is up, if any.
   *
   * The veil is one element with three meanings, and they must not be confused:
   * `boot` is the click-to-start affordance pointer lock requires, `paused` is what
   * Esc produces, and `result` is the end of a run. A single "is the veil up" boolean
   * would make "died, then pressed Esc" look identical to "died again" — and would
   * make the click that dismisses a pause restart the whole game.
   */
  type VeilMode = 'boot' | 'paused' | 'result' | 'none';
  let veilMode: VeilMode = 'boot';
  /** Set when the run ends, so a lock loss cannot overwrite the results screen. */
  let runOver = false;

  const veilMessageFor = (mode: VeilMode): { title: string; detail: string; cta: string } => {
    switch (mode) {
      case 'boot':
        return { title: '箱庭射击', detail: '点击画面开始 · Esc 释放鼠标', cta: '点击画面开始（Esc 释放鼠标）' };
      case 'paused':
        return { title: '已暂停', detail: '点击画面返回游戏 · Esc 释放鼠标', cta: '点击画面继续' };
      case 'result':
        return { title: results.title, detail: results.detail, cta: '点击画面重开一局' };
      default:
        return { title: '', detail: '', cta: '' };
    }
  };

  const showVeilFor = (mode: VeilMode): void => {
    veilMode = mode;
    const message = veilMessageFor(mode);
    bootCta.textContent = message.cta;
    hud.showVeil(message.title, message.detail);
  };

  /** The results screen's text, filled in by the run-ending events. */
  const results = { title: '箱庭射击', detail: '' };

  // --- Input ----------------------------------------------------------------
  const input = new InputState(
    canvas,
    (isLocked) => {
      locked = isLocked;
      if (isLocked) {
        hideVeilAndPlay();
        return;
      }
      // Losing the lock from the results screen must not paint a pause veil over the
      // score: the run is already over and there is nothing to resume.
      if (runOver) return;
      // Paused the moment the pointer is released, so the world cannot advance while the
      // player is reading the veil.
      loop.setPaused(true);
      showVeilFor('paused');
    },
    /**
     * A refused pointer lock is a dead end: without it there is no mouse look, so the run
     * cannot start, and the click must not be shrugged off. This is the one failure that
     * leaves the screen *completely* unchanged, which is why it is the one most likely to
     * be misreported as "the game never loaded".
     */
    (reason) => {
      showBootProblem(
        `浏览器拒绝了鼠标锁定：${reason}。若本页嵌在 iframe 里，需要给 iframe 加 allow="pointer-lock"；` +
          '否则请在新标签页里直接打开本页，然后再点一次画面。',
      );
    },
  );

  const hideVeilAndPlay = (): void => {
    veilMode = 'none';
    hud.hideVeil();
    loop.setPaused(false);
  };

  /** Puts the world back to a fresh run and empties every view that outlives it. */
  const restartRun = (): void => {
    world.reset();
    // The simulation is reset, but the *views* keep their own one-shot state: a spent
    // spawn ring, a half-expanded blast shell, a mesh assigned to an item that no
    // longer exists. Clearing them is what makes "restart" a fresh start rather than a
    // reset with the previous run's leftovers on screen.
    telegraph.clear();
    spawnWarnings.clear();
    throwable.clear();
    effects.setMuzzle(muzzleScratch, aimScratch, false);
    enemyView.update(world.enemies.targets, 0, 0);
    // The body is snapped rather than turned to the spawn facing: on a restart the character
    // is placed, not walked there, and a quarter-second pivot out of the death pose would
    // read as the loop starting late. It is also told the run is over, or the new one begins
    // with a corpse standing in the arena.
    character?.reset(world.player.yaw);
    runOver = false;
    results.title = '箱庭射击';
    results.detail = '';
    lastRenderMs = 0;
    loop.resetClock();
  };

  const handleVeilClick = (event: MouseEvent): void => {
    // Interactive controls inside the veil (the audio panel) are not "click to
    // start": a slider drag must not request pointer lock and must not dismiss a
    // pause screen. Matched on the control element rather than on a container id, so
    // clicking the panel's own text still starts the game.
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea')) return;
    // Same click, same gesture: pointer lock and the audio context both require one.
    mixer.unlock();
    if (veilMode === 'result') {
      restartRun();
      showVeilFor('boot');
    }
    input.requestLock();
  };
  veil.addEventListener('click', handleVeilClick);

  /** Whether the hit log panel should be drawn. */
  const hitLogActive = (): boolean => showHitLog;

  // --- Debug toggles, defined after the loop so the handlers can pause it -----
  function toggleStats(): void {
    showStats = !showStats;
    writeFlag(platform, SETTING_KEYS.showStats, showStats);
    document.body.classList.toggle('show-stats', showStats);
  }

  function toggleLog(): void {
    showHitLog = !showHitLog;
    hitLog.enabled = showHitLog;
    writeFlag(platform, SETTING_KEYS.showHitLog, showHitLog);
    document.body.classList.toggle('show-hitlog', showHitLog);
    if (showHitLog) {
      hitLog.clear();
      hitLogElement.textContent = hitLog.render(0);
    }
  }

  // A muzzle flash is scheduled from the event rather than read from the weapon's
  // mode, or a held trigger would leave it permanently lit.
  events.on('shot:fired', () => {
    muzzleTimer = 0.05;
  });

  // The marker's job ends the instant the shell lands: the ring is replaced by an
  // expanding flash in the same footprint, so "the warning was here" and "the blast
  // was here" are visibly the same patch of ground.
  events.on('barrage:impact', (payload) => {
    telegraph.flash(payload.position, payload.radius);
  });

  // Directional screen feedback. The intensity is the share of the *player's* bar
  // that came off, so a clipped blast edge reads as a graze and a full 34-point
  // shell reads as a real hit -- a fixed flash would make both feel identical.
  events.on('player:damaged', (payload) => {
    hud.flashDamage(payload.amount / Math.max(1, world.player.maxHealth));
  });

  // --- Blasts and wave feedback ---------------------------------------------
  // The shell is drawn from the event rather than from the item pool: the pool slot is
  // already recycled by the time the renderer sees it, and the blast's *position* is
  // the one thing the picture and the damage have to agree on.
  events.on('item:exploded', (payload) => {
    effects.explode(payload.position, payload.radius);
  });

  // A wave change is the run's beat, so it gets a banner. The numbers come from the
  // simulation's own counter, never from a private tally here.
  events.on('wave:started', (payload) => {
    hud.banner(payload.breathing ? `第 ${payload.wave} 波 · 喘息` : `第 ${payload.wave} 波`, payload.breathing ? 'good' : 'neutral');
  });

  events.on('boss:spawned', (payload) => {
    // The one event with a `reason`: a release because the field was cleared is a
    // reward and reads differently from one the clock forced, so the banner says which.
    hud.banner(payload.reason === 'cleared' ? '典狱长登场 · 场上已清空' : '典狱长登场', 'warn');
  });

  events.on('boss:died', () => {
    hud.banner('典狱长已被击毙', 'good');
  });

  /**
   * The run ended.
   *
   * `runOver` is set before the veil is shown and the pointer is released, so the lock
   * handler cannot then paint a pause screen on top of the result. Releasing the lock
   * is also what stops the player from shooting at a scoreboard.
   */
  const endRun = (title: string, detail: string): void => {
    if (runOver) return;
    runOver = true;
    results.title = title;
    results.detail = detail;
    loop.setPaused(true);
    showVeilFor('result');
    input.releaseLock();
  };

  const elapsedLabel = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
  };

  events.on('run:victory', (payload) => {
    endRun('胜利', `${payload.waves} 波全部清空 · 用时 ${elapsedLabel(payload.elapsed)} · 种子已记录在 F3`);
  });

  events.on('run:defeat', (payload) => {
    endRun('阵亡', `倒在第 ${payload.wave} 波 · 坚持了 ${elapsedLabel(payload.elapsed)}`);
  });

  // --- Resize ---------------------------------------------------------------
  const handleResize = (): void => {
    const width = window.innerWidth;
    const height = Math.max(window.innerHeight, 1);
    syncCameraProjection(camera, width, height);
    renderer.setSize(width, height, false);
  };
  window.addEventListener('resize', handleResize);

  const handleVisibility = (): void => {
    // Never simulate while hidden: rAF is throttled anyway, and a resumed tab would
    // otherwise apply a single huge catch-up step. Coming back only resumes if the
    // player was actually in control — a run that ended stays ended.
    if (document.hidden) {
      if (!runOver) loop.setPaused(true);
    } else if (locked && !runOver) loop.setPaused(false);
  };
  document.addEventListener('visibilitychange', handleVisibility);

  return {
    start() {
      handleResize();
      // The veil owns the visibility of both full-screen layers: it is shown and the
      // HUD is hidden until the pointer is locked. Setting `hudRoot.hidden = false`
      // here as well would fight it on the very first click and put the HUD *under* an
      // opaque veil.
      showVeilFor('boot');
      runOver = false;
      lastRenderMs = 0;
      loop.resetClock();
      loop.start();
    },

    dispose() {
      disposed = true;
      loop.stop();
      input.dispose();
      detachAudio();
      mixer.dispose();
      effects.dispose();
      hud.dispose();
      character?.model.dispose();
      enemyView.dispose();
      telegraph.dispose();
      spawnWarnings.dispose();
      throwable.dispose();
      levelView.dispose();
      rig.dispose();
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      veil.removeEventListener('click', handleVeilClick);
      events.clear();
      renderer.dispose();
    },
  };
}

/**
 * Boot, with every way it can fail made visible.
 *
 * The listeners are registered *before* the boot call and deliberately left in place
 * afterwards. A module-level throw or a rejected promise used to reach nothing but the
 * console, and the veil gives no hint that anything went wrong — so the one thing a
 * stuck player could report ("clicking does nothing") was also the one thing that could
 * not be diagnosed from a screenshot. See {@link showBootProblem} and plan §5.13.
 */
window.addEventListener('error', (event) => {
  showBootProblem(`运行错误：${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  showBootProblem(`未处理的 Promise 拒绝：${reasonText(event.reason)}`);
});

const canvas = document.getElementById('app');
if (canvas instanceof HTMLCanvasElement) {
  try {
    bootGame(canvas).start();
  } catch (error) {
    showBootProblem(`启动失败：${reasonText(error)}`);
  }
} else {
  // Not thrown: a stack trace in a console nobody opened helps nobody. The markup is
  // static, so the message is guaranteed to have somewhere to land.
  showBootProblem('启动失败：文档里找不到 <canvas id="app">，index.html 与 main.ts 不同步。');
}
