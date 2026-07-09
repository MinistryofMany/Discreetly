import { describe, expect, it } from 'vitest';
import { nameChangeUpdate, slugify } from './admin-room-form';

// ---- slugify -------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and hyphenates a name', () => {
    expect(slugify('My Cool Room')).toBe('my-cool-room');
  });

  it('trims leading/trailing hyphens from punctuation runs', () => {
    expect(slugify('  --Room #1!!--  ')).toBe('room-1');
  });
});

// ---- nameChangeUpdate -----------------------------------------------------
//
// Regression coverage for the create/edit slug bug: RoomDialog's Name field
// must only re-derive the slug while creating a room. Editing an existing
// room's name must never touch its already-assigned (uniqueness-enforced)
// slug.

describe('nameChangeUpdate', () => {
  it('derives the slug from the name when creating', () => {
    const result = nameChangeUpdate('', 'My Cool Room', false);
    expect(result).toEqual({ name: 'My Cool Room', slug: 'my-cool-room' });
  });

  it('keeps the existing slug stable when editing, even on a full rename', () => {
    const result = nameChangeUpdate('original-slug', 'Totally Different Name', true);
    expect(result).toEqual({ name: 'Totally Different Name', slug: 'original-slug' });
  });

  it('does not derive a slug from an empty name while editing', () => {
    const result = nameChangeUpdate('original-slug', '', true);
    expect(result).toEqual({ name: '', slug: 'original-slug' });
  });
});
