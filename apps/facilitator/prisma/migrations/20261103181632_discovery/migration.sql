-- CreateTable
CREATE TABLE "discovery_resources" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "resource" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "method" TEXT,
    "x402_version" INTEGER NOT NULL,
    "scheme" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "pay_to" TEXT NOT NULL,
    "accepts_json" TEXT NOT NULL,
    "extensions" TEXT,
    "description" TEXT,
    "mime_type" TEXT,
    "service_name" TEXT,
    "tags" TEXT,
    "last_updated" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "discovery_resources_network_scheme_idx" ON "discovery_resources"("network", "scheme");
