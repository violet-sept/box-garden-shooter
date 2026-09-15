/**
 * Level data tests.
 *
 * The phase-4 task list called this the stage's most likely way to cause a gameplay
 * regression, and the reason is structural rather than careless: `game/level.ts`'s
 * `props` is a single source of truth that derives **three** things at once — the
 * `InstancedMesh` meshes you can see, the `collisionBoxes` you cannot walk through,
 * and the `blockers` that stop bullets. Beautifying the level by editing a prop
 * therefore edits the collision world too, silently.
 *
 * What is pinned here is the playable space:
 *
 *   - the arena's half extent, and the counts of collision boxes and blockers;
 *   - nothing solid inside the spawn clearing (the phase-1 bug: the first step put
 *     the player into a crate);
 *   - the fence still stops the player and still lets bullets through;
 *   - **every decorative piece is physical** (phase 6), is present in *both* world lists,
 *     and none of them can trap the enemy AI behind itself;
 *   - the one box the controller must never see is the floor slab.
 *
 * The counts are deliberately hard-coded. They are the *point* of the test: any
 * change to them is a change to the playable space, and it should require someone to
 * come here and edit a number with the reason written next to it.
 */

import { describe, expect, it } from 'vitest';
import { ARENA_HALF_SIZE, buildLevel, decorCollisionBoxes } from '#/game/level';
import { ENEMY_SMALL, SIM } from '#/core/config';
import { SPAWN_LIMIT } from '#/game/director/spawnPoints';
import type { Aabb } from '#/core/math/vec3';

/**
 * Counts as of the end of phase 3, plus the 26 boxes the decorative pieces contribute
 * once they became solid in phase 6.
 *
 * The breakdown of the +26 is written down on purpose: 8 lamps + 3 masts + 4 stacks of
 * three crates + 3 pipe runs. If a future change moves one of those numbers, this is the
 * place that says so, and the difference will be visible rather than a surprise in play.
 */
const COLLISION_BOXES = 122 + 26;
const BLOCKERS = 22 + 26;

/** The clearing that has to stay walkable, centred on the player's spawn. */
const SPAWN = { x: 0, z: 8 };
const SPAWN_CLEARANCE = 3;

/** Structural-AABB equality: two boxes are the same box if all six numbers match. */
function sameBox(a: Aabb, b: Aabb): boolean {
  return (
    a.center.x === b.center.x &&
    a.center.y === b.center.y &&
    a.center.z === b.center.z &&
    a.halfExtents.x === b.halfExtents.x &&
    a.halfExtents.y === b.halfExtents.y &&
    a.halfExtents.z === b.halfExtents.z
  );
}

describe('level data', () => {
  it('keeps the arena extent in step with the simulation', () => {
    const level = buildLevel();
    expect(level.halfSize).toBe(ARENA_HALF_SIZE);
    expect(level.halfSize).toBe(SIM.arenaHalfSize);
    // A single number for the playable box: the renderer, the collision world and
    // the spawn-point sampler all read it, so a drift here is three bugs.
    expect(ARENA_HALF_SIZE).toBe(24);
  });

  it('keeps the collision world at the size the playable space was authored for', () => {
    const level = buildLevel();
    expect(level.collisionBoxes.length).toBe(COLLISION_BOXES);
    expect(level.blockers.length).toBe(BLOCKERS);
    // Blockers are a strict subset of the collision boxes here: every prop that
    // stops a bullet also stops the player, and the fence is the only thing that
    // stops one and not the other.
    expect(level.blockers.length).toBeLessThan(level.collisionBoxes.length);
  });

  it('buries nothing but the floor slab below the feet', () => {
    // `createCollisionWorld` drops exactly the boxes whose top is at or below `y = 0`,
    // because a box coplanar with the player's feet ejects them upward every tick. The
    // rule is only safe while the slab is the *only* thing it matches: anything else
    // buried in the floor would silently vanish from the collision world instead of
    // stopping the player.
    const level = buildLevel();
    const buried = level.collisionBoxes.filter((box) => box.center.y + box.halfExtents.y <= 0);
    expect(buried).toHaveLength(1);
    expect(buried[0]!.halfExtents.x).toBe(ARENA_HALF_SIZE + 1);
  });

  it('has the same layout for the same seed', () => {
    const a = buildLevel(4242);
    const b = buildLevel(4242);
    expect(a.props.length).toBe(b.props.length);
    for (let i = 0; i < a.props.length; i += 1) {
      expect(a.props[i]!.position.x).toBeCloseTo(b.props[i]!.position.x, 9);
      expect(a.props[i]!.position.z).toBeCloseTo(b.props[i]!.position.z, 9);
    }
    // The decorative pieces and their bodies are seeded the same way — a pipe run that
    // moved between two launches would be a collision box that moved too.
    expect(a.decor).toEqual(b.decor);
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

  it('gives every decorative piece a physical body in both worlds', () => {
    const level = buildLevel();
    expect(level.decor.length).toBeGreaterThan(12);

    // The phase-6 contract, and the exact inverse of the phase-4 one it replaces: the
    // pieces you can see are the pieces you bump into and the pieces that stop a round.
    // "Only decor" is not an excuse the player can see.
    for (const piece of level.decor) {
      const boxes = decorCollisionBoxes(piece);
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(box.halfExtents.x).toBeGreaterThan(0);
        expect(box.halfExtents.y).toBeGreaterThan(0);
        expect(box.halfExtents.z).toBeGreaterThan(0);
        // Present in the list the controller walks in...
        expect(level.collisionBoxes.some((candidate) => sameBox(candidate, box))).toBe(true);
        // ... and in the list a shot stops on.
        expect(level.blockers.some((candidate) => sameBox(candidate, box))).toBe(true);
      }
    }
  });

  it('keeps the long pipe runs clear of the band an enemy may spawn in', () => {
    // The AI has no pathfinding: it seeks the player and is then pushed out of geometry
    // along the shallowest axis. A collider that overlaps the spawn square can therefore
    // split the arena with a corridor that an enemy is pushed *into* and can only slide
    // along — for the whole 34 m of a pipe run. These three pieces are the only decor long
    // enough to do it, so they hug the fence instead; this is the assertion that keeps
    // them there, and it fails if a run is moved back out into the field.
    const level = buildLevel();
    const pipes = level.decor.filter((piece) => piece.kind === 'pipeRun');
    expect(pipes.length).toBeGreaterThan(0);

    for (const box of pipes.flatMap(decorCollisionBoxes)) {
      // Distance from the box's far face to the edge of the spawn square, with the spawn
      // square inflated by an enemy's own radius.
      const clearanceX = Math.abs(box.center.x) - box.halfExtents.x - ENEMY_SMALL.radius - SPAWN_LIMIT;
      const clearanceZ = Math.abs(box.center.z) - box.halfExtents.z - ENEMY_SMALL.radius - SPAWN_LIMIT;
      // Clear on at least one axis is enough: the box is then wholly outside the square.
      expect(Math.max(clearanceX, clearanceZ)).toBeGreaterThan(0);
    }
  });

  it('gives every decorative piece a length and a yaw where it needs one', () => {
    const level = buildLevel();
    const pipes = level.decor.filter((decor) => decor.kind === 'pipeRun');
    expect(pipes.length).toBeGreaterThan(0);
    for (const pipe of pipes) {
      expect(pipe.length ?? 0).toBeGreaterThan(4);
      expect(pipe.yawDeg ?? 0).toBeGreaterThanOrEqual(0);
      // A run with no length would collide as a single point-sized box, and the mesh
      // would be the same nothing: both readers fall back to `DECOR_SPECS`.
      expect(decorCollisionBoxes(pipe)[0]!.halfExtents.x > 1 || decorCollisionBoxes(pipe)[0]!.halfExtents.z > 1).toBe(
        true,
      );
    }
  });
});
