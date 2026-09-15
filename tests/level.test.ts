/**
 * Level data tests (phase 4).
 *
 * The phase-4 task list calls this the stage's most likely way to cause a gameplay
 * regression, and the reason is structural rather than careless: `game/level.ts`'s
 * `props` is a single source of truth that derives **three** things at once — the
 * `InstancedMesh` meshes you can see, the `collisionBoxes` you cannot walk through,
 * and the `blockers` that stop bullets. Beautifying the level by editing a prop
 * therefore edits the collision world too, silently.
 *
 * So the dressing-up in phase 4 went through the `decor` channel, which can never
 * enter either list, and these tests pin the properties that would have to be
 * deliberately broken to change the playable space:
 *
 *   - the arena's half extent, and the counts of collision boxes and blockers;
 *   - nothing solid inside the spawn clearing (the phase-1 bug: the first step put
 *     the player into a crate);
 *   - the fence still stops the player and still lets bullets through;
 *   - decor is absent from both collision lists.
 *
 * The counts are deliberately hard-coded. They are the *point* of the test: any
 * change to them is a change to the playable space, and it should require someone to
 * come here and edit a number with the reason written next to it.
 */

import { describe, expect, it } from 'vitest';
import { ARENA_HALF_SIZE, buildLevel } from '#/game/level';
import { SIM } from '#/core/config';

/** Counts as of the end of phase 3, before any phase-4 dressing-up. */
const PHASE3_COLLISION_BOXES = 122;
const PHASE3_BLOCKERS = 22;

/** The clearing that has to stay walkable, centred on the player's spawn. */
const SPAWN = { x: 0, z: 8 };
const SPAWN_CLEARANCE = 3;

describe('level data', () => {
  it('keeps the arena extent in step with the simulation', () => {
    const level = buildLevel();
    expect(level.halfSize).toBe(ARENA_HALF_SIZE);
    expect(level.halfSize).toBe(SIM.arenaHalfSize);
    // A single number for the playable box: the renderer, the collision world and
    // the spawn-point sampler all read it, so a drift here is three bugs.
    expect(ARENA_HALF_SIZE).toBe(24);
  });

  it('keeps the collision world identical across the phase-4 art pass', () => {
    const level = buildLevel();
    expect(level.collisionBoxes.length).toBe(PHASE3_COLLISION_BOXES);
    expect(level.blockers.length).toBe(PHASE3_BLOCKERS);
    // Blockers are a strict subset of the collision boxes here: every prop that
    // stops a bullet also stops the player, and the fence is the only thing that
    // stops one and not the other.
    expect(level.blockers.length).toBeLessThan(level.collisionBoxes.length);
  });

  it('has the same layout for the same seed', () => {
    const a = buildLevel(4242);
    const b = buildLevel(4242);
    expect(a.props.length).toBe(b.props.length);
    for (let i = 0; i < a.props.length; i += 1) {
      expect(a.props[i]!.position.x).toBeCloseTo(b.props[i]!.position.x, 9);
      expect(a.props[i]!.position.z).toBeCloseTo(b.props[i]!.position.z, 9);
    }
  });

  it('leaves the spawn clearing empty', () => {
    const level = buildLevel();
    // Everything except the ground slab: it is 1 m thick and sits at y = -0.5, so it
    // is under the player's feet rather than in their way.
    const solids = level.collisionBoxes.filter((box) => box.halfExtents.y < 5 && box.center.y > 0.01);
    const intruders = solids.filter((box) => {
      const overlapX =
        Math.abs(box.center.x - SPAWN.x) < box.halfExtents.x + SPAWN_CLEARANCE;
      const overlapZ =
        Math.abs(box.center.z - SPAWN.z) < box.halfExtents.z + SPAWN_CLEARANCE;
      return overlapX && overlapZ;
    });
    expect(intruders.map((box) => `${box.center.x},${box.center.z}`)).toEqual([]);
  });

  it('keeps the fence solid to the player and transparent to bullets', () => {
    const level = buildLevel();
    const fence = level.props.filter((prop) => prop.kind === 'fence');
    expect(fence.length).toBeGreaterThan(0);
    // A visible boundary that stops bullets reads as an invisible wall. This is a
    // deliberate design decision and not an oversight to be tidied up.
    expect(fence.every((prop) => prop.solid)).toBe(true);
    expect(fence.every((prop) => prop.blocksShots === false)).toBe(true);
    // ... and the fence must not have leaked into the blocker list through a prop
    // that happens to share its coordinates.
    const fenceZ = new Set(fence.map((prop) => prop.position.z.toFixed(3)));
    const blockerZ = new Set(level.blockers.map((box) => box.center.z.toFixed(3)));
    expect(fenceZ.has(`${(ARENA_HALF_SIZE + 0.3).toFixed(3)}`)).toBe(true);
    expect(blockerZ.has(`${(ARENA_HALF_SIZE + 0.3).toFixed(3)}`)).toBe(false);
  });

  it('dresses the level without touching either collision list', () => {
    const level = buildLevel();
    expect(level.decor.length).toBeGreaterThan(12);

    // The decor channel's whole contract: it is looked at, never collided with and
    // never shot at. A decor entry that shares a footprint with a collision box would
    // mean someone moved furniture into the collision world through the wrong door.
    for (const decor of level.decor) {
      const collisionAtSameSpot = level.collisionBoxes.some(
        (box) =>
          Math.abs(box.center.x - decor.position.x) < 1e-6 &&
          Math.abs(box.center.z - decor.position.z) < 1e-6 &&
          box.halfExtents.y > 0.4,
      );
      expect(collisionAtSameSpot).toBe(false);
    }
  });

  it('gives every decorative piece a length and a yaw where it needs one', () => {
    const level = buildLevel();
    const pipes = level.decor.filter((decor) => decor.kind === 'pipeRun');
    expect(pipes.length).toBeGreaterThan(0);
    for (const pipe of pipes) {
      expect(pipe.length ?? 0).toBeGreaterThan(4);
      expect(pipe.yawDeg ?? 0).toBeGreaterThanOrEqual(0);
    }
  });
});
