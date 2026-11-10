-- Channels: client-initiated close in progress.
ALTER TABLE "channels" ADD COLUMN "client_close_period" INTEGER;

-- Actions: units broadcast per row, and the voucher a close / fraud proof carried.
ALTER TABLE "actions" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "actions" ADD COLUMN "voucher_seq" INTEGER;

-- Vouchers: amount_spent as an integer (≤ 1e15, ordered by SQL), indexes for
-- the best voucher and the duplicate lookup, and the AA-profile check
-- (verified NULL for existing rows: decided by the startup pass).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_vouchers" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "network" TEXT NOT NULL,
    "aa" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "amount_spent" BIGINT NOT NULL,
    "payment_amount" TEXT NOT NULL,
    "binding" TEXT NOT NULL,
    "package_json" TEXT NOT NULL,
    "received_at" INTEGER NOT NULL,
    "verified" BOOLEAN
);
INSERT INTO "new_vouchers" ("seq", "network", "aa", "period", "amount_spent", "payment_amount", "binding", "package_json", "received_at")
SELECT "seq", "network", "aa", "period", CAST("amount_spent" AS INTEGER), "payment_amount", "binding", "package_json", "received_at" FROM "vouchers";
DROP TABLE "vouchers";
ALTER TABLE "new_vouchers" RENAME TO "vouchers";
CREATE INDEX "vouchers_aa_period_amount_spent_idx" ON "vouchers"("aa", "period", "amount_spent");
CREATE INDEX "vouchers_aa_period_package_json_idx" ON "vouchers"("aa", "period", "package_json");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
