-- Phase 3 (Path B): the durable RP-side proven-badge store is removed. Per-room
-- disclosure now runs the SDK auth-code+PKCE flow and the gate evaluates the
-- room policy INLINE on the freshly-presented token alone; after admission
-- Semaphore membership carries access. There is no longer any durable badge
-- record on the relying party. This is a NEW forward migration that DROPs the
-- table created by 20260627033452_proven_badge (the shipped migration is left
-- untouched so deployed databases' migration history stays consistent).

-- DropTable
DROP TABLE "ProvenBadge";
