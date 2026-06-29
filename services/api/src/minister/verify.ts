// Discreetly's Minister id_token + badge verifier now lives in the shared
// `@minister/minister-verify` package (a generalization of this file's former
// `makeVerifier`). The only app-coupling that was here - the direct pino logger
// import for rejected-badge observability - is now an injectable
// `onRejectedBadges(report)` callback wired up in `production-verifier.ts`.
//
// This re-export keeps every existing `../minister/verify.js` consumer (gate,
// trpc context, tests) unchanged. Remove this shim once consumers import
// `@minister/minister-verify` directly.
export {
  makeVerifier,
  type VerifiedIdentity,
  type VerifierDeps,
  type RejectedBadgesReport,
} from '@minister/minister-verify';
