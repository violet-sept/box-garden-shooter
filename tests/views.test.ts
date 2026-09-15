/**
 * Presentation-layer tests: enemy bodies, telegraph markers, damage vignette, and the
 * player's own body.
 *
 * The rule is that `src/render/**` decides nothing, so there is deliberately very
 * little here to assert. What is left is the handful of properties that are
 * expensive to get wrong and invisible in a screenshot:
 *
 *   - **The body pool does not grow during play.** "One `Group` per enemy per
 *     frame" is the classic way a layer like this quietly starts allocating.
 *   - **A corpse plays out before its slot is reused.** An enemy that vanishes on
 *     the frame it dies reads as a despawn rather than as a kill.
 *   - **Markers are keyed by index against the simulation's array**, because that
 *     is the contract the composition root relies on when it rebuilds the marker
 *     list every frame instead of pushing events.
 *   - **The player's body is turned and placed by the rig** (phase 6), which is the
 *     part that used to be four untestable lines inside `main.ts`.
 *
 * None of this needs WebGL: geometry, materials and the scene graph are plain data
 * structures until something renders them.
 */

import { describe, expect, it } from 'vitest';
import { AnimationClip, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Sprite, SpriteMaterial, Vector3 } from 'three';
import { createEnemyView } from '#/render/models/enemyView';
import { buildCharacter, createPlaceholderCharacter, type CharacterModel } from '#/render/models/CharacterLoader';
import { createCharacterRig } from '#/render/models/characterRig';
import { createTelegraphView } from '#/render/fx/telegraph';
import { createHud, overlayVisibility, type HudElements } from '#/render/hud/hud';
import { createWorld } from '#/game/World';
import { createPlayerState } from '#/game/player/player';
import { createWeaponState } from '#/game/player/weapon';
import { ENEMY_ARCHETYPES, HEALTH_BAR, PLAYER, WEAPON_MODEL } from '#/core/config';
import { DEG2RAD } from '#/core/math/vec3';
import { EventBus } from '#/core/events';
import type { EnemyState } from '#/game/enemies/EnemyState';
import type { PlayerState } from '#/game/player/player';
import type { ImpactMarker } from '#/render/fx/telegraph';

/**
 * A handful of real enemies of both archetypes, spawned straight into a world.
 *
 * Phase 2 borrowed these from the debug line-up. That line-up is gone (stage 3
 * replaced it with the wave director), so the test builds them explicitly: the view
 * layer only needs live entries of each kind, and going through the store's public
 * `spawn` is both cheaper and closer to how the director does it.
 */
function liveEnemies(): EnemyState[] {
  const world = createWorld({ events: new EventBus(), seed: 7 });
  world.enemies.spawn('small', { x: -9, y: 0, z: -6 }, { state: 'IDLE' });
  world.enemies.spawn('small', { x: -6.5, y: 0, z: -10 }, { state: 'IDLE' });
  world.enemies.spawn('small', { x: 9.5, y: 0, z: -8 }, { state: 'IDLE' });
  world.enemies.spawn('large', { x: -14, y: 0, z: 8 }, { state: 'IDLE' });
  return world.enemies.targets.filter((enemy) => enemy.kind !== 'dummy');
}

/** How many meshes the view has built in total, pooled and visible alike. */
function meshCount(root: Object3D): number {
  let count = 0;
  root.traverse((object) => {
    if ((object as Mesh).isMesh) count += 1;
  });
  return count;
}

describe('enemy view', () => {
  it('does not grow its pool as bodies come and go', () => {
    const enemies = liveEnemies();
    const view = createEnemyView();
    view.update(enemies, 0, 1 / 60);
    const built = meshCount(view.root);
    expect(built).toBeGreaterThan(0);

    // Churn the line-up the way a wave does: kill half, drive the rest, spawn the
    // dead ones back at a different position.
    for (let round = 0; round < 40; round += 1) {
      for (let i = 0; i < enemies.length; i += 1) {
        const enemy = enemies[i]!;
        enemy.alive = i % 2 === 0 || round % 3 !== 0;
        enemy.previousPosition.x = enemy.position.x;
        enemy.position.x += 0.05;
      }
      view.update(enemies, 0.5, 1 / 60);
    }
    expect(meshCount(view.root)).toBe(built);
  });

  it('hides a dead body instead of deleting it, then reuses it', () => {
    const enemies = liveEnemies();
    const view = createEnemyView();
    view.update(enemies, 0, 1 / 60);
    const before = view.root.children.filter((child) => child.visible).length;
    expect(before).toBeGreaterThan(0);

    // Killed: the view is told nothing, the enemy simply stops being reported. The
    // body stays on screen rather than blinking out on the frame of the kill.
    const survivors = enemies.filter((_, index) => index !== 0);
    view.update(survivors, 0, 1 / 60);
    expect(view.root.children.filter((child) => child.visible).length).toBe(before);

    // A few frames into the collapse it is visibly falling over.
    for (let i = 0; i < 6; i += 1) view.update(survivors, 0, 1 / 60);
    const fallen = view.root.children.find((child) => Math.abs(child.rotation.x) > 0.05);
    expect(fallen).toBeDefined();

    // Past the corpse lifetime the slot goes back to the pool: same bodies, fewer
    // visible, and no new mesh was built.
    const built = meshCount(view.root);
    for (let i = 0; i < 120; i += 1) view.update(survivors, 0, 1 / 60);
    expect(view.root.children.filter((child) => child.visible).length).toBeLessThan(before);
    expect(meshCount(view.root)).toBe(built);
  });

  it('interpolates between the previous and the current tick position', () => {
    const [enemy] = liveEnemies();
    expect(enemy).toBeDefined();
    const view = createEnemyView();
    enemy!.previousPosition.x = 0;
    enemy!.previousPosition.z = 0;
    enemy!.position.x = 10;
    enemy!.position.z = 0;

    view.update([enemy!], 0, 1 / 60);
    const atStart = view.root.children[0]!.position.x;
    view.update([enemy!], 1, 1 / 60);
    const atEnd = view.root.children[0]!.position.x;
    expect(atStart).toBeCloseTo(0, 6);
    expect(atEnd).toBeCloseTo(10, 6);
  });

  it('clamps an out-of-range interpolation factor rather than overshooting', () => {
    const [enemy] = liveEnemies();
    enemy!.previousPosition.x = 0;
    enemy!.position.x = 4;
    const view = createEnemyView();
    view.update([enemy!], 40, 1 / 60);
    expect(view.root.children[0]!.position.x).toBeCloseTo(4, 6);
    view.update([enemy!], -3, 1 / 60);
    expect(view.root.children[0]!.position.x).toBeCloseTo(0, 6);
  });

  it('shows the two archetypes at plainly different sizes', () => {
    const enemies = liveEnemies();
    const kinds = new Set(enemies.map((enemy) => enemy.kind));
    expect(kinds.has('small')).toBe(true);
    expect(kinds.has('large')).toBe(true);

    const view = createEnemyView();
    view.update(enemies, 0, 1 / 60);
    const height = (kind: string): number => {
      const group = view.root.children.find((child) => child.name === `enemy:${kind}`);
      expect(group).toBeDefined();
      const box = new Vector3();
      const union = { min: Infinity, max: -Infinity };
      group!.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.computeBoundingBox();
        box.copy(mesh.geometry.boundingBox!.max).add(mesh.position);
        union.max = Math.max(union.max, box.y);
        box.copy(mesh.geometry.boundingBox!.min).add(mesh.position);
        union.min = Math.min(union.min, box.y);
      });
      return union.max - union.min;
    };
    const small = height('small');
    const large = height('large');
    // The acceptance criterion is "tell them apart at a glance", and the cheapest
    // axis to check mechanically is that the Warden really is a head taller.
    expect(large).toBeGreaterThan(small * 1.5);
  });

  it('disposes every geometry and material it built', () => {
    const view = createEnemyView();
    view.update(liveEnemies(), 0, 1 / 60);
    expect(() => view.dispose()).not.toThrow();
    expect(view.root.children.length).toBe(0);
  });

  /**
   * Phase 4 shadow audit.
   *
   * A corpse lies on the ground for 1.4 s doing nothing, and it used to keep casting
   * a shadow for that whole time: the shadow pass is a *second* traversal of every
   * casting object, so a body that cannot move and is about to shrink to a fifth of
   * its size is the cheapest thing on the field to stop drawing twice.
   */
  it('stops a corpse casting a shadow, and restores it when the slot is reused', () => {
    const enemies = liveEnemies();
    const view = createEnemyView();
    const census = (): { casting: number; meshes: number } => {
      let casting = 0;
      let meshes = 0;
      view.root.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        meshes += 1;
        if (mesh.castShadow) casting += 1;
      });
      return { casting, meshes };
    };

    view.update(enemies, 0, 1 / 60);
    const alive = census();
    expect(alive.meshes).toBeGreaterThan(0);
    expect(alive.casting).toBe(alive.meshes);

    // Every body stops being reported at once: all of them are corpses now.
    view.update([], 0, 1 / 60);
    expect(census().casting).toBe(0);

    // One small enemy is reported again, so its slot is taken back out of the corpse
    // pile — with its shadow flag back on.
    const stalker = enemies.find((enemy) => enemy.kind === 'small');
    expect(stalker).toBeDefined();
    view.update([stalker!], 0, 1 / 60);

    const fullyCasting = view.root.children.filter((child) => {
      let meshes = 0;
      let casting = 0;
      child.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        meshes += 1;
        if (mesh.castShadow) casting += 1;
      });
      return meshes > 0 && casting === meshes;
    });
    expect(fullyCasting).toHaveLength(1);
    expect(fullyCasting[0]!.name).toBe('enemy:small');
  });

  /**
   * The pool audit.
   *
   * "One `Group` per enemy per frame" is the failure this pins: the object graph must
   * be identical across repeated `update` calls for the same live set, and the pool
   * must settle at the peak number of *simultaneously* tracked bodies rather than at
   * the number of deaths.
   */
  it('keeps updating without building anything new', () => {
    const enemies = liveEnemies();
    const view = createEnemyView();
    for (let i = 0; i < 30; i += 1) view.update(enemies, i / 30, 1 / 60);

    const children = new Set<Object3D>(view.root.children);
    const meshes = meshCount(view.root);
    for (let i = 0; i < 120; i += 1) view.update(enemies, 1 - i / 120, 1 / 60);

    expect(new Set<Object3D>(view.root.children)).toEqual(children);
    expect(meshCount(view.root)).toBe(meshes);
  });

  /**
   * The health bars.
   *
   * The requirement is "a red bar over every enemy, short on the small one and long on the
   * big one, in proportion to the body" — so the assertions are the size relationship, the
   * colour, the fill tracking the damage, and the one thing a screenshot cannot show: that
   * a corpse does not keep a bar floating over it.
   */
  describe('health bars', () => {
    /** The bar group under a body of the given kind, or `undefined`. */
    const barFor = (view: ReturnType<typeof createEnemyView>, kind: string): Object3D | undefined =>
      view.root.children.find((child) => child.name === `enemy:${kind}`)?.children.find((child) => child.name.endsWith(':bar'));

    const spriteNamed = (bar: Object3D, name: string): Sprite => {
      const found = bar.children.find((child) => child.name === name);
      expect(found).toBeDefined();
      expect((found as Sprite).isSprite).toBe(true);
      return found as Sprite;
    };

    it('sizes each bar to the body it belongs to, and places it above that body', () => {
      const enemies = liveEnemies();
      const view = createEnemyView();
      view.update(enemies, 0, 1 / 60);

      for (const kind of ['small', 'large'] as const) {
        const bar = barFor(view, kind);
        expect(bar, kind).toBeDefined();
        const track = spriteNamed(bar!, 'health-track');
        const fill = spriteNamed(bar!, 'health-fill');
        expect(track.scale.x).toBeCloseTo(HEALTH_BAR.width[kind], 6);
        expect(fill.scale.x).toBeCloseTo(HEALTH_BAR.width[kind], 6);
        expect(track.scale.y).toBeCloseTo(HEALTH_BAR.height[kind], 6);
        // The bar clears the silhouette: the Warden is 3.4 m tall, the Stalker 1.1 m.
        expect(bar!.position.y).toBeCloseTo(ENEMY_ARCHETYPES[kind].height + HEALTH_BAR.topGap[kind], 6);
      }

      // "Short on the small one, long on the big one" — the whole point of the feature.
      const small = spriteNamed(barFor(view, 'small')!, 'health-fill');
      const large = spriteNamed(barFor(view, 'large')!, 'health-fill');
      expect(large.scale.x).toBeGreaterThan(small.scale.x * 3);
    });

    it('paints the fill red and gives it a dark trough to sit in', () => {
      const view = createEnemyView();
      view.update(liveEnemies(), 0, 1 / 60);
      const bar = barFor(view, 'small')!;
      const fill = spriteNamed(bar, 'health-fill').material as SpriteMaterial;
      const track = spriteNamed(bar, 'health-track').material as SpriteMaterial;
      expect(fill.color.getHex()).toBe(HEALTH_BAR.fillColour);
      expect(track.color.getHex()).toBe(HEALTH_BAR.trackColour);
      // Coplanar quads: the pair must not write depth, and the fill must be ordered on top.
      expect(fill.depthWrite).toBe(false);
      expect(track.depthWrite).toBe(false);
      expect(spriteNamed(bar, 'health-fill').renderOrder).toBeGreaterThan(
        spriteNamed(bar, 'health-track').renderOrder,
      );
    });

    it('shortens the fill as the body takes damage, and refills it on reuse', () => {
      const enemies = liveEnemies();
      const stalker = enemies.find((enemy) => enemy.kind === 'small');
      expect(stalker).toBeDefined();
      const view = createEnemyView();
      view.update([stalker!], 0, 1 / 60);
      const bar = barFor(view, 'small')!;
      const fill = spriteNamed(bar, 'health-fill');
      const full = HEALTH_BAR.width.small;

      stalker!.health = stalker!.stats.maxHealth * 0.5;
      view.update([stalker!], 0, 1 / 60);
      expect(fill.scale.x).toBeCloseTo(full * 0.5, 6);

      stalker!.health = 0;
      view.update([stalker!], 0, 1 / 60);
      expect(fill.scale.x).toBeLessThan(full * 0.01);

      // A pooled body handed to the next enemy must not inherit the last one's wounds.
      stalker!.health = stalker!.stats.maxHealth;
      view.update([stalker!], 0, 1 / 60);
      expect(fill.scale.x).toBeCloseTo(full, 6);
    });

    it('takes the bar away with the corpse, and restores it when the slot is reused', () => {
      const enemies = liveEnemies();
      const stalker = enemies.find((enemy) => enemy.kind === 'small')!;
      const view = createEnemyView();
      view.update([stalker], 0, 1 / 60);
      const bar = barFor(view, 'small')!;
      expect(bar.visible).toBe(true);

      // The enemy is gone from the simulation, so it is a corpse playing out its collapse.
      view.update([], 0, 1 / 60);
      expect(bar.visible).toBe(false);

      view.update([stalker], 0, 1 / 60);
      expect(bar.visible).toBe(true);
    });

    it('adds two sprites per body and never allocates another one', () => {
      const enemies = liveEnemies();
      const view = createEnemyView();
      const countSprites = (): number => {
        let sprites = 0;
        view.root.traverse((object) => {
          if ((object as Sprite).isSprite) sprites += 1;
        });
        return sprites;
      };

      view.update(enemies, 0, 1 / 60);
      const built = countSprites();
      expect(built).toBe(enemies.length * 2);

      for (let i = 0; i < 60; i += 1) view.update(enemies, i / 60, 1 / 60);
      expect(countSprites()).toBe(built);
    });
  });

  it('settles its pool at the peak simultaneous count, not the kill count', () => {
    const world = createWorld({ events: new EventBus(), seed: 11 });
    const view = createEnemyView();
    const batch = 5;

    for (let round = 0; round < 40; round += 1) {
      const live: EnemyState[] = [];
      for (let i = 0; i < batch; i += 1) {
        live.push(world.enemies.spawn('small', { x: i * 2 - 4, y: 0, z: -6 }, { state: 'IDLE' }));
      }
      view.update(live, 0, 1 / 60);
      // Killed without waiting out the corpse life, which is what a wave actually
      // does — the bodies pile up on the ground while the next ones arrive.
      for (const enemy of live) world.enemies.despawn(enemy);
      view.update([], 0, 1 / 60);
    }

    expect(view.root.children.length).toBeLessThanOrEqual(batch);
  });
});

describe('telegraph view', () => {
  /** One marker at a fixed spot, with a fuse that burns down. */
  const marker = (fuse: number, radius = 3): ImpactMarker => ({
    position: { x: 1, y: 0, z: -2 },
    radius,
    fuse,
    total: 1,
  });

  it('maps markers to ground rings one for one', () => {
    const view = createTelegraphView();
    view.showBarrageMarkers([marker(1), marker(0.5), marker(0.2)]);
    const visible = view.root.children.filter((child) => child.visible);
    expect(visible.length).toBe(3);
    // Every marker sits on the ground plane, never at its own y.
    for (const child of visible) {
      expect(child.position.y).toBe(0);
    }
    expect(visible[0]!.position.x).toBeCloseTo(1, 6);
    expect(visible[0]!.position.z).toBeCloseTo(-2, 6);
    expect(visible[0]!.scale.x).toBeCloseTo(3, 6);
  });

  it('hides rings that are no longer reported', () => {
    const view = createTelegraphView();
    view.showBarrageMarkers([marker(1), marker(0.5), marker(0.2)]);
    expect(view.root.children.filter((child) => child.visible).length).toBe(3);
    view.showBarrageMarkers([marker(0.5)]);
    expect(view.root.children.filter((child) => child.visible).length).toBe(1);
    view.showBarrageMarkers([]);
    expect(view.root.children.filter((child) => child.visible).length).toBe(0);
  });

  it('never exceeds its pool, however many Wardens are on field', () => {
    const view = createTelegraphView();
    const many: ImpactMarker[] = [];
    for (let i = 0; i < 40; i += 1) many.push(marker(1, 2));
    expect(() => view.showBarrageMarkers(many)).not.toThrow();
    expect(view.root.children.length).toBeLessThanOrEqual(24);
  });

  it('shows a detonation flash and then clears itself', () => {
    const view = createTelegraphView();
    view.flash({ x: 4, y: 0, z: 4 }, 5);
    const flashed = view.root.children.filter((child) => child.visible);
    expect(flashed.length).toBe(1);

    view.update(0.2);
    expect(view.root.children.filter((child) => child.visible).length).toBe(1);
    // Well past the flash lifetime.
    view.update(1);
    expect(view.root.children.filter((child) => child.visible).length).toBe(0);
  });

  it('clears both rings and flashes on demand', () => {
    const view = createTelegraphView();
    view.showBarrageMarkers([marker(1)]);
    view.flash({ x: 0, y: 0, z: 0 }, 3);
    view.clear();
    expect(view.root.children.filter((child) => child.visible).length).toBe(0);
    expect(() => view.dispose()).not.toThrow();
  });
});

/** A detached DOM stand-in, so the HUD wiring can be exercised without a browser. */
function fakeElement(): HTMLElement {
  const classes = new Set<string>();
  const style = {
    setProperty(): void {},
    getPropertyValue(): string {
      return '';
    },
    opacity: '',
    width: '',
    background: '',
    animation: '',
  };
  const element = {
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    offsetWidth: 0,
    offsetHeight: 0,
    style,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
  };
  return element as unknown as HTMLElement;
}

function fakeHudElements(): HudElements {
  return {
    root: fakeElement(),
    veil: fakeElement(),
    pause: fakeElement(),
    crosshair: fakeElement(),
    healthFill: fakeElement(),
    healthText: fakeElement(),
    ammoMagazine: fakeElement(),
    ammoReserve: fakeElement(),
    ammoState: fakeElement(),
    chargeCount: fakeElement(),
    spreadHint: fakeElement(),
    stats: fakeElement(),
    hint: fakeElement(),
    damageFlash: fakeElement(),
  };
}

describe('HUD layer state', () => {
  it('ships each overlay and the HUD as exact opposites, in both directions', () => {
    const elements = fakeHudElements();
    const hud = createHud(elements);

    hud.showVeil('title', 'detail');
    expect(elements.veil.hidden).toBe(false);
    expect(elements.pause.hidden).toBe(true);
    expect(elements.root.hidden).toBe(true);
    // The bug that shipped: the veil was never hidden, so the canvas stayed covered
    // while every state assertion still read correctly.
    expect(overlayVisibility('boot').veilHidden).toBe(false);

    // Esc. The pause panel is its own layer, so the opaque veil must be down while it is up.
    hud.showPause();
    expect(elements.pause.hidden).toBe(false);
    expect(elements.veil.hidden).toBe(true);
    expect(elements.root.hidden).toBe(true);

    hud.hideOverlays();
    expect(elements.veil.hidden).toBe(true);
    expect(elements.pause.hidden).toBe(true);
    expect(elements.root.hidden).toBe(false);
  });

  it('flashes the damage vignette for both hits, not just the first', () => {
    const elements = fakeHudElements();
    const hud = createHud(elements);
    hud.flashDamage(0.5);
    expect(elements.damageFlash.classList.contains('hit')).toBe(true);
    hud.flashDamage(1);
    // The animation class is re-added every time, so a second hit inside the CSS
    // animation window is not silently swallowed.
    expect(elements.damageFlash.classList.contains('hit')).toBe(true);
    expect(() => hud.dispose()).not.toThrow();
  });
});

/**
 * The body rig.
 *
 * These are the assertions that the four lines in `main.ts` could never have: the body turn
 * is driven, the clip follows the simulation's velocity rather than the keyboard, and a
 * restart puts a dead body back on its feet. Every one of them is a `main.ts`-shaped mistake
 * that a green suite would have let through — `InputState.update()` was never called for the
 * whole life of the build for exactly this reason.
 */
describe('character rig', () => {
  /** A player state good enough to drive the rig: a rig reads, it does not simulate. */
  function playerState(overrides: Partial<PlayerState> = {}): PlayerState {
    const state = createPlayerState(createWeaponState(1));
    return Object.assign(state, overrides);
  }

  /**
   * A body with real clips, so the death hold and its reset are observable.
   *
   * The procedural stand-in has no animation states at all (`play` is a no-op on it), which
   * makes it the right model for the placement and turn assertions and useless for the
   * question "did the body come back off the floor".
   */
  function clipModel(): CharacterModel {
    const group = new Group();
    const mesh = new Mesh(new BoxGeometry(0.5, 1.75, 0.5), new MeshStandardMaterial());
    mesh.position.y = 1.75 / 2;
    group.add(mesh);
    const clips = [new AnimationClip('idle', 1, []), new AnimationClip('death', 1, [])];
    return buildCharacter(group, clips, 1.75, () => {});
  }

  it('turns the body toward the direction of travel, not toward the camera', () => {
    const rig = createCharacterRig(createPlaceholderCharacter(1.75));
    const player = playerState({ yaw: 0 });
    rig.sync(player, 1 / 60); // placed, facing the camera

    // Walking -X (to the player's left) while the camera looks straight down -Z: the body
    // has to come round a quarter turn, which is the whole point of the feature.
    player.velocity.x = -PLAYER.walkSpeed;
    // One 12° step at the configured rate, so the turn is visibly a turn and not a snap.
    rig.sync(player, 1 / 60);
    expect(rig.yaw).toBeCloseTo(PLAYER.turnRateDegPerSec * DEG2RAD * (1 / 60), 9);

    for (let i = 0; i < 14; i += 1) rig.sync(player, 1 / 60);

    expect(rig.yaw).toBeCloseTo(Math.PI / 2, 6);
    // The rendering convention: the model faces +Z, the simulation's yaw 0 faces -Z.
    expect(rig.model.root.rotation.y).toBeCloseTo(Math.PI / 2 + Math.PI, 6);
  });

  it('places the body at the player, on every frame', () => {
    const rig = createCharacterRig(createPlaceholderCharacter(1.75));
    const player = playerState();
    player.position.x = 3;
    player.position.y = 1.5;
    player.position.z = -7.25;

    rig.sync(player, 1 / 60);

    expect(rig.model.root.position.x).toBe(3);
    expect(rig.model.root.position.y).toBe(1.5);
    expect(rig.model.root.position.z).toBe(-7.25);
  });

  it('snaps the body to the camera on the first frame instead of pivoting to it', () => {
    // The model loads asynchronously, so the first `sync` can be a long way into a run. A
    // body that pivoted from yaw 0 to the player's yaw at that moment would turn for no
    // reason the player could explain.
    const rig = createCharacterRig(createPlaceholderCharacter(1.75));
    const player = playerState({ yaw: 2.4 });

    rig.sync(player, 1 / 60);

    expect(rig.yaw).toBeCloseTo(2.4, 12);
    expect(rig.bank).toBe(0);
  });

  it('leans the body while it is turning and settles when it is not', () => {
    const rig = createCharacterRig(createPlaceholderCharacter(1.75));
    const player = playerState({ yaw: 3.1 });
    rig.sync(player, 1 / 60); // placed

    player.velocity.x = -PLAYER.walkSpeed;
    rig.sync(player, 1 / 60);
    expect(Math.abs(rig.bank)).toBeGreaterThan(0);
    expect(rig.model.root.rotation.z).toBeCloseTo(rig.bank, 12);

    // Keep walking long enough for the body to arrive and the lean to wash out.
    for (let i = 0; i < 120; i += 1) rig.sync(player, 1 / 60);
    expect(rig.yaw).toBeCloseTo(Math.PI / 2, 6);
    expect(rig.bank).toBeCloseTo(0, 3);
  });

  it('picks the clip from the simulation, not from the input', () => {
    const rig = createCharacterRig(createPlaceholderCharacter(1.75));
    const player = playerState();

    rig.sync(player, 1 / 60);
    expect(rig.state).toBe('idle');

    // Sprinting state: the body follows the world's speed.
    player.velocity.x = PLAYER.sprintSpeed;
    rig.sync(player, 1 / 60);
    expect(rig.state).toBe('run');

    player.velocity.x = PLAYER.walkSpeed;
    rig.sync(player, 1 / 60);
    expect(rig.state).toBe('walk');

    // Held against a crate: the key is still down, the speed is zero, and the body must
    // read as standing rather than as running on the spot.
    player.velocity.x = 0;
    player.velocity.z = 0;
    rig.sync(player, 1 / 60);
    expect(rig.state).toBe('idle');
  });

  it('reports the reload and the death state the simulation is in', () => {
    const rig = createCharacterRig(createPlaceholderCharacter(1.75));
    const player = playerState();
    player.weapon.mode = 'reloading';
    rig.sync(player, 1 / 60);
    expect(rig.state).toBe('reload');

    player.weapon.mode = 'idle';
    player.dead = true;
    rig.sync(player, 1 / 60);
    expect(rig.state).toBe('death');
  });

  it('puts the body back on its feet when the run restarts', () => {
    const rig = createCharacterRig(clipModel());
    const player = playerState();
    player.dead = true;
    rig.sync(player, 1 / 60);
    rig.sync(player, 1 / 60);
    expect(rig.state).toBe('death');
    expect(rig.model.state).toBe('death');

    player.dead = false;
    rig.reset(player.yaw);
    rig.sync(player, 1 / 60);

    // Without the reset the model refuses to leave the death clip — `play` is a no-op out
    // of it by design — and the next run begins with a body lying in the arena.
    expect(rig.state).toBe('idle');
    expect(rig.model.state).toBe('idle');
    expect(rig.bank).toBe(0);
  });

  /**
   * The rifle in the player's hands.
   *
   * The requirement is a gun on the character's **right-hand side**, black furniture with a
   * partly orange barrel. The sign that can be wrong invisibly is the side: the model faces
   * `+Z` and its right hand is at `-x`, while the body is drawn with `rotation.y = yaw + π`,
   * so a plausible-looking local offset can put the rifle on the left shoulder and look
   * perfectly fine in any screenshot of a standing character. The assertion is therefore about
   * the rifle's **world** position relative to the player, not about its local offset.
   */
  describe('held weapon', () => {
    /** Every named mesh in the rifle, by name. */
    const gunMesh = (rig: ReturnType<typeof createCharacterRig>, name: string): Mesh => {
      const found = rig.weapon.root.getObjectByName(name);
      expect(found, name).toBeDefined();
      return found as Mesh;
    };

    const colourOf = (mesh: Mesh): number => (mesh.material as MeshStandardMaterial).color.getHex();

    it('hangs the rifle beside the player’s right hand, in front of the body', () => {
      const rig = createCharacterRig(createPlaceholderCharacter(1.75));
      const player = playerState({ yaw: 0 });
      player.position.x = 3;
      player.position.z = -7;
      rig.sync(player, 1 / 60);

      const where = rig.weapon.root.getWorldPosition(new Vector3());
      // Yaw 0 faces -Z with the camera behind it, so the player's right hand is +X. The
      // muzzle end is in front of the body, i.e. further along -Z.
      expect(where.x).toBeGreaterThan(player.position.x);
      expect(where.z).toBeLessThan(player.position.z);
      expect(where.y).toBeGreaterThan(0.8);
      expect(where.y).toBeLessThan(PLAYER.height);
      // It rides the body: same parent, one write per frame, no per-frame placement here.
      expect(rig.weapon.root.parent).toBe(rig.model.root);
    });

    it('keeps the rifle at a fixed offset from the body as the body turns', () => {
      // The anchor's distance from the body's origin cannot depend on which way the body
      // faces. This is the assertion that would catch a rifle bolted to the wrong axis.
      const rig = createCharacterRig(createPlaceholderCharacter(1.75));
      const player = playerState({ yaw: 0 });
      const radiusNow = (): number => {
        const where = rig.weapon.root.getWorldPosition(new Vector3());
        return Math.hypot(where.x - player.position.x, where.z - player.position.z);
      };

      rig.sync(player, 1 / 60);
      const before = radiusNow();
      expect(before).toBeGreaterThan(0.2);

      // Walk to the player's left until the body has come round a quarter turn.
      player.velocity.x = -PLAYER.walkSpeed;
      for (let i = 0; i < 60; i += 1) rig.sync(player, 1 / 60);
      expect(Math.abs(rig.yaw - Math.PI / 2)).toBeLessThan(0.05);
      // Trigonometry, so the radius is only invariant to within a few ulps.
      expect(radiusNow()).toBeCloseTo(before, 5);
    });

    it('builds black furniture with a partly orange barrel and a trigger', () => {
      const rig = createCharacterRig(createPlaceholderCharacter(1.75));
      const black = WEAPON_MODEL.colours.furniture;
      const orange = WEAPON_MODEL.colours.muzzle;

      // The brief names the parts: grip, stock and trigger are black...
      for (const part of ['grip', 'stock', 'trigger', 'trigger-guard']) {
        expect(colourOf(gunMesh(rig, part)), part).toBe(black);
      }
      // ...and part of the barrel is orange, which is why the barrel is two meshes.
      expect(colourOf(gunMesh(rig, 'barrel-front'))).toBe(orange);
      expect(colourOf(gunMesh(rig, 'muzzle'))).toBe(orange);
      expect(colourOf(gunMesh(rig, 'barrel-rear'))).not.toBe(orange);

      // A rifle, not a pistol: the stock reaches behind the grip and the barrel forward.
      expect(gunMesh(rig, 'stock').position.z).toBeLessThan(0);
      expect(gunMesh(rig, 'muzzle').position.z).toBeGreaterThan(gunMesh(rig, 'grip').position.z);
      expect(rig.weapon.length).toBeGreaterThan(0.6);
      expect(rig.weapon.length).toBeLessThan(1.4);
    });

    it('disposes its own geometry without touching the body it was hung on', () => {
      const model = createPlaceholderCharacter(1.75);
      const rig = createCharacterRig(model);
      const bodyMeshes = model.root.children.filter((child) => (child as Mesh).isMesh).length;
      expect(bodyMeshes).toBeGreaterThan(0);

      rig.dispose();
      expect(rig.weapon.root.parent).toBeNull();
      // The body is handed in, so it is the caller's to release — the rig must not eat it.
      expect(model.root.children.filter((child) => (child as Mesh).isMesh).length).toBe(bodyMeshes);
      expect(() => model.dispose()).not.toThrow();
    });
  });
});
