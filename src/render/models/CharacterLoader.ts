/**
 * Character model loading.
 *
 * The supplied player model is a runtime asset, not a build input: dropping
 * `public/assets/models/player/player.glb` into place has to work with **no code
 * change**, and a missing file or a missing clip has to degrade rather than throw.
 * That contract is the whole reason this module exists separately from the enemy
 * view — the enemy view always has a procedural body to fall back to, and this is
 * the thing that decides whether there is a supplied one to use instead.
 *
 * ## The silent failure this module is built around
 *
 * `Object3D.layers` is **not inherited by children**. Setting the layer on a loaded
 * model's root is a no-op, and the visible symptom is that raycasts "only work on
 * layer 0" — enemies become unhittable while the code that sets the layer looks
 * perfectly correct. Every mesh must be assigned individually, inside `traverse`.
 * The same loop attaches `userData.hitZone`, because the zone guess and the layer
 * assignment have to happen together or one of them will be forgotten.
 *
 * ## Clip matching
 *
 * Clip names are matched by case-insensitive keyword, because the naming of a
 * delivered file is not something this project controls ("Idle", "idle_01",
 * "mixamorig:Idle" all have to land on the same state). A missing clip falls back
 * to the nearest state that *does* exist — `run → walk → idle` — and warns once, on
 * the console, naming the clip that was missing.
 */

import {
  AnimationClip,
  AnimationMixer,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  type AnimationAction,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ENEMY_SMALL } from '../../core/config';
import { inferZone } from '../../game/combat/hitboxes';

/** Layers used by the renderer. Layer 0 is the level and everything decorative. */
export const LAYER_DEFAULT = 0;
/**
 * Layer every damageable body part is moved to.
 *
 * Phase 1's shot resolution is analytic and never consults `layers`; this exists so
 * a *renderer-side* pick (the debug panel's "what is under the cursor", and phase 4's
 * decal placement) cannot hit an enemy hitbox by accident. It is assigned per mesh
 * anyway, because that is the lesson in the module header.
 */
export const LAYER_HITTABLE = 2;

/** Locomotion and combat states the game asks a character for. */
export type CharacterState = 'idle' | 'walk' | 'run' | 'shoot' | 'reload' | 'death';

/**
 * Keyword table, in priority order.
 *
 * `walk` is listed before `run` for a reason: a file whose only locomotion clip is
 * called `walk_run_cycle` should be treated as a walk, because the fallback chain
 * (`run → walk → idle`) is then able to serve both states from it. Matching `run`
 * first would leave `walk` empty and produce a warning for a clip that is present.
 */
const CLIP_KEYWORDS: readonly { state: CharacterState; keywords: readonly string[] }[] = [
  { state: 'walk', keywords: ['walk'] },
  { state: 'run', keywords: ['run', 'sprint', 'jog'] },
  { state: 'reload', keywords: ['reload', 'reloads'] },
  { state: 'shoot', keywords: ['shoot', 'fire', 'attack'] },
  { state: 'death', keywords: ['death', 'die', 'dead'] },
  { state: 'idle', keywords: ['idle', 'breath', 'stand'] },
];

/**
 * Fallback chain per state.
 *
 * A state with no clip borrows the nearest one that exists rather than freezing on
 * the bind pose — a character that stands perfectly still while running is worse
 * than one whose run looks like a walk.
 */
const FALLBACKS: Record<CharacterState, readonly CharacterState[]> = {
  idle: ['idle'],
  walk: ['walk', 'run', 'idle'],
  run: ['run', 'walk', 'idle'],
  shoot: ['shoot', 'idle'],
  reload: ['reload', 'idle'],
  death: ['death', 'idle'],
};

/** What the caller gets back. Safe to call in any state, at any time. */
export interface CharacterModel {
  readonly root: Object3D;
  /** Blends to a state. Ignored while the model is mid-death. */
  play(state: CharacterState): void;
  /** Advances the mixer. `dt` is render time. */
  update(dt: number): void;
  /** True when every requested state resolved to a real clip. */
  readonly complete: boolean;
  /** Clip names that were missing and had to be substituted. */
  readonly missing: readonly CharacterState[];
  /** True when nothing was loaded and the procedural stand-in is in use. */
  readonly placeholder: boolean;
  dispose(): void;
}

/** Options for {@link loadCharacter}. */
export interface CharacterLoadOptions {
  /** Target height in metres. The model is scaled uniformly to match. */
  readonly height?: number;
  /** Called for every degradation, so the composition root can surface it. */
  readonly onWarn?: (message: string) => void;
}

/**
 * A procedural stand-in body.
 *
 * Deliberately the same silhouette the practice dummies use, so "the supplied model
 * has not arrived yet" looks like the project's own art rather than like a bug.
 */
export function createPlaceholderCharacter(height: number, colour = 0x5a6472): CharacterModel {
  const root = new Group();
  root.name = 'character:placeholder';
  const material = new MeshStandardMaterial({ color: colour, roughness: 0.7, metalness: 0.15 });
  const geometry = new SphereGeometry(1, 12, 10);
  const body = new Mesh(geometry, material);
  body.scale.set(height * 0.28, height * 0.5, height * 0.28);
  body.position.y = height * 0.5;
  body.castShadow = true;
  body.layers.disableAll();
  body.layers.enable(LAYER_DEFAULT);
  root.add(body);
  return {
    root,
    play() {
      /* A capsule has no states. */
    },
    update() {
      /* Nothing to advance. */
    },
    complete: false,
    missing: [],
    placeholder: true,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Loads a character, or falls back to the placeholder.
 *
 * **Never rejects.** A loader that throws on a missing file makes "the asset has not
 * been delivered yet" indistinguishable from "the game is broken", and the brief is
 * explicit that an absent model must not block anything.
 */
export async function loadCharacter(url: string, options: CharacterLoadOptions = {}): Promise<CharacterModel> {
  const height = options.height ?? 1.75;
  const warn = options.onWarn ?? ((message: string) => console.warn(message));

  let gltf: { scene: Object3D; animations: AnimationClip[] };
  try {
    const loader = new GLTFLoader();
    gltf = (await loader.loadAsync(url)) as unknown as { scene: Object3D; animations: AnimationClip[] };
  } catch (error) {
    // A 404 is the expected case before the asset is delivered, so it is reported
    // as information rather than as an error.
    warn(
      `[character] no model at "${url}" (${describeError(error)}) -- using the procedural stand-in. ` +
        'Drop a .glb at that path and it will be picked up with no code change.',
    );
    return createPlaceholderCharacter(height);
  }

  return buildCharacter(gltf.scene, gltf.animations ?? [], height, warn);
}

/** Wraps an already-loaded scene. Split out so tests can drive it without a loader. */
export function buildCharacter(
  scene: Object3D,
  clips: readonly AnimationClip[],
  height: number,
  warn: (message: string) => void,
): CharacterModel {
  const root = new Group();
  root.name = 'character';
  root.add(scene);

  // --- Normalise the scale ---------------------------------------------------
  // The delivered model is specified as ~1.75 m with its feet at the origin, but a
  // model that is 40x too big or small is a common export mistake and it would
  // otherwise read as "the enemy hitbox is wrong".
  const measured = measureHeight(scene);
  if (measured > 1e-3) {
    const scale = height / measured;
    if (Math.abs(scale - 1) > 0.02) {
      scene.scale.multiplyScalar(scale);
      warn(
        `[character] model measured ${measured.toFixed(2)} m against a target of ${height.toFixed(2)} m; ` +
          `scaled by ${scale.toFixed(3)}. Fix the export rather than relying on this.`,
      );
    }
  }

  // --- Per-mesh layer and zone assignment (the trap) -------------------------
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    // NOT inherited. Every mesh, no exceptions: setting this on `root` leaves every
    // child on layer 0 and the hit query silently finds nothing.
    mesh.layers.disableAll();
    mesh.layers.enable(LAYER_HITTABLE);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.hitZone = inferZone(mesh.name || object.parent?.name || '');
  });

  // --- Clip resolution -------------------------------------------------------
  const resolved = new Map<CharacterState, AnimationClip>();
  const missing: CharacterState[] = [];
  for (const { state, keywords } of CLIP_KEYWORDS) {
    const direct = findClip(clips, keywords);
    if (direct) {
      resolved.set(state, direct);
      continue;
    }
    const substitute = FALLBACKS[state].map((candidate) => resolved.get(candidate)).find(Boolean);
    if (substitute) {
      resolved.set(state, substitute);
      missing.push(state);
      warn(
        `[character] no AnimationClip matching ${keywords.join('/')} for the "${state}" state; ` +
          `falling back to "${substitute.name}".`,
      );
    } else {
      missing.push(state);
    }
  }

  const mixer = new AnimationMixer(scene);
  const actions = new Map<CharacterState, AnimationAction>();
  let current: CharacterState | null = null;
  let currentAction: AnimationAction | null = null;
  let dying = false;

  for (const [state, clip] of resolved) {
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setEffectiveWeight(0);
    // A death clip holds its last frame; everything else loops.
    action.setLoop(clip.name.toLowerCase().includes('death') || clip.name.toLowerCase().includes('die') ? 2201 : 2200, Infinity);
    actions.set(state, action);
  }

  const model: CharacterModel = {
    root,

    play(state) {
      if (dying && state !== 'death') return;
      if (state === current) return;
      const next = actions.get(state) ?? actions.get('idle');
      if (!next) {
        // No clips at all: the model is a statue, which is still better than a
        // crash and is exactly what the placeholder path also produces.
        current = state;
        return;
      }
      if (state === 'death') dying = true;
      if (currentAction && currentAction !== next) {
        // A short crossfade rather than a hard cut. 0.15 s is under the eye's
        // threshold for "pop" but long enough that a walk-to-run change reads as a
        // transition instead of a glitch.
        next.reset().setEffectiveWeight(1).fadeIn(0.15).play();
        currentAction.fadeOut(0.15);
      } else {
        next.reset().setEffectiveWeight(1).play();
      }
      currentAction = next;
      current = state;
    },

    update(dt) {
      mixer.update(dt);
    },

    complete: missing.length === 0,
    missing,
    placeholder: false,

    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
      scene.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) for (const entry of material) entry.dispose();
        else material?.dispose();
      });
    },
  };

  // A model with no clips is playable but frozen; report it as degraded so the
  // composition root can say so once, loudly, instead of the player wondering.
  if (actions.size === 0) {
    warn(`[character] "${scene.name || 'model'}" has no usable AnimationClips at all; it will not animate.`);
  }

  return model;
}

/** Finds the first clip whose name matches any keyword, case-insensitively. */
export function findClip(clips: readonly AnimationClip[], keywords: readonly string[]): AnimationClip | undefined {
  return clips.find((clip) => {
    const name = clip.name.toLowerCase();
    return keywords.some((keyword) => name.includes(keyword));
  });
}

/** Axis-aligned height of a subtree, from its world-space bounding boxes. */
function measureHeight(scene: Object3D): number {
  scene.updateMatrixWorld(true);
  let min = Infinity;
  let max = -Infinity;
  const corner = { x: 0, y: 0, z: 0 };
  const point = { x: 0, y: 0, z: 0 };
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (!box) return;
    const m = mesh.matrixWorld.elements;
    for (let i = 0; i < 8; i += 1) {
      corner.x = i & 1 ? box.max.x : box.min.x;
      corner.y = i & 2 ? box.max.y : box.min.y;
      corner.z = i & 4 ? box.max.z : box.min.z;
      transformPoint(point, corner, m);
      if (point.y < min) min = point.y;
      if (point.y > max) max = point.y;
    }
  });
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  return Math.max(0, max - min);
}

/**
 * Applies a column-major 4x4 to a point, in place.
 *
 * Hand-rolled rather than pulling in `Vector3`: this is the module's only matrix
 * arithmetic, and `three`'s vector class is not otherwise needed here.
 */
function transformPoint(
  out: { x: number; y: number; z: number },
  point: { x: number; y: number; z: number },
  m: ArrayLike<number>,
): void {
  const x = point.x;
  const y = point.y;
  const z = point.z;
  const w = (m[3] ?? 0) * x + (m[7] ?? 0) * y + (m[11] ?? 0) * z + (m[15] ?? 1);
  const inv = w === 0 ? 1 : 1 / w;
  out.x = ((m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0)) * inv;
  out.y = ((m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0)) * inv;
  out.z = ((m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0)) * inv;
}

/** Short, human-readable reason for a load failure. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Default path the art brief specifies.
 *
 * **Relative on purpose — the leading `./` is load-bearing.** Vite's `base` is
 * `'./'`, so the page can be mounted anywhere: a user site at `/`, a GitHub Pages
 * project site at `/<repo>/`, or a desktop `file://` document. An absolute
 * `/assets/...` resolves against the *origin* (or, under `file://`, against the
 * drive root), so the asset would 404 in exactly those two cases — and because a
 * missing model is a supported degradation here, the failure would be silent:
 * the procedural stand-in appears and nothing says why. This is the `dist/`-works-
 * from-anywhere rule (plan §2.5) applied to the one runtime asset.
 */
export const PLAYER_MODEL_URL = './assets/models/player/player.glb';

/** Enemy model paths, if the same convention is extended to enemies later. */
export const ENEMY_MODEL_URLS = {
  small: './assets/models/enemy/stalker.glb',
  large: './assets/models/enemy/warden.glb',
} as const;

/** Height the player model is normalised to, matching `PLAYER.height`. */
export const PLAYER_MODEL_HEIGHT = 1.75;

/** Height the small enemy's placeholder is built at. */
export const SMALL_PLACEHOLDER_HEIGHT = ENEMY_SMALL.height;
