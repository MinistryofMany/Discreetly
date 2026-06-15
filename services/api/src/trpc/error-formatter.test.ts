import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { ZodError, z } from 'zod';
import type { DefaultErrorShape } from '@trpc/server/unstable-core-do-not-import';
import { formatTrpcError } from './error-formatter.js';

function baseShape(overrides: Partial<DefaultErrorShape['data']> = {}): DefaultErrorShape {
  return {
    message: 'raw internal detail with secrets',
    code: -32603,
    data: {
      code: 'INTERNAL_SERVER_ERROR',
      httpStatus: 500,
      stack: 'Error: boom\n    at secret.ts:1:1',
      path: 'room.get',
      ...overrides,
    },
  } as DefaultErrorShape;
}

describe('formatTrpcError', () => {
  it('keeps the code and exposes zod flattened errors', () => {
    let zodErr: ZodError | undefined;
    try {
      z.object({ name: z.string() }).parse({ name: 123 });
    } catch (e) {
      zodErr = e as ZodError;
    }
    const error = new TRPCError({ code: 'BAD_REQUEST', cause: zodErr });
    const shape = baseShape({ code: 'BAD_REQUEST', httpStatus: 400, stack: undefined });
    const out = formatTrpcError({ shape, error }, false);
    expect(out.data.code).toBe('BAD_REQUEST');
    expect((out.data as unknown as { zodError: unknown }).zodError).toBeTruthy();
  });

  it('in production, masks INTERNAL_SERVER_ERROR message and stack', () => {
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: new Error('boom') });
    const out = formatTrpcError({ shape: baseShape(), error }, true);
    expect(out.message).toBe('Internal server error');
    expect(out.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect((out.data as { stack?: string }).stack).toBeUndefined();
  });

  it('in non-production, preserves the raw message and stack', () => {
    const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: new Error('boom') });
    const out = formatTrpcError({ shape: baseShape(), error }, false);
    expect(out.message).toBe('raw internal detail with secrets');
    expect((out.data as { stack?: string }).stack).toBeDefined();
  });

  it('in production, does not mask non-internal errors', () => {
    const error = new TRPCError({ code: 'FORBIDDEN', message: 'not an admin' });
    const shape = baseShape({ code: 'FORBIDDEN', httpStatus: 403 });
    shape.message = 'not an admin';
    const out = formatTrpcError({ shape, error }, true);
    expect(out.message).toBe('not an admin');
    expect(out.data.code).toBe('FORBIDDEN');
  });
});
