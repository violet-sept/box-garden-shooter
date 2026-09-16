/**
 * The wiring between the event bus and the mixer.
 *
 * Kept out of `main.ts` (which is already the composition root for everything else)
 * and out of the mixer (which must stay ignorant of game events) so that the one
 * interesting decision here is visible on its own: **the sound is started inside the
 * event callback**, not collected and played on the next render frame.
 *
 * That is not a micro-optimisation. A subscriber runs inside the simulation tick that
 * emitted the event, so "start it now" puts the noise on the audio clock at the same
 * moment the muzzle flash is spawned. Deferring to the render callback adds up to a
 * frame — 16.7 ms — which is the entire tolerance budget the technical plan gives
 * the SFX channel (±1 frame). The phase-3 `[HITLOG]` instrumentation then reports
 * the frame delta for every shot, so `sfx` becomes a reading rather than an opinion.
 */

import type { GameEventName, GameEvents } from '../../core/events';
import type { AudioMixer } from './mixer';
import { soundRequestsForAny } from './triggers';

/** The subset of the event bus this module needs. */
export interface AudioEventSource {
  on<K extends GameEventName>(name: K, handler: (payload: GameEvents[K]) => void): () => void;
}

/** Options for {@link attachAudio}. */
export interface AttachAudioOptions {
  readonly events: AudioEventSource;
  readonly mixer: AudioMixer;
  /**
   * Called once per event that produced at least one sound, with that event's
   * simulation tick and the number of sounds requested.
   *
   * This is the hook the `[HITLOG]` sfx channel hangs off. It reports the tick the
   * event carried rather than a fresh timestamp, because the question the log
   * answers is "was the sound decided on the frame of the event", and a wall-clock
   * sample taken here would answer a different one.
   */
  readonly onSound?: (tick: number, count: number) => void;
}

/**
 * The events that can make a noise.
 *
 * An explicit list rather than a wildcard subscription: the bus has no wildcard
 * (deliberately — see `core/events.ts`), and enumerating the audible events here
 * means "what does this game sound like" is answerable by reading one array.
 */
const AUDIBLE_EVENTS: readonly GameEventName[] = [
  'shot:fired',
  'hit:registered',
  'player:damaged',
  'enemy:telegraph',
  'enemy:shot',
  'enemy:shotEnded',
  'enemy:died',
  'spawn:pending',
  'weapon:magazineEmpty',
  'weapon:reloadStarted',
  'weapon:reloadFinished',
  'item:thrown',
  'item:exploded',
  'assault:started',
  'field:cleared',
  'boss:spawned',
  'run:victory',
  'run:defeat',
];

/** The payload shape every game event shares. */
interface TickPayload {
  readonly tick: number;
}

/**
 * Subscribes the mixer to the audible events.
 *
 * @returns An unsubscribe function for every subscription it made.
 */
export function attachAudio(options: AttachAudioOptions): () => void {
  const { events, mixer, onSound } = options;
  /**
   * The bus subscription helper, **bound to the bus**.
   *
   * The cast is needed because the catalogue is not uniform: `debug:enabled` carries
   * `{ enabled }` rather than `{ tick }`, so the union of all payloads is wider than the
   * `tick`-shaped one this loop uses. Every event in {@link AUDIBLE_EVENTS} does carry
   * `tick`, which is what makes the loosened signature sound for this call site only.
   *
   * `.bind(events)` is **load-bearing, not decoration**. Without it this is a detached
   * method reference, and an ES module is *always* strict, so `this` is `undefined`
   * inside it: the very first subscription throws
   * `Cannot read properties of undefined (reading 'handlers')`. `bootGame()` calls this
   * before it registers the veil's click listener, so the game died right there — veil
   * up, every click ignored. It survived two phases because no test ever handed this
   * module a real `EventBus`; see technical plan §5.14.
   */
  const on = events.on.bind(events) as unknown as (
    name: GameEventName,
    handler: (payload: TickPayload) => void,
  ) => () => void;

  const offs = AUDIBLE_EVENTS.map((name) =>
    on(name, (payload) => {
      const requests = soundRequestsForAny(name, payload as GameEvents[GameEventName]);
      if (requests.length === 0) return;
      mixer.playAll(requests);
      onSound?.(payload.tick, requests.length);
    }),
  );

  return () => {
    for (const off of offs) off();
  };
}
