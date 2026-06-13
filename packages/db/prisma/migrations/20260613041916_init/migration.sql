-- CreateEnum
CREATE TYPE "RoomVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "RoomPersistence" AS ENUM ('PERSISTENT', 'EPHEMERAL');

-- CreateEnum
CREATE TYPE "RoomEncryption" AS ENUM ('PLAINTEXT', 'AES');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'BANNED');

-- CreateEnum
CREATE TYPE "BanReason" AS ENUM ('RATE_LIMIT_COLLISION', 'ADMIN');

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "rlnIdentifier" TEXT NOT NULL,
    "rateLimit" INTEGER NOT NULL,
    "userMessageLimit" INTEGER NOT NULL,
    "maxDevices" INTEGER NOT NULL DEFAULT 5,
    "visibility" "RoomVisibility" NOT NULL DEFAULT 'PUBLIC',
    "persistence" "RoomPersistence" NOT NULL DEFAULT 'PERSISTENT',
    "encryption" "RoomEncryption" NOT NULL DEFAULT 'PLAINTEXT',
    "passwordHash" TEXT,
    "accessPolicy" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "joinNullifier" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipLeaf" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "identityCommitment" TEXT NOT NULL,
    "rateCommitment" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MembershipLeaf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ban" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "joinNullifier" TEXT,
    "rateCommitment" TEXT,
    "reason" "BanReason" NOT NULL,
    "shamirSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ban_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL,
    "rlnNullifier" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "proof" JSONB NOT NULL,
    "sessionColor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "pairwiseSub" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Room_slug_key" ON "Room"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Room_rlnIdentifier_key" ON "Room"("rlnIdentifier");

-- CreateIndex
CREATE INDEX "Membership_roomId_status_idx" ON "Membership"("roomId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_roomId_joinNullifier_key" ON "Membership"("roomId", "joinNullifier");

-- CreateIndex
CREATE INDEX "MembershipLeaf_membershipId_idx" ON "MembershipLeaf"("membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipLeaf_roomId_rateCommitment_key" ON "MembershipLeaf"("roomId", "rateCommitment");

-- CreateIndex
CREATE INDEX "Ban_roomId_joinNullifier_idx" ON "Ban"("roomId", "joinNullifier");

-- CreateIndex
CREATE INDEX "Message_roomId_epoch_idx" ON "Message"("roomId", "epoch");

-- CreateIndex
CREATE UNIQUE INDEX "Message_roomId_epoch_rlnNullifier_key" ON "Message"("roomId", "epoch", "rlnNullifier");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_pairwiseSub_key" ON "AdminUser"("pairwiseSub");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipLeaf" ADD CONSTRAINT "MembershipLeaf_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipLeaf" ADD CONSTRAINT "MembershipLeaf_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ban" ADD CONSTRAINT "Ban_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;
