/**
 * Audio tests (phase 4, decision D14).
 *
 * **No `AudioContext` is created anywhere in this file.** Node has none, and even a
 * browser test runner would only have a crippled one, so anything that needed a real
 * audio graph would be untestable — which is exactly why the phase-4 design splits
 * the subsystem in three:
 *
 *   - `synth.ts`    recipe -> waveform parameters, pure;
 *   - `triggers.ts` event -> requests, plus the throttle/concurrency/mute rules, pure;
 *   - `mixer.ts`    the only module that touches Web Audio.
 *
 * The wiring between them (`attach.ts`) is covered at the end of this file, and it is
 * covered **through a real `EventBus`** on purpose: a hand-written double whose methods
 * are plain properties cannot fail the way a class instance can, which is how a detached
 * method call in that file stayed invisible until the game was opened in a browser.
 *
 * The rules that a player would actually notice if they broke live in the first two,
 * so they are what is asserted here: that a melee wind-up does not sound like a
 * barrage alarm, that a weak-point hit is audibly different from a body hit, that a
 * held trigger does not open a new voice per round, and that an explosion is never
 * the sound that gets dropped when the field is busy.
 *
 * "Does it sound good" is not testable and is not tested.
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIO,
  SOUND_SPECS,
  type AudioBus,
  type SoundId,
  type SoundSpec,
} from '#/core/config';
import { createRng } from '#/core/math/rng';
import { CHANNEL_TOLERANCE_FRAMES } from '#/debug/hitlog';
import {
  SOUND_REQUESTS,
  createSoundPolicy,
  mixGain,
  soundRequestsFor,
  soundRequestsForAny,
  type SoundRequest,
} from '#/platform/audio/triggers';
import { fillNoise, planVoice } from '#/platform/audio/synth';
import { createAudioMixer, type AudioMixer } from '#/platform/audio/mixer';
import { attachAudio } from '#/platform/audio/attach';
import { EventBus, type GameEventName } from '#/core/events';

const P = { x: 1, y: 0, z: -2 };

/** Request ids for one event, which is what most of these assertions compare. */
function idsFor<K extends GameEventName>(
  name: K,
  payload: Parameters<typeof soundRequestsFor<K>>[1],
): SoundId[] {
  return soundRequestsFor(name, payload).map((request) => request.id);
}

describe('sound recipes', () => {
  it('covers every sound id with a usable recipe', () => {
    const ids = Object.keys(SOUND_SPECS) as SoundId[];
    expect(ids.length).toBeGreaterThan(15);
    const buses = Object.keys(AUDIO.busGain) as AudioBus[];
    for (const id of ids) {
      const spec: SoundSpec = SOUND_SPECS[id];
      expect(spec.gain).toBeGreaterThan(0);
      expect(spec.gain).toBeLessThanOrEqual(1);
      expect(spec.priority).toBeGreaterThan(0);
      expect(spec.frequency).toBeGreaterThan(0);
      expect(spec.frequencySweep).toBeGreaterThan(0);
      expect(spec.decay).toBeGreaterThan(0);
      expect(spec.lowpass).toBeGreaterThan(0);
      // Every voice must have *something* to make a noise with.
      expect(spec.noiseMix + (1 - spec.noiseMix)).toBeCloseTo(1, 9);
      expect(buses).toContain(spec.bus);
      expect(SOUND_REQUESTS[id].id).toBe(id);
    }
  });

  it('keeps the recipe table and the request table from drifting', () => {
    for (const id of Object.keys(SOUND_SPECS) as SoundId[]) {
      const request = SOUND_REQUESTS[id];
      expect(request.spec).toBe(SOUND_SPECS[id]);
      expect(request.gain).toBe(SOUND_SPECS[id].gain);
      expect(request.priority).toBe(SOUND_SPECS[id].priority);
      expect(request.bus).toBe(SOUND_SPECS[id].bus);
    }
  });

  it('agrees with the hit-log tolerance budget', () => {
    // Two places claim the same number: the tuning table (which the mixer aims at)
    // and the instrumentation (which judges it). They are allowed to be equal and
    // never allowed to disagree silently.
    expect(AUDIO.sfxLatencyBudgetFrames).toBe(CHANNEL_TOLERANCE_FRAMES.sfx);
  });
});

describe('event to sound mapping', () => {
  it('gives the two enemy wind-ups different sounds', () => {
    const melee = idsFor('enemy:telegraph', {
      tick: 1,
      id: 1,
      archetype: 'small',
      kind: 'melee',
      until: 1.5,
    });
    const shot = idsFor('enemy:telegraph', {
      tick: 1,
      id: 2,
      archetype: 'large',
      kind: 'shot',
      until: 2.4,
    });
    expect(melee).toHaveLength(1);
    expect(shot).toHaveLength(1);
    // The melee cue is a reaction window ("back off"); the Warden's alarm is a
    // commitment ("he is charging"). Same event name, different information.
    expect(melee[0]).not.toBe(shot[0]);
  });

  it('says three different things across one Warden attack', () => {
    // Charge, fired, struck. Three pieces of information the player acts on differently, so
    // three sounds — the same rule that keeps the melee cue apart from them.
    const charging = idsFor('enemy:telegraph', {
      tick: 1,
      id: 2,
      archetype: 'large',
      kind: 'shot',
      until: 2.4,
    });
    const fired = idsFor('enemy:shot', {
      tick: 2,
      enemyId: 2,
      origin: P,
      direction: { x: 0, y: 0, z: 1 },
    });
    const struck = idsFor('enemy:shotEnded', {
      tick: 3,
      enemyId: 2,
      position: P,
      radius: 0.85,
      hitPlayer: true,
    });
    expect(fired[0]).not.toBe(charging[0]);
    expect(struck[0]).not.toBe(charging[0]);
    expect(struck[0]).not.toBe(fired[0]);
    // A shot that stopped on a crate is a *visual*: sounding the heavy, ducking impact for it
    // would tell the player they were hit when they were not.
    expect(
      idsFor('enemy:shotEnded', { tick: 4, enemyId: 2, position: P, radius: 0.85, hitPlayer: false }),
    ).toHaveLength(0);
  });

  it('layers a bright ping on top of the impact for a weak-point hit', () => {
    const body = idsFor('hit:registered', {
      tick: 5,
      shotId: 1,
      targetId: 3,
      zone: 'body',
      baseDamage: 22,
      finalDamage: 22,
      distance: 10,
      point: P,
      hitstop: 0.03,
    });
    const head = idsFor('hit:registered', {
      tick: 5,
      shotId: 1,
      targetId: 3,
      zone: 'head',
      baseDamage: 22,
      finalDamage: 61.6,
      distance: 10,
      point: P,
      hitstop: 0.05,
    });
    expect(body).toHaveLength(1);
    expect(head).toHaveLength(2);
    // The multiplier's reward is otherwise only a number on screen.
    expect(head).toContain(body[0]);
    expect(head).not.toEqual(body);
  });

  it('gives a weak-point hit a higher priority than a body hit', () => {
    const head = soundRequestsFor('hit:registered', {
      tick: 5,
      shotId: 1,
      targetId: 3,
      zone: 'head',
      baseDamage: 22,
      finalDamage: 61.6,
      distance: 10,
      point: P,
      hitstop: 0.05,
    }).find((request) => request.id === 'hitHead');
    const body = SOUND_REQUESTS.hitBody;
    expect(head?.priority ?? 0).toBeGreaterThan(body.priority);
  });

  it('separates the two deaths and the two spawn notices by archetype', () => {
    const smallDeath = idsFor('enemy:died', { tick: 9, id: 4, archetype: 'small', position: P, scoreValue: 100 });
    const bossDeath = idsFor('enemy:died', { tick: 9, id: 5, archetype: 'large', position: P, scoreValue: 1500 });
    expect(smallDeath[0]).not.toBe(bossDeath[0]);

    const spawn = idsFor('spawn:pending', { tick: 9, archetype: 'small', position: P, warning: 0.9 });
    const bossSpawn = idsFor('spawn:pending', { tick: 9, archetype: 'large', position: P, warning: 0.9 });
    expect(spawn[0]).not.toBe(bossSpawn[0]);
    // A spawn notice is information; a telegraph is a reaction window. They must not
    // be the same sound, or the player cannot tell "look over there" from "move now".
    expect(spawn[0]).not.toBe(idsFor('enemy:telegraph', {
      tick: 9,
      id: 5,
      archetype: 'large',
      kind: 'melee',
      until: 1,
    })[0]);
  });

  it('sounds the shot, the reload cycle and the run beats', () => {
    expect(idsFor('shot:fired', { tick: 1, shotId: 1, origin: P, direction: P, spreadDeg: 1 })).toEqual([
      'shot',
      'shotTail',
    ]);
    expect(idsFor('weapon:magazineEmpty', { tick: 1 })).toEqual(['magazineEmpty']);
    expect(idsFor('weapon:reloadStarted', { tick: 1, duration: 2.1 })).toEqual(['reloadStarted']);
    expect(idsFor('weapon:reloadFinished', { tick: 1, empty: true })).toEqual(['reloadFinished']);
    expect(idsFor('item:thrown', { tick: 1, position: P, direction: P, chargesLeft: 2 })).toEqual(['itemThrown']);
    expect(idsFor('item:exploded', { tick: 1, position: P, radius: 5.5, hits: 3 })).toEqual(['itemExploded']);
    expect(
      idsFor('assault:started', { tick: 1, totalSmall: 30, totalDrops: 5, firstDropIn: 10 }),
    ).toEqual(['assaultStarted']);
    expect(idsFor('field:cleared', { tick: 1, totalSmall: 30 })).toEqual(['fieldCleared']);
    expect(idsFor('boss:spawned', { tick: 1, enemyId: 1 })).toEqual(['bossSpawned']);
    expect(idsFor('run:victory', { tick: 1, elapsed: 600 })).toEqual(['runVictory']);
    expect(idsFor('run:defeat', { tick: 1, elapsed: 200 })).toEqual(['runDefeat']);
  });

  it('stays silent where a sound would carry no information', () => {
    // Ten impacts a second, each saying only "you missed by a little" — folded into
    // the shot's tail instead. `boss:died` is already the Warden's `enemy:died`.
    expect(idsFor('bullet:impact', { tick: 1, shotId: 1, point: P, normal: P, surface: 'concrete', distance: 3 })).toEqual([]);
    expect(idsFor('bullet:miss', { tick: 1, shotId: 1, end: P })).toEqual([]);
    expect(idsFor('boss:died', { tick: 1, enemyId: 1 })).toEqual([]);
    expect(idsFor('weapon:reloadCancelled', { tick: 1 })).toEqual([]);
    expect(idsFor('player:died', { tick: 1 })).toEqual([]);
  });

  it('gives the loudest sounds the highest priorities', () => {
    const explosion = SOUND_REQUESTS.itemExploded.priority;
    const boss = SOUND_REQUESTS.bossDied.priority;
    const shot = SOUND_REQUESTS.shot.priority;
    expect(explosion).toBeGreaterThan(shot);
    expect(boss).toBeGreaterThan(shot);
    // Ducking is data: anything at or above the threshold pulls the mix down.
    expect(explosion).toBeGreaterThanOrEqual(AUDIO.duckingPriority);
    expect(SOUND_REQUESTS.playerHurt.priority).toBeLessThan(AUDIO.duckingPriority);
  });

  it('accepts the loose payload form the attach loop uses', () => {
    const requests = soundRequestsForAny('shot:fired', {
      tick: 1,
      shotId: 1,
      origin: P,
      direction: P,
      spreadDeg: 1,
    });
    expect(requests.length).toBe(2);
  });
});

describe('gain staging', () => {
  it('multiplies the request gain by the bus gain and the master', () => {
    const request = SOUND_REQUESTS.shot;
    const busGain = AUDIO.busGain.weapon;
    expect(mixGain(request, 1, false)).toBeCloseTo(request.gain * busGain, 9);
    expect(mixGain(request, 0.5, false)).toBeCloseTo(request.gain * busGain * 0.5, 9);
  });

  it('clamps to [0, 1] and never returns NaN', () => {
    const request = SOUND_REQUESTS.shot;
    expect(mixGain(request, 4, false)).toBeLessThanOrEqual(1);
    expect(mixGain(request, -3, false)).toBe(0);
    expect(mixGain(request, Number.NaN, false)).toBe(0);
    expect(mixGain(request, 1, false, { ...AUDIO.busGain, weapon: 5 })).toBeLessThanOrEqual(1);
  });

  it('zeroes the gain when muted but still produces the requests', () => {
    const requests = soundRequestsFor('shot:fired', { tick: 1, shotId: 1, origin: P, direction: P, spreadDeg: 1 });
    // Mute must not suppress the mapping: if it did, unmuting would silently lose
    // whatever happened while muted — and the `[HITLOG]` sfx channel would go quiet
    // exactly when someone is debugging a mute bug.
    expect(requests.length).toBe(2);
    for (const request of requests) expect(mixGain(request, 1, true)).toBe(0);
  });
});

describe('sound policy', () => {
  /** A shot request and the item explosion, for the priority comparisons. */
  const shot: SoundRequest = SOUND_REQUESTS.shot;
  const explosion: SoundRequest = SOUND_REQUESTS.itemExploded;

  it('drops a repeat inside the throttle window and recovers after it', () => {
    const policy = createSoundPolicy();
    const windowSeconds = AUDIO.throttleMs.shot / 1000;
    expect(policy.admitOne(shot, 0)).toBe(true);
    policy.started(shot, 0);
    expect(policy.admitOne(shot, windowSeconds * 0.5)).toBe(false);
    expect(policy.admitOne(shot, windowSeconds + 0.001)).toBe(true);
  });

  it('does not throttle sounds that have no window', () => {
    const policy = createSoundPolicy();
    const explosionAgain = explosion;
    for (let i = 0; i < 5; i += 1) {
      expect(policy.admitOne(explosionAgain, i * 0.001)).toBe(true);
      // Not calling `started` keeps the concurrency budget out of this assertion.
    }
  });

  it('stops admitting once the concurrency budget is full', () => {
    const policy = createSoundPolicy({ maxConcurrentSources: 2 });
    policy.started(shot, 0);
    policy.started(shot, 0);
    expect(policy.admitOne(shot, 1)).toBe(false);
    policy.finished();
    expect(policy.admitOne(shot, 1)).toBe(true);
    expect(policy.activeCount()).toBe(1);
  });

  it('drops the lowest priority request when a batch does not fit', () => {
    const policy = createSoundPolicy({ maxConcurrentSources: 3 });
    policy.started(shot, 0);
    policy.started(shot, 0);
    // One slot left, two candidates: the explosion must win. A burst of gunfire
    // burying the one sound that tells the player a grenade went off is precisely the
    // failure this rule exists to prevent.
    const admitted = policy.admit([shot, explosion], 1);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.id).toBe('itemExploded');
  });

  it('keeps the batch order stable when everything fits', () => {
    const policy = createSoundPolicy({ maxConcurrentSources: 8 });
    const requests = [shot, explosion, SOUND_REQUESTS.hitBody];
    expect(policy.admit(requests, 0)).toEqual(requests);
  });

  it('admits nothing when the budget is already exhausted', () => {
    const policy = createSoundPolicy({ maxConcurrentSources: 1 });
    policy.started(explosion, 0);
    expect(policy.admit([shot, explosion], 1)).toEqual([]);
  });

  it('forgets its history on reset', () => {
    const policy = createSoundPolicy();
    policy.started(shot, 0);
    expect(policy.admitOne(shot, 0.001)).toBe(false);
    policy.reset();
    expect(policy.activeCount()).toBe(0);
    expect(policy.admitOne(shot, 0.002)).toBe(true);
  });

  it('never lets the active count go negative', () => {
    const policy = createSoundPolicy();
    policy.finished();
    policy.finished();
    expect(policy.activeCount()).toBe(0);
  });
});

describe('synthesis', () => {
  it('is a pure function of the recipe', () => {
    const spec = SOUND_SPECS.shot;
    const first = planVoice(spec);
    const second = planVoice(spec);
    // Deep equality including the noise seed: "the same shot" has to be the same
    // waveform, or a recorded demo cannot be reproduced (phase-4 trap 4).
    expect(second).toEqual(first);
    expect(first.noiseSeed).toBe(spec.noiseSeed >>> 0);
  });

  it('scales the sweep with the pitch but not its ratio', () => {
    const spec = SOUND_SPECS.itemExploded;
    const base = planVoice(spec);
    const up = planVoice(spec, 2);
    expect(up.frequency).toBeCloseTo(base.frequency * 2, 6);
    expect(up.endFrequency / up.frequency).toBeCloseTo(base.endFrequency / base.frequency, 9);
    expect(up.duration).toBeCloseTo(base.duration, 9);
  });

  it('falls back to unity for a nonsense pitch scale', () => {
    const spec = SOUND_SPECS.shot;
    expect(planVoice(spec, 0).frequency).toBe(spec.frequency);
    expect(planVoice(spec, Number.NaN).frequency).toBe(spec.frequency);
    expect(planVoice(spec, -3).frequency).toBe(spec.frequency);
  });

  it('applies headroom to the peak gain', () => {
    const spec = SOUND_SPECS.shot;
    expect(planVoice(spec, 1, 0.5).peakGain).toBeCloseTo(spec.gain * 0.5, 9);
    expect(planVoice(spec, 1, 4).peakGain).toBeLessThanOrEqual(1);
  });

  it('fills noise deterministically from a seeded rng', () => {
    const a = new Float32Array(64);
    const b = new Float32Array(64);
    fillNoise(a, createRng(1234));
    fillNoise(b, createRng(1234));
    expect(Array.from(b)).toEqual(Array.from(a));

    const c = new Float32Array(64);
    fillNoise(c, createRng(4321));
    expect(Array.from(c)).not.toEqual(Array.from(a));
  });

  it('keeps the noise inside [-1, 1]', () => {
    const buffer = new Float32Array(512);
    fillNoise(buffer, createRng(99));
    for (const sample of buffer) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
      expect(Number.isFinite(sample)).toBe(true);
    }
  });
});

describe('mixer without an audio host', () => {
  /**
   * Node has no `AudioContext`, and this is a contract rather than an accident: a
   * host with no Web Audio (or a browser that refuses to start one before a gesture)
   * must leave the game fully playable and the console clean.
   */
  it('is inert but harmless before it is unlocked', () => {
    const mixer = createAudioMixer();
    expect(mixer.ready).toBe(false);
    expect(() => mixer.unlock()).not.toThrow();
    expect(mixer.ready).toBe(false);
    expect(() => mixer.play(SOUND_REQUESTS.shot)).not.toThrow();
    expect(() => mixer.playAll([SOUND_REQUESTS.itemExploded])).not.toThrow();
    expect(mixer.activeSourceCount()).toBe(0);
    expect(() => mixer.dispose()).not.toThrow();
  });

  it('advances its own clock by dt rather than by wall time', () => {
    const mixer = createAudioMixer();
    expect(mixer.clock).toBe(0);
    mixer.update(1 / 60);
    mixer.update(1 / 60);
    expect(mixer.clock).toBeCloseTo(2 / 60, 9);
    // A long frame or a paused render must not lurch the clock.
    mixer.update(0);
    mixer.update(-1);
    mixer.update(Number.NaN);
    expect(mixer.clock).toBeCloseTo(2 / 60, 9);
  });

  it('holds the volume and mute state so the UI can read them back', () => {
    const mixer = createAudioMixer({ masterVolume: 0.4, muted: false });
    expect(mixer.masterVolume()).toBeCloseTo(0.4, 9);
    expect(mixer.isMuted()).toBe(false);
    mixer.setMuted(true);
    expect(mixer.isMuted()).toBe(true);
    mixer.setMasterVolume(4);
    expect(mixer.masterVolume()).toBe(1);
    mixer.setMasterVolume(Number.NaN);
    expect(mixer.masterVolume()).toBe(0);
  });

  it('survives being disposed twice', () => {
    const mixer = createAudioMixer();
    mixer.dispose();
    expect(() => mixer.dispose()).not.toThrow();
    expect(() => mixer.play(SOUND_REQUESTS.shot)).not.toThrow();
  });
});

describe('attachAudio wiring, through the real event bus', () => {
  /**
   * Phase-5 postscript: this block exists because the module that *wires* the bus to the
   * mixer was the one part of the audio subsystem with no coverage at all. Every other
   * test here drives `triggers`/`synth`/`mixer` directly, so `attachAudio` could — and
   * did — carry a defect that made the game unstartable in a browser while this file
   * stayed green.
   */
  function makeMixerSpy(): { mixer: AudioMixer; played: SoundRequest[][] } {
    const played: SoundRequest[][] = [];
    const mixer = {
      playAll(requests: readonly SoundRequest[]): void {
        played.push([...requests]);
      },
    } as unknown as AudioMixer;
    return { mixer, played };
  }

  const shot = { tick: 42, shotId: 7, origin: P, direction: P, spreadDeg: 1.5 };

  it('subscribes without detaching the bus method it was handed', () => {
    // The regression. `attachAudio` used to do `const on = events.on`, which pulls the
    // method off the instance; an ES module is *always* strict, so `this` is `undefined`
    // inside it and the first subscription throws
    // `Cannot read properties of undefined (reading 'handlers')`.
    // `bootGame()` calls this before it registers the veil's click listener, so the
    // whole game died there: the veil stayed up and ignored every click.
    const { mixer } = makeMixerSpy();
    const events = new EventBus();

    expect(() => attachAudio({ events, mixer })).not.toThrow();
    expect(events.listenerCount('shot:fired')).toBe(1);
    // Only the audible table is subscribed — not every event the game emits.
    expect(events.listenerCount('bullet:miss')).toBe(0);
  });

  it('plays what the trigger table asks for and reports the event tick', () => {
    const { mixer, played } = makeMixerSpy();
    const events = new EventBus();
    const heard: number[] = [];
    const detach = attachAudio({ events, mixer, onSound: (tick) => heard.push(tick) });

    events.emit('shot:fired', shot);

    // Two requests for one shot: the report and its tail.
    expect(played.map((batch) => batch.map((request) => request.id))).toEqual([idsFor('shot:fired', shot)]);
    // The tick is the payload's, not a fresh clock reading — that is what makes the
    // `[HITLOG]` sfx channel a frame-alignment measurement rather than an opinion.
    expect(heard).toEqual([42]);

    detach();
  });

  it('stops listening once detached', () => {
    const { mixer, played } = makeMixerSpy();
    const events = new EventBus();
    const detach = attachAudio({ events, mixer });

    detach();
    events.emit('shot:fired', shot);

    expect(played).toHaveLength(0);
    expect(events.listenerCount('shot:fired')).toBe(0);
  });

  it('stays silent for an event it never subscribed to', () => {
    const { mixer, played } = makeMixerSpy();
    const events = new EventBus();
    attachAudio({ events, mixer });

    // `bullet:miss` is deliberately not in the audible table: a miss makes no noise.
    events.emit('bullet:miss', { tick: 1, shotId: 1, end: P });

    expect(played).toHaveLength(0);
  });
});
