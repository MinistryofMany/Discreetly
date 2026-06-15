import { beforeEach, describe, expect, it } from 'vitest';
import { currentEpoch, nextMessageId } from './rln';

beforeEach(() => {
  localStorage.clear();
});

describe('currentEpoch', () => {
  it('floors now / rateLimitMs', () => {
    expect(currentEpoch(1000, 5500)).toBe(5n);
    expect(currentEpoch(1000, 5999)).toBe(5n);
    expect(currentEpoch(1000, 6000)).toBe(6n);
  });

  it('rejects a non-positive rate limit', () => {
    expect(() => currentEpoch(0)).toThrow(/Invalid rateLimitMs/);
    expect(() => currentEpoch(-1)).toThrow(/Invalid rateLimitMs/);
  });
});

describe('nextMessageId', () => {
  const ROOM = 'room_1';

  it('hands out 0-based ids up to the limit, then throws', () => {
    expect(nextMessageId(ROOM, 7n, 3n)).toBe(0n);
    expect(nextMessageId(ROOM, 7n, 3n)).toBe(1n);
    expect(nextMessageId(ROOM, 7n, 3n)).toBe(2n);
    expect(() => nextMessageId(ROOM, 7n, 3n)).toThrow(/Rate limit reached/);
  });

  it('resets the counter when the epoch rolls over', () => {
    expect(nextMessageId(ROOM, 7n, 2n)).toBe(0n);
    expect(nextMessageId(ROOM, 7n, 2n)).toBe(1n);
    expect(() => nextMessageId(ROOM, 7n, 2n)).toThrow(/Rate limit reached/);
    // New epoch -> fresh counter.
    expect(nextMessageId(ROOM, 8n, 2n)).toBe(0n);
  });

  it('tracks counters per room independently', () => {
    expect(nextMessageId('a', 1n, 5n)).toBe(0n);
    expect(nextMessageId('b', 1n, 5n)).toBe(0n);
    expect(nextMessageId('a', 1n, 5n)).toBe(1n);
  });

  it('a limit of 0 throws immediately', () => {
    expect(() => nextMessageId(ROOM, 1n, 0n)).toThrow(/Rate limit reached/);
  });

  it('recovers from a corrupt counter value', () => {
    localStorage.setItem('discreetly.msgcounter.v1.room_1', 'not json');
    expect(nextMessageId(ROOM, 1n, 5n)).toBe(0n);
  });
});
