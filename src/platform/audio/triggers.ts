/**
 * Event → sound mapping and the mixing *rules*, as pure functions.
 *
 * The split this file exists for: the presentation layer subscribes to the event
 * bus, and everything about "should this make a noise, how loud, at what priority,
 * and may it repeat yet" is decided here, in data, with no `AudioContext` in sight.
 * The mixer (`mixer.ts`) is then a dumb executor: hand it a request and it makes a
 * noise. That is what lets the interesting half — the mapping table, the layering,
 * the throttle windows, the concurrency cap, the mute rule — be asserted in Node,
 * where there is no audio stack at all.
 *
 * Two rules from the phase-4 hard list live here:
 *
 *   9. A telegraph's sound must land on the same frame as the telegraph. Since the
 *      event callback runs inside the tick that emitted it, the request is handed
 *      to the audio clock immediately — nothing is queued for the render frame.
 *  13. Audio only ever *subscribes*. Nothing in `src/game/**` knows this module
 *      exists.
 */

import {
  AUDIO,
  SOUND_SPECS,
  type AudioBus,
  type AudioThrottleKey,
  type SoundId,
  type SoundSpec,
} from '../../core/config';
import type { GameEventName, GameEvents } from '../../core/events';

/** One sound to play. Derived from a {@link SoundSpec}; it carries no Web Audio state. */
export interface SoundRequest {
  readonly id: SoundId;
  readonly spec: SoundSpec;
  readonly bus: AudioBus;
  /** Gain relative to the bus, `[0, 1]`. */
  readonly gain: number;
  /** Higher wins the concurrency budget. */
  readonly priority: number;
  /** Pitch randomisation to apply, `[0, 1]`. */
  readonly pitchJitter: number;
  /** Throttle class, or `null` when the sound may repeat freely. */
  readonly throttle: AudioThrottleKey | null;
}

/** Builds a request from the recipe table. Every numeric field comes from config. */
function makeRequest(id: SoundId): SoundRequest {
  const spec = SOUND_SPECS[id];
  return {
    id,
    spec,
    bus: spec.bus,
    gain: spec.gain,
    priority: spec.priority,
    pitchJitter: spec.jitter,
    throttle: spec.throttle,
  };
}

/** One request per sound, built once: the hot path allocates nothing. */
export const SOUND_REQUESTS: Readonly<Record<SoundId, SoundRequest>> = Object.fromEntries(
  (Object.keys(SOUND_SPECS) as SoundId[]).map((id) => [id, makeRequest(id)]),
) as Record<SoundId, SoundRequest>;

/** Pre-built return values, so a burst of gunfire allocates no arrays. */
const NONE: readonly SoundRequest[] = Object.freeze([]);
const SHOT: readonly SoundRequest[] = Object.freeze([SOUND_REQUESTS.shot, SOUND_REQUESTS.shotTail]);
const WEAK_POINT_HIT: readonly SoundRequest[] = Object.freeze([SOUND_REQUESTS.hitBody, SOUND_REQUESTS.hitHead]);
const SINGLE: Readonly<Record<SoundId, readonly SoundRequest[]>> = Object.fromEntries(
  (Object.keys(SOUND_SPECS) as SoundId[]).map((id) => [id, Object.freeze([SOUND_REQUESTS[id]])]),
) as Record<SoundId, readonly SoundRequest[]>;

function only(id: SoundId): readonly SoundRequest[] {
  return SINGLE[id];
}

/**
 * The mapping, as a switch rather than a table.
 *
 * A static table cannot express the cases that carry their meaning in the payload:
 * a weak-point hit is a different sound from a body hit, the Warden's death is not
 * the Stalker's, and the Warden's attack says three different things on its way out
 * (charge, fired, struck). Every branch is a decision about *information*, and the
 * numbers behind each one stay in `SOUND_SPECS`.
 *
 * Returning an empty array is a deliberate answer, not a gap: `bullet:impact` is
 * not sounded separately because it fires ten times a second and carries almost no
 * information — it is folded into the shot's tail instead (stage-4 §3.5, priority
 * P3). Same for `boss:died`, which is already covered by the Warden's `enemy:died`.
 */
export function soundRequestsForAny(
  name: GameEventName,
  payload: GameEvents[GameEventName],
): readonly SoundRequest[] {
  switch (name) {
    case 'shot:fired':
      return SHOT;

    case 'hit:registered': {
      const hit = payload as GameEvents['hit:registered'];
      // A weak-point hit gets the impact *plus* a bright ping: the multiplier's
      // reward is otherwise only a number on screen, and the whole point of the
      // 2.8x headshot multiplier is to make the player stop and aim.
      return hit.zone === 'head' ? WEAK_POINT_HIT : only('hitBody');
    }

    case 'player:damaged':
      return only('playerHurt');

    case 'enemy:telegraph': {
      const telegraph = payload as GameEvents['enemy:telegraph'];
      if (telegraph.kind === 'melee') return only('enemyTelegraphMelee');
      // The Warden's charge alarm: "he is committing". What happens next has its own
      // events, because a single attack that fires, flies and lands is three pieces of
      // information the player acts on differently.
      return only('enemyTelegraphShot');
    }

    case 'enemy:shot':
      return only('enemyShotFired');

    case 'enemy:shotEnded':
      // Only the shot that went through the player gets the boom. One that stopped on a
      // crate is a visual (the yellow flash); sounding the heaviest, ducking-priority
      // impact for it would tell the player they were hit when they were not.
      return (payload as GameEvents['enemy:shotEnded']).hitPlayer ? only('enemyShotHit') : NONE;

    case 'enemy:died': {
      const died = payload as GameEvents['enemy:died'];
      return only(died.archetype === 'large' ? 'bossDied' : 'enemyDied');
    }

    case 'spawn:pending': {
      const pending = payload as GameEvents['spawn:pending'];
      return only(pending.archetype === 'large' ? 'spawnPendingBoss' : 'spawnPending');
    }

    case 'weapon:magazineEmpty':
      return only('magazineEmpty');
    case 'weapon:reloadStarted':
      return only('reloadStarted');
    case 'weapon:reloadFinished':
      return only('reloadFinished');

    case 'item:thrown':
      return only('itemThrown');
    case 'item:exploded':
      return only('itemExploded');

    case 'wave:started':
      return only('waveStarted');
    case 'wave:cleared':
      return only('waveCleared');
    case 'boss:spawned':
      return only('bossSpawned');

    case 'run:victory':
      return only('runVictory');
    case 'run:defeat':
      return only('runDefeat');

    default:
      // `bullet:impact`, `bullet:miss`, `enemy:damaged`, `enemy:spawned`,
      // `boss:died`, `target:*`, `player:died`, `weapon:reloadCancelled`,
      // `player:adsChanged`, `debug:enabled`: intentionally silent.
      return NONE;
  }
}

/**
 * Typed front door for {@link soundRequestsForAny}.
 *
 * Kept as a one-line wrapper rather than making the switch itself generic: the
 * switch has to narrow the payload by hand for each case anyway, and the generic
 * signature is what the tests want while the attach loop wants the loose one.
 */
export function soundRequestsFor<K extends GameEventName>(
  name: K,
  payload: GameEvents[K],
): readonly SoundRequest[] {
  return soundRequestsForAny(name, payload as GameEvents[GameEventName]);
}

/**
 * The gain a request actually plays at.
 *
 * Three multiplications, in this order: the recipe's own gain, its bus gain (so
 * "the gun is too loud" is one number), and the master. Muting multiplies by zero
 * rather than suppressing the request, because a muted game must still *generate*
 * its requests — otherwise unmuting would silently lose whatever happened while
 * muted, and the `[HITLOG]` sfx channel would go quiet exactly when it is being
 * used to debug a mute bug.
 */
export function mixGain(
  request: SoundRequest,
  masterVolume: number,
  muted: boolean,
  busGain: Readonly<Record<AudioBus, number>> = AUDIO.busGain,
): number {
  if (muted) return 0;
  return clamp01(request.gain * (busGain[request.bus] ?? 1) * clamp01(masterVolume));
}

/** The rules for dropping requests, as a small stateful object with no audio in it. */
export interface SoundPolicy {
  /**
   * Filters a batch of requests.
   *
   * Drops (a) anything inside its throttle window and (b) anything past the
   * concurrency budget, lowest priority first. Mute is *not* applied here — see
   * {@link mixGain}.
   */
  admit(requests: readonly SoundRequest[], now: number): readonly SoundRequest[];
  /**
   * Whether one request may play right now.
   *
   * The single-request form exists because the mixer's hot path is one request at
   * a time (a shot), and going through {@link admit} would allocate an array ten
   * times a second for no reason.
   */
  admitOne(request: SoundRequest, now: number): boolean;
  /** Records that a request actually started: opens its throttle window and takes a voice. */
  started(request: SoundRequest, now: number): void;
  /** Records that a voice finished, freeing its slot. */
  finished(): void;
  /** Voices currently sounding, as far as this policy has been told. */
  activeCount(): number;
  /** Forgets the throttle history and every active voice. Used on run restart. */
  reset(): void;
}

/** Options for {@link createSoundPolicy}. Defaults come from the tuning table. */
export interface SoundPolicyOptions {
  readonly maxConcurrentSources?: number;
  readonly throttleMs?: Readonly<Record<AudioThrottleKey, number>>;
}

/**
 * Creates the request filter.
 *
 * Kept separate from the mixer so the two things that actually go wrong — a sound
 * that repeats too fast, and one that starves because the budget is full — are
 * testable with a fake clock and no audio device.
 */
export function createSoundPolicy(options: SoundPolicyOptions = {}): SoundPolicy {
  const maxSources = options.maxConcurrentSources ?? AUDIO.maxConcurrentSources;
  const windows = options.throttleMs ?? AUDIO.throttleMs;
  /** Last time each throttle class fired, in seconds on the caller's clock. */
  const lastFired = new Map<AudioThrottleKey, number>();
  let active = 0;

  /** True when `request`'s throttle window is still open. Does not write state. */
  const throttled = (request: SoundRequest, now: number): boolean => {
    if (request.throttle === null) return false;
    const windowSeconds = (windows[request.throttle] ?? 0) / 1000;
    const previous = lastFired.get(request.throttle);
    return previous !== undefined && now - previous < windowSeconds;
  };

  return {
    admit(requests, now) {
      if (requests.length === 0) return requests;

      // --- Throttle -----------------------------------------------------------
      const allowed: SoundRequest[] = [];
      for (const request of requests) {
        if (throttled(request, now)) continue;
        allowed.push(request);
      }
      if (allowed.length === 0) return allowed;

      // --- Concurrency --------------------------------------------------------
      // Highest priority first, so an explosion is never the thing that gets
      // dropped because a burst of gunfire happened to arrive in the same tick.
      // Ties keep their original order (they are the same sound, so it does not
      // matter which one survives, only that one of them does).
      const room = Math.max(0, maxSources - active);
      if (allowed.length <= room) return allowed;
      if (room === 0) return [];
      const ranked = allowed
        .map((request, index) => ({ request, index }))
        .sort((a, b) => b.request.priority - a.request.priority || a.index - b.index)
        .slice(0, room)
        .sort((a, b) => a.index - b.index);
      return ranked.map((entry) => entry.request);
    },

    admitOne(request, now) {
      if (active >= maxSources) return false;
      return !throttled(request, now);
    },

    started(request, now) {
      if (request.throttle !== null) lastFired.set(request.throttle, now);
      active += 1;
    },

    finished() {
      active = Math.max(0, active - 1);
    },

    activeCount() {
      return active;
    },

    reset() {
      lastFired.clear();
      active = 0;
    },
  };
}

/** Clamps to `[0, 1]`; non-finite input becomes 0 rather than NaN-propagating into a gain. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
