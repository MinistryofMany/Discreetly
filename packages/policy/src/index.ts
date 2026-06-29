// `@discreetly/policy` is now a thin re-export of the shared `@minister/policy`
// package (a verbatim lift of this package's former source). Consumers keep
// importing `@discreetly/policy`; the single implementation lives in
// `@minister/policy`. Remove this shim once consumers are repointed at
// `@minister/policy` directly.
export * from '@minister/policy';
