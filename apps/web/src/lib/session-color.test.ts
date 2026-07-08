import { beforeEach, describe, expect, it } from 'vitest';
import { getSessionColor, identiconDataUri, sessionHandle } from './session-color';

beforeEach(() => {
  sessionStorage.clear();
});

describe('getSessionColor', () => {
  it('returns a hex color', () => {
    expect(getSessionColor()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is stable across calls within a session', () => {
    const a = getSessionColor();
    const b = getSessionColor();
    expect(a).toBe(b);
  });

  it('regenerates after the session store is cleared', () => {
    const a = getSessionColor();
    sessionStorage.clear();
    // It is astronomically unlikely (but not impossible) to collide; assert it
    // is at least a valid color and persisted fresh.
    const b = getSessionColor();
    expect(b).toMatch(/^#[0-9a-f]{6}$/);
    expect(sessionStorage.getItem('discreetly.sessionColor.v1')).toBe(b);
    void a;
  });
});

describe('identiconDataUri', () => {
  it('is deterministic for the same seed', () => {
    expect(identiconDataUri('seed-1')).toBe(identiconDataUri('seed-1'));
  });

  it('differs for different seeds', () => {
    expect(identiconDataUri('seed-1')).not.toBe(identiconDataUri('seed-2'));
  });

  it('produces an svg data uri', () => {
    expect(identiconDataUri('x')).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it('honors an explicit foreground color', () => {
    const uri = identiconDataUri('x', '#ff0000');
    expect(decodeURIComponent(uri)).toContain('#ff0000');
  });
});

describe('sessionHandle', () => {
  it('is deterministic and stable for the same seed', () => {
    expect(sessionHandle('seed-1')).toBe(sessionHandle('seed-1'));
  });

  it('has the anon-xxxx shape (4 hex chars)', () => {
    expect(sessionHandle('anything')).toMatch(/^anon-[0-9a-f]{4}$/);
  });

  it('differs across seeds (spot check)', () => {
    expect(sessionHandle('seed-1')).not.toBe(sessionHandle('seed-2'));
  });
});
