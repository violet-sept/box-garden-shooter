/**
 * Platform capability layer.
 *
 * The rule from the technical plan (§2.5) is that platform differences are
 * *probed*, never branched on. So there is exactly one place that asks "where am
 * I running?", and it answers with capabilities rather than with a platform
 * name — no `if (isElectron)` scattered through the codebase.
 *
 * Today the answers are deliberately boring: the desktop shell and the browser
 * behave the same for everything the game needs, because `localStorage`,
 * pointer lock and WebGL2 are all present in both. That is the point. This file
 * exists so that the one difference there *is* — a touch-only device, which the
 * game does not support — is detected and reported in one place.
 */

/** What the host can do. Immutable once created. */
export interface PlatformInfo {
  /** True inside the Electron shell. */
  readonly isDesktop: boolean;
  /** True for a device whose primary input is touch and which has no fine pointer. */
  readonly isTouchOnly: boolean;
  /** Persistence, or `null` when the host blocks it (private mode, file:// quirks). */
  readonly storage: Storage | null;
}

/** Shape of the frozen bridge the Electron preload exposes, if present. */
interface ShellBridge {
  readonly isDesktop?: boolean;
}

/**
 * Probes the host.
 *
 * `window.dshShell` is injected by `electron/preload.cjs`. It is read through a
 * local structural type rather than a global declaration so nothing in `src/`
 * depends on the desktop shell existing.
 */
export function detectPlatform(): PlatformInfo {
  const shell = (globalThis as { dshShell?: ShellBridge }).dshShell;
  const isDesktop = shell?.isDesktop === true;

  // `hover: none` + `pointer: coarse` is the reliable pair: a laptop with a
  // touchscreen reports `pointer: fine` and must NOT be treated as touch-only.
  const touchOnly =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(hover: none)').matches &&
    globalThis.matchMedia('(pointer: coarse)').matches;

  let storage: Storage | null = null;
  try {
    // Access itself can throw in a locked-down browsing context, so probe it.
    storage = globalThis.localStorage;
    const probeKey = '__bgs_probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
  } catch {
    storage = null;
  }

  return { isDesktop, isTouchOnly: touchOnly, storage };
}

/** Reads a stored value, returning `fallback` when storage is unavailable. */
export function readSetting(platform: PlatformInfo, key: string, fallback: string): string {
  if (!platform.storage) return fallback;
  try {
    return platform.storage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Writes a stored value. Silently does nothing when storage is unavailable. */
export function writeSetting(platform: PlatformInfo, key: string, value: string): void {
  if (!platform.storage) return;
  try {
    platform.storage.setItem(key, value);
  } catch {
    /* storage full or blocked; a lost preference is not worth a crash */
  }
}

/** Reads a boolean setting. */
export function readFlag(platform: PlatformInfo, key: string, fallback: boolean): boolean {
  return readSetting(platform, key, fallback ? '1' : '0') === '1';
}

/** Writes a boolean setting. */
export function writeFlag(platform: PlatformInfo, key: string, value: boolean): void {
  writeSetting(platform, key, value ? '1' : '0');
}

/** Setting keys, kept together so they cannot silently collide. */
export const SETTING_KEYS = {
  showStats: 'bgs.showStats',
  showHitLog: 'bgs.showHitLog',
  /** Master volume, stored as a decimal string in `[0, 1]`. */
  masterVolume: 'bgs.masterVolume',
  /** Mute state, stored as `0` / `1`. */
  muted: 'bgs.muted',
} as const;

/** Reads a volume-style setting, clamped to `[0, 1]` and falling back on garbage. */
export function readVolume(platform: PlatformInfo, key: string, fallback: number): number {
  const raw = readSetting(platform, key, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

/** Writes a volume-style setting. */
export function writeVolume(platform: PlatformInfo, key: string, value: number): void {
  writeSetting(platform, key, Math.min(1, Math.max(0, value)).toFixed(3));
}

/**
 * Reads a host capability out of the page URL.
 *
 * The performance scene (`?scene=perf`, see `PERF` in `core/config.ts`) is
 * opt-in through the URL rather than through a build flag: it drives the world
 * from outside the input layer, so it must be impossible to reach by accident, and
 * it has to work identically in the browser and in the desktop shell. Probing
 * `location` belongs here with the other host questions — nothing in `src/game/**`
 * or `src/render/**` may look at the URL.
 */
export function readQueryParam(name: string): string | null {
  const search = (globalThis as { location?: { search?: string } }).location?.search;
  if (typeof search !== 'string' || search.length === 0) return null;
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf('=');
    const key = equals === -1 ? pair : pair.slice(0, equals);
    if (key !== name) continue;
    if (equals === -1) return '';
    return decodeURIComponent(pair.slice(equals + 1));
  }
  return null;
}
