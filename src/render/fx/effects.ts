/**
 * Weapon and impact effects — every one of them pooled.
 *
 * The technical plan is blunt about this (§3.5): "new a Mesh per bullet" is the
 * number-one cause of frame drops in a shooter, and at 640 RPM with tracers,
 * decals and sparks the allocation rate would be in the thousands per second. So
 * every effect here is a fixed-size pool built once, driven by `visible` flags and
 * buffer writes, and never reallocated during play.
 *
 * The module also owns the *orchestration* of a shot's visual chain, because
 * ordering is part of the feedback design: the muzzle flash and the tracer land on
 * the same frame as the shot (VFX tolerance is ±0 frames), while the decal and
 * sparks are allowed a frame of slack.
 *
 * No gameplay decisions live here. Whether a shot hit, what it hit and how much
 * damage it did are all decided in `game/combat/**` and arrive as events.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import type { EventSink, GameEvents, SurfaceKind } from '../../core/events';
import { RENDER } from '../../core/config';
import { createRng, seedFromString, type Rng } from '../../core/math/rng';
import type { Vector3 as PlainVector3 } from '../../core/math/vec3';

/**
 * Structural 3D point.
 *
 * The events carry plain `{x, y, z}` objects from the simulation layer, which
 * deliberately does not import `three`. Declaring the shape structurally here is
 * what lets this module read those payloads directly instead of copying every
 * vector through a `THREE.Vector3` — and it keeps the layering rule intact in
 * both directions.
 */
type PointLike = PlainVector3 | { x: number; y: number; z: number };

/** One pooled tracer streak. */
interface Tracer {
  readonly mesh: Mesh;
  /** Seconds of life remaining. Zero means the slot is free. */
  life: number;
  readonly maxLife: number;
}

/** One pooled impact decal. */
interface Decal {
  readonly mesh: Mesh;
  life: number;
  readonly maxLife: number;
}

/** One pooled impact spark burst. */
interface SparkBurst {
  readonly points: Points;
  readonly positions: BufferAttribute;
  readonly velocities: Float32Array;
  life: number;
  readonly maxLife: number;
  readonly count: number;
}

/** Colour per surface family. Keeps impact feedback legible without a texture. */
const SURFACE_COLOR: Record<SurfaceKind, number> = {
  concrete: 0xd8d2c4,
  metal: 0xfff0b0,
  crate: 0xd39b5c,
  target: 0xff6a52,
  ground: 0xa8a294,
};

/** Lifetime of each effect, in seconds. */
const LIFETIME = {
  tracer: 0.05,
  decal: 6,
  sparks: 0.3,
  muzzleFlash: 0.04,
  hitFlash: 0.18,
} as const;

/** Sparks per impact. */
const SPARKS_PER_BURST = 12;
/** Concurrent spark bursts. */
const SPARK_BURSTS = 24;
/** Constant "straight up" normal, for effects with no surface to normal off. */
const UP: PointLike = { x: 0, y: 1, z: 0 };
/** Pooled floating damage numbers. */
const DAMAGE_NUMBERS = 32;
/** Concurrent blast shells. Two items plus a Warden shot, with slack. */
const BLAST_SHELLS = 6;
/** Seconds a blast shell takes to expand and fade out. */
const BLAST_SHELL_LIFE = 0.42;

/** Where a world point lands on screen. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
  readonly visible: boolean;
}

/** The effect system's public surface. */
export interface Effects {
  /** Subscribes to the events it draws. Called once by the composition root. */
  attach(events: EventSink & {
    on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void): () => void;
  }): void;
  /** Advances every effect. `dt` is *render* time, deliberately unscaled by hitstop. */
  update(dt: number): void;
  /** Places the muzzle flash. `visible: false` retires it immediately. */
  setMuzzle(position: PointLike, direction: PointLike, visible: boolean): void;
  /**
   * Detonates a blast at `position`.
   *
   * The expanding shell plus a spark burst in the surface colour, which is the same
   * language the bullet impacts already use. Driven by the simulation's
   * `item:exploded` event rather than by anything in this layer, so the picture and the
   * damage can never disagree about where the blast was.
   */
  explode(position: PointLike, radius: number): void;
  /** Supplies world→screen projection, which is what damage numbers need. */
  setProjector(fn: (point: PointLike) => ScreenPoint): void;
  dispose(): void;
}

/** Options for {@link createEffects}. */
export interface EffectsOptions {
  readonly scene: Scene;
  /** Container the pooled damage-number nodes are appended to. */
  readonly numberLayer: HTMLElement;
  readonly seed?: number;
}

/**
 * Creates the effect system.
 *
 * Pool sizes come from `RENDER` where they are tuning values, so the memory
 * footprint is one table rather than scattered constants.
 */
export function createEffects({ scene, numberLayer, seed = seedFromString('fx') }: EffectsOptions): Effects {
  const rng: Rng = createRng(seed);
  const root = new Group();
  root.name = 'fx';
  scene.add(root);

  // --- Muzzle flash: one instance, toggled and spun --------------------------
  const muzzleMaterial = new MeshBasicMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.95,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  const muzzleGeometry = new SphereGeometry(0.11, 10, 8);
  const muzzleFlash = new Mesh(muzzleGeometry, muzzleMaterial);
  muzzleFlash.visible = false;
  muzzleFlash.frustumCulled = false;
  root.add(muzzleFlash);
  let muzzleLife = 0;

  // --- Tracers ---------------------------------------------------------------
  // A unit sphere stretched along its local Z and oriented with `lookAt`: one
  // shared geometry, one matrix write per shot, and the streak reads correctly
  // from every angle (unlike a billboard, which can vanish edge-on).
  const tracerGeometry = new SphereGeometry(0.024, 6, 4);
  const tracerMaterials: MeshBasicMaterial[] = [];
  const tracers: Tracer[] = [];
  for (let i = 0; i < RENDER.maxTracers; i += 1) {
    // A material per tracer: they fade independently, and a shared material would
    // make every tracer dim whenever any one of them expired.
    const material = new MeshBasicMaterial({
      color: 0xffe6a8,
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new Mesh(tracerGeometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    root.add(mesh);
    tracerMaterials.push(material);
    tracers.push({ mesh, life: 0, maxLife: LIFETIME.tracer });
  }
  let tracerCursor = 0;

  // --- Decals ---------------------------------------------------------------
  // Ring buffer: the oldest decal is overwritten rather than deleted, which is
  // what keeps the pool allocation-free and the decal count bounded.
  const decalGeometry = new PlaneGeometry(0.16, 0.16);
  const decals: Decal[] = [];
  for (let i = 0; i < RENDER.maxDecals; i += 1) {
    const material = new MeshBasicMaterial({
      color: 0x0a0a0a,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const mesh = new Mesh(decalGeometry, material);
    mesh.visible = false;
    root.add(mesh);
    decals.push({ mesh, life: 0, maxLife: LIFETIME.decal });
  }
  let decalCursor = 0;

  // --- Impact sparks --------------------------------------------------------
  const sparkBursts: SparkBurst[] = [];
  for (let i = 0; i < SPARK_BURSTS; i += 1) {
    const positions = new Float32Array(SPARKS_PER_BURST * 3);
    const geometry = new BufferGeometry();
    const attribute = new BufferAttribute(positions, 3);
    geometry.setAttribute('position', attribute);
    geometry.setDrawRange(0, 0);
    const material = new PointsMaterial({
      color: 0xffd9a0,
      size: 0.08,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new Points(geometry, material);
    points.visible = false;
    points.frustumCulled = false;
    root.add(points);
    sparkBursts.push({
      points,
      positions: attribute,
      velocities: new Float32Array(SPARKS_PER_BURST * 3),
      life: 0,
      maxLife: LIFETIME.sparks,
      count: SPARKS_PER_BURST,
    });
  }
  let sparkCursor = 0;

  // --- Impact flash ---------------------------------------------------------
  // A brief emissive puff at the impact point, which is what actually sells a hit
  // at range, where individual sparks are sub-pixel.
  const hitFlashMaterial = new MeshBasicMaterial({
    color: 0xfff2cc,
    transparent: true,
    opacity: 0.9,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const hitFlashGeometry = new SphereGeometry(0.16, 10, 8);
  const hitFlash = new Mesh(hitFlashGeometry, hitFlashMaterial);
  hitFlash.visible = false;
  hitFlash.frustumCulled = false;
  root.add(hitFlash);
  let hitFlashLife = 0;
  /** Size multiplier of the current flash, so a death puff reads bigger than a bullet. */
  let hitFlashScale = 1;

  // --- Blast shells ---------------------------------------------------------
  // One expanding, fading sphere per detonation. Pooled and round-robin, like the
  // decals: a wave can produce several explosions within a second and none of them may
  // allocate. Additive and depth-write-free so the shell never occludes the bodies
  // inside it — the blast is a readout of where the damage was, not a wall.
  const blastShells: { mesh: Mesh; material: MeshBasicMaterial; life: number }[] = [];
  for (let i = 0; i < BLAST_SHELLS; i += 1) {
    const material = new MeshBasicMaterial({
      color: 0xffb163,
      transparent: true,
      opacity: 0.7,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    const mesh = new Mesh(new SphereGeometry(1, 20, 14), material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    root.add(mesh);
    blastShells.push({ mesh, material, life: 0 });
  }
  let blastCursor = 0;

  // --- Damage numbers -------------------------------------------------------
  // Pooled DOM nodes: positioning text is far cheaper than a canvas texture per
  // hit, and the browser does the glyph rendering for free.
  const numberPool: HTMLElement[] = [];
  const numberLife: number[] = [];
  for (let i = 0; i < DAMAGE_NUMBERS; i += 1) {
    const element = document.createElement('div');
    element.className = 'dmg-number';
    element.style.opacity = '0';
    numberLayer.appendChild(element);
    numberPool.push(element);
    numberLife.push(0);
  }
  let numberCursor = 0;

  const tmpVec = new Vector3();
  let projectToScreen: ((point: PointLike) => ScreenPoint) | null = null;

  const spawnTracer = (from: PointLike, to: PointLike): void => {
    const slot = tracers[tracerCursor];
    tracerCursor = (tracerCursor + 1) % tracers.length;
    if (!slot) return;
    slot.mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    const length = Math.max(0.02, Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
    // `lookAt` aligns the mesh's local +Z with the direction, so stretching Z by
    // the segment length produces a streak running from `from` to `to`. A sphere
    // (rather than a cylinder or a billboard) is used because a stretched sphere
    // has no silhouette that can disappear when viewed exactly edge-on.
    slot.mesh.lookAt(to.x, to.y, to.z);
    slot.mesh.scale.set(1, 1, length);
    slot.mesh.visible = true;
    slot.life = LIFETIME.tracer;
  };

  const spawnImpact = (point: PointLike, normal: PointLike, surface: SurfaceKind, flashScale = 1): void => {
    const color = SURFACE_COLOR[surface];

    const decal = decals[decalCursor];
    decalCursor = (decalCursor + 1) % decals.length;
    if (decal) {
      decal.mesh.position.set(point.x + normal.x * 0.012, point.y + normal.y * 0.012, point.z + normal.z * 0.012);
      tmpVec.set(point.x + normal.x, point.y + normal.y, point.z + normal.z);
      decal.mesh.lookAt(tmpVec);
      const size = rng.range(0.85, 1.3);
      decal.mesh.scale.set(size, size, size);
      decal.mesh.visible = true;
      decal.life = LIFETIME.decal;
      (decal.mesh.material as MeshBasicMaterial).color.setHex(surface === 'target' ? 0x7a1410 : 0x0a0a0a);
    }

    const burst = sparkBursts[sparkCursor];
    sparkCursor = (sparkCursor + 1) % sparkBursts.length;
    if (burst) {
      const array = burst.positions.array as Float32Array;
      for (let i = 0; i < burst.count; i += 1) {
        array[i * 3] = point.x;
        array[i * 3 + 1] = point.y;
        array[i * 3 + 2] = point.z;
        // Spray biased along the surface normal, plus a little scatter, so the
        // sparks read as coming *out of* the wall rather than off it.
        const along = rng.range(1.4, 4.6);
        burst.velocities[i * 3] = normal.x * along + rng.range(-1.7, 1.7);
        burst.velocities[i * 3 + 1] = normal.y * along + rng.range(-0.5, 2.3);
        burst.velocities[i * 3 + 2] = normal.z * along + rng.range(-1.7, 1.7);
      }
      burst.positions.needsUpdate = true;
      burst.points.geometry.setDrawRange(0, burst.count);
      (burst.points.material as PointsMaterial).color.setHex(color);
      burst.points.visible = true;
      burst.life = LIFETIME.sparks;
    }

    hitFlash.position.set(point.x + normal.x * 0.05, point.y + normal.y * 0.05, point.z + normal.z * 0.05);
    hitFlashMaterial.color.setHex(color);
    hitFlash.visible = true;
    hitFlashLife = LIFETIME.hitFlash;
    hitFlashScale = flashScale > 0 ? flashScale : 1;
    hitFlash.scale.setScalar(hitFlashScale * 0.6);
  };

  /**
   * The detonation itself, shared by the item explosion and the Warden's death.
   *
   * Extracted from the public `explode` method because `attach` needs to call it and
   * a method on the object literal being constructed is not in scope inside its own
   * sibling closure — the kind of mistake that only shows up at runtime.
   */
  const detonate = (position: PointLike, radius: number): void => {
    const slot = blastShells[blastCursor];
    blastCursor = (blastCursor + 1) % blastShells.length;
    if (slot) {
      slot.mesh.position.set(position.x, position.y, position.z);
      // Starts at a third of the radius so the shell reads as growing *out of* the
      // impact rather than appearing at full size, which is the difference between a
      // blast and a bubble.
      slot.mesh.scale.setScalar(Math.max(0.15, radius * 0.34));
      slot.mesh.visible = true;
      slot.material.opacity = 0.7;
      slot.life = BLAST_SHELL_LIFE;
    }
    // A spark burst in the same surface colour the bullet impacts use. The normal is
    // straight up: a blast throws debris up and out, and the burst's own scatter
    // supplies the "out".
    spawnImpact(position, UP, 'ground', 2.2);
  };

  const spawnDamageNumber = (amount: number, screen: ScreenPoint): void => {
    const index = numberCursor;
    numberCursor = (numberCursor + 1) % numberPool.length;
    const element = numberPool[index];
    if (!element) return;
    element.textContent = String(Math.round(amount));
    element.style.left = `${screen.x.toFixed(1)}px`;
    element.style.top = `${screen.y.toFixed(1)}px`;
    // Slight per-hit jitter so simultaneous numbers do not stack illegibly.
    element.style.setProperty('--dx', `${rng.range(-18, 18).toFixed(1)}px`);
    element.style.opacity = '1';
    numberLife[index] = 0.75;
  };

  return {
    attach(events) {
      events.on('shot:fired', (payload) => {
        // A short starter streak at the muzzle. The full-length tracer is drawn
        // on impact or miss, so the two together read as one continuous line.
        spawnTracer(payload.origin, {
          x: payload.origin.x + payload.direction.x * 1.6,
          y: payload.origin.y + payload.direction.y * 1.6,
          z: payload.origin.z + payload.direction.z * 1.6,
        });
      });

      events.on('bullet:impact', (payload) => {
        spawnTracer(payload.point, payload.point);
        spawnImpact(payload.point, payload.normal, payload.surface);
      });

      events.on('bullet:miss', (payload) => {
        // A miss still draws a full-length tracer: without it, a shot into empty
        // space reads as a shot that never happened.
        spawnTracer(payload.end, payload.end);
      });

      events.on('hit:registered', (payload) => {
        if (!projectToScreen) return;
        const screen = projectToScreen(payload.point);
        if (screen.visible) spawnDamageNumber(payload.finalDamage, screen);
      });

      /**
       * A death puff, in the same visual language as every other impact.
       *
       * Phase 4 addition. The body's collapse animation is the primary kill signal,
       * but it is a slow rotation on a shape that is already small at range, so at
       * the far end of a 48 m arena a kill and a miss looked alike. The burst reuses
       * the pools that already exist — a spark burst plus the shared hit flash — so
       * the fix costs no new allocation and no new draw call type.
       *
       * The Warden gets a blast shell as well, because its death is a run beat and
       * the shell is the same "something big happened here" language the item
       * explosion uses.
       */
      events.on('enemy:died', (payload) => {
        const heavy = payload.archetype === 'large';
        const at = { x: payload.position.x, y: payload.position.y + (heavy ? 1.7 : 0.6), z: payload.position.z };
        spawnImpact(at, UP, 'target', RENDER.deathBurstScale);
        if (heavy) detonate(payload.position, RENDER.bossDeathBurstRadius);
      });
    },

    update(dt) {
      if (muzzleLife > 0) {
        muzzleLife = Math.max(0, muzzleLife - dt);
        if (muzzleLife === 0) {
          muzzleFlash.visible = false;
        } else {
          const t = muzzleLife / LIFETIME.muzzleFlash;
          muzzleMaterial.opacity = 0.95 * t;
          muzzleFlash.scale.setScalar(0.7 + (1 - t) * 0.9);
        }
      }

      for (const tracer of tracers) {
        if (tracer.life <= 0) continue;
        tracer.life -= dt;
        if (tracer.life <= 0) {
          tracer.mesh.visible = false;
          continue;
        }
        (tracer.mesh.material as MeshBasicMaterial).opacity = 0.9 * (tracer.life / tracer.maxLife);
      }

      for (const decal of decals) {
        if (decal.life <= 0) continue;
        decal.life -= dt;
        if (decal.life <= 0) {
          decal.mesh.visible = false;
          continue;
        }
        // Fade only over the last second, so the ring-buffer recycle is not a pop.
        (decal.mesh.material as MeshBasicMaterial).opacity = 0.5 * Math.min(1, decal.life);
      }

      for (const burst of sparkBursts) {
        if (burst.life <= 0) continue;
        burst.life -= dt;
        if (burst.life <= 0) {
          burst.points.visible = false;
          burst.points.geometry.setDrawRange(0, 0);
          continue;
        }
        const array = burst.positions.array as Float32Array;
        for (let i = 0; i < burst.count; i += 1) {
          const vy = (burst.velocities[i * 3 + 1] ?? 0) - 15 * dt;
          burst.velocities[i * 3 + 1] = vy;
          array[i * 3] = (array[i * 3] ?? 0) + (burst.velocities[i * 3] ?? 0) * dt;
          array[i * 3 + 1] = (array[i * 3 + 1] ?? 0) + vy * dt;
          array[i * 3 + 2] = (array[i * 3 + 2] ?? 0) + (burst.velocities[i * 3 + 2] ?? 0) * dt;
        }
        burst.positions.needsUpdate = true;
        (burst.points.material as PointsMaterial).opacity = 0.95 * (burst.life / burst.maxLife);
      }

      for (const slot of blastShells) {
        if (slot.life <= 0) continue;
        slot.life = Math.max(0, slot.life - dt);
        if (slot.life === 0) {
          slot.mesh.visible = false;
          continue;
        }
        const t = 1 - slot.life / BLAST_SHELL_LIFE;
        // Expands as it fades: the shell reaches its full size exactly as it
        // disappears, so the last thing on screen is the blast's real footprint.
        slot.mesh.scale.multiplyScalar(1 + t * 0.14);
        slot.material.opacity = 0.7 * (1 - t) * (1 - t);
      }

      if (hitFlashLife > 0) {
        hitFlashLife = Math.max(0, hitFlashLife - dt);
        if (hitFlashLife === 0) {
          hitFlash.visible = false;
        } else {
          const t = hitFlashLife / LIFETIME.hitFlash;
          hitFlashMaterial.opacity = 0.9 * t;
          hitFlash.scale.setScalar(hitFlashScale * (0.6 + (1 - t) * 1.7));
        }
      }

      for (let i = 0; i < numberPool.length; i += 1) {
        const life = numberLife[i] ?? 0;
        if (life <= 0) continue;
        const next = Math.max(0, life - dt);
        numberLife[i] = next;
        const element = numberPool[i];
        if (!element) continue;
        if (next === 0) {
          element.style.opacity = '0';
        } else {
          element.style.transform = `translate(-50%, calc(-50% - ${((0.75 - next) * 48).toFixed(1)}px)) translateX(var(--dx, 0))`;
        }
      }
    },

    setMuzzle(position, direction, visible) {
      if (!visible) {
        muzzleLife = 0;
        muzzleFlash.visible = false;
        return;
      }
      muzzleFlash.position.set(position.x, position.y, position.z);
      tmpVec.set(position.x + direction.x, position.y + direction.y, position.z + direction.z);
      muzzleFlash.lookAt(tmpVec);
      // Random roll so repeated shots do not look like a rubber stamp.
      muzzleFlash.rotateZ(rng.range(0, Math.PI * 2));
      muzzleFlash.visible = true;
      muzzleLife = LIFETIME.muzzleFlash;
    },

    setProjector(fn) {
      projectToScreen = fn;
    },

    explode(position, radius) {
      detonate(position, radius);
    },

    dispose() {
      scene.remove(root);
      muzzleGeometry.dispose();
      muzzleMaterial.dispose();
      tracerGeometry.dispose();
      for (const material of tracerMaterials) material.dispose();
      decalGeometry.dispose();
      for (const decal of decals) (decal.mesh.material as MeshBasicMaterial).dispose();
      hitFlashGeometry.dispose();
      hitFlashMaterial.dispose();
      for (const burst of sparkBursts) {
        burst.points.geometry.dispose();
        (burst.points.material as PointsMaterial).dispose();
      }
      for (const slot of blastShells) {
        slot.mesh.geometry.dispose();
        slot.material.dispose();
      }
      for (const element of numberPool) element.remove();
    },
  };
}
