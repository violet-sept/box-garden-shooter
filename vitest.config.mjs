import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Test configuration — deliberately plain JavaScript (`.mjs`).
 *
 * A `.ts` config forces Vitest to *bundle* the file before evaluating it, and on
 * Windows that bundling path shells out to `net use` to detect network drives.
 * That child process is blocked in restricted environments, which makes the whole
 * suite unrunnable for reasons that have nothing to do with the tests. A `.mjs`
 * config is loaded directly by Node, so the entire bundling step — and the spawn
 * with it — never happens.
 *
 * Only pure logic is tested (technical plan §4.2): the simulation layer has no
 * WebGL, no DOM and no `three` dependency, so tests run in a plain Node
 * environment with no browser shim. If a test ever needs a canvas, that is a
 * signal that logic has leaked into the render layer.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Mirrors the `imports` map in package.json, which is what plain Node uses.
      '#': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Worker threads rather than forked processes. Both give isolation, but
    // threads also work in environments that forbid spawning child processes —
    // and the simulation layer holds no global state that needs a fresh process.
    pool: 'threads',
    // The fixed-timestep assertions run thousands of ticks; the default 5 s
    // timeout is uncomfortably close once the suite grows.
    testTimeout: 20_000,
  },
});
