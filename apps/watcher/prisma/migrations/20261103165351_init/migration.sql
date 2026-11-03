-- CreateTable
CREATE TABLE "vouchers" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "network" TEXT NOT NULL,
    "aa" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "amount_spent" TEXT NOT NULL,
    "payment_amount" TEXT NOT NULL,
    "binding" TEXT NOT NULL,
    "package_json" TEXT NOT NULL,
    "received_at" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "channels" (
    "aa" TEXT NOT NULL PRIMARY KEY,
    "network" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "timeout" INTEGER NOT NULL,
    "first_seen" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "actions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "aa" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "unit" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "instance" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pid" INTEGER NOT NULL,
    "started_at" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "vouchers_aa_period_idx" ON "vouchers"("aa", "period");

-- CreateIndex
CREATE UNIQUE INDEX "actions_aa_period_kind_key" ON "actions"("aa", "period", "kind");
