/**
 * Input layer.
 *
 * Converts raw DOM events into a semantic {@link InputIntent} snapshot that the
 * simulation reads once per tick. Gameplay code never sees a `KeyboardEvent`,
 * which is what makes the systems testable: synthesise an intent, assert state.
 *
 * Bindings (see {@link BINDINGS}):
 *   W / A / S / D  - move forward / left / back / right
 *   Mouse Left     - fire
 *   Mouse Right    - aim down sights (ADS)
 *   R              - reload
 *   E              - throw item
 *   Shift          - sprint      Space - jump      Esc - release pointer
 */

/** Movement axes in the range [-1, 1], in the player's local frame. */
export interface MoveAxes {
  /** +1 is forward (W), -1 is backward (S). */
  readonly forward: number;
  /** +1 is right (D), -1 is left (A). */
  readonly right: number;
}

/**
 * One tick's worth of player intent.
 *
 * `fire` and `aim` are level-triggered (true while held).
 * `reload` and `throwItem` are edge-triggered: the flag is true only on the ticks
 * whose window contained the key-down event, and the simulation consumes it by
 * acting on it, so a single press can never leak across ticks or trigger twice.
 */
export interface InputIntent {
  readonly move: MoveAxes;
  readonly sprint: boolean;
  readonly jump: boolean;
  readonly fire: boolean;
  readonly aim: boolean;
  /** Edge-triggered: true on the tick R went down. */
  readonly reload: boolean;
  /** Edge-triggered: true on the tick E went down. */
  readonly throwItem: boolean;
  /** Accumulated mouse delta for this tick, in pixels. */
  readonly lookDeltaX: number;
  readonly lookDeltaY: number;
}

/**
 * Keyboard and mouse bindings, kept in one place so they are remappable.
 *
 * `stats` and `hitlog` are debug channels rather than gameplay actions. They live
 * in the same table on purpose: adding a debug key by registering a second
 * `keydown` listener somewhere would put a keyboard binding outside the one place
 * that owns them, and the two would eventually disagree about `preventDefault`.
 */
export const BINDINGS = {
  forward: ['KeyW'],
  left: ['KeyA'],
  back: ['KeyS'],
  right: ['KeyD'],
  reload: ['KeyR'],
  throwItem: ['KeyE'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  stats: ['F3'],
  hitlog: ['F4'],
  /**
   * Mute / unmute (phase 4).
   *
   * A gameplay-adjacent binding rather than a debug channel, and it lives in this
   * table for the same reason the debug keys do: a `keydown` listener registered
   * anywhere else would disagree with this one about `preventDefault` and about
   * what happens when the pointer is not locked.
   */
  mute: ['KeyM'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Bindings the game reacts to but that must not swallow the browser's own
 * shortcut. F3 is "find again" in some browsers and F4 has no default, but both
 * are harmless to suppress in a full-window game canvas.
 */
const SUPPRESS_DEFAULT: readonly (keyof typeof BINDINGS)[] = ['jump', 'stats', 'hitlog'];

/** A DOM event code → binding lookup built once from {@link BINDINGS}. */
const CODE_TO_ACTION: ReadonlyMap<string, keyof typeof BINDINGS> = new Map(
  (Object.entries(BINDINGS) as [keyof typeof BINDINGS, readonly string[]][]).flatMap(
    ([action, codes]) => codes.map((code) => [code, action] as const),
  ),
);

/**
 * Owns the pointer-lock session and accumulates input between ticks.
 *
 * Usage per frame:
 * ```ts
 * input.update();               // fold queued look deltas into this tick
 * const intent = input.sample(); // read the intent
 * input.endTick();              // clear one-shot edges
 * ```
 */
export class InputState {
  private readonly held = new Set<string>();
  /** Actions whose press event arrived since the last `endTick`. */
  private readonly pressedEdges = new Set<keyof typeof BINDINGS>();

  private pendingLookX = 0;
  private pendingLookY = 0;
  private tickLookX = 0;
  private tickLookY = 0;

  private locked = false;
  private disposed = false;

  /** Mouse buttons currently down. Index 0 is left, 2 is right. */
  private readonly buttons = new Set<number>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** Called when the pointer lock state changes, so the UI can react. */
    private readonly onLockChange?: (locked: boolean) => void,
    /**
     * Called when a pointer-lock request is refused, with the reason.
     *
     * This exists because a refusal is otherwise **invisible**: nothing on screen
     * changes, no listener the game has fires, and the player is left clicking a page
     * that never responds — indistinguishable from a build where the script never ran
     * at all. The reason is only available from the rejected promise (Chrome) or from
     * `pointerlockerror` (other engines), so both routes report through here.
     */
    private readonly onLockError?: (reason: string) => void,
  ) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    canvas.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    // `contextmenu` must be suppressed or right-click ADS opens the OS menu.
    canvas.addEventListener('contextmenu', this.handleContextMenu);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('pointerlockerror', this.handlePointerLockError);
    document.addEventListener('mousemove', this.handleMouseMove);
  }

  /** Whether the pointer is currently locked to the canvas. */
  get isLocked(): boolean {
    return this.locked;
  }

  /** Requests pointer lock. Must be called from a user gesture. */
  requestLock(): void {
    if (this.disposed || this.locked) return;
    // Browsers differ: Chrome returns a promise that rejects with the reason, Firefox
    // returns one that rejects when the gesture was not trusted, and older engines
    // return nothing at all and fire `pointerlockerror` instead. Report rather than
    // discard — see `onLockError` for why silence is the one unacceptable outcome.
    const result = this.canvas.requestPointerLock() as unknown;
    if (result instanceof Promise) {
      result.catch((error: unknown) => this.reportLockFailure(describeLockFailure(error)));
    }
  }

  /** Releases pointer lock. */
  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /**
   * Folds accumulated mouse movement into the tick being simulated.
   * Call once per simulation step, before {@link sample}.
   */
  update(): void {
    this.tickLookX = this.pendingLookX;
    this.tickLookY = this.pendingLookY;
    this.pendingLookX = 0;
    this.pendingLookY = 0;
  }

  /** Reads the current intent. Does not clear anything. */
  sample(): InputIntent {
    return {
      move: {
        forward: Number(this.isActionHeld('forward')) - Number(this.isActionHeld('back')),
        right: Number(this.isActionHeld('right')) - Number(this.isActionHeld('left')),
      },
      sprint: this.isActionHeld('sprint'),
      jump: this.isActionHeld('jump'),
      fire: this.buttons.has(0),
      aim: this.buttons.has(2),
      // Edge flags are folded into the intent rather than read separately, so the
      // simulation has exactly one input object to consume and tests can build it
      // by hand. `endTick` clears them, so a press reaches exactly one tick even
      // when a frame runs several steps.
      reload: this.pressedEdges.has('reload'),
      throwItem: this.pressedEdges.has('throwItem'),
      lookDeltaX: this.tickLookX,
      lookDeltaY: this.tickLookY,
    };
  }

  /** True if the action's key was pressed at any point during this tick. */
  wasPressed(action: keyof typeof BINDINGS): boolean {
    return this.pressedEdges.has(action);
  }

  /** Clears one-shot edges and the per-tick look delta. Call after the tick. */
  endTick(): void {
    this.pressedEdges.clear();
    this.tickLookX = 0;
    this.tickLookY = 0;
  }

  /** Removes every listener. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.canvas.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('pointerlockerror', this.handlePointerLockError);
    document.removeEventListener('mousemove', this.handleMouseMove);
    this.held.clear();
    this.buttons.clear();
    this.pressedEdges.clear();
  }

  private isActionHeld(action: keyof typeof BINDINGS): boolean {
    for (const code of BINDINGS[action]) {
      if (this.held.has(code)) return true;
    }
    return false;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const action = CODE_TO_ACTION.get(event.code);
    if (!action) return;
    // Stop the page from scrolling on Space and from triggering browser shortcuts.
    if (SUPPRESS_DEFAULT.includes(action)) event.preventDefault();
    if (event.repeat) return;
    this.held.add(event.code);
    this.pressedEdges.add(action);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  /** Losing focus must clear held keys, or the player runs forever. */
  private readonly handleBlur = (): void => {
    this.held.clear();
    this.buttons.clear();
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (!this.locked) {
      this.requestLock();
      return;
    }
    event.preventDefault();
    this.buttons.add(event.button);
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    this.buttons.delete(event.button);
  };

  private readonly handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.pendingLookX += event.movementX;
    this.pendingLookY += event.movementY;
  };

  private readonly handlePointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    // Held state is meaningless across a lock boundary, and a stuck fire button
    // after an Esc-then-Esc sequence is a classic bug.
    this.held.clear();
    this.buttons.clear();
    this.onLockChange?.(this.locked);
  };

  /** Some engines report a refusal only through this event, with no reason attached. */
  private readonly handlePointerLockError = (): void => {
    this.reportLockFailure('浏览器触发了 pointerlockerror，但没有给出原因');
  };

  /** Hands a refusal reason to the host, if anyone is listening. */
  private reportLockFailure(reason: string): void {
    // A rejection can land after teardown (the callback is a microtask, `dispose`
    // is synchronous), so nothing may be reported through a disposed instance.
    if (this.disposed) return;
    this.onLockError?.(reason);
  }
}

/**
 * Turns a pointer-lock rejection into a line a player can act on.
 *
 * Pure and exported so the mapping is unit-testable. This matters more than usual
 * here: the failure it describes leaves the screen completely unchanged, so if the
 * text is wrong or empty there is no other witness that anything was refused.
 */
export function describeLockFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.trim() === '' ? '浏览器没有说明拒绝原因' : reason;
}
