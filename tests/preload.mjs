/**
 * Test-runner preload.
 *
 * ## 1. The problem this solves
 *
 * On Windows, Vite runs `net use` through `child_process.exec` the first time it
 * resolves a real path, in order to detect mapped network drives (whose realpath
 * behaves differently). In a locked-down environment that child process is
 * denied outright — `spawn EPERM` — and the failure surfaces as "failed to load
 * config", which makes the entire test suite unrunnable for a reason that has
 * nothing to do with the code under test.
 *
 * The check is a pure optimisation for an environment this project does not run
 * in. Answering "no network drives" is both truthful (the workspace is on a local
 * drive) and exactly what Vite does when the command fails on its own. Patching
 * `exec` — rather than asking for elevated permissions — keeps the suite runnable
 * by anyone who clones the repository.
 *
 * ## 2. Extensionless TypeScript imports
 *
 * The source uses bundler-style extensionless imports (`from './config'`). Node's
 * ESM resolver requires extensions and does not guess them, so a resolve hook
 * teaches it the same inference the bundler already applies. This applies to
 * `#/*` package-import specifiers too, which Node maps to `./src/*` but will not
 * then extend.
 *
 * Everything here is test-only tooling; none of it is part of the shipped build.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';

// ---------------------------------------------------------------------------
// 1. Neutralise Vite's network-drive probe.
// ---------------------------------------------------------------------------

if (process.platform === 'win32' && !globalThis.__DSH_NET_USE_SHIM__) {
  globalThis.__DSH_NET_USE_SHIM__ = true;

  /** Marker in the error's `cmd`, matching how Vite itself detects this case. */
  const isNetUse = (command) => typeof command === 'string' && command.includes('net use');

  /**
   * Empty stdout with a zero exit code. Vite's parser sees no drive mappings,
   * caches "not a network drive", and falls through to the normal Node realpath.
   */
  const fakeNoNetworkDrives = (callback, child) => {
    const cb = typeof callback === 'function' ? callback : undefined;
    if (cb) queueMicrotask(() => cb(null, '', ''));
    if (child) {
      child.stdout = child.stdout ?? null;
      child.stderr = child.stderr ?? null;
      if (typeof child.emit === 'function') queueMicrotask(() => child.emit('close', 0));
    }
    return child;
  };

  const originalExec = childProcess.exec;
  childProcess.exec = function exec(command, options, callback) {
    if (isNetUse(command)) return fakeNoNetworkDrives(callback, { kill() {}, on() {} });
    return originalExec.call(this, command, options, callback);
  };

  const originalExecFile = childProcess.execFile;
  childProcess.execFile = function execFile(file, args, options, callback) {
    if (isNetUse(file) || (Array.isArray(args) && args[0] === 'use')) {
      return fakeNoNetworkDrives(callback, { kill() {}, on() {} });
    }
    return originalExecFile.call(this, file, args, options, callback);
  };

  // Belt and braces: ask Vite to skip the Windows-safe realpath path entirely, in
  // case a future version changes how it shells out.
  process.env.NO_WINDOWS_SAFE_REALPATH_SYNC ??= 'true';
}

// ---------------------------------------------------------------------------
// 2. Teach Node the bundler's extension inference.
// ---------------------------------------------------------------------------

const isFile = (path) => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

/** Appends the extension a bundler would infer, or returns `path` unchanged. */
function resolveWithExtension(path) {
  for (const candidate of [`${path}.ts`, `${path}.mts`, `${path}.js`, `${path}/index.ts`, `${path}/index.js`]) {
    if (isFile(candidate)) return candidate;
  }
  return path;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // `#/*` is the package `imports` map: Node resolves it to a file URL but will
    // not append an extension afterwards, so it is resolved here instead.
    if (specifier.startsWith('#/')) {
      const path = fileURLToPath(new URL(`../src/${specifier.slice(2)}`, import.meta.url));
      return { url: pathToFileURL(resolveWithExtension(path)).href, shortCircuit: true };
    }

    // Bare package specifiers and Node built-ins are left alone.
    if (!specifier.startsWith('.') && !specifier.startsWith('file:')) {
      return nextResolve(specifier, context);
    }

    let base;
    try {
      base = new URL(specifier, context.parentURL ?? import.meta.url);
    } catch {
      return nextResolve(specifier, context);
    }
    if (base.protocol !== 'file:') return nextResolve(specifier, context);

    const path = fileURLToPath(base);
    if (isFile(path)) return nextResolve(specifier, context);
    const resolved = resolveWithExtension(path);
    if (resolved !== path) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
