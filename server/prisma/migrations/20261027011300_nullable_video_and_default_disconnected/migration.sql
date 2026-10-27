-- AlterTable
ALTER TABLE "Participant" ALTER COLUMN "isConnected" SET DEFAULT false;

-- AlterTable
ALTER TABLE "Room" ALTER COLUMN "currentVideoId" DROP NOT NULL,
ALTER COLUMN "currentVideoId" DROP DEFAULT;
