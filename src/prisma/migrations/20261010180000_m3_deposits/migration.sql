-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "assetUnit" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'created',
    "requestedBaseUnits" TEXT NOT NULL,
    "receivedBaseUnits" TEXT,
    "btcToAccount" TEXT NOT NULL,
    "btcValueSats" TEXT NOT NULL,
    "btcMemo" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "btcTxid" TEXT,
    "btcVout" INTEGER,
    "btcSentAt" DATETIME,
    "redeemTxHash" TEXT,
    "redeemIndex" INTEGER,
    "fundsUnit" TEXT,
    "fundsTxId" TEXT,
    "depositTxId" TEXT,
    "commitAttempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_depositTxId_key" ON "Deposit"("depositTxId");

-- CreateIndex
CREATE INDEX "Deposit_state_idx" ON "Deposit"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_btcTxid_btcVout_key" ON "Deposit"("btcTxid", "btcVout");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_redeemTxHash_redeemIndex_key" ON "Deposit"("redeemTxHash", "redeemIndex");
