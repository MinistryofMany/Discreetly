// `@discreetly/policy` is now a thin re-export of the shared `@ministryofmany/policy`
// package (a verbatim lift of this package's former source). Consumers keep
// importing `@discreetly/policy`; the single implementation lives in
// `@ministryofmany/policy`. Remove this shim once consumers are repointed at
// `@ministryofmany/policy` directly.
export * from '@ministryofmany/policy';
