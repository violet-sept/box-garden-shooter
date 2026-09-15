/**
 * Fixed-timestep game loop.
 *
 * Simulation and rendering are deliberately decoupled:
 *   - `step(dt)` is called a whole number of times at a constant dt.
 *   - `render(alpha)` is called once per animation frame and receives the
 *     interpolation factor between the previous and current simulation states.
 *
 * A constant dt is what makes the shooting, hit detection and enemy AI behave
 * identically on a 60 Hz laptop and a 240 Hz monitor, and it is what lets the
 * simulation be unit-tested by calling `step` in a plain loop.
 */

import { SIM } from './config';

/** Callbacks the loop drives. Implemented by the game composition root. */
export interface LoopHooks {
  /** Advance the simulation by exactly `dt` seconds. */
  step(dt: number, tickIndex: number): void;
  /**
   * Draw a frame.
   * @param alpha Fraction of a tick elapsed since the last `step`, in [0, 1).
   *              Render code lerps between previous and current transforms with it.
   */
  render(alpha: number): void;
}

/** Rolling performance counters, surfaced by the debug overlay. */
export interface LoopMetrics {
  /** Smoothed frames per second. */
  fps: number;
  /** Smoothed simulation ticks per second. */
  tps: number;
  /** Milliseconds spent in `step` during the last frame. */
  stepMs: number;
  /** Milliseconds spent in `render` during the last frame. */
  renderMs: number;
  /** Simulation steps executed during the last frame. */
  stepsLastFrame: number;
  /** Frames whose frame-time budget was exceeded by hitting the step cap. */
  droppedStepFrames: number;
}

export class GameLoop {
  /** Seconds a single simulation tick advances the world. */
  private readonly fixedDelta: number;
  private accumulator = 0;
  private lastTimeMs = 0;
  private tickIndex = 0;
  private rafHandle = 0;
  private running = false;
  private paused = false;

  private readonly metrics: LoopMetrics = {
    fps: 0,
    tps: 0,
    stepMs: 0,
    renderMs: 0,
    stepsLastFrame: 0,
    droppedStepFrames: 0,
  };

  constructor(
    private readonly hooks: LoopHooks,
    /** Injectable clock, so tests can drive the loop without real time. */
    private readonly now: () => number = () => performance.now(),
    private readonly tickHz: number = SIM.tickHz,
  ) {
    this.fixedDelta = 1 / this.tickHz;
  }

  /** A read-only snapshot of the current performance counters. */
  getMetrics(): Readonly<LoopMetrics> {
    return this.metrics;
  }

  /** Whether the loop is currently stepping. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Starts the loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = this.now();
    this.accumulator = 0;
    this.rafHandle = requestAnimationFrame(this.frame);
  }

  /** Stops the loop and cancels the pending frame. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  /**
   * Suspends stepping while the loop keeps rendering. Used for pause menus and
   * for the window-blur case: the world must not advance while the player is
   * looking at another application.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    // Discard wall-clock time accumulated while paused so the simulation does
    // not lurch forward by the length of the pause on resume.
    if (!paused) {
      this.lastTimeMs = this.now();
      this.accumulator = 0;
    }
  }

  /** Discards accumulated time. Call after a long stall (tab restore, load). */
  resetClock(): void {
    this.lastTimeMs = this.now();
    this.accumulator = 0;
  }

  private readonly frame = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.frame);

    const frameStart = this.now();
    // Clamp: a backgrounded tab or a breakpoint can hand us a multi-second
    // delta. Without the clamp the loop would try to catch up in one frame.
    const rawDelta = Math.min((frameStart - this.lastTimeMs) / 1000, SIM.maxFrameDelta);
    this.lastTimeMs = frameStart;

    if (this.paused) {
      this.metrics.fps = 0;
      this.metrics.tps = 0;
      this.hooks.render(0);
      return;
    }

    this.accumulator += rawDelta;

    const stepStart = this.now();
    let steps = 0;
    while (this.accumulator >= this.fixedDelta) {
      if (steps >= SIM.maxStepsPerFrame) {
        // Too far behind. Drop the backlog rather than freeze: a slow frame is
        // better than a spiral where catching up causes the next frame to be slow.
        this.accumulator = 0;
        this.metrics.droppedStepFrames += 1;
        break;
      }
      this.hooks.step(this.fixedDelta, this.tickIndex);
      this.tickIndex += 1;
      this.accumulator -= this.fixedDelta;
      steps += 1;
    }
    const stepEnd = this.now();

    const alpha = this.accumulator / this.fixedDelta;
    this.hooks.render(alpha);
    const renderEnd = this.now();

    this.metrics.stepMs = stepEnd - stepStart;
    this.metrics.renderMs = renderEnd - stepEnd;
    this.metrics.stepsLastFrame = steps;

    // Exponential moving averages, smoothed enough to be readable in a HUD.
    const frameMs = Math.max(rawDelta * 1000, 0.001);
    this.metrics.fps = this.metrics.fps === 0 ? 1000 / frameMs : this.metrics.fps * 0.9 + (1000 / frameMs) * 0.1;
    const instantTps = steps / Math.max(rawDelta, 0.001);
    this.metrics.tps = this.metrics.tps === 0 ? instantTps : this.metrics.tps * 0.9 + instantTps * 0.1;
  };
}
