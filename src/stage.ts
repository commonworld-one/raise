// The /demo stage step engine. Pure state machine, no DOM: the page binds it in public/app.js.
// It is sent to the browser via Function#toString (inline on /demo), so stageEngine must stay
// self-contained: nothing inside may reference anything outside its own body.

export interface StageStep { text: string }
export interface StageState {
  /** How many steps are shown (0 = none yet, total = all). */
  shown: number; total: number; playing: boolean; speed: number;
  /** Index of the step shown last (the active one), -1 before the first. */
  active: number; done: boolean;
  /** false under prefers-reduced-motion: no enter animation, scroll jumps instead of gliding. */
  animate: boolean; scroll: 'smooth' | 'auto';
}
export type StageEvent = 'next' | 'back' | 'restart' | 'play' | 'pause' | 'speed' | 'end' | 'goto';
export interface StageOpts {
  steps: StageStep[];
  reducedMotion?: boolean;
  onChange?: (s: StageState, e: StageEvent) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export function stageEngine() {
  const SPEEDS = [1, 1.5, 2];
  // Slow auto-play: the pause before the next message grows with the text on screen.
  const BASE_MS = 1600, PER_CHAR_MS = 55, MAX_MS = 7000, FIRST_MS = 600;
  const delayFor = (text: string, speed: number): number => Math.round(Math.min(MAX_MS, BASE_MS + PER_CHAR_MS * text.length) / speed);

  function create(o: StageOpts) {
    const total = o.steps.length;
    const set = o.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clear = o.clearTimer || ((h: unknown) => clearTimeout(h as number));
    let shown = 0, playing = false, speed = 1;
    let timer: unknown = null;

    const state = (): StageState => ({
      shown, total, playing, speed, active: shown - 1, done: shown >= total,
      animate: !o.reducedMotion, scroll: o.reducedMotion ? 'auto' : 'smooth',
    });
    const emit = (e: StageEvent) => { if (o.onChange) o.onChange(state(), e); };
    const stopTimer = () => { if (timer != null) clear(timer); timer = null; };
    /** The wait before the next step: reading time of the message on screen (a short beat before the first). */
    const nextDelay = (): number => (shown === 0 ? Math.round(FIRST_MS / speed) : delayFor(o.steps[shown - 1]!.text, speed));
    const schedule = () => {
      stopTimer();
      if (!playing) return;
      if (shown >= total) { playing = false; emit('end'); return; }
      timer = set(() => { timer = null; advance(); }, nextDelay());
    };
    const advance = () => {
      if (shown < total) { shown++; emit('next'); }
      schedule();
    };

    return {
      state,
      delay: nextDelay,
      /** Step forward (Next button, Space). Keeps auto-play running if it is on. */
      next() { if (shown < total) { shown++; emit('next'); } schedule(); },
      /** Step back: hides the last message and pauses auto-play. */
      back() { playing = false; stopTimer(); if (shown > 0) { shown--; emit('back'); } },
      goto(n: number) { playing = false; stopTimer(); shown = Math.max(0, Math.min(total, Math.floor(n))); emit('goto'); },
      play() { if (playing) return; if (shown >= total) { shown = 0; emit('restart'); } playing = true; emit('play'); schedule(); },
      pause() { if (!playing) return; playing = false; stopTimer(); emit('pause'); },
      toggle() { if (playing) this.pause(); else this.play(); },
      setSpeed(s: number) { if (SPEEDS.indexOf(s) < 0 || s === speed) return; speed = s; emit('speed'); if (playing) schedule(); },
      restart() { playing = false; stopTimer(); shown = 0; emit('restart'); },
    };
  }
  return { SPEEDS, delayFor, create };
}

export type StageEngine = ReturnType<ReturnType<typeof stageEngine>['create']>;

/** Inline script for /demo: defines window.RaiseStage; public/app.js binds it to the page. */
export function stageScript(): string {
  return `<script>var __name=window.__name||function(f){return f};window.RaiseStage=(${stageEngine.toString()})();</script>`;
}
