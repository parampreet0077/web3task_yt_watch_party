-- DropIndex
DROP INDEX "Participant_roomId_sessionToken_key";

-- DropIndex
DROP INDEX "Participant_sessionToken_idx";

-- DropIndex
DROP INDEX "Participant_sessionToken_key";

-- AlterTable
ALTER TABLE "Participant" DROP COLUMN "sessionToken",
ADD COLUMN     "tokenHash" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Participant_tokenHash_key" ON "Participant"("tokenHash");

-- CreateIndex
CREATE INDEX "Participant_tokenHash_idx" ON "Participant"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_roomId_tokenHash_key" ON "Participant"("roomId", "tokenHash");
