/**
 * Pure helpers for the admin RoomDialog form. Kept out of `page.tsx` because
 * Next's App Router restricts what a `page.tsx` file may export.
 */

/**
 * Derive a URL-safe slug from a room name: lowercase, non-alphanumeric runs
 * collapse to single hyphens, and leading/trailing hyphens are trimmed. Keeps
 * only `[a-z0-9-]`. The slug field is derived from the name, never typed.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Compute the `name`/`slug` pair after a Name field edit. Creating a room
 * re-derives the slug from the name on every keystroke. Editing an existing
 * room never touches its already-assigned slug - a plain display-name rename
 * must not silently reassign the uniqueness-enforced room identifier.
 */
export function nameChangeUpdate(
  prevSlug: string,
  nextName: string,
  isEditing: boolean,
): { name: string; slug: string } {
  return {
    name: nextName,
    slug: isEditing ? prevSlug : slugify(nextName),
  };
}
