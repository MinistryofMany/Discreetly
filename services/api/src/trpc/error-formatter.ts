import { ZodError } from 'zod';
import type { TRPCError } from '@trpc/server';
import type { DefaultErrorShape } from '@trpc/server/unstable-core-do-not-import';
import { logger } from '../log.js';

export interface FormatErrorArgs {
  shape: DefaultErrorShape;
  error: TRPCError;
}

/**
 * tRPC error formatter. Keeps the tRPC `code` and zod `flattened` errors. In
 * production, internal-error messages and stacks are replaced with a generic
 * string so server internals never reach the client. The full error is always
 * logged server-side (pino redacts known secret paths).
 */
export function formatTrpcError(
  { shape, error }: FormatErrorArgs,
  isProduction = process.env.NODE_ENV === 'production',
): DefaultErrorShape {
  logger.error({ code: error.code, err: error.cause ?? error, path: shape.data.path }, 'trpc error');

  const zodError = error.cause instanceof ZodError ? error.cause.flatten() : null;
  const data = { ...shape.data, zodError };

  if (isProduction && error.code === 'INTERNAL_SERVER_ERROR') {
    return {
      ...shape,
      message: 'Internal server error',
      data: { ...data, stack: undefined },
    };
  }

  return { ...shape, data };
}
