import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Build and dev-server configuration.
 *
 * Test configuration deliberately lives in `vitest.config.ts` instead of being
 * folded in here: Vitest 5 requires its own `UserConfig` type to accept the
 * `test` key, and importing that type from a plain Vite config would make the
 * build config depend on the test runner. Two small files beat one file with a
 * cast in it.
 */
export default defineConfig({
  // Relative base so the same build works from file:// inside the desktop shell.
  base: './',
  resolve: {
    // Vite 8 has a built-in `resolve.tsconfigPaths: true` alternative, but it is
    // off by default and carries a small resolution cost on every import. The
    // explicit alias is zero-cost and keeps vite.config.ts the single source of
    // truth for build-time resolution.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    // Source maps stay ON, and the two delivery surfaces make different use of
    // them (phase-5 decision S1):
    //
    //   web      the built `.map` files are uploaded with the rest. A browser only
    //            fetches a map when devtools is open, so a player downloads none of
    //            the ~3.7 MB, while anyone debugging a reported crash gets real
    //            stack traces instead of `index-<hash>.js:1:418322`.
    //   desktop  `electron-builder.yml` excludes `**/*.map` from the package. There
    //            the maps are pure weight: a `file://` page inside an asar is not
    //            something anyone can debug in place.
    //
    // Either way this is a decision on record, not a default that nobody looked at.
    sourcemap: true,
    // Keep three in its own chunk so game code can be re-downloaded cheaply.
    // Vite 8 (Rolldown) types `manualChunks` as a function only, so the chunk is
    // expressed as a predicate rather than the older object map.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
});
