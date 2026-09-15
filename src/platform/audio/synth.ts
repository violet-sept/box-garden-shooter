/**
 * Sound synthesis — a recipe in, a waveform plan out.
 *
 * Phase 4 decision D14 is that **every** sound is synthesised at runtime. The
 * reason is coupling, not taste: `public/` does not exist in this repository, so a
 * file-backed sound would be a load that is certain to fail, and the phase-3
 * acceptance fix (D12) exists specifically to stop "a load that is expected to
 * fail" from being normalised.
 *
 * This module is deliberately *pure*: it never touches `AudioContext`. A
 * {@link SoundSpec} (see `core/config.ts`) is turned into a {@link SynthesisPlan}
 * of plain numbers, which `mixer.ts` then applies to real nodes. Keeping the two
 * apart is what lets the whole recipe table be asserted in Node, where no audio
 * hardware, no `AudioContext` and no browser exist.
 *
 * Randomness rule 7 applies here too: the noise buffer is filled from a seeded
 * `Rng`, so one recipe always produces the same waveform. `Math.random()` would
 * make "the same shot" sound different on every run and make a recorded demo
 * unreproducible.
 */

import type { SoundSpec } from '../../core/config';
import type { Rng } from '../../core/math/rng';

/** Where a voice's envelope ends up, in the audio clock's seconds. */
export interface SynthesisPlan {
  /** Starting frequency in Hz. */
  readonly frequency: number;
  /** Ending frequency in Hz, after the sweep. */
  readonly endFrequency: number;
  /** Total life of the voice in seconds: attack plus decay. */
  readonly duration: number;
  /** Envelope: ramp up over the attack, then down over the decay. */
  readonly attack: number;
  readonly decay: number;
  /** Noise share of the source, `[0, 1]`. */
  readonly noiseMix: number;
  /** Oscillator share, `1 - noiseMix`. */
  readonly toneMix: number;
  /** Low-pass cutoff in Hz. */
  readonly lowpass: number;
  /** Peak gain before the bus stage, `[0, 1]`. */
  readonly peakGain: number;
  /** Seed for the noise buffer fill. */
  readonly noiseSeed: number;
}

/**
 * Turns a recipe into a plan.
 *
 * @param spec       The recipe from `SOUND_SPECS`.
 * @param pitchScale Deterministic pitch multiplier, already drawn from a seeded
 *                   `Rng` by the caller. It scales the sweep's endpoints but not
 *                   its ratio, so a jittered shot is the same *sound*, a little
 *                   higher or lower.
 * @param headroom   Peak gain ceiling applied to every voice (see
 *                   `AUDIO.voiceHeadroom`). Summing several voices at full gain
 *                   clips, and clipping reads as a broken speaker.
 */
export function planVoice(spec: SoundSpec, pitchScale = 1, headroom = 1): SynthesisPlan {
  const scale = Number.isFinite(pitchScale) && pitchScale > 0 ? pitchScale : 1;
  const frequency = spec.frequency * scale;
  const duration = spec.attack + spec.decay;
  return {
    frequency,
    // `frequencySweep` is a ratio, so the sweep survives the pitch scaling: an
    // explosion an octave down is still the same shape, not a different one.
    endFrequency: frequency * spec.frequencySweep,
    duration,
    attack: spec.attack,
    decay: spec.decay,
    noiseMix: clamp01(spec.noiseMix),
    toneMix: 1 - clamp01(spec.noiseMix),
    lowpass: spec.lowpass,
    peakGain: clamp01(spec.gain * headroom),
    noiseSeed: spec.noiseSeed >>> 0,
  };
}

/**
 * Fills a noise buffer deterministically.
 *
 * Written as a function over a target array rather than as a buffer constructor so
 * it can be tested without any Web Audio object at all — the pool hands it the one
 * shared `Float32Array` it allocated.
 */
export function fillNoise(target: Float32Array, rng: Rng): void {
  for (let i = 0; i < target.length; i += 1) {
    target[i] = rng.range(-1, 1);
  }
}

/** Truncates a cached buffer view: the tail beyond `duration` is never played. */
export function framesFor(duration: number, sampleRate: number): number {
  return Math.max(1, Math.ceil(duration * sampleRate));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
