/**
 * Central tuning table.
 *
 * Everything a designer would want to tweak lives here and nowhere else.
 * All values are metrics: meters, seconds, damage points, degrees.
 * The simulation runs at a fixed tick (see {@link SIM}), so "per second"
 * values are converted to "per tick" exactly once, in the systems that use them.
 */

/** Fixed-timestep simulation parameters. */
export const SIM = {
  /** Simulation ticks per second. Decoupled from render rate. */
  tickHz: 60,
  /** Largest real-time slice a single frame may consume, in seconds. */
  maxFrameDelta: 0.25,
  /** Maximum simulation steps per rendered frame, to avoid a death spiral. */
  maxStepsPerFrame: 5,
  /** Arena half-extent in meters: the playable box-garden footprint. */
  arenaHalfSize: 24,
} as const;

/** Player tuning. */
export const PLAYER = {
  maxHealth: 150,
  /** Collision capsule. */
  radius: 0.35,
  height: 1.75,
  eyeHeight: 1.6,

  walkSpeed: 4.2,
  sprintSpeed: 6.4,
  /** Seconds to reach full speed; higher is heavier. */
  accelerationTime: 0.18,
  /** Seconds to stop; lower is snappier. */
  decelerationTime: 0.12,
  /**
   * How fast the **body** pivots to face where it is going, in degrees per second.
   *
   * The camera yaw is the player's authority and is never rate-limited; this is the
   * visible model catching up to it. 720°/s turns the character around in a quarter of a
   * second, which reads as a deliberate pivot rather than a snap — and, because the shot
   * direction comes from the player's own yaw rather than from the body, the animation
   * never costs a fraction of a second of aim.
   */
  turnRateDegPerSec: 720,
  /**
   * Ground speed below which the body faces the camera instead of the motion, in m/s.
   *
   * A player standing still and looking around should turn on the spot; a player walking
   * should face where they are walking, even while looking somewhere else. This is the
   * one threshold that decides which of the two the body is doing.
   */
  idleSpeedThreshold: 0.15,
  /** Radians of bank per radian still left to turn: the lean into the pivot. */
  bodyTurnBankGain: 0.09,
  /** Cap on that lean, in degrees. A character rolled further than this reads as broken. */
  bodyTurnBankMaxDeg: 9,
  /** Exponential rate the lean settles at, e-folds per second. */
  bodyTurnBankRate: 12,

  /** Aim-down-sights transition, seconds. */
  adsTime: 0.18,
  /** Field-of-view in degrees for hip fire and ADS. */
  fovHip: 78,
  fovAds: 45,
  /** Movement speed multiplier while aiming. */
  adsMoveScale: 0.55,
  /** Look sensitivity, radians per pixel of mouse movement. */
  lookSensitivity: 0.0022,
  /** Sensitivity multiplier while aiming. */
  adsSensitivityScale: 0.6,
  /** Vertical look clamp in degrees. */
  pitchClampDeg: 85,

  /** Gravity in m/s². Only used while airborne; the ground jump is an impulse. */
  gravity: 22,
  /** Upward impulse of a jump, m/s. Used for the ground jump and for the air jump. */
  jumpVelocity: 7.2,
  /**
   * Jumps allowed between two ground contacts, i.e. "double jump" = 2.
   *
   * The air jump needs a **fresh press**: holding Space down gives exactly one ground
   * jump and no air jump, so a player cannot spend the second jump by accident. Leaving
   * the ground by walking off a ledge costs the takeoff jump (the counter starts at 1
   * once gravity takes over), so "two jumps" means two jumps, not "one plus however
   * many times you fell".
   */
  maxJumps: 2,
  /** Maximum step height the controller walks up without a jump, in metres. */
  stepHeight: 0.45,
  /** Surfaces within this distance below the feet count as ground. */
  groundSnapDistance: 0.25,

  /** Seconds of invulnerability after taking a hit, prevents swarm stunlock. */
  hitInvulnerability: 0.35,
  /** Seconds before health begins regenerating after last damage. */
  regenDelay: 6,
  /** Health per second once regeneration starts. */
  regenRate: 12,
} as const;

/** The player's starting weapon. Additional weapons are further entries of this shape. */
export const WEAPON = {
  /** Display name, used by the HUD. */
  name: 'AR-15 Service Rifle',

  magazineSize: 30,
  reserveAmmo: 210,
  /** Rounds per minute. */
  rpm: 640,
  /** True for automatic fire (hold to keep shooting). */
  automatic: true,

  reloadTime: 2.1,
  /** Reload is cancellable during this opening window, seconds. */
  reloadCancelWindow: 0.35,
  /** Reload this fast when the magazine is empty and the bolt is already open. */
  reloadTimeEmpty: 1.7,

  /** Base damage per bullet before hitbox multipliers. */
  damage: 22,
  /** Damage falloff: full damage to `falloffStart`, linear decay to `falloffEnd`. */
  falloffStart: 22,
  falloffEnd: 60,
  falloffMinScale: 0.55,
  /** Maximum hitscan range in meters. */
  range: 120,
  /** Number of rays per shot. >1 means buckshot. */
  pelletsPerShot: 1,
  /** Whether a trigger pull can score more than one hit on the same target. */
  canMultiHitPerShot: false,

  /** Spread cone half-angle in degrees, hip fire and ADS. */
  spreadHipDeg: 3.4,
  spreadAdsDeg: 0.35,
  /** Spread added per shot, decays over time. */
  spreadPerShotDeg: 0.5,
  spreadMaxDeg: 7,
  spreadRecoveryPerSec: 9,
  /**
   * Recovery multiplier while aiming.
   *
   * The base rate needs ~0.33 s to walk a fully bloomed cone back to the ADS
   * value, which is longer than the ADS transition itself — so without this the
   * crosshair is still visibly open after the sight picture has settled, and the
   * player is punished for a state they can see they are in. 2.6× brings the
   * settle inside the 0.18 s transition.
   */
  spreadRecoveryAdsScale: 2.6,

  /** Camera recoil: vertical kick per shot, plus a horizontal random component. */
  recoilPitchDeg: 0.55,
  recoilYawDeg: 0.22,
  /** Fraction of accumulated recoil the camera recovers automatically. */
  recoilRecovery: 0.72,
  recoilRecoveryPerSec: 9,

  /** Reload consumes one magazine from this pool; picking up ammo adds to it. */
  maxReserveAmmo: 300,
} as const;

/**
 * The rifle the player is holding, as procedural geometry.
 *
 * Decision D14's sibling: the project owns no binary art (there is no `public/`), so the
 * weapon is built from primitives in `render/models/playerWeapon.ts` — the same rule the
 * level, the enemies and the placeholder body follow. The brief for it is a colour
 * description (black grip, black stock, black trigger, a partly orange barrel), which is
 * why every dimension *and* every colour lives here rather than in the builder.
 *
 * `anchor` is where the grip sits in the **body's own frame** (the model faces `+Z`, so
 * `-x` is the body's right hand and `+z` is in front of it). It is a held-rifle pose
 * tuned against the procedural stand-in that ships; the delivered `player.glb` is
 * specified as a 1.75 m humanoid with its feet at the origin facing `+Z`, which is the
 * same frame, so the same numbers apply. See the technical plan's phase-7 memo.
 */
export const WEAPON_MODEL = {
  /**
   * Body-frame position of the grip: the right hand, chest height, in front of the torso.
   *
   * `-x` for the right hand because the model faces `+Z` (right = forward × up = `-x`), and
   * `-0.5` because the procedural stand-in that ships is a 0.98 m-wide capsule — the hand is
   * on its surface. If the delivered `.glb` arrives with narrower shoulders, this is the one
   * number to move; nothing else in the builder knows where the hand is.
   */
  anchor: { x: -0.5, y: 1.15, z: 0.32 },
  /** Barrel pitch in degrees; positive tilts the muzzle up. */
  pitchDeg: 0,

  /** Receiver: the box the whole thing is built around, ahead of the grip. */
  receiver: { width: 0.075, height: 0.13, length: 0.3, z: 0.15, y: 0.06 },
  /** Pistol grip. `rakeDeg` tilts its top forward, the way a real grip leans. */
  grip: { width: 0.065, height: 0.2, length: 0.1, z: 0.0, y: -0.1, rakeDeg: 12 },
  /** Trigger blade, and the guard bar below it. Both black; the pair is what makes it read. */
  trigger: { width: 0.018, height: 0.075, length: 0.022, z: 0.08, y: -0.04 },
  guard: { width: 0.05, height: 0.016, length: 0.13, z: 0.075, y: -0.1 },
  /** Butt stock, behind the receiver. Black. */
  stock: { width: 0.06, height: 0.125, length: 0.24, z: -0.16, y: 0.03 },
  /** Magazine, below the receiver. */
  magazine: { width: 0.05, height: 0.17, length: 0.08, z: 0.16, y: -0.1 },
  /** Handguard over the barrel's rear half. */
  handguard: { width: 0.062, height: 0.075, length: 0.22, z: 0.32, y: 0.085 },
  /**
   * Barrel, in two segments along `z`: a dark one against the handguard and an **orange**
   * one in front of it. "Part of the barrel is orange" is the brief, so the split is a
   * configured pair of lengths rather than a colour on the whole piece.
   */
  barrel: {
    radius: 0.026,
    y: 0.1,
    rear: { length: 0.12, z: 0.4 },
    front: { length: 0.14, z: 0.53 },
  },
  /** Muzzle brake: orange, wider than the barrel, the front-most piece. */
  muzzle: { radius: 0.034, length: 0.1, z: 0.65, y: 0.1 },

  /**
   * Palette. Black furniture, dark-steel receiver and barrel, orange barrel front + muzzle.
   *
   * The orange carries a little emissive so it still reads as orange under the ACES tone
   * mapping and the level's blue-grey light, which turns a plain diffuse red-orange brown.
   */
  colours: {
    furniture: 0x111317,
    receiver: 0x30363f,
    barrel: 0x3c434c,
    muzzle: 0xff7a1a,
    muzzleEmissive: 0xff5a00,
    muzzleEmissiveIntensity: 0.35,
  },
} as const;

/**
 * Over-the-shoulder camera rig.
 *
 * `pivotOffset` sits at the player's shoulder rather than their eyes, and
 * `extension` pulls the camera back along the aim direction. The lateral offset
 * is what makes the character read as being *beside* the crosshair instead of
 * under it — the defining trait of a shoulder camera, and the reason the
 * crosshair still marks where bullets go.
 */
export const CAMERA = {
  /** Lateral (right) and vertical offset of the rig pivot from the player origin. */
  pivotRight: 0.42,
  pivotUp: 1.42,
  /**
   * Hip-fire distance behind the pivot. Also the ADS distance: in a shoulder
   * camera, aiming is a lateral offset change plus an FOV change, not a dolly.
   * Keeping the distance fixed means the character never occludes the target.
   */
  hipDistance: 3.2,
  adsDistance: 3.2,
  /** The lateral offset collapses toward this while aiming. */
  adsPivotRight: 0.34,
  /** Exponential convergence rate for camera position, e-folds per second. */
  followRate: 18,
  /** Radius used to push the camera out of level geometry. */
  collisionRadius: 0.3,
  /** Shortest the boom may become before the near plane starts clipping the body. */
  minDistance: 0.35,

  /**
   * Where the tracer leaves from, expressed in the camera's basis.
   *
   * Sideways and down so it reads as coming from the weapon rather than from
   * between the eyes — but *on the aim axis*, which is what keeps the crosshair
   * and the impact point in agreement.
   */
  muzzleSide: 0.26,
  muzzleDrop: 0.16,
} as const;

/** Statistics shared by every enemy archetype. */
export interface EnemyStats {
  readonly id: string;
  readonly displayName: string;

  readonly maxHealth: number;
  /** Meters per second. */
  readonly moveSpeed: number;
  /** Meters per second while executing an attack. Usually 0 for ranged. */
  readonly attackMoveSpeed: number;
  /** Acceleration and braking, meters per second squared. */
  readonly acceleration: number;

  /** Collision capsule. */
  readonly radius: number;
  readonly height: number;
  /** Mass in kilograms; used for knockback and enemy-enemy separation. */
  readonly mass: number;

  /** Distance from the player at which the enemy commits to an attack. */
  readonly attackRange: number;
  /** Distance at which the enemy notices the player. */
  readonly detectionRange: number;
  /** Distance beyond which an alerted enemy gives up and returns to idle. */
  readonly loseTargetRange: number;

  /** Seconds between the end of one attack and the start of the next. */
  readonly attackCooldown: number;

  /** Seconds of "telegraph" before damage lands. Readability budget. */
  readonly telegraphTime: number;
  /** Seconds the damaging window stays open. */
  readonly activeTime: number;
  /** Seconds of immobile recovery after the active window. */
  readonly recoveryTime: number;
  /** Damage dealt per successful attack. */
  readonly damage: number;

  /** Damage multiplier applied to incoming weak-point hits. */
  readonly headshotMultiplier: number;

  /** Score awarded on death. */
  readonly scoreValue: number;
  /** Enemy "bounty" dropped for the item-throw system, if any. */
  readonly dropChance: number;
}

/**
 * Small enemy: fast, fragile, melee/contact damage, attacks in packs.
 * Designed to die in 3 body shots or 1 weak-point shot (22 × 2.8 = 61.6 > 60),
 * which is what gives the player a reason to slow down and aim while swarmed.
 */
export const ENEMY_SMALL: EnemyStats = {
  id: 'small',
  displayName: 'Stalker',

  maxHealth: 60,
  moveSpeed: 5.2,
  attackMoveSpeed: 9.0,
  acceleration: 28,

  radius: 0.32,
  height: 1.1,
  mass: 55,

  attackRange: 1.5,
  detectionRange: 42,
  loseTargetRange: 60,

  attackCooldown: 1.1,
  telegraphTime: 0.42,
  activeTime: 0.12,
  recoveryTime: 0.55,
  damage: 9,

  headshotMultiplier: 2.8,

  scoreValue: 100,
  dropChance: 0.08,
};

/**
 * Large enemy: slow, armoured, ranged/area attacks. Appears only after the
 * small wave is cleared or the wave timer expires.
 * Designed to survive 3.7 magazines of body fire (110 rounds) or 2.3 magazines
 * of weak-point fire (69 rounds), so the kill always needs a reload the player
 * chose; and to kill an unwary player in 5 barrage hits (150 / 34).
 */
export const ENEMY_LARGE: EnemyStats = {
  id: 'large',
  displayName: 'Warden',

  maxHealth: 2400,
  moveSpeed: 1.9,
  attackMoveSpeed: 0.8,
  acceleration: 8,

  radius: 1.1,
  height: 3.4,
  mass: 900,

  attackRange: 26,
  detectionRange: 60,
  loseTargetRange: 90,

  attackCooldown: 2.8,
  telegraphTime: 1.35,
  activeTime: 0.25,
  recoveryTime: 1.5,
  damage: 34,

  headshotMultiplier: 1.6,

  scoreValue: 1500,
  dropChance: 1.0,
};

/** Every enemy archetype, keyed by id. */
export const ENEMY_ARCHETYPES = {
  small: ENEMY_SMALL,
  large: ENEMY_LARGE,
} as const;

export type EnemyArchetypeId = keyof typeof ENEMY_ARCHETYPES;

/**
 * Behaviour constants shared by both enemy archetypes.
 *
 * The per-archetype numbers live on {@link EnemyStats}; these are the rules that
 * have to mean the same thing on every enemy, which is why they are not fields on
 * the stats table (a per-archetype copy of "how much health counts as enraged"
 * is how two enemies silently disagree about the rule).
 */
export const ENEMY = {
  /**
   * Fraction of `height` occupied by the head sphere's diameter.
   *
   * Hitboxes are derived analytically from the stats rather than read out of the
   * model, so a new mesh can never shift where the shots land (phase 2 trap:
   * "treating the head hitbox as something you read from the model"). For the
   * 1.1 m Stalker this puts the head's top exactly at `height`.
   */
  headFraction: 0.4,
  /** Below this fraction of `height`, the head is not modelled at all. */
  minHeadFraction: 0.12,

  /** Knockback speed in m/s per point of damage, before the mass correction. */
  knockbackPerDamage: 0.02,
  /** Reference mass: knockback is divided by the victim's mass over this value. */
  knockbackReferenceMass: 60,
  /** Ceiling on knockback speed, m/s. A 2400-damage blast must not launch a body. */
  knockbackMax: 12,
  /** Extra speed above `moveSpeed` granted by a knockback impulse. */
  knockbackBoost: 2.5,
  /** Seconds a victim must wait after a knockback before it can be pushed again. */
  knockbackCooldown: 0.25,

  /**
   * Hitstun applied when a hit exceeds `stunDamageThreshold` of the victim's max
   * health. Small enemies feel it; the Warden's 2400 HP means a rifle round never
   * reaches it, which is exactly the intended contrast.
   */
  stunDuration: 0.22,
  stunDamageFraction: 0.28,

  /** How far apart the separation force keeps two enemies, as a radius multiple. */
  separationRadiusScale: 1.6,
  /** Separation push strength, as a multiple of `moveSpeed`. */
  separationStrength: 1.25,
  /** Minimum time between re-pathing decisions for a chasing enemy, seconds. */
  repathInterval: 0.25,

  /** Seconds an enemy stands still while it turns to face the player. */
  turnDelay: 0.12,

  /** Blasts a barrage calls down, and the delay added per blast, in seconds. */
  barrageBlasts: 3,
  barrageStagger: 0.32,
  /** Lifetime of a landed blast's damage zone, seconds. */
  barrageZoneLife: 0.18,
  /** Blast radius in metres, as a fraction of the Warden's height. */
  barrageRadius: 3.4,
} as const;

/**
 * The red health bar every enemy carries above its head.
 *
 * Sizes are **per archetype and derived from the body**, which is the whole point of the
 * feature: a Stalker's bar is 0.8 m wide because a Stalker is 1.1 m tall, and the Warden's
 * is 3.0 m because the Warden is 3.4 m tall across the shoulders. One width for both would
 * either float over the small enemy like a banner or vanish on the large one.
 *
 * The values are metres in world space, so the bar shrinks with distance exactly like the
 * body it belongs to (sprites, not a screen-space overlay: a DOM bar would need a
 * projection and a DOM write per enemy per frame, and would still not be occluded by the
 * crates the enemy is standing behind).
 */
export const HEALTH_BAR = {
  /** Bar width in metres, per archetype. */
  width: { small: 0.8, large: 3.0 },
  /** Bar thickness in metres. */
  height: { small: 0.1, large: 0.26 },
  /** Gap between the top of the body and the bar, in metres. */
  topGap: { small: 0.3, large: 0.55 },
  /** Red fill and the dark trough it sits in. */
  fillColour: 0xff3b30,
  trackColour: 0x1b1012,
  /**
   * Draw order between the two quads of one bar.
   *
   * They are coplanar, so the trough would z-fight with its own fill if depth writes were
   * on. Both materials therefore test depth (a crate still hides the bar) but write none,
   * and these two orders decide which of the pair paints last.
   */
  trackOrder: 1,
  fillOrder: 2,
} as const;

/**
 * Practice-dummy stats.
 *
 * The dummies are enemies with no AI: they keep the phase-1 tuning baseline
 * reachable from the debug panel and from the whole-world tests, and they prove
 * that the enemy repository is a substitution rather than a rewrite.
 */
export const ENEMY_DUMMY: EnemyStats = {
  ...ENEMY_SMALL,
  id: 'dummy',
  displayName: 'Practice Dummy',
  maxHealth: 200,
  moveSpeed: 0,
  attackMoveSpeed: 0,
  acceleration: 0,
  damage: 0,
  attackRange: 0,
  detectionRange: 0,
  loseTargetRange: 0,
  scoreValue: 0,
  dropChance: 0,
};

/**
 * Body radius of the player's damage capsule, in metres.
 *
 * Separate from `PLAYER.radius` because they answer different questions: the
 * movement radius keeps the player out of crates, while this one decides how
 * generously a Stalker's swipe connects. Conflating them makes "that clearly
 * touched me" a collision bug rather than a tuning value.
 */
export const PLAYER_HURTBOX_RADIUS = 0.42;


/**
 * Wave director tuning.
 *
 * A wave is: `smallCount` small enemies spawn over `spawnInterval`; the large
 * enemy is released when the small enemies are all dead OR `bossTimer` seconds
 * have elapsed since the wave started, whichever happens first.
 *
 * ## The shape of a run (decision D13, technical plan section 6.3)
 *
 * `totalWaves` waves, then the run ends. Every `breathingWaveEvery`-th wave is a
 * *breathing wave*: fewer small enemies, a longer pause before the next one and
 * the only place charges are topped up. That gives the run a pulse instead of a
 * monotonic ramp, and it is what keeps items scarce — handing one out per wave
 * (the original guess) meant a full belt by wave 3 and no decisions left to make
 * with them.
 *
 * Paper estimate for the 8-wave shape: ~8 minutes if every wave is cleared early
 * and ~13.5 if every wave runs to its boss timer, which is the 10-15 minute target.
 * That estimate is *not* acceptance evidence — see section 4.5 of `docs/阶段3.md`.
 */
export const DIRECTOR = {
  /**
   * Seconds of quiet before the first wave.
   *
   * Short on purpose. The brief's curve asks for a half-minute of "how big is this
   * place, how does the gun feel", but an empty arena with a clock is not what
   * teaches that — moving does. Six seconds is one lap of the spawn area, and the
   * intermission and breathing-wave gaps are where the exploring actually happens.
   */
  openingGracePeriod: 6,
  /** Seconds of quiet between waves. */
  interWaveDelay: 8,
  /** Extra seconds added to the intermission after a breathing wave, for recovery. */
  breathingWaveExtraDelay: 6,

  /** Waves in one run. Reaching the end of them kills the run (win or lose). */
  totalWaves: 8,
  /** Every Nth wave is a breathing wave. Must be >= 2 to mean anything. */
  breathingWaveEvery: 3,
  /** Fraction of `smallCount` a breathing wave keeps. */
  breathingWaveCountScale: 0.45,

  /** Enemies a wave may have alive at once, caps spawn pressure. */
  maxConcurrentSmall: 14,
  /** Absolute cap on live enemies including the large one. */
  maxConcurrentTotal: 18,

  /** Seconds between individual small-enemy spawns. */
  spawnInterval: 0.7,
  /** Spawn interval shrinks by this factor each wave, floored. */
  spawnIntervalDecay: 0.96,
  spawnIntervalMin: 0.22,

  /** Small enemy count per wave: base + growth * wave, capped. */
  smallCountBase: 6,
  smallCountGrowth: 2.4,
  smallCountMax: 40,
  /**
   * Per-wave randomisation of `smallCount`, as a fraction.
   *
   * The curve is deterministic and the *exact* count per wave is not, so two seeds
   * give two runs that feel the same shape without being the same wave. Zero would
   * make the run a fixed script; the tests pin the curve with this set to 0.
   */
  smallCountJitter: 0.12,
  /** Small enemy HP scales by this factor each wave. */
  smallHealthScalePerWave: 1.12,

  /** Seconds before the large enemy is force-spawned if smalls remain. */
  bossTimerBase: 75,
  bossTimerDecay: 0.97,
  bossTimerMin: 40,
  /** If the large enemy is alive, small enemies keep trickling at this interval. */
  addsWhileBossAlive: true,
  /** Seconds between reinforcement trickles while the large enemy is alive. */
  addsIntervalWhileBossAlive: 5.5,
  /** Reinforcements released per trickle. */
  addsPerTrickle: 2,

  /** Minimum distance a spawn point must keep from the player. */
  minSpawnDistanceFromPlayer: 12,
  /** Maximum distance from the player, so enemies are not irrelevant. */
  maxSpawnDistanceFromPlayer: 40,
  /** Minimum distance between two spawn points chosen in the same burst. */
  minSpawnSeparation: 3.5,

  /**
   * Spawn candidates drawn per attempt.
   *
   * Each one is sampled *inside* the arena by construction (the radius is clamped
   * to the distance the arena actually allows in that direction), so this is a
   * quality knob, not a rejection budget.
   */
  spawnCandidateCount: 24,
  /** Directions swept by the dense fallback when no random candidate passes. */
  spawnFallbackDirections: 32,
  /** Innermost fraction of the allowed range a fallback point is placed at. */
  spawnFallbackDistanceScale: 0.98,

  /**
   * Half-angle of the cone in front of the player that spawn points must avoid,
   * in degrees. The brief says "never in the 60-degree cone directly ahead", which
   * is the full angle, so the half-angle is 30.
   */
  spawnViewConeHalfAngleDeg: 30,

  /**
   * Keep-out band along the arena fence, in metres.
   *
   * Must clear the widest body the director can place, or the Warden's 1.1 m radius
   * ends up half inside the fence. `ENEMY_LARGE.radius * 2` is the value this was
   * derived from.
   */
  spawnFenceMargin: 2.4,

  /**
   * Seconds between "an enemy is about to appear here" and the enemy appearing.
   *
   * Deliberately **not** `ENEMY_LARGE.telegraphTime`: a telegraph is a reaction
   * window that the player has to be able to act inside, while this is an
   * announcement that has to be readable. Tying them together would mean that
   * retuning the Warden's wind-up silently retuned how much warning a spawn gets.
   */
  spawnWarningDuration: 0.9,
  /**
   * Radius of the ground ring drawn under an incoming spawn, in metres.
   *
   * Smaller than the Warden's barrage marker on purpose: this one says "an enemy is
   * arriving", not "this patch of ground is about to hurt", and the two must not be
   * confused at a glance in the middle of a barrage.
   */
  spawnWarningRadius: 1.5,
  /** Radius of the ring drawn under an incoming *large* enemy. */
  spawnWarningRadiusBoss: 3.2,
};

/**
 * A mutable view of {@link DIRECTOR}.
 *
 * The table is declared `as const` so its values are narrow literal types where they
 * are read, but the curve, spawn and director tests need to pin individual knobs —
 * the count jitter, the distance band, the wave count — to assert the rules they
 * encode. Exporting a mutable alias is cheaper, and much less surprising, than
 * casting at every call site, and it keeps the numbers in one place. Nothing in
 * `src/` writes through it.
 */
export const DIRECTOR_TUNING: {
  smallCountJitter: number;
  minSpawnDistanceFromPlayer: number;
  maxSpawnDistanceFromPlayer: number;
  minSpawnSeparation: number;
  totalWaves: number;
  openingGracePeriod: number;
  interWaveDelay: number;
  bossTimerBase: number;
} = DIRECTOR;


/**
 * How many small enemies may be mid-attack at once.
 *
 * Without this cap, a pack of eight reaches the player and all eight strikes
 * land inside the same half-second, which reads as "I died instantly" rather
 * than "I mistimed my dodge". Enemies that fail to claim a slot keep orbiting
 * at the edge of attack range instead. The pressure stays; the confusion does not.
 */
export const ATTACK_SLOTS = 3;

/** Fraction of max health at which the large enemy enters its enraged phase. */
export const ENRAGE_HEALTH_FRACTION = 0.35;

/**
 * Enrage multiplies cooldowns and recovery times, but deliberately NOT the
 * telegraph window: the telegraph is the player's only cue to react, so
 * shortening it would trade difficulty for unfairness.
 */
export const ENRAGE_COOLDOWN_SCALE = 0.75;

/**
 * The Warden's behaviour when it is not attacking.
 *
 * A distance band rather than a chase: the large enemy is a "battlefield
 * remodeller", not a pursuer. Holding 18-26 m means it is always in the fight
 * without ever being the thing the player has to run from, which is what keeps
 * the small-enemy swarm the primary pressure.
 */
export const WARDEN = {
  /** Closest it is willing to be to the player. */
  bandMin: 18,
  /** Furthest it is willing to be before it starts closing again. */
  bandMax: 26,
  /** Distance inside `bandMin` at which it commits to backing away. */
  retreatThreshold: 16,
  /** Lateral drift magnitude while holding the band, m/s. */
  strafeSpeed: 0.9,
  /** Radians per second the strafe direction wanders. */
  strafeWanderRate: 0.35,
  /** Seconds of lead applied when predicting the player's position. */
  leadTime: 0.45,
  /**
   * Blasts whose impact point is cached at telegraph time. The player is
   * expected to *move*, so the telegraph has to show where the shots are going,
   * not where the player is.
   */
  telegraphLocksImpactPoints: true,
} as const;


/**
 * Hitstop, in seconds, by impact weight.
 *
 * Implemented as a simulation time scale rather than skipped ticks, so the
 * fixed-timestep accumulator stays intact and visual effects keep animating.
 * Distinct values per weight are the whole point: giving every hit the same
 * freeze makes light and heavy impacts feel identical.
 */
export const HITSTOP = {
  light: 2 / 60,
  medium: 4 / 60,
  heavy: 9 / 60,
  /** Added on top of the weight tier when the hit was a weak-point hit. */
  criticalBonus: 2 / 60,
  /** Hitstop only freezes the victim, never the player, so firing stays responsive. */
  affectsPlayer: false,
} as const;

/** Throwable item tuning, driven by the E key. */
export const ITEMS = {
  /** Seconds between throws. */
  throwCooldown: 1.2,
  /** Number of charges the player starts a run with. */
  startingCharges: 3,
  /** Charges granted per wave cleared. */
  chargesPerWaveCleared: 1,
  /** Maximum held charges. */
  maxCharges: 5,

  /** Seconds from release to detonation. */
  fuse: 1.4,
  /** Splash radius in meters. */
  blastRadius: 5.5,
  /** Damage at the epicentre, linearly decaying to zero at `blastRadius`. */
  blastDamage: 130,
  /** Upward impulse applied to enemies inside the blast. */
  blastImpulse: 9,

  /** Initial throw speed, meters per second. */
  throwSpeed: 16,
  /** Fraction of ground speed retained per bounce. */
  bounciness: 0.35,
  /** Collision radius of the thrown object. */
  radius: 0.14,

  /** Seconds before an unexploded item despawns. */
  maxLifetime: 3.5,
} as const;

/**
 * Charges granted when a wave is cleared (decision D13).
 *
 * Kept next to {@link ITEMS} rather than inside {@link DIRECTOR} so the reward has
 * one home: the item table owns how many the player holds, and this owns when the
 * belt is topped up.
 */
export const DIRECTOR_REWARDS = {
  /**
   * Charges granted for clearing an ordinary wave.
   *
   * Zero, by decision D13. The original guess was one per wave, which with
   * `maxCharges = 5` means a full belt by wave 3 and no decision left to make
   * about when to spend them. Topping up only on breathing waves keeps the throw
   * a resource.
   */
  chargesPerWaveCleared: 0,
  /** Charges granted for clearing a breathing wave. */
  chargesPerBreathingWave: ITEMS.chargesPerWaveCleared,
} as const;

/** Renderer and camera tuning that designers may want to touch. */
export const RENDER = {
  /** Hard cap on device pixel ratio; 2 is plenty and saves fill rate. */
  maxPixelRatio: 2,

  // --- Atmosphere -----------------------------------------------------------
  //
  // Phase 4 fix: `fogNear` / `fogFar` used to live here and were **dead fields**.
  // The scene uses `FogExp2`, which takes a *density* in 1/m, so the two distance
  // fields were never read for appearance at all (only `fogFar` leaked into the
  // camera's far plane). A knob that looks adjustable and changes nothing is
  // worse than no knob, so the density is now explicit and the frame is derived
  // from the scene rather than hard-coded in `sceneRig.ts`.
  /** Fog colour. Matches the sky so the arena edge dissolves instead of ending. */
  fogColor: 0x1d2531,
  /**
   * Exponential fog density, expressed as a multiple of `1 / arenaSpan`.
   *
   * Relative rather than absolute so growing the arena keeps the same read: at
   * 1.25 the fence is visibly softening at the far edge without the middle of
   * the play space turning hazy. Higher is denser.
   */
  fogDensityPerArenaSpan: 1.25,
  /** Sky behind everything. Kept near the fog colour, a shade darker. */
  backgroundColor: 0x141a24,
  /** Ambient bounce: sky tint, ground tint, intensity. */
  hemiSkyColor: 0x9fc4ff,
  hemiGroundColor: 0x2b2620,
  hemiIntensity: 0.85,
  /** Key light: the single shadow caster. */
  keyColor: 0xfff0d6,
  keyIntensity: 2.1,
  /** Rim light: no shadows, separates silhouettes from the fog. */
  rimColor: 0x6f8cff,
  rimIntensity: 0.55,
  /** ACES exposure. Above 1 lifts the mid-tones; the arena reads flat below it. */
  toneMappingExposure: 1.05,

  // --- Shadow ---------------------------------------------------------------
  /** Shadow map size for the single directional light. */
  shadowMapSize: 2048,
  /**
   * Half-extent of the shadow camera's orthographic frustum, in metres.
   *
   * It travels with the player, so this is "how far around me do things cast
   * shadows" and it is the main cost/quality knob of the shadow pass: the map is
   * fixed at `shadowMapSize`, so halving this doubles the effective resolution.
   * 32 covers the whole 48 m arena from the middle and the interesting half of it
   * from the corners.
   */
  shadowExtent: 32,

  // --- Camera ---------------------------------------------------------------
  /**
   * Far clip plane, in metres.
   *
   * The camera must clear the arena and let the fog do the fading, or the far
   * wall is clipped into a hard edge. `sceneRig.syncCameraProjection` keeps it at
   * least `arenaSpan * 3` so this is a floor, not the whole rule.
   */
  cameraFar: 170,

  /** Maximum number of pooled decals alive at once. */
  maxDecals: 96,
  /** Maximum number of pooled tracers alive at once. */
  maxTracers: 64,
  /**
   * Size multiplier for the pooled death burst, relative to a bullet impact.
   *
   * The collapse animation alone is a poor kill signal at range, where the body is
   * a handful of pixels; a slightly larger burst in the same footprint fixes that
   * without a new pool. The large enemy gets its own, much bigger, value because its
   * body is three times the size and its death is a run beat rather than a tick.
   */
  deathBurstScale: 1.6,
  bossDeathBurstRadius: 4.2,
} as const;

/**
 * A mutable view of the render knobs that are tuned from measurements.
 *
 * Same reasoning as {@link DIRECTOR_TUNING}: the table is `as const` so call sites
 * get narrow literal types, but the phase-4 scene tests need to pin individual
 * knobs (fog density, shadow extent) to assert that the *derived* values really
 * come from the table. Nothing in `src/` writes through it.
 */
export const RENDER_TUNING: {
  fogDensityPerArenaSpan: number;
  shadowExtent: number;
  shadowMapSize: number;
  cameraFar: number;
} = RENDER;

/**
 * Performance-scene knobs (phase 4, technical plan section 5.10.2).
 *
 * "120 entities at 60 FPS" could not be measured at all before this existed: the
 * director's concurrency cap is 18 and the debug formation was deleted in phase 3,
 * so nothing in the game could put more than a couple of dozen bodies on the field.
 * The entity count lives here rather than inside `tools/desktop-acceptance.mjs`
 * because a number written into the acceptance script and a different number in the
 * documentation is two sources of truth for the same claim.
 */
export const PERF = {
  /**
   * Body count the performance scene holds alive.
   *
   * This is the figure the brief's acceptance criterion names ("no visible frame
   * drop within 120 entities"), which is why it is not derived from anything.
   */
  entityCount: 120,
  /** Radius of the ring the bodies are placed on, around the player. */
  ringRadius: 16,
  /**
   * Seconds the scene's aim takes to sweep a full circle.
   *
   * Firing down one fixed axis would leave the hit query, the damage path and the
   * impact effects nearly idle — half of what a "worst case" measurement is
   * supposed to contain. The sweep rate below is derived from this and the player's
   * look sensitivity, so the two can never disagree.
   */
  sweepSeconds: 8,
  /** Fixed seed, so two runs of the scene are the same run. */
  seed: 0x5eed1e,
  /**
   * URL query value that turns the scene on (`?scene=perf`).
   *
   * An explicit opt-in rather than a debug flag: the scene deliberately drives the
   * world from outside the input layer, and it must not be reachable by accident
   * during a normal run.
   */
  sceneName: 'perf',
} as const;

/**
 * Aim sweep rate for the performance scene, in mouse pixels per simulation tick.
 *
 * Derived rather than tuned: a full circle over `PERF.sweepSeconds`, converted to
 * pixels by the same sensitivity the real input layer uses. Writing a pixel number
 * here instead would silently change the sweep when the sensitivity is retuned.
 */
export const PERF_SWEEP_PIXELS_PER_TICK =
  (Math.PI * 2) / (PERF.sweepSeconds * SIM.tickHz) / PLAYER.lookSensitivity;

// --- Audio ------------------------------------------------------------------

/**
 * Audio buses. Every sound is routed to exactly one, and each has a gain in
 * {@link AUDIO.busGain}, so "the gun is too loud" is one number.
 */
export type AudioBus = 'weapon' | 'impact' | 'enemy' | 'world' | 'ui' | 'uiStinger';

/** Throttle windows: the classes of sound that may repeat faster than they should. */
export type AudioThrottleKey = 'shot' | 'impact' | 'enemyVoice' | 'death';

/**
 * Audio tuning (phase 4, decision D14).
 *
 * **Every sound in the game is synthesised at runtime** — oscillators, one shared
 * noise buffer and gain envelopes, all through the Web Audio API. There are no
 * audio files, which is not a taste decision: `public/` does not exist in this
 * repository, so `new Audio('/assets/audio/shot.ogg')` would be a load that is
 * guaranteed to fail, and the phase-3 acceptance fix (D12) exists precisely to
 * stop that class of false positive. Synthesised audio also keeps the package
 * offline-clean for phase 5.
 */
export const AUDIO = {
  /** Master gain, and the state a fresh install starts in. */
  masterVolume: 0.7,
  muted: false,
  /**
   * Per-bus gain, multiplied by the master and by the request's own gain.
   *
   * The weapon bus is the loudest because it is the sound the player hears most
   * often and the one that carries the fire-rate feedback; `impact` is deliberately
   * below it so a burst of hits never masks the next shot.
   */
  busGain: { weapon: 0.9, impact: 0.65, enemy: 0.85, world: 0.75, ui: 0.5, uiStinger: 0.6 },
  /**
   * Ceiling on simultaneously sounding voices.
   *
   * At 640 RPM the gun alone asks for 10.7 voices per second; with a pack of
   * enemies, a barrage and an explosion on top, the peak is far above this. Past
   * the cap the lowest-priority request is dropped, which is what keeps an
   * explosion audible instead of being buried by gunfire.
   */
  maxConcurrentSources: 24,
  /**
   * Minimum interval between two sounds in the same class, in milliseconds.
   *
   * The shot window is half a firing interval (60000/640 = 94 ms): long enough
   * that a held trigger reads as grains rather than a single buzz, short enough
   * that the rate still tracks the weapon.
   */
  throttleMs: { shot: 45, impact: 25, enemyVoice: 120, death: 40 },
  /** Gain applied to the non-ducked buses while a big blast is playing. */
  duckingAmount: 0.45,
  /** Seconds-ish recovery constant for ducking, in milliseconds. */
  duckingDecayMs: 350,
  /**
   * Priority at or above which a sound ducks the others.
   *
   * Data rather than a list of sound names, so "the explosion is the loudest thing
   * in the game" is expressed once: the barrage impact (85), the Warden's death
   * (95) and the thrown item (100) all clear this bar, and nothing else does.
   */
  duckingPriority: 85,
  /**
   * Synchronisation budget for the `[HITLOG]` sfx channel, in frames.
   *
   * The technical plan's tolerance table says SFX is allowed one frame of slack.
   * The implementation aims at zero: the event callback runs inside the tick that
   * produced it, so the request is handed to the audio clock immediately.
   */
  sfxLatencyBudgetFrames: 1,
  /** Length of the single shared white-noise buffer, in seconds. */
  noiseBufferSeconds: 2,
  /**
   * Headroom applied to a voice's peak gain before the master stage.
   *
   * Several voices summing at once clip hard without it, and clipping reads as a
   * broken speaker rather than as a loud explosion.
   */
  voiceHeadroom: 0.55,
} as const;

/**
 * A synthesis recipe: pure parameters, no Web Audio objects.
 *
 * Defining the shape here (rather than in `platform/audio/synth.ts`) is what lets
 * {@link SOUND_SPECS} live in the one tuning table while the code that turns a
 * recipe into a waveform stays a pure function that Node can test.
 */
export interface SoundSpec {
  /** Playback bus. */
  readonly bus: AudioBus;
  /** Gain relative to the bus, `[0, 1]`. */
  readonly gain: number;
  /** Higher survives the concurrency cap; explosions are the top of the range. */
  readonly priority: number;
  /** Per-voice pitch randomisation, `[0, 1]`, so a burst is not a machine gun of clones. */
  readonly jitter: number;
  /** Throttle class, or `null` when the sound may repeat freely. */
  readonly throttle: AudioThrottleKey | null;
  /** Base frequency in Hz. Noise-led sounds still sweep around it. */
  readonly frequency: number;
  /** End frequency as a multiple of `frequency`; 1 means no sweep. */
  readonly frequencySweep: number;
  /** Envelope attack, seconds. */
  readonly attack: number;
  /** Envelope decay to silence, seconds. */
  readonly decay: number;
  /** Noise share of the source, `[0, 1]`; 1 is pure noise. */
  readonly noiseMix: number;
  /** Low-pass cutoff in Hz. This is what separates a thud from a crack. */
  readonly lowpass: number;
  /** Seed for the noise buffer fill, so one recipe always sounds the same. */
  readonly noiseSeed: number;
}

/** Every sound the game can make. */
export type SoundId =
  | 'shot'
  | 'shotTail'
  | 'impactSurface'
  | 'hitBody'
  | 'hitHead'
  | 'playerHurt'
  | 'enemyTelegraphMelee'
  | 'enemyTelegraphBarrage'
  | 'barrageLock'
  | 'barrageImpact'
  | 'enemyDied'
  | 'bossDied'
  | 'spawnPending'
  | 'spawnPendingBoss'
  | 'magazineEmpty'
  | 'reloadStarted'
  | 'reloadFinished'
  | 'itemThrown'
  | 'itemExploded'
  | 'waveStarted'
  | 'waveCleared'
  | 'bossSpawned'
  | 'runVictory'
  | 'runDefeat';

/**
 * The recipes.
 *
 * Read the numbers as "what does the player need to be able to tell apart". The
 * two that matter most are the *telegraph* family and the *notification* one:
 * `enemyTelegraphMelee` is a rising mid buzz (a reaction window, "something is
 * about to hit you"), `enemyTelegraphBarrage` is a two-tone low alarm ("this patch
 * of ground is about to hurt"), and `spawnPending` is a short bright blip ("note
 * the direction something is arriving from"). The brief's readability budget is
 * spent on exactly those three being distinguishable with your eyes shut, and the
 * barrage one is deliberately the lowest and longest because the reaction window
 * it announces is the longest.
 */
export const SOUND_SPECS: Readonly<Record<SoundId, SoundSpec>> = {
  // --- Weapon ---------------------------------------------------------------
  shot: {
    bus: 'weapon',
    gain: 0.85,
    priority: 40,
    jitter: 0.12,
    throttle: 'shot',
    frequency: 220,
    frequencySweep: 0.45,
    attack: 0.001,
    decay: 0.09,
    noiseMix: 0.75,
    lowpass: 5200,
    noiseSeed: 0x51f7a1,
  },
  /** A short tail under the shot, so a burst reads as a burst and not a click. */
  shotTail: {
    bus: 'weapon',
    gain: 0.3,
    priority: 20,
    jitter: 0.08,
    throttle: 'shot',
    frequency: 90,
    frequencySweep: 0.7,
    attack: 0.004,
    decay: 0.16,
    noiseMix: 0.4,
    lowpass: 900,
    noiseSeed: 0x51f7b2,
  },

  // --- Impacts --------------------------------------------------------------
  impactSurface: {
    bus: 'impact',
    gain: 0.35,
    priority: 15,
    jitter: 0.3,
    throttle: 'impact',
    frequency: 900,
    frequencySweep: 0.5,
    attack: 0.001,
    decay: 0.05,
    noiseMix: 0.9,
    lowpass: 7000,
    noiseSeed: 0x1a2b3c,
  },
  /** Body hit: a dead, low thud. */
  hitBody: {
    bus: 'impact',
    gain: 0.55,
    priority: 30,
    jitter: 0.18,
    throttle: 'impact',
    frequency: 180,
    frequencySweep: 0.7,
    attack: 0.001,
    decay: 0.08,
    noiseMix: 0.5,
    lowpass: 1600,
    noiseSeed: 0x2b3c4d,
  },
  /**
   * Weak-point hit: the same thud plus a bright ping an octave and a half up.
   *
   * The headshot's reward is otherwise purely visual, and the whole reason the
   * multiplier is 2.8 is that the game wants the player to aim. A pitch rise is
   * the cheapest possible "that was the right shot" signal.
   */
  hitHead: {
    bus: 'impact',
    gain: 0.6,
    priority: 45,
    jitter: 0.1,
    throttle: 'impact',
    frequency: 1180,
    frequencySweep: 1.6,
    attack: 0.001,
    decay: 0.11,
    noiseMix: 0.12,
    lowpass: 9000,
    noiseSeed: 0x3c4d5e,
  },
  playerHurt: {
    bus: 'world',
    gain: 0.5,
    priority: 55,
    jitter: 0.15,
    throttle: null,
    frequency: 130,
    frequencySweep: 0.6,
    attack: 0.002,
    decay: 0.22,
    noiseMix: 0.55,
    lowpass: 1200,
    noiseSeed: 0x4d5e6f,
  },

  // --- Enemy cues -----------------------------------------------------------
  /** Melee wind-up: rising buzz. The player's cue to back off. */
  enemyTelegraphMelee: {
    bus: 'enemy',
    gain: 0.6,
    priority: 60,
    jitter: 0.06,
    throttle: 'enemyVoice',
    frequency: 320,
    frequencySweep: 2.1,
    attack: 0.03,
    decay: 0.3,
    noiseMix: 0.35,
    lowpass: 2600,
    noiseSeed: 0x5e6f70,
  },
  /** Barrage wind-up: a low two-tone alarm. Must not sound like the melee cue. */
  enemyTelegraphBarrage: {
    bus: 'enemy',
    gain: 0.7,
    priority: 70,
    jitter: 0.02,
    throttle: 'enemyVoice',
    frequency: 118,
    frequencySweep: 1.35,
    attack: 0.06,
    decay: 0.62,
    noiseMix: 0.08,
    lowpass: 1400,
    noiseSeed: 0x6f7081,
  },
  barrageImpact: {
    bus: 'world',
    gain: 0.8,
    priority: 85,
    jitter: 0.15,
    throttle: null,
    frequency: 74,
    frequencySweep: 0.45,
    attack: 0.002,
    decay: 0.45,
    noiseMix: 0.85,
    lowpass: 1100,
    noiseSeed: 0x708192,
  },
  /**
   * The instant the barrage's impact points are locked and the ground markers go
   * down: a short high tick.
   *
   * Three separate sounds describe one Warden attack, on purpose, because they are
   * three different pieces of information: the charge alarm says "he is committing",
   * this says "the markers are down, move now", and `barrageImpact` says "that patch
   * just went off". Collapsing any two of them would make the player unable to tell
   * "brace" from "run".
   */
  barrageLock: {
    bus: 'enemy',
    gain: 0.55,
    priority: 75,
    jitter: 0.03,
    throttle: null,
    frequency: 1500,
    frequencySweep: 1.5,
    attack: 0.001,
    decay: 0.09,
    noiseMix: 0.15,
    lowpass: 9000,
    noiseSeed: 0x708193,
  },
  enemyDied: {
    bus: 'enemy',
    gain: 0.5,
    priority: 50,
    jitter: 0.2,
    throttle: 'death',
    frequency: 260,
    frequencySweep: 0.35,
    attack: 0.002,
    decay: 0.24,
    noiseMix: 0.7,
    lowpass: 2200,
    noiseSeed: 0x8192a3,
  },
  /** The Warden's death: the same idea an octave down and three times as long. */
  bossDied: {
    bus: 'enemy',
    gain: 0.9,
    priority: 95,
    jitter: 0.05,
    throttle: null,
    frequency: 62,
    frequencySweep: 0.32,
    attack: 0.01,
    decay: 1.1,
    noiseMix: 0.8,
    lowpass: 900,
    noiseSeed: 0x92a3b4,
  },
  /** "Something is arriving over there": short, bright, informational. */
  spawnPending: {
    bus: 'enemy',
    gain: 0.45,
    priority: 35,
    jitter: 0.05,
    throttle: 'enemyVoice',
    frequency: 880,
    frequencySweep: 1.25,
    attack: 0.005,
    decay: 0.14,
    noiseMix: 0.05,
    lowpass: 6000,
    noiseSeed: 0xa3b4c5,
  },
  spawnPendingBoss: {
    bus: 'enemy',
    gain: 0.75,
    priority: 90,
    jitter: 0.02,
    throttle: null,
    frequency: 150,
    frequencySweep: 1.9,
    attack: 0.05,
    decay: 0.8,
    noiseMix: 0.25,
    lowpass: 1800,
    noiseSeed: 0xb4c5d6,
  },

  // --- Weapon state ---------------------------------------------------------
  magazineEmpty: {
    bus: 'weapon',
    gain: 0.5,
    priority: 65,
    jitter: 0.04,
    throttle: null,
    frequency: 2200,
    frequencySweep: 0.6,
    attack: 0.001,
    decay: 0.035,
    noiseMix: 0.95,
    lowpass: 8000,
    noiseSeed: 0xc5d6e7,
  },
  reloadStarted: {
    bus: 'weapon',
    gain: 0.4,
    priority: 45,
    jitter: 0.06,
    throttle: null,
    frequency: 420,
    frequencySweep: 0.8,
    attack: 0.001,
    decay: 0.09,
    noiseMix: 0.85,
    lowpass: 4200,
    noiseSeed: 0xd6e7f8,
  },
  reloadFinished: {
    bus: 'weapon',
    gain: 0.45,
    priority: 45,
    jitter: 0.06,
    throttle: null,
    frequency: 240,
    frequencySweep: 1.1,
    attack: 0.001,
    decay: 0.12,
    noiseMix: 0.7,
    lowpass: 3600,
    noiseSeed: 0xe7f809,
  },

  // --- Items ----------------------------------------------------------------
  itemThrown: {
    bus: 'world',
    gain: 0.35,
    priority: 30,
    jitter: 0.15,
    throttle: null,
    frequency: 500,
    frequencySweep: 0.4,
    attack: 0.01,
    decay: 0.24,
    noiseMix: 0.9,
    lowpass: 3000,
    noiseSeed: 0xf8091a,
  },
  /** The loudest thing in the game, and the only one that ducks the others. */
  itemExploded: {
    bus: 'world',
    gain: 1,
    priority: 100,
    jitter: 0.1,
    throttle: null,
    frequency: 58,
    frequencySweep: 0.38,
    attack: 0.001,
    decay: 0.72,
    noiseMix: 0.9,
    lowpass: 900,
    noiseSeed: 0x091a2b,
  },

  // --- Run beats ------------------------------------------------------------
  waveStarted: {
    bus: 'uiStinger',
    gain: 0.5,
    priority: 60,
    jitter: 0,
    throttle: null,
    frequency: 330,
    frequencySweep: 1.5,
    attack: 0.02,
    decay: 0.3,
    noiseMix: 0.05,
    lowpass: 5000,
    noiseSeed: 0x1a2b3c,
  },
  waveCleared: {
    bus: 'uiStinger',
    gain: 0.5,
    priority: 60,
    jitter: 0,
    throttle: null,
    frequency: 440,
    frequencySweep: 1.1892,
    attack: 0.02,
    decay: 0.34,
    noiseMix: 0.05,
    lowpass: 5200,
    noiseSeed: 0x2b3c4d,
  },
  bossSpawned: {
    bus: 'uiStinger',
    gain: 0.85,
    priority: 95,
    jitter: 0,
    throttle: null,
    frequency: 110,
    frequencySweep: 1.7,
    attack: 0.04,
    decay: 1.05,
    noiseMix: 0.3,
    lowpass: 2200,
    noiseSeed: 0x3c4d5e,
  },
  runVictory: {
    bus: 'uiStinger',
    gain: 0.7,
    priority: 100,
    jitter: 0,
    throttle: null,
    frequency: 392,
    frequencySweep: 1.5,
    attack: 0.03,
    decay: 1.4,
    noiseMix: 0.05,
    lowpass: 6000,
    noiseSeed: 0x4d5e6f,
  },
  runDefeat: {
    bus: 'uiStinger',
    gain: 0.7,
    priority: 100,
    jitter: 0,
    throttle: null,
    frequency: 300,
    frequencySweep: 0.4,
    attack: 0.05,
    decay: 1.6,
    noiseMix: 0.2,
    lowpass: 1600,
    noiseSeed: 0x5e6f70,
  },
};
