-- CreateTable
CREATE TABLE "exact_settlements" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "network" TEXT NOT NULL,
    "unit_hash" TEXT NOT NULL,
    "binding" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "pay_to" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "unit_json" TEXT,
    "publish_deadline" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT,
    "data" TEXT
);

-- CreateTable
CREATE TABLE "batch_channels" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "network" TEXT NOT NULL,
    "aa" TEXT NOT NULL,
    "pay_to" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "committed" TEXT NOT NULL,
    "pending_seq" INTEGER,
    "updated_at" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "batch_commitments" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel_key" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "aa" TEXT NOT NULL,
    "pay_to" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "amount_spent" TEXT NOT NULL,
    "payment_amount" TEXT NOT NULL,
    "binding" TEXT NOT NULL,
    "package_hash" TEXT NOT NULL,
    "package_json" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL,
    "committed_at" INTEGER
);

-- CreateTable
CREATE TABLE "instance" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pid" INTEGER NOT NULL,
    "started_at" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "exact_settlements_state_idx" ON "exact_settlements"("state");

-- CreateIndex
CREATE INDEX "events_key_idx" ON "events"("key");

-- CreateIndex
CREATE UNIQUE INDEX "batch_commitments_package_hash_key" ON "batch_commitments"("package_hash");

-- CreateIndex
CREATE INDEX "batch_commitments_pay_to_seq_idx" ON "batch_commitments"("pay_to", "seq");
