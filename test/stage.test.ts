// /demo stage step engine (src/stage.ts): advance, back, speed, restart, auto-play, reduced motion.
import { describe, expect, it } from 'vitest';
import { stageEngine, stageScript } from '../src/stage';
import { STAGE_STEPS } from '../src/views';
import { dget } from './helpers';

const E = stageEngine();
/** A fake clock: timers fire only when we say so. */
function rig(texts = ['Test message 1', 'Test message 2 is a good deal longer than the first one', 'Test 3'], reducedMotion = false) {
  const timers: { fn: () => void; ms: number }[] = [];
  const events: string[] = [];
  const eng = E.create({
    steps: texts.map((text) => ({ text })), reducedMotion,
    onChange: (_s, e) => events.push(e),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (h) => { const i = timers.indexOf(h as any); if (i >= 0) timers.splice(i, 1); },
  });
  const fire = () => { const t = timers.shift(); expect(t).toBeDefined(); t!.fn(); return t!.ms; };
  return { eng, timers, events, fire };
}

describe('stage engine', () => {
  it('default is manual: nothing shown, not playing, no timer', () => {
    const { eng, timers } = rig();
    expect(eng.state()).toMatchObject({ shown: 0, total: 3, playing: false, speed: 1, active: -1, done: false });
    expect(timers).toHaveLength(0);
  });

  it('next shows one message per step and stops at the end; back hides the last', () => {
    const { eng, events } = rig();
    eng.next(); expect(eng.state()).toMatchObject({ shown: 1, active: 0 });
    eng.next(); eng.next(); eng.next();
    expect(eng.state()).toMatchObject({ shown: 3, active: 2, done: true });
    eng.back(); expect(eng.state()).toMatchObject({ shown: 2, active: 1, done: false });
    eng.back(); eng.back(); eng.back();
    expect(eng.state().shown).toBe(0);
    expect(events.filter((e) => e === 'next')).toHaveLength(3);
    expect(events.filter((e) => e === 'back')).toHaveLength(3);
  });

  it('auto-play advances on its own; the pause grows with the text on screen; it stops at the end', () => {
    const { eng, timers, fire } = rig();
    eng.play();
    expect(eng.state().playing).toBe(true);
    fire(); // first beat
    expect(eng.state().shown).toBe(1);
    const short = fire(); // after "Test message 1"
    expect(eng.state().shown).toBe(2);
    const long = fire(); // after the longer message 2
    expect(long).toBeGreaterThan(short);
    expect(short).toBe(E.delayFor('Test message 1', 1));
    expect(eng.state()).toMatchObject({ shown: 3, playing: false, done: true });
    expect(timers).toHaveLength(0);
  });

  it('back and pause stop auto-play; play at the end starts over', () => {
    const { eng, timers, fire } = rig();
    eng.play(); fire(); eng.back();
    expect(eng.state()).toMatchObject({ playing: false, shown: 0 });
    expect(timers).toHaveLength(0);
    eng.play(); eng.pause();
    expect(eng.state().playing).toBe(false);
    expect(timers).toHaveLength(0);
    eng.goto(3); eng.play();
    expect(eng.state()).toMatchObject({ shown: 0, playing: true });
  });

  it('speed 1x / 1.5x / 2x scales the pause; other values are ignored', () => {
    const { eng, timers } = rig();
    eng.next();
    const at = (s: number) => { eng.setSpeed(s); return eng.delay(); };
    const d1 = at(1), d15 = at(1.5), d2 = at(2);
    expect(d15).toBe(Math.round(d1 / 1.5));
    expect(d2).toBe(Math.round(d1 / 2));
    eng.setSpeed(3);
    expect(eng.state().speed).toBe(2);
    eng.play();
    expect(timers[0]!.ms).toBe(d2);
    eng.setSpeed(1); // reschedules at the new pace
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(d1);
  });

  it('restart goes back to the empty stage and stops playing', () => {
    const { eng, timers, events } = rig();
    eng.next(); eng.next(); eng.play(); eng.restart();
    expect(eng.state()).toMatchObject({ shown: 0, playing: false, active: -1 });
    expect(timers).toHaveLength(0);
    expect(events.at(-1)).toBe('restart');
  });

  it('reduced motion: steps still work, without animation and with instant scroll', () => {
    const r = rig(undefined, true);
    r.eng.next();
    expect(r.eng.state()).toMatchObject({ shown: 1, animate: false, scroll: 'auto' });
    expect(rig().eng.state()).toMatchObject({ animate: true, scroll: 'smooth' });
  });

  it('the browser copy is the same engine source, with the __name shim', () => {
    const js = stageScript();
    expect(js).toContain(stageEngine.toString());
    expect(js).toContain('window.RaiseStage=');
  });
});

describe('/demo stage page', () => {
  it('renders every placeholder step once, hints, controls, no tabs', async () => {
    const t = await (await dget('/demo')).text();
    const steps = [...t.matchAll(/data-step="(\d+)"/g)].map((m) => Number(m[1]));
    expect(steps.sort((a, b) => a - b)).toEqual(STAGE_STEPS.map((_, i) => i));
    expect(t).toContain('Test message 1');
    expect(t).toContain('Step hint (test)');
    for (const a of ['next', 'back', 'play', 'restart']) expect(t).toContain(`data-act="${a}"`);
    for (const s of ['1', '1.5', '2']) expect(t).toContain(`data-speed="${s}"`);
    expect(t).toContain('↓ new');
    expect(t).toContain('window.RaiseStage=');
    expect(t).not.toContain('role="tab"');
    expect((t.match(/data-surface="/g) || []).length).toBe(3);
  });
});
