/*
  Warnings:

  - You are about to drop the column `deviceLabel` on the `MembershipLeaf` table. All the data in the column will be lost.
  - You are about to drop the column `maxDevices` on the `Room` table. All the data in the column will be lost.

  One-root-per-user identity: leaf replacement is now gated on the signed
  `minister_anon_epoch` strictly advancing (audit finding C1), tracked per
  membership via `anonEpoch`. `maxDevices` (a rate-limit multiplier in the clear)
  and per-device `deviceLabel` are removed - every device of a user derives the
  SAME per-room commitment, so there is one leaf per membership.

*/
-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "anonEpoch" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MembershipLeaf" DROP COLUMN "deviceLabel";

-- AlterTable
ALTER TABLE "Room" DROP COLUMN "maxDevices";
