/**
 * The pause menu's wiring.
 *
 * This file exists for one reason, and it is the reason this project keeps writing it: the
 * defects that reached players were never in the arithmetic, they were in the *接线* — a
 * `const on = events.on` that lost its receiver, and an `InputState.update()` the composition
 * root never called. Both passed a green suite because the only code that could have caught
 * them lived inside `main.ts`, which no test can reach.
 *
 * So the panel is a module that takes its elements and its three callbacks, and this test
 * clicks the real buttons through a detached stand-in and asserts that the *game* was told.
 * "The button exists in `index.html`" is not the assertion; "pressing 重新开始 restarts the
 * run" is.
 */

import { describe, expect, it } from 'vitest';
import { createPauseMenu, type PauseMenuElements } from '#/render/hud/pauseMenu';

/**
 * An element that records listeners and can dispatch to them, which is the whole contract the
 * panel uses. The project has no jsdom, and it does not need one for this: the risk being
 * tested is "did the handler get attached, and to which element", not CSS or bubbling.
 */
interface FakeElement extends HTMLElement {
  click(): void;
  listeners(type: string): number;
}

function fakeElement(): FakeElement {
  const registered = new Map<string, Set<(event: unknown) => void>>();
  const element = {
    hidden: false,
    textContent: '',
    addEventListener(type: string, handler: (event: unknown) => void) {
      const set = registered.get(type) ?? new Set();
      set.add(handler);
      registered.set(type, set);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      registered.get(type)?.delete(handler);
    },
    click() {
      for (const handler of registered.get('click') ?? []) handler({ type: 'click' });
    },
    listeners(type: string): number {
      return registered.get(type)?.size ?? 0;
    },
  };
  return element as unknown as FakeElement;
}

/** The panel plus a log of what the game was told to do. */
function harness() {
  const resume = fakeElement();
  const restart = fakeElement();
  const mainMenu = fakeElement();
  const warn = fakeElement();
  // Mirrors the `hidden` attribute the markup ships with; `tests/shell.test.ts` asserts that
  // the real markup has it, this only keeps the stand-in honest.
  warn.hidden = true;
  // Typed as the module's own element contract on the way in, kept strongly typed on the way
  // out so the test can count listeners.
  const elements: PauseMenuElements = { root: fakeElement(), resume, restart, mainMenu, warn };
  const calls: string[] = [];
  const menu = createPauseMenu(elements, {
    resume: () => calls.push('resume'),
    restart: () => calls.push('restart'),
    mainMenu: () => calls.push('mainMenu'),
  });
  return { elements: { resume, restart, mainMenu, warn }, calls, menu };
}

describe('pause menu wiring', () => {
  it('tells the game to resume when 结束暂停 is pressed', () => {
    const { elements, calls } = harness();
    elements.resume.click();
    expect(calls).toEqual(['resume']);
  });

  it('tells the game to restart when 重新开始 is pressed', () => {
    const { elements, calls } = harness();
    elements.restart.click();
    expect(calls).toEqual(['restart']);
  });

  it('tells the game to go back to the title screen when 返回主界面 is pressed', () => {
    const { elements, calls } = harness();
    elements.mainMenu.click();
    expect(calls).toEqual(['mainMenu']);
  });

  it('keeps the three choices apart', () => {
    // The failure this guards is a copy-pasted handler: two buttons wired to the same action
    // looks right in a screenshot of the panel and is only visible when someone clicks.
    const { elements, calls } = harness();
    elements.resume.click();
    elements.restart.click();
    elements.mainMenu.click();
    elements.restart.click();
    expect(calls).toEqual(['resume', 'restart', 'mainMenu', 'restart']);
  });

  it('shows and clears a refused-lock message on the panel itself', () => {
    // The veil's warn line lives inside the *hidden* veil while this panel is up, so a
    // refusal reported there would be written to an element nobody can see — the silent
    // failure the visible-warning rule exists to prevent.
    const { elements, menu } = harness();
    expect(elements.warn.hidden).toBe(true);

    menu.showProblem('浏览器拒绝了鼠标锁定：…');
    expect(elements.warn.hidden).toBe(false);
    expect(elements.warn.textContent).toContain('拒绝了鼠标锁定');

    menu.clearProblem();
    expect(elements.warn.hidden).toBe(true);
    expect(elements.warn.textContent).toBe('');
  });

  it('detaches every listener and can be disposed twice', () => {
    // A listener that cannot be removed fires after teardown; the bound-method defect this
    // project shipped was exactly a handler that could not be taken off.
    const { elements, menu } = harness();
    expect(elements.resume.listeners('click')).toBe(1);
    menu.dispose();
    expect(elements.resume.listeners('click')).toBe(0);
    expect(elements.restart.listeners('click')).toBe(0);
    expect(elements.mainMenu.listeners('click')).toBe(0);
    expect(() => menu.dispose()).not.toThrow();
  });
});
