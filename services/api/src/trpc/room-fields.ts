// Non-secret room fields. Excludes `passwordHash` (AES-room secret) — never disclosed.
export const PUBLIC_ROOM_FIELDS = {
  id: true,
  name: true,
  slug: true,
  description: true,
  rlnIdentifier: true,
  rateLimit: true,
  userMessageLimit: true,
  maxDevices: true,
  visibility: true,
  persistence: true,
  encryption: true,
  accessPolicy: true,
  pinned: true,
  createdAt: true,
  updatedAt: true,
} as const;
