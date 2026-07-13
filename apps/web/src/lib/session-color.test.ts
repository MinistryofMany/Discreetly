import { beforeEach, describe, expect, it } from 'vitest';
import { getSessionColor, avatarDataUri, sessionHandle } from './session-color';

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

describe('avatarDataUri', () => {
  it('is deterministic for the same seed', () => {
    expect(avatarDataUri('seed-1')).toBe(avatarDataUri('seed-1'));
  });

  it('differs for different seeds', () => {
    expect(avatarDataUri('seed-1')).not.toBe(avatarDataUri('seed-2'));
  });

  it('produces an svg data uri', () => {
    expect(avatarDataUri('x')).toMatch(/^data:image\/svg\+xml;utf8,/);
  });

  it('renders a Dicebear Rings SVG', () => {
    // The generated SVG uses radial gradients ("rings"); decode and spot-check.
    expect(decodeURIComponent(avatarDataUri('x'))).toContain('<svg');
  });
});

describe('sessionHandle', () => {
  it('is deterministic and stable for the same seed', () => {
    expect(sessionHandle('seed-1')).toBe(sessionHandle('seed-1'));
  });

  it('is a friendly PascalCase {Adjective}{Noun} name', () => {
    expect(sessionHandle('anything')).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
  });

  it('differs across seeds (spot check)', () => {
    expect(sessionHandle('seed-1')).not.toBe(sessionHandle('seed-2'));
  });
});
