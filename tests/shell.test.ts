/**
 * Delivery-surface tests: the shell, the build config and the docs.
 *
 * Phase 5 adds no game logic, so it adds no gameplay tests. What it *does* add is a
 * set of decisions about how the thing ships — and those live in files that nothing
 * else exercises: `index.html`'s policy, the Electron shell's security switches, the
 * packaging whitelist, the Vite `base`, the icon, `README.md`, and the workflow that
 * publishes the web build to GitHub Pages.
 *
 * Every assertion here is a decision that was made deliberately and would otherwise
 * be undone silently by the next person who edits these files. They read repository
 * sources with `node:fs`; they deliberately do not read `dist/`, because a unit test
 * that depends on build output cannot run before a build.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8');

describe('content security policy', () => {
  it('index.html declares a CSP with no eval and no inline script', () => {
    const html = read('index.html');
    // Assert on the policy itself, not on the file: the surrounding comment is
    // allowed to *name* `'unsafe-eval'` while explaining why it is absent.
    const policy = html.match(/http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]+)"/)?.[1] ?? '';
    expect(policy).not.toBe('');
    expect(policy).not.toContain("'unsafe-eval'");
    // Styles need it (the HUD CSS lives in this document); scripts must not get it.
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toMatch(/script-src 'self' file:/);
    // Without `file:` the packaged window loads this page over file:// and comes up
    // black, while the web build keeps working — the hardest kind of bug to find.
    expect(policy).toMatch(/default-src 'self' file:/);
    expect(policy).toContain("object-src 'none'");
    // The dev server's HMR socket is the only ws: hole, and it is loopback-only.
    for (const source of policy.split(';').find((part) => part.includes('connect-src'))?.split(/\s+/) ?? []) {
      if (source.startsWith('ws://')) expect(source).toMatch(/^ws:\/\/(localhost|127\.0\.0\.1):\*$/);
    }
    expect(policy).toContain('ws://localhost:*');
  });
});

describe('boot veil', () => {
  it('does not promise readiness in static markup', () => {
    const html = read('index.html');
    const cta = html.match(/<div class="cta" id="boot-cta">([^<]*)<\/div>/)?.[1] ?? '';

    // The veil is static HTML: it is on screen before a single line of the module runs,
    // and it *stays* on screen if the module never runs at all. A call to action written
    // here would therefore be indistinguishable from a working boot screen — which is
    // exactly the field report "点击后没有任何反应" that plan §5.13 was written for.
    expect(cta).toBe('正在载入…');

    // The real call to action comes from the module, so it can only appear once the
    // module has actually executed.
    expect(read('src/main.ts')).toContain('点击画面开始');
    expect(html).not.toContain('点击画面开始');
  });

  it('keeps a visible place for boot and lock failures', () => {
    const html = read('index.html');
    // `role="alert"` so the message is announced, not just painted.
    expect(html).toMatch(/id="boot-warn"[^>]*role="alert"/);

    const main = read('src/main.ts');
    // Both paths that used to be silent: a throw during boot, and a refused lock.
    expect(main).toContain("window.addEventListener('unhandledrejection'");
    expect(main).toContain('浏览器拒绝了鼠标锁定');
  });
});

describe('pause menu', () => {
  it('ships the three choices as static markup, hidden, and nowhere else', () => {
    const html = read('index.html');
    for (const label of ['结束暂停', '重新开始', '返回主界面']) expect(html).toContain(label);
    for (const id of ['pause-menu', 'pause-resume', 'pause-restart', 'pause-main', 'pause-warn']) {
      expect(html).toContain(`id="${id}"`);
    }
    // The panel must start hidden: the module shows it when Esc releases the pointer, and a
    // panel that shipped visible would cover the boot screen with a paused game.
    expect(html).toMatch(/id="pause-menu"[^>]*hidden/);
    // A refused pointer lock is reported on the *visible* overlay. The veil's own warn line
    // is inside the hidden veil while this panel is up, so it cannot be the only one.
    expect(html).toMatch(/id="pause-warn"[^>]*role="alert"/);
  });

  it('routes a pause through its own overlay rather than reusing the veil', () => {
    const main = read('src/main.ts');
    // The defect: Esc used to reopen the opaque veil, i.e. what the player reads as the
    // title screen, with no way to restart or to leave the run.
    expect(main).toContain('hud.showPause()');
    // And the three choices go through the module that owns their wiring, which is the part
    // a unit test can click.
    expect(main).toContain('createPauseMenu(');
    expect(main).toMatch(/requireElement\('pause-resume'\)/);
    expect(main).toMatch(/requireElement\('pause-restart'\)/);
    expect(main).toMatch(/requireElement\('pause-main'\)/);
  });
});

describe('view toggle', () => {
  it('tells the player the key exists on the screen they start from', () => {
    // The one piece of discoverability this feature has: first person is the default, so a player
    // who never learns about `V` never learns there is another view at all. The key list on the
    // veil is static markup, which is why the assertion is on the markup.
    const html = read('index.html');
    expect(html).toContain('切换第一/第三人称');
    expect(html).toContain('V ');
  });

  it('wires V through the world rather than moving the camera here', () => {
    const main = read('src/main.ts');
    // The switch is a world call, because it has to re-solve the aim for the moved pivot and snap
    // the camera. A composition root that only moved `world.camera.position` would leave the
    // crosshair, the tracer and the impact describing three different places.
    expect(main).toContain("input.wasPressed('toggleView')");
    expect(main).toContain('world.toggleView()');
    // And the rig is told immediately, so the frame in between does not draw the rifle in the
    // body's hands from inside the player's head.
    expect(main).toMatch(/character\?\.sync\(world\.player, 0, mode, camera\)/);
  });
});

describe('desktop shell', () => {
  it('preload still exposes exactly one frozen object and no IPC', () => {
    const preload = read('electron/preload.cjs');
    const exposed = [...preload.matchAll(/exposeInMainWorld\(\s*'([^']+)'/g)].map((match) => match[1]);
    expect(exposed).toEqual(['dshShell']);
    expect(preload).toContain('Object.freeze');
    expect(preload).not.toMatch(/ipcRenderer|ipcMain/);
  });

  it('keeps context isolation, the renderer sandbox, and no IPC channel', () => {
    const main = read('electron/main.cjs');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
    expect(main).toContain('sandbox: true');
    // Phase-5 decision S3: no quit confirmation. Deciding whether "a run is in
    // progress" needs the game state in the main process, i.e. a new IPC channel,
    // which this rule exists to prevent.
    expect(main).not.toMatch(/ipcMain|ipcRenderer/);
    // The window geometry is a design premise for the 16:9 HUD, not a preference.
    expect(main).toContain('width: 1600, height: 900');
    expect(main).toContain('width: 1280, height: 720');
  });
});

describe('packaging configuration', () => {
  const yml = read('electron-builder.yml');

  it('ships only the runtime essentials', () => {
    const filesBlock = yml.match(/^files:\n(?:[ \t]+.*\n)+/m)?.[0] ?? '';
    expect(filesBlock).toContain('dist/**/*');
    expect(filesBlock).toContain('electron/**/*');
    expect(filesBlock).toContain('package.json');
    expect(filesBlock).not.toContain('node_modules');
    expect(filesBlock).not.toMatch(/^\s*-\s*(src|tests)\//m);
  });

  it('keeps the phase-5 decisions S1 (maps out) and S2 (ascii exe name)', () => {
    // S1: the web build keeps source maps, the package does not.
    expect(yml).toContain("'!**/*.map'");
    // S2: Chinese product name, ASCII file name, Chinese shortcut.
    expect(yml).toMatch(/productName:\s*箱庭射击/);
    expect(yml).toMatch(/executableName:\s*box-garden-shooter/);
    expect(yml).toMatch(/shortcutName:\s*箱庭射击/);
  });

  it('keeps the settings that make packaging work in this environment', () => {
    expect(yml).toMatch(/npmRebuild:\s*false/);
    // The shell has to be the entry point without touching the repository's
    // package.json, or the web story ("npm run dev") stops being clean.
    expect(yml).toMatch(/main:\s*electron\/main\.cjs/);
    expect(yml).toMatch(/buildResources:\s*build/);
  });
});

describe('build configuration', () => {
  it('vite.config.ts keeps the file://-safe base and the sourcemap decision', () => {
    const config = read('vite.config.ts');
    expect(config).toContain("base: './'");
    expect(config).not.toMatch(/base:\s*'\/'/);
    expect(config).toContain('sourcemap: true');
  });

  it('package.json keeps the runtime dependency surface empty', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      imports: Record<string, string>;
      engines: { node: string };
      scripts: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({});
    // `three` is bundled into `dist/` by Vite, so it is a build input, not a
    // runtime dependency of the shell.
    expect(pkg.devDependencies.three).toBeDefined();
    expect(pkg.devDependencies.electron).toBeDefined();
    expect(pkg.imports['#/*']).toBe('./src/*');
    // 22.15 rather than Vite's own 22.12 floor: `tests/preload.mjs` uses
    // `module.registerHooks`, which Node added in v22.15.0. Advertising the lower
    // number would send a contributor on 22.12 into an unrunnable test suite.
    expect(pkg.engines.node).toBe('>=22.15.0');
    for (const script of [
      'dev',
      'build',
      'preview',
      'typecheck',
      'test',
      'assets:icon',
      'desktop:dev',
      'desktop:build',
      'desktop:accept',
    ]) {
      expect(Object.keys(pkg.scripts)).toContain(script);
    }
  });
});

describe('application icon', () => {
  it('build/icon.ico is a real multi-size icon with the 256x256 entry required', () => {
    const ico = readFileSync(path.join(ROOT, 'build', 'icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(4);

    const sizes: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const base = 6 + index * 16;
      const width = ico[base] === 0 ? 256 : (ico[base] ?? 0);
      const height = ico[base + 1] === 0 ? 256 : (ico[base + 1] ?? 0);
      sizes.push(`${width}x${height}`);
      // Every declared payload must actually live inside the file, or Windows and
      // electron-builder will read whatever follows the directory as image data.
      const bytes = ico.readUInt32LE(base + 8);
      const offset = ico.readUInt32LE(base + 12);
      expect(bytes).toBeGreaterThan(0);
      expect(offset + bytes).toBeLessThanOrEqual(ico.length);
      expect(width).toBe(height);
    }
    expect(sizes).toContain('256x256');
    // The icon is generated by `npm run assets:icon`; if the generator and the
    // committed file drift apart this is the test that notices.
    expect(sizes).toEqual(['16x16', '24x24', '32x32', '48x48', '64x64', '128x128', '256x256']);
  });
});

describe('README', () => {
  it('documents every command it mentions', () => {
    const readme = read('README.md');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const referenced = [...readme.matchAll(/npm run ([a-z0-9:_-]+)/gi)].map((match) => match[1] ?? '');
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of new Set(referenced)) {
      // A README line that cannot be run is worse than no README line.
      expect(Object.keys(pkg.scripts)).toContain(name);
    }
  });

  it('describes the character-model contract the loader actually implements', () => {
    const readme = read('README.md');
    const loader = read('src/render/models/CharacterLoader.ts');
    expect(loader).toContain("PLAYER_MODEL_URL = './assets/models/player/player.glb'");
    expect(readme).toContain('public/assets/models/player/player.glb');

    // The README may only advertise clip keywords the matcher really accepts.
    for (const keyword of ['idle', 'walk', 'run', 'shoot', 'fire', 'reload', 'death', 'die']) {
      expect(loader).toContain(keyword);
      expect(readme).toContain(keyword);
    }
    // And it has to state the fallback chain, in one of its spellings.
    expect(readme).toMatch(/run\s*(->|→|\u2192)\s*walk\s*(->|→|\u2192)\s*idle/);
  });

  it('states the delivery limits honestly', () => {
    const readme = read('README.md');
    // No audio files exist anywhere in the project (decision D14), so the README
    // must not send anyone looking for them.
    expect(readme).toMatch(/mp3|程序化合成|procedural/i);
    // The asset has never been delivered, so it must not be described as shipped.
    expect(readme).toMatch(/程序化占位|procedural stand-in/i);
  });
});

describe('web deployment (GitHub Pages)', () => {
  const WORKFLOW = '.github/workflows/deploy-pages.yml';

  it('keeps the runtime asset URL relative, so one dist/ works at any mount path', () => {
    const loader = read('src/render/models/CharacterLoader.ts');
    // `base: './'` is what lets a single build serve `/`, `/<repo>/` (a Pages project
    // site) and `file://` (the desktop shell). An absolute `/assets/...` silently
    // opts out of two of those three: it resolves against the origin, or against the
    // drive root under `file://`. And because a missing model is a *supported*
    // degradation, the failure shows up only as the procedural stand-in.
    expect(loader).toContain("PLAYER_MODEL_URL = './assets/models/player/player.glb'");
    expect(loader).not.toMatch(/PLAYER_MODEL_URL = '\/assets/);
    expect(loader).toContain("small: './assets/models/enemy/stalker.glb'");
    expect(loader).toContain("large: './assets/models/enemy/warden.glb'");
  });

  it('publishes dist/ with the official Pages actions', () => {
    const workflow = read(WORKFLOW);
    // Both scopes are required by `deploy-pages`; the id-token is what attests the
    // artifact. Missing either one fails at deploy time, not at build time.
    expect(workflow).toContain('pages: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('actions/upload-pages-artifact@');
    expect(workflow).toContain('path: dist');
    expect(workflow).toContain('actions/deploy-pages@');
    expect(workflow).toContain('npm run build');
    // Re-deploying by hand is needed after changing a Pages setting.
    expect(workflow).toContain('workflow_dispatch');
    // A half-published site is worse than a site that is one commit behind.
    expect(workflow).toMatch(/concurrency:\s*\n\s*group: pages\s*\n\s*cancel-in-progress: false/);
  });

  it('does not patch the build for the host', () => {
    const workflow = read(WORKFLOW);
    // The widespread belief is that a subpath deployment needs an absolute `--base`.
    // It needs the opposite: relative references are exactly why the same artifact
    // works at `/`, at `/<repo>/` and inside the desktop shell (plan §2.5 / §5.15).
    expect(workflow).not.toMatch(/--base[= ]/);
    expect(read('vite.config.ts')).toContain("base: './'");
  });
});
