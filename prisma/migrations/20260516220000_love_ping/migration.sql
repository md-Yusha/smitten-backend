-- CreateTable
CREATE TABLE "LovePing" (
    "id" TEXT NOT NULL,
    "coupleId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LovePing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LovePing_coupleId_readAt_createdAt_idx" ON "LovePing"("coupleId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "LovePing" ADD CONSTRAINT "LovePing_coupleId_fkey" FOREIGN KEY ("coupleId") REFERENCES "Couple"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LovePing" ADD CONSTRAINT "LovePing_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
