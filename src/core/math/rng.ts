/**
 * Seeded pseudo-random numbers.
 *
 * `Math.random()` is banned in this codebase (technical plan §4.2): the
 * simulation has to be reproducible so wave layouts, spread and spawn points can
 * be asserted in tests and replayed from a seed. Every stochastic system takes
 * an {@link Rng} by injection rather than reaching for a global.
 *
 * The generator is `mulberry32` — 32 bits of state, one multiply-xorshift round,
 * passes the usual small-scale statistical checks, and is fast enough to call
 * per bullet. It is *not* cryptographic and must never be used as such.
 */

/** A deterministic random source. */
export interface Rng {
  /** Uniform in `[0, 1)`. */
  next(): number;
  /** Uniform in `[min, max)`. */
  range(min: number, max: number): number;
  /** Uniform integer in `[min, max]`, inclusive. */
  int(min: number, max: number): number;
  /** True with probability `probability`. */
  chance(probability: number): boolean;
  /** A random unit vector written into `out`. */
  unitVector(out: { x: number; y: number; z: number }): { x: number; y: number; z: number };
}

/** Creates a generator from a 32-bit seed. The same seed gives the same sequence. */
export function createRng(seed: number): Rng {
  // `>>> 0` keeps the state an unsigned 32-bit integer whatever the caller passes.
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // Top 24 bits: the low bits of mulberry32 are the weakest.
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const range = (min: number, max: number): number => min + next() * (max - min);

  return {
    next,
    range,
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    chance: (probability: number) => next() < probability,
    unitVector(out) {
      // Rejection-free spherical sampling: z uniform in [-1,1) plus a uniform
      // azimuth. Produces a genuinely uniform direction, unlike normalising
      // three independent uniform components (which clusters on the cube's
      // corners).
      const z = range(-1, 1);
      const azimuth = range(0, Math.PI * 2);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      out.x = r * Math.cos(azimuth);
      out.y = r * Math.sin(azimuth);
      out.z = z;
      return out;
    },
  };
}

/**
 * A deterministic hash of a string into a 32-bit seed.
 *
 * Lets a system derive a stable seed from a readable key ("level", "wave-3")
 * instead of hard-coding magic numbers all over the codebase.
 */
export function seedFromString(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
