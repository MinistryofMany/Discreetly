-- Phase 3 (Path B): per-room SDK disclosure flow state. The RP "start join"
-- route persists PKCE+state+nonce here and redirects to Minister; the callback
-- looks the row up by `state`, runs the token exchange, stores the fresh
-- per-room id_token back on the row, and redirects to the room with the row id
-- as a single-use pickup token. Short-lived, single-use, no durable badge data.

-- CreateTable
CREATE TABLE "RoomAuthFlow" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "roomId" TEXT NOT NULL,
    "idToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomAuthFlow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RoomAuthFlow_state_key" ON "RoomAuthFlow"("state");

-- CreateIndex
CREATE INDEX "RoomAuthFlow_expiresAt_idx" ON "RoomAuthFlow"("expiresAt");
