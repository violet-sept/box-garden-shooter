/**
 * The pause panel: three buttons, and the wiring between them and the game.
 *
 * ## Why it is its own module
 *
 * Because it is a *接线* module, and this project has now shipped two defects that lived in
 * exactly that shape: a `const on = events.on` that lost its receiver, and an
 * `InputState.update()` the composition root never called. Both were invisible to a green
 * suite because the only code that could catch them ran inside `main.ts`, which no test can
 * reach. Handing this file the elements and the three callbacks means `tests/pauseMenu.test.ts`
 * can click the real buttons through a detached stand-in and assert that the game was told —
 * instead of asserting that some element exists in `index.html`.
 *
 * ## What it owns, and what it does not
 *
 * It owns the buttons' event listeners and the panel's problem line. It does **not** own the
 * panel's visibility: that belongs to `overlayVisibility` in `hud.ts`, together with the veil
 * and the HUD, because "at most one full-screen layer" is a contract that only holds if one
 * function decides it. `main.ts` calls `hud.showPause()` and this module's callbacks; neither
 * reaches into the other's half.
 *
 * ## The three choices
 *
 * `结束暂停` resumes, `重新开始` starts a fresh run, `返回主界面` goes back to the title
 * screen. All three are deliberately *explicit* buttons rather than a click-anywhere panel:
 * the veil's "click to start" is fine for a boot screen, but a pause menu whose background
 * click restarts the run is a trap.
 */

/** Elements this module drives. Looked up once by the composition root. */
export interface PauseMenuElements {
  /** The panel root. Only used to keep the problem line's subtree in one place. */
  readonly root: HTMLElement;
  readonly resume: HTMLElement;
  readonly restart: HTMLElement;
  readonly mainMenu: HTMLElement;
  /** Where a refused pointer lock is reported while this panel is the visible one. */
  readonly warn: HTMLElement;
}

/** What the game does when a button is pressed. */
export interface PauseMenuHandlers {
  /** Resume the run that is already loaded. */
  readonly resume: () => void;
  /** Abandon this run and start a fresh one. */
  readonly restart: () => void;
  /** Abandon this run and return to the title screen. */
  readonly mainMenu: () => void;
}

/** The panel's public surface. */
export interface PauseMenu {
  /**
   * Shows a problem on the panel.
   *
   * Needed because the veil's own `#boot-warn` is *inside the hidden veil* while the pause
   * panel is up: a refused lock would otherwise write its explanation to an invisible
   * element, which is the "failure must be visible" rule (plan §5.13) broken in the one
   * situation it exists for.
   */
  showProblem(message: string): void;
  /** Clears the problem line, so a stale refusal does not follow the player into the run. */
  clearProblem(): void;
  /** Removes every listener. Safe to call more than once. */
  dispose(): void;
}

/** Wires the three buttons to the three actions. */
export function createPauseMenu(elements: PauseMenuElements, handlers: PauseMenuHandlers): PauseMenu {
  /**
   * Named handlers rather than three anonymous closures, because `removeEventListener` needs
   * the same reference it was given. The bound-method defect this project shipped came from
   * exactly this corner: a listener that cannot be removed is a listener that fires after
   * teardown.
   */
  const onResume = (): void => handlers.resume();
  const onRestart = (): void => handlers.restart();
  const onMainMenu = (): void => handlers.mainMenu();

  elements.resume.addEventListener('click', onResume);
  elements.restart.addEventListener('click', onRestart);
  elements.mainMenu.addEventListener('click', onMainMenu);

  return {
    showProblem(message) {
      elements.warn.hidden = false;
      elements.warn.textContent = message;
    },

    clearProblem() {
      elements.warn.hidden = true;
      elements.warn.textContent = '';
    },

    dispose() {
      elements.resume.removeEventListener('click', onResume);
      elements.restart.removeEventListener('click', onRestart);
      elements.mainMenu.removeEventListener('click', onMainMenu);
    },
  };
}
