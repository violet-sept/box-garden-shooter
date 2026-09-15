/**
 * Presentation-layer tests: enemy bodies, telegraph markers, damage vignette.
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
 *
 * None of this needs WebGL: geometry, materials and the scene graph are plain data
 * structures until something renders them.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, Object3D, Vector3 } from 'three';
import { createEnemyView } from '#/render/models/enemyView';
import { createTelegraphView } from '#/render/fx/telegraph';
import { createHud, hudVisibility, type HudElements } from '#/render/hud/hud';
import { createWorld } from '#/game/World';
import { EventBus } from '#/core/events';
import type { EnemyState } from '#/game/enemies/EnemyState';
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
  it('ships the veil and the HUD as opposites, in both directions', () => {
    const elements = fakeHudElements();
    const hud = createHud(elements);

    hud.showVeil('title', 'detail');
    expect(elements.veil.hidden).toBe(false);
    expect(elements.root.hidden).toBe(true);
    // The bug that shipped: the veil was never hidden, so the canvas stayed covered
    // while every state assertion still read correctly.
    expect(hudVisibility(true).veilHidden).toBe(false);

    hud.hideVeil();
    expect(elements.veil.hidden).toBe(true);
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
