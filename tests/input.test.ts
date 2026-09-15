/**
 * Input layer: the pointer-lock failure path.
 *
 * The rest of `InputState` is a straight mapping from DOM events to an intent snapshot,
 * and the world tests drive that end to end. What is pinned here is the one thing they
 * cannot see: a **refused** pointer lock.
 *
 * Nothing on screen changes when a lock is refused. The veil is static markup, so the
 * page simply sits there ignoring clicks — which is also exactly what a page whose
 * script never executed looks like. Before `onLockError` existed, the rejected promise
 * was discarded inside `requestLock`, so the game was dead with no symptom a player
 * could report and no picture an assertion could read (technical plan §5.13).
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
