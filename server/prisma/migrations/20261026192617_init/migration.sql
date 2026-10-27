-- CreateEnum
CREATE TYPE "Role" AS ENUM ('HOST', 'MODERATOR', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "RequestType" AS ENUM ('PLAY', 'PAUSE', 'SEEK', 'CHANGE_VIDEO');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'YouTube Watch Party',
    "currentVideoId" TEXT NOT NULL DEFAULT 'dQw4w9WgXcQ',
    "currentTimestamp" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isPlaying" BOOLEAN NOT NULL DEFAULT false,
    "playbackRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "lastSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'PARTICIPANT',
    "sessionToken" TEXT NOT NULL,
    "isConnected" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControlRequest" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "type" "RequestType" NOT NULL,
    "targetTimestamp" DOUBLE PRECISION,
    "targetVideoId" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ControlRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Room_code_key" ON "Room"("code");

-- CreateIndex
CREATE INDEX "Room_code_idx" ON "Room"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_sessionToken_key" ON "Participant"("sessionToken");

-- CreateIndex
CREATE INDEX "Participant_sessionToken_idx" ON "Participant"("sessionToken");

-- CreateIndex
CREATE INDEX "Participant_roomId_idx" ON "Participant"("roomId");

-- CreateIndex
CREATE INDEX "Participant_roomId_role_idx" ON "Participant"("roomId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_roomId_sessionToken_key" ON "Participant"("roomId", "sessionToken");

-- CreateIndex
CREATE INDEX "ControlRequest_roomId_status_idx" ON "ControlRequest"("roomId", "status");

-- CreateIndex
CREATE INDEX "ControlRequest_participantId_idx" ON "ControlRequest"("participantId");

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlRequest" ADD CONSTRAINT "ControlRequest_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlRequest" ADD CONSTRAINT "ControlRequest_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
