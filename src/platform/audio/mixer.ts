/**
 * The mixer: the one place in the project that touches `AudioContext`.
 *
 * Everything that could be *decided* about a sound was decided in `triggers.ts` and
 * `synth.ts`, which are pure. What is left here is bookkeeping that needs a real
 * audio graph: a fixed pool of voices, the bus gains, the ducking stage, and the
 * lifecycle of the short-lived source nodes.
 *
 * ## Why a voice pool instead of "new nodes per sound"
 *
 * Hard rule 8 says short-lived objects must be pooled, and an audio voice is a
 * short-lived object *more* expensive than a mesh: every `OscillatorNode` has to be
 * added to the graph and removed again. So the persistent part — the envelope gain,
 * the tone/noise mix gains, the low-pass filter, and the bus routing — is built
 * once, `AUDIO.maxConcurrentSources` times, and only the two source nodes (one
 * oscillator, one noise buffer source) are created per sound. Those are stopped and
 * disconnected in `onended`, which is the point the brief's trap table calls out
 * ("every shot news an OscillatorNode and never disconnects it").
 *
 * ## Why nothing happens before a user gesture
 *
 * Browsers refuse to start an `AudioContext` outside a user gesture, and a shell
 * that logs "The AudioContext was not allowed to start" on every launch is a shell
 * whose console-error assertion means nothing. So the context is created in
 * {@link AudioMixer.unlock} — called from the same click that requests pointer lock
 * — and until then every request is dropped silently. Dropping rather than queueing
 * is deliberate: playing a backlog of sounds the moment the player clicks in would
 * be a burst of noise describing events that are already over.
 */

import { AUDIO, type AudioBus } from '../../core/config';
import { createRng, seedFromString, type Rng } from '../../core/math/rng';
import { fillNoise, planVoice } from './synth';
import { createSoundPolicy, mixGain, type SoundRequest } from './triggers';

/** The mixer's public surface. */
export interface AudioMixer {
  /** True once an audio context exists and is running. */
  readonly ready: boolean;
  /** The audio clock, in seconds. Advances with `update(dt)`, never with `Date.now()`. */
  readonly clock: number;
  /**
   * Creates and resumes the audio context. Must be called from a user gesture.
   * Idempotent, and safe on a host with no Web Audio at all.
   */
  unlock(): void;
  /** Plays one request, subject to the throttle and concurrency rules. */
  play(request: SoundRequest): void;
  /** Plays several, ranked by priority against each other. */
  playAll(requests: readonly SoundRequest[]): void;
  /**
   * Advances the mixer's own clock.
   *
   * `dt` is render time and is *not* scaled by hitstop: a sound that stopped
   * advancing while the world froze would leave a shot's noise ringing past the
   * moment its impact landed.
   */
  update(dt: number): void;
  setMasterVolume(volume: number): void;
  masterVolume(): number;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Voices currently sounding. The debug panel and the performance scene read it. */
  activeSourceCount(): number;
  /** Frees every node. After this the mixer is inert. */
  dispose(): void;
}

/** One pooled voice: everything that outlives a single sound. */
interface Voice {
  /** Envelope: 0 → peak → 0 over the recipe's attack and decay. */
  readonly envelope: GainNode;
  readonly filter: BiquadFilterNode;
  readonly toneGain: GainNode;
  readonly noiseGain: GainNode;
  /** Sources created for the sound currently playing, so they can be detached. */
  tone: OscillatorNode | null;
  noise: AudioBufferSourceNode | null;
  /** Audio-clock time at which this voice goes quiet. */
  endsAt: number;
  busy: boolean;
  /** Bus this voice is currently patched into, or `null` when unpatched. */
  bus: AudioBus | null;
}

/** How the mixer is built. */
export interface AudioMixerOptions {
  /** Overrides the tuning table. Tests pass explicit values. */
  readonly maxConcurrentSources?: number;
  /** Bus gains and master volume, injectable so nothing has to be mutated globally. */
  readonly masterVolume?: number;
  readonly muted?: boolean;
}

/**
 * Creates the mixer.
 *
 * Construction touches no audio API: on a host without Web Audio (Node, a test
 * runner, a browser with audio disabled) the object still works and simply drops
 * every request.
 */
export function createAudioMixer(options: AudioMixerOptions = {}): AudioMixer {
  const policy = createSoundPolicy({
    ...(options.maxConcurrentSources === undefined
      ? {}
      : { maxConcurrentSources: options.maxConcurrentSources }),
  });

  let context: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  /** Ducking stage: pulled down by loud sounds, ramped back by the clock. */
  let duckGain: GainNode | null = null;
  let disposed = false;
  let clock = 0;
  let volume = clamp01(options.masterVolume ?? AUDIO.masterVolume);
  let muted = options.muted ?? AUDIO.muted;

  const voices: Voice[] = [];
  const busNodes = new Map<AudioBus, GainNode>();
  /** One noise buffer per recipe seed, built lazily so startup allocates nothing. */
  const noiseBuffers = new Map<number, AudioBuffer>();
  /**
   * Jitter stream.
   *
   * Seeded like every other random source in the project (rule 7). It exists so a
   * ten-round burst is not ten identical clones — the *recipe* stays byte-identical
   * (that is what `synth.ts` guarantees), only the playback pitch drifts.
   */
  const jitter: Rng = createRng(seedFromString('audio-jitter'));
  let voiceCursor = 0;

  /** Reads the host constructor without assuming it exists. */
  const contextCtor = (): typeof AudioContext | null => {
    const host = globalThis as { AudioContext?: typeof AudioContext };
    return typeof host.AudioContext === 'function' ? host.AudioContext : null;
  };

  const buildGraph = (Ctor: typeof AudioContext): void => {
    const ctx = new Ctor();
    context = ctx;

    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : volume;
    masterGain.connect(ctx.destination);

    duckGain = ctx.createGain();
    duckGain.gain.value = 1;
    duckGain.connect(masterGain);

    for (const bus of Object.keys(AUDIO.busGain) as AudioBus[]) {
      const node = ctx.createGain();
      node.gain.value = AUDIO.busGain[bus];
      node.connect(duckGain);
      busNodes.set(bus, node);
    }

    for (let i = 0; i < AUDIO.maxConcurrentSources; i += 1) {
      const envelope = ctx.createGain();
      envelope.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1000;
      const toneGain = ctx.createGain();
      toneGain.gain.value = 1;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0;
      toneGain.connect(filter);
      noiseGain.connect(filter);
      filter.connect(envelope);
      // The envelope is deliberately NOT connected to a bus yet: the bus depends
      // on the sound, and re-connecting a persistent node is cheaper than building
      // six complete chains and picking one.
      voices.push({ envelope, filter, toneGain, noiseGain, tone: null, noise: null, endsAt: 0, busy: false, bus: null });
    }
  };

  /** The shared noise buffer for a recipe seed, filled from a seeded `Rng`. */
  const noiseBufferFor = (seed: number): AudioBuffer | null => {
    const ctx = context;
    if (!ctx) return null;
    const cached = noiseBuffers.get(seed);
    if (cached) return cached;
    const frames = Math.max(1, Math.floor(AUDIO.noiseBufferSeconds * ctx.sampleRate));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Seeded, not `Math.random()`: rule 7 applies to audio too, or the same shot
    // sounds different on every run and a recorded demo cannot be reproduced.
    fillNoise(data, createRng(seed));
    noiseBuffers.set(seed, buffer);
    return buffer;
  };

  /** Deterministic pitch drift for one playback, `[1 - jitter, 1 + jitter]`. */
  const pitchScaleFor = (request: SoundRequest): number => {
    if (request.pitchJitter <= 0) return 1;
    return 1 + jitter.range(-request.pitchJitter, request.pitchJitter);
  };

  /** Finds a free voice, preferring the one that has been idle longest. */
  const claimVoice = (): Voice | null => {    for (let i = 0; i < voices.length; i += 1) {
      const index = (voiceCursor + i) % voices.length;
      const voice = voices[index];
      if (voice && !voice.busy) {
        voiceCursor = (index + 1) % voices.length;
        return voice;
      }
    }
    return null;
  };

  const releaseVoice = (voice: Voice): void => {
    voice.busy = false;
    voice.endsAt = 0;
    voice.tone = null;
    voice.noise = null;
  };

  /** Starts one voice. Returns false when the graph cannot take it. */
  const startVoice = (request: SoundRequest): boolean => {
    const ctx = context;
    const duck = duckGain;
    if (!ctx || !duck || ctx.state !== 'running') return false;

    const voice = claimVoice();
    if (!voice) return false;

    const plan = planVoice(request.spec, pitchScaleFor(request), AUDIO.voiceHeadroom);
    const bus = busNodes.get(request.bus);
    if (!bus) return false;

    // Re-patch only when the bus changed: `disconnect` on an unconnected node is a
    // no-op, and staying patched keeps a repeated sound from churning the graph.
    if (voice.bus !== request.bus) {
      voice.envelope.disconnect();
      voice.envelope.connect(bus);
      voice.bus = request.bus;
    }

    const now = ctx.currentTime;
    const end = now + plan.duration;

    voice.filter.frequency.setValueAtTime(plan.lowpass, now);
    voice.toneGain.gain.setValueAtTime(plan.toneMix, now);
    voice.noiseGain.gain.setValueAtTime(plan.noiseMix, now);

    // Envelope: a short attack then a decay to (almost) silence. `exponentialRamp`
    // cannot start or end at zero, so a silent voice (muted, or a zero-gain recipe)
    // takes the linear path and everything else fades exponentially.
    const peak = mixGain(request, volume, muted) * plan.peakGain;
    const envelope = voice.envelope.gain;
    envelope.cancelScheduledValues(now);
    envelope.setValueAtTime(0, now);
    if (plan.attack > 0) envelope.linearRampToValueAtTime(peak, now + plan.attack);
    else envelope.setValueAtTime(peak, now);
    if (peak > 0.0002) {
      envelope.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.0001), end);
      envelope.setValueAtTime(0, end);
    } else {
      envelope.linearRampToValueAtTime(0, end);
    }

    if (plan.toneMix > 0) {
      const tone = ctx.createOscillator();
      tone.type = 'sawtooth';
      tone.frequency.setValueAtTime(Math.max(1, plan.frequency), now);
      tone.frequency.exponentialRampToValueAtTime(Math.max(1, plan.endFrequency), end);
      tone.connect(voice.toneGain);
      tone.onended = () => {
        tone.disconnect();
        voice.tone = null;
      };
      tone.start(now);
      tone.stop(end);
      voice.tone = tone;
    }

    if (plan.noiseMix > 0) {
      const buffer = noiseBufferFor(plan.noiseSeed);
      if (buffer) {
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        noise.connect(voice.noiseGain);
        noise.onended = () => {
          noise.disconnect();
          voice.noise = null;
        };
        noise.start(now);
        noise.stop(end);
        voice.noise = noise;
      }
    }

    voice.busy = true;
    voice.endsAt = end;

    // Ducking: the loudest sounds pull the rest of the mix down and let it recover.
    if (request.priority >= AUDIO.duckingPriority) {
      const attack = Math.max(0.005, plan.attack);
      const recovery = AUDIO.duckingDecayMs / 1000;
      duck.gain.cancelScheduledValues(now);
      duck.gain.setValueAtTime(Math.max(0.0001, 1 - AUDIO.duckingAmount), now + attack);
      duck.gain.linearRampToValueAtTime(1, now + attack + recovery);
    }

    return true;
  };

  /**
   * Frees any voice whose scheduled end has passed.
   *
   * `onended` is the primary mechanism, but it does not fire while a context is
   * suspended, and a pool that only ever frees on `onended` would leak every voice
   * the first time the tab is backgrounded.
   */
  const reap = (): void => {
    const ctx = context;
    if (!ctx) return;
    for (const voice of voices) {
      if (!voice.busy) continue;
      if (ctx.currentTime < voice.endsAt) continue;
      voice.tone?.stop();
      voice.noise?.stop();
      voice.tone = null;
      voice.noise = null;
      releaseVoice(voice);
    }
  };

  return {
    get ready() {
      return context !== null && context.state === 'running';
    },
    get clock() {
      return clock;
    },

    unlock() {
      if (disposed) return;
      const Ctor = contextCtor();
      if (!Ctor) return;
      if (!context) {
        try {
          buildGraph(Ctor);
        } catch {
          // Audio is a presentation nicety: a host that refuses to give us a
          // context must not take the game down with it.
          context = null;
          return;
        }
      }
      if (context && context.state !== 'running') {
        void context.resume().catch(() => undefined);
      }
    },

    play(request) {
      if (disposed || !context) return;
      if (!policy.admitOne(request, clock)) return;
      if (!startVoice(request)) return;
      policy.started(request, clock);
    },

    playAll(requests) {
      if (disposed || !context || requests.length === 0) return;
      const admitted = policy.admit(requests, clock);
      for (const request of admitted) {
        if (!startVoice(request)) continue;
        policy.started(request, clock);
      }
    },

    update(dt) {
      if (disposed) return;
      if (Number.isFinite(dt) && dt > 0) clock += dt;
      reap();
    },

    setMasterVolume(next) {
      volume = clamp01(next);
      if (masterGain && context) {
        masterGain.gain.setTargetAtTime(muted ? 0 : volume, context.currentTime, 0.01);
      }
    },

    masterVolume() {
      return volume;
    },

    setMuted(next) {
      muted = next;
      if (masterGain && context) {
        masterGain.gain.setTargetAtTime(muted ? 0 : volume, context.currentTime, 0.01);
      }
    },

    isMuted() {
      return muted;
    },

    activeSourceCount() {
      let count = 0;
      for (const voice of voices) if (voice.busy) count += 1;
      return count;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const voice of voices) {
        voice.tone?.stop();
        voice.noise?.stop();
        voice.envelope.disconnect();
        voice.filter.disconnect();
        voice.toneGain.disconnect();
        voice.noiseGain.disconnect();
      }
      voices.length = 0;
      busNodes.clear();
      noiseBuffers.clear();
      if (context) void context.close().catch(() => undefined);
      context = null;
      masterGain = null;
      duckGain = null;
      policy.reset();
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
