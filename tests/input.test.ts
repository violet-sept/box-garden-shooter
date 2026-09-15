/**
 * Input layer: the pointer-lock failure path, and mouse look.
 *
 * Two things are pinned here, and both of them are *wiring* rather than arithmetic,
 * which is why nothing else in the suite covers them:
 *
 *   - a **refused** pointer lock. Nothing on screen changes when a lock is refused: the
 *     veil is static markup, so the page simply sits there ignoring clicks — which is
 *     also exactly what a page whose script never executed looks like. Before
 *     `onLockError` existed, the rejected promise was discarded inside `requestLock`, so
 *     the game was dead with no symptom a player could report and no picture an assertion
 *     could read (technical plan §5.13).
 *   - **mouse look reaching the simulation**. `InputState` accumulated the motion and then
 *     required the caller to fold it in with `update()`; the composition root never called
 *     it, so the camera could not be turned at all. The tests that existed called
 *     `update()` themselves, which is precisely how a method only the tests call keeps
 *     passing. See technical plan §5.16.
 *
 * `window` and `document` are stubbed per test and restored afterwards, following the
 * `globalThis.location` precedent in `perf.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeLockFailure, InputState } from '#/core/input';

type Listener = (event: unknown) => void;

/** A minimal `EventTarget` stand-in that also remembers what is attached to it. */
function makeTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    /** How many listeners of `type` are still attached. */
    count(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
    addEventListener(type: string, listener: Listener): void {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: Listener): void {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string, event: unknown = {}): void {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
  };
}

/** A canvas stand-in whose lock request is whatever the test wants it to be. */
function makeCanvas(requestPointerLock: () => unknown): HTMLCanvasElement {
  return Object.assign(makeTarget(), { requestPointerLock }) as unknown as HTMLCanvasElement;
}

describe('pointer-lock refusal reporting', () => {
  let windowStub: ReturnType<typeof makeTarget>;
  let documentStub: ReturnType<typeof makeTarget> & { pointerLockElement: unknown };
  let savedWindow: PropertyDescriptor | undefined;
  let savedDocument: PropertyDescriptor | undefined;

  beforeEach(() => {
    windowStub = makeTarget();
    documentStub = Object.assign(makeTarget(), { pointerLockElement: null });
    savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { value: windowStub, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true, writable: true });
  });

  afterEach(() => {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  /** Lets the `requestLock` rejection and its handler run. */
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('reports the reason when the browser rejects the request', async () => {
    const reasons: string[] = [];
    const canvas = makeCanvas(() => Promise.reject(new Error('not allowed to use the Pointer Lock API')));
    const input = new InputState(canvas, undefined, (reason) => reasons.push(reason));

    input.requestLock();
    await settle();

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('Pointer Lock API');
  });

  it('reports a refusal that arrives as an event instead of a rejection', () => {
    const reasons: string[] = [];
    // Older engines return nothing from `requestPointerLock` and only fire the event.
    new InputState(makeCanvas(() => undefined), undefined, (reason) => reasons.push(reason));

    documentStub.fire('pointerlockerror');

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('pointerlockerror');
  });

  it('stays quiet when the request is accepted', async () => {
    const reasons: string[] = [];
    const input = new InputState(makeCanvas(() => Promise.resolve()), undefined, (reason) => reasons.push(reason));

    input.requestLock();
    await settle();

    expect(reasons).toHaveLength(0);
  });

  it('ignores a second request while the pointer is already locked', () => {
    let requests = 0;
    const canvas = makeCanvas(() => {
      requests += 1;
      return undefined;
    });
    const locks: boolean[] = [];
    const input = new InputState(canvas, (locked) => locks.push(locked));

    documentStub.pointerLockElement = canvas;
    documentStub.fire('pointerlockchange');
    input.requestLock();

    expect(locks).toEqual([true]);
    expect(requests).toBe(0);
  });

  it('does not throw when the host is not listening for refusals', async () => {
    const canvas = makeCanvas(() => Promise.reject(new Error('refused')));
    // No callbacks at all: the point is that the wiring tolerates a host that only wants
    // the lock and nothing else. The request still has to be made for the refusal to exist.
    new InputState(canvas).requestLock();

    await expect(settle()).resolves.toBeUndefined();
    // The listener is attached either way: a host that passes no callback today can
    // still be given one later without the wiring changing.
    expect(documentStub.count('pointerlockerror')).toBe(1);
  });

  it('drops a refusal that lands after dispose', async () => {
    const reasons: string[] = [];
    // Held in an object because the rejection arrives through a closure, and a plain
    // `let` would still read as its initial `null` at the call site below.
    const pending: { reject: ((error: unknown) => void) | null } = { reject: null };
    const canvas = makeCanvas(
      () =>
        new Promise((_resolve, rejectFn) => {
          pending.reject = rejectFn;
        }),
    );
    const input = new InputState(canvas, undefined, (reason) => reasons.push(reason));

    input.requestLock();
    input.dispose();
    pending.reject?.(new Error('arrived too late'));
    await settle();

    expect(reasons).toHaveLength(0);
  });

  it('unhooks every listener on dispose, including the refusal channel', () => {
    const input = new InputState(makeCanvas(() => undefined));
    input.dispose();

    expect(documentStub.count('pointerlockerror')).toBe(0);
    expect(documentStub.count('pointerlockchange')).toBe(0);
    expect(documentStub.count('mousemove')).toBe(0);
    expect(windowStub.count('keydown')).toBe(0);

    // And a refusal that arrives afterwards is simply gone, not reported twice.
    const reasons: string[] = [];
    const second = new InputState(makeCanvas(() => undefined), undefined, (reason) => reasons.push(reason));
    second.dispose();
    documentStub.fire('pointerlockerror');
    expect(reasons).toHaveLength(0);
  });
});

describe('describeLockFailure', () => {
  it('uses the message of an Error', () => {
    expect(describeLockFailure(new Error('The user has exited the lock'))).toBe('The user has exited the lock');
  });

  it('passes through a bare string, which is what some engines reject with', () => {
    expect(describeLockFailure('SecurityError')).toBe('SecurityError');
  });

  it('never reports an empty reason', () => {
    // A blank line on the veil is indistinguishable from "nothing was wrong", which is
    // the one outcome this whole path exists to prevent.
    expect(describeLockFailure(new Error('   '))).not.toBe('');
    expect(describeLockFailure('')).not.toBe('');
  });

  it('describes a rejection that is not an Error at all', () => {
    expect(describeLockFailure(undefined)).toBe('undefined');
    expect(describeLockFailure({ code: 5 })).toContain('object');
  });
});

/**
 * Mouse look.
 *
 * This is the wiring side of the look input, and it is tested here because it shipped
 * broken in a way nothing else could see: `InputState` had an `update()` that folded the
 * accumulated motion into the tick, and the composition root never called it — so the
 * camera could not be turned with the mouse **at all**, while every unit test passed,
 * because the tests called `update()` themselves.
 *
 * The assertions below are therefore written as "one read, no other call in between". If
 * the fold ever moves back out of `sample()`, this goes red instead of the game.
 */
describe('mouse look', () => {
  let windowStub: ReturnType<typeof makeTarget>;
  let documentStub: ReturnType<typeof makeTarget> & { pointerLockElement: unknown };
  let savedWindow: PropertyDescriptor | undefined;
  let savedDocument: PropertyDescriptor | undefined;

  beforeEach(() => {
    windowStub = makeTarget();
    documentStub = Object.assign(makeTarget(), { pointerLockElement: null });
    savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { value: windowStub, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true, writable: true });
  });

  afterEach(() => {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  /** An input whose pointer is already locked, which is the state a player plays in. */
  function locked(): InputState {
    const canvas = makeCanvas(() => undefined);
    const input = new InputState(canvas);
    documentStub.pointerLockElement = canvas;
    documentStub.fire('pointerlockchange');
    expect(input.isLocked).toBe(true);
    return input;
  }

  it('carries a mouse move into the next intent with no other call in between', () => {
    const input = locked();
    documentStub.fire('mousemove', { movementX: 12, movementY: -4 });

    const intent = input.sample();

    expect(intent.lookDeltaX).toBe(12);
    expect(intent.lookDeltaY).toBe(-4);
  });

  it('sums every move that arrived during the tick', () => {
    const input = locked();
    documentStub.fire('mousemove', { movementX: 3, movementY: 1 });
    documentStub.fire('mousemove', { movementX: 4, movementY: 2 });
    documentStub.fire('mousemove', { movementX: -1, movementY: 0 });

    const intent = input.sample();

    expect(intent.lookDeltaX).toBe(6);
    expect(intent.lookDeltaY).toBe(3);
  });

  it('hands one flick to exactly one tick', () => {
    const input = locked();
    documentStub.fire('mousemove', { movementX: 40, movementY: 0 });

    // Reading twice inside the same tick gives the same answer: the motion is not
    // consumed by a read, it is consumed by the tick ending.
    expect(input.sample().lookDeltaX).toBe(40);
    expect(input.sample().lookDeltaX).toBe(40);

    input.endTick();

    // The next tick must not turn again — a leak here is a camera that keeps spinning
    // for as long as the player holds the mouse still.
    expect(input.sample().lookDeltaX).toBe(0);
    expect(input.sample().lookDeltaY).toBe(0);
  });

  it('ignores the mouse entirely while the pointer is not locked', () => {
    const input = new InputState(makeCanvas(() => undefined));
    documentStub.fire('mousemove', { movementX: 99, movementY: 99 });

    const intent = input.sample();

    expect(intent.lookDeltaX).toBe(0);
    expect(intent.lookDeltaY).toBe(0);
  });

  it('drops motion that was still in flight when the lock ended', () => {
    // Esc during a flick: the pixels gathered before the boundary belong to the session that
    // just ended. Applying them to the next run would be a camera that jumps on re-entry.
    const canvas = makeCanvas(() => undefined);
    const input = new InputState(canvas);
    documentStub.pointerLockElement = canvas;
    documentStub.fire('pointerlockchange');
    documentStub.fire('mousemove', { movementX: 25, movementY: -9 });

    documentStub.pointerLockElement = null;
    documentStub.fire('pointerlockchange');

    expect(input.sample().lookDeltaX).toBe(0);
    expect(input.sample().lookDeltaY).toBe(0);
  });
});

/**
 * The view toggle (`V`).
 *
 * Tested here rather than only in the camera tests because the interesting failure is a *wiring*
 * one, and this project has shipped two of those already: a key that reaches no binding, and an
 * edge that leaks across ticks. `InputIntent.toggleView` must be true on exactly the tick the key
 * went down — a level that stayed true would rewrite the camera mode sixty times a second, and
 * which mode the player ended up in would depend on how long they leaned on the key.
 */
describe('view toggle key', () => {
  let windowStub: ReturnType<typeof makeTarget>;
  let documentStub: ReturnType<typeof makeTarget> & { pointerLockElement: unknown };
  let savedWindow: PropertyDescriptor | undefined;
  let savedDocument: PropertyDescriptor | undefined;

  beforeEach(() => {
    windowStub = makeTarget();
    documentStub = Object.assign(makeTarget(), { pointerLockElement: null });
    savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { value: windowStub, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true, writable: true });
  });

  afterEach(() => {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });

  it('maps V onto a one-shot toggle in the next intent', () => {
    const input = new InputState(makeCanvas(() => undefined));

    windowStub.fire('keydown', { code: 'KeyV', repeat: false });
    expect(input.sample().toggleView).toBe(true);
    // The world also reads it through `wasPressed`, which is how the composition root applies it.
    expect(input.wasPressed('toggleView')).toBe(true);

    input.endTick();
    expect(input.sample().toggleView).toBe(false);
    expect(input.wasPressed('toggleView')).toBe(false);
  });

  it('does not treat a held key as a new press', () => {
    // The browser's own auto-repeat must not read as "the player pressed it again", or holding V
    // for a second would flip the view dozens of times.
    const input = new InputState(makeCanvas(() => undefined));

    windowStub.fire('keydown', { code: 'KeyV', repeat: false });
    input.endTick();
    windowStub.fire('keydown', { code: 'KeyV', repeat: true });

    expect(input.sample().toggleView).toBe(false);

    // A genuine release-and-press is a new edge.
    windowStub.fire('keyup', { code: 'KeyV' });
    windowStub.fire('keydown', { code: 'KeyV', repeat: false });
    expect(input.sample().toggleView).toBe(true);
  });

  it('needs no pointer lock, unlike the mouse', () => {
    // Deliberate: the view key is a keyboard gesture, and the composition root applies it inside
    // the same `locked` guard as the other key actions. Asserted here so that a future change
    // which silences it while the pointer is free is a decision rather than an accident.
    const input = new InputState(makeCanvas(() => undefined));
    expect(input.isLocked).toBe(false);
    windowStub.fire('keydown', { code: 'KeyV', repeat: false });
    expect(input.sample().toggleView).toBe(true);
  });
});
