-- CreateTable
CREATE TABLE "ProvenBadge" (
    "id" TEXT NOT NULL,
    "userKey" TEXT NOT NULL,
    "badgeType" TEXT NOT NULL,
    "firstProvenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvenBadge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProvenBadge_userKey_idx" ON "ProvenBadge"("userKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProvenBadge_userKey_badgeType_key" ON "ProvenBadge"("userKey", "badgeType");
