import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL ?? 'info';

/**
 * Paths whose values are scrubbed from any logged object. Covers auth tokens,
 * secrets, and OAuth/PKCE material. Wildcard (`*.idToken`) catches nested
 * occurrences one level deep. NEVER log raw tokens, secrets, or message
 * plaintext - redaction is a backstop, not a license.
 */
const redactPaths = [
  'idToken',
  'id_token',
  'authorization',
  'req.headers.authorization',
  'headers.authorization',
  'password',
  'passwordHash',
  'secret',
  'shamirSecret',
  'code_verifier',
  '*.idToken',
  '*.id_token',
  '*.secret',
];

/** Structured application logger. Pretty in dev, JSON in production. */
export const logger = pino({
  level,
  redact: { paths: redactPaths, censor: '[redacted]' },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }),
});
