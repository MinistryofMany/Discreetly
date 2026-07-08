/*
  Warnings:

  - You are about to drop the `AdminUser` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "authorToken" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "senderMembershipId" TEXT;

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "AdminUser";

-- CreateIndex
CREATE UNIQUE INDEX "Membership_authorToken_key" ON "Membership"("authorToken");

-- CreateIndex
CREATE INDEX "Message_senderMembershipId_idx" ON "Message"("senderMembershipId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderMembershipId_fkey" FOREIGN KEY ("senderMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;
