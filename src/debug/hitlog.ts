/**
 * Hit-feedback instrumentation (`[HITLOG]`).
 *
 * The technical plan (§3.4) makes this a deliverable rather than a nice-to-have,
 * for a specific reason: judging "does the hit feedback land on the right frame"
 * by feel produces arguments that cannot be settled, and every re-tune risks
 * silently breaking feedback that used to be correct. With a timestamped log, the
 * same question becomes a reading against a published tolerance table:
 *
 *     VFX ±0 frames · SFX ±1 · camera shake ±1 · damage number ±2
 *
 * So this module keeps the *data*: one record per shot, tracking when each link
 * in the chain fired. Rendering it is the debug overlay's problem.
 *
 * Pure data, no DOM. `tests/` can drive it directly.
 */

import type { GameEvents, GameEventName } from '../core/events';
import { SIM } from '../core/config';

/** The links of the feedback chain, in the order they are expected to appear. */
export type FeedbackChannel = 'hitbox' | 'vfx' | 'sfx' | 'damage' | 'shake' | 'number' | 'decal';

/** Per-channel tolerance in frames, from the technical plan's synchronisation table. */
export const CHANNEL_TOLERANCE_FRAMES: Record<FeedbackChannel, number> = {
  // The authoritative hit itself: this IS the reference frame.
  hitbox: 0,
  vfx: 0,
  sfx: 1,
  damage: 0,
  shake: 1,
  number: 2,
  decal: 1,
};

/** One timestamped link in a shot's feedback chain. */
export interface FeedbackMark {
  readonly channel: FeedbackChannel;
  /** Simulation time of the event, in seconds. */
  readonly time: number;
  /** Frames behind the shot's reference frame. Negative means it arrived early. */
  readonly deltaFrames: number;
  /** True when `|deltaFrames|` exceeds the channel's tolerance. */
  readonly late: boolean;
}

/** Everything recorded about one shot. */
export interface ShotRecord {
  readonly shotId: number;
  /** Simulation time the shot was fired. */
  readonly firedAt: number;
  /** Set once the shot resolves into a hit. */
  hitAt: number | null;
  targetId: number;
  zone: 'head' | 'body' | null;
  damage: number;
  marks: FeedbackMark[];
  /** True when any link broke its tolerance. */
  violated: boolean;
}

/** A one-line summary, ready for the overlay. */
export interface HitLogLine {
  readonly shotId: number;
  readonly text: string;
  readonly violated: boolean;
}

/** The logger's public surface. */
export interface HitLog {
  /** Starts tracking a shot. Called on `shot:fired`. */
  onShotFired(payload: GameEvents['shot:fired']): void;
  /** Records a feedback link for the current shot. */
  mark(channel: FeedbackChannel, time: number, shotId?: number): void;
  /** Records a resolved hit. */
  onHit(payload: GameEvents['hit:registered']): void;
  /** Subscribes to every event the log cares about. */
  attach(events: { on<K extends GameEventName>(name: K, handler: (payload: GameEvents[K]) => void): () => void }): void;
  /** Whether recording is active. Toggled by F4. */
  enabled: boolean;
  /** Completed records, oldest first, bounded to `limit`. */
  records(): readonly ShotRecord[];
  /** The most recent `count` records as printable lines. */
  lines(count: number): readonly HitLogLine[];
  /** Full `[HITLOG]` text block, in the format the technical plan specifies. */
  render(count: number): string;
  clear(): void;
}

/** Maximum retained shot records. Older records are dropped. */
const DEFAULT_LIMIT = 64;

/**
 * Creates the hit log.
 *
 * @param limit How many shots to retain. Bounded so a long session cannot grow
 *              memory without limit while the panel is closed.
 */
export function createHitLog(limit = DEFAULT_LIMIT): HitLog {
  const completed: ShotRecord[] = [];
  let current: ShotRecord | null = null;

  const close = (record: ShotRecord): void => {
    completed.push(record);
    if (completed.length > limit) completed.splice(0, completed.length - limit);
  };

  const log: HitLog = {
    enabled: false,

    onShotFired(payload) {
      if (!log.enabled) return;
      // A shot that never resolved (still in flight) is still closed out, so a
      // missing hit cannot silently keep a record open forever.
      if (current) close(current);
      current = {
        shotId: payload.shotId,
        firedAt: payload.tick / SIM.tickHz,
        hitAt: null,
        targetId: 0,
        zone: null,
        damage: 0,
        marks: [],
        violated: false,
      };
    },

    mark(channel, time, shotId) {
      if (!log.enabled || !current) return;
      // A mark that names a different shot is a straggler from an earlier one.
      // At 640 RPM the previous shot's impact events routinely arrive *after* the
      // next shot has already been fired, and attributing them to the new record
      // produces negative frame deltas that look like a feedback bug which is not
      // there. Unnamed marks are accepted, because the caller may legitimately not
      // know the shot id.
      if (shotId !== undefined && shotId !== current.shotId) return;
      const reference = current.hitAt ?? current.firedAt;
      const deltaFrames = (time - reference) * SIM.tickHz;
      const tolerance = CHANNEL_TOLERANCE_FRAMES[channel];
      const late = Math.abs(deltaFrames) > tolerance;
      current.marks.push({ channel, time, deltaFrames, late });
      if (late) current.violated = true;
    },

    onHit(payload) {
      if (!log.enabled || !current) return;
      // Late/duplicate hits from a previous shot must not be misattributed either.
      if (payload.shotId !== current.shotId) return;
      current.hitAt = payload.tick / SIM.tickHz;
      current.targetId = payload.targetId;
      current.zone = payload.zone;
      current.damage = payload.finalDamage;
      // The hit *is* the reference frame, so these marks are definitionally on time.
      log.mark('hitbox', current.hitAt, current.shotId);
      log.mark('damage', current.hitAt, current.shotId);
    },

    attach(events) {
      events.on('shot:fired', (payload) => log.onShotFired(payload));
      events.on('hit:registered', (payload) => log.onHit(payload));
      events.on('bullet:impact', (payload) => log.mark('decal', payload.tick / SIM.tickHz, payload.shotId));
    },

    records() {
      return completed;
    },

    lines(count) {
      return completed.slice(-count).map((record) => ({
        shotId: record.shotId,
        violated: record.violated,
        text:
          `shot ${String(record.shotId).padStart(4)}  ` +
          `t=${(record.firedAt * 1000).toFixed(1).padStart(8)}ms  ` +
          (record.hitAt === null
            ? 'miss'
            : `hit t=${record.targetId} ${record.zone} ${record.damage} dmg`) +
          `  ${record.marks
            .map((mark) => `${mark.channel}${mark.deltaFrames >= 0 ? '+' : ''}${mark.deltaFrames.toFixed(1)}f`)
            .join(' ')}`,
      }));
    },

    render(count) {
      // The exact format from the technical plan's §3.4 example, so a log pasted
      // into a review reads the same as the specification.
      const rows: string[] = [`[HITLOG] tolerances ${formatTolerances()}`];
      for (const record of completed.slice(-count)) {
        rows.push(`[HITLOG] shot=${record.shotId} t=${(record.firedAt * 1000).toFixed(1)}ms fired`);
        for (const mark of record.marks) {
          rows.push(
            `[HITLOG] t=${(mark.time * 1000).toFixed(1)}ms shot=${record.shotId} evt=${mark.channel}` +
              ` Δ=${mark.deltaFrames >= 0 ? '+' : ''}${mark.deltaFrames.toFixed(1)}f` +
              (mark.late ? '  ← OUT OF TOLERANCE' : ''),
          );
        }
      }
      return rows.join('\n');
    },

    clear() {
      completed.length = 0;
      current = null;
    },
  };

  return log;
}

/** One-line reminder of the tolerances, for the top of a rendered log. */
function formatTolerances(): string {
  return (Object.keys(CHANNEL_TOLERANCE_FRAMES) as FeedbackChannel[])
    .filter((channel) => channel !== 'hitbox')
    .map((channel) => `${channel}±${CHANNEL_TOLERANCE_FRAMES[channel]}f`)
    .join(' ');
}
