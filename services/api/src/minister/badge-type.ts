const MINISTER_CRED = /^Minister(.+)Credential$/;

/** Map a VC `type` array to the policy badge-type string, or null if unrecognized. */
export function credentialTypeToBadgeType(vcTypes: readonly string[]): string | null {
  const specific = vcTypes.find((t) => t !== 'VerifiableCredential');
  if (!specific) return null;
  const m = MINISTER_CRED.exec(specific);
  if (!m) return null;
  const g = m[1];
  if (!g) return null;
  // PascalCase/alphanumerics -> kebab: EmailDomain->email-domain, AgeOver21->age-over-21
  return g
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])([0-9])/g, '$1-$2')
    .toLowerCase();
}
