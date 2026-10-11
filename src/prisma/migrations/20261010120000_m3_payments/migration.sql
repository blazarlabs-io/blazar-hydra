-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "firebaseUid" TEXT,
    "apiKeyHash" TEXT
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchantAddress" TEXT NOT NULL,
    "assetUnit" TEXT NOT NULL,
    "amountBaseUnits" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'created',
    "expiresAt" DATETIME NOT NULL,
    "payerAddress" TEXT,
    "fundsInRef" TEXT,
    "hydraTxId" TEXT,
    "snapshotNumber" INTEGER,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_firebaseUid_key" ON "Account"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "Account_apiKeyHash_key" ON "Account"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_hydraTxId_key" ON "Payment"("hydraTxId");

-- CreateIndex
CREATE INDEX "Payment_merchantAddress_state_idx" ON "Payment"("merchantAddress", "state");

