import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import obyte from 'obyte';
import { OBYTE_NETWORKS, channelAddress } from '@obbyx/obyte';
import { canonical } from '@obbyx/x402-obyte';
import { describe, expect, it } from 'vitest';
import { addressOf, testKey } from '../../../packages/obyte/test/helpers.js';
import { WatcherStore, openWatcherDatabase } from '../src/storage/store.js';

/*
 * The branch migration on a database created by the released init migration:
 * existing rows keep their data (amount_spent becomes an integer), the startup
 * pass checks them in chunks, and the hot lookups use an index.
 */

const MIGRATIONS = new URL('../prisma/migrations/', import.meta.url);
const sql = (name: string) => readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), 'utf8');
const NET = OBYTE_NETWORKS.testnet;
const clientKey = testKey('client');
const client = addressOf(clientKey);
const AA = channelAddress({
  addressA: addressOf(testKey('seller')),
  addressB: client,
  asset: 'base',
  salt: 'mig',
  timeout: 3600,
});
const pkg = (amount: number) =>
  canonical(
    obyte.utils.signMessage(
      { aa_address: AA, period: 1, amount_spent: amount, payment_amount: 100, binding: 'f0' },
      { privateKey: clientKey, testnet: true },
    ),
  );

describe('watcher migration from the init schema', () => {
  it('backfills existing rows, checks them in chunks, and indexes the lookups', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'obbyx-watcher-')), 'watcher.db');
    const raw = new DatabaseSync(file);
    raw.exec(sql('20261103165351_init'));
    const insert = raw.prepare(
      'INSERT INTO vouchers (seq, network, aa, period, amount_spent, payment_amount, binding, package_json, received_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
    );
    insert.run(1, NET.caip2, AA, '900', '100', 'f0', pkg(900), 10);
    insert.run(2, NET.caip2, AA, '1000', '100', 'f0', pkg(1000), 20);
    // more rows than one startup-pass chunk; they do not match their package
    for (let seq = 3; seq <= 1300; seq += 1)
      insert.run(seq, NET.caip2, AA, '5', '100', 'f0', pkg(900), 30);
    raw
      .prepare(
        'INSERT INTO channels (aa, network, payer, asset, timeout, first_seen) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(AA, NET.caip2, client, 'base', 3600, 1);
    raw
      .prepare(
        'INSERT INTO actions (aa, period, kind, unit, status, created_at, updated_at) VALUES (?, 0, ?, ?, ?, 1, 1)',
      )
      .run(AA, 'close', 'U', 'sent');
    raw.exec(sql('20261110120000_voucher_checks_and_client_closes'));

    expect(
      raw.prepare('SELECT seq, amount_spent, verified FROM vouchers WHERE seq <= 2').all(),
    ).toEqual([
      { seq: 1, amount_spent: 900, verified: null },
      { seq: 2, amount_spent: 1000, verified: null },
    ]);
    expect(raw.prepare('SELECT attempts, voucher_seq FROM actions').all()).toEqual([
      { attempts: 0, voucher_seq: null },
    ]);
    const plan = (q: string) =>
      raw
        .prepare(`EXPLAIN QUERY PLAN ${q}`)
        .all()
        .map((r) => String(r['detail']))
        .join('; ');
    expect(
      plan("SELECT seq FROM vouchers WHERE aa = 'x' AND period = 1 AND package_json = 'y' LIMIT 1"),
    ).toMatch(/USING (COVERING )?INDEX vouchers_aa_period_package_json_idx/);
    const best = plan(
      "SELECT * FROM vouchers WHERE aa = 'x' AND period = 1 AND verified = 1 ORDER BY amount_spent DESC LIMIT 1",
    );
    expect(best).toMatch(/USING INDEX vouchers_aa_period_amount_spent_idx/);
    expect(best).not.toMatch(/TEMP B-TREE/);
    raw.close();

    const store = new WatcherStore(await openWatcherDatabase(file));
    const invalid = await store.verifyStoredVouchers();
    expect(invalid).toHaveLength(1298);
    expect(await store.verifyStoredVouchers()).toEqual([]);
    const top = await store.best(AA, 1);
    expect(top).toMatchObject({ seq: 2, amountSpent: 1000n, firstReceivedAt: 10 });
    await store.close();
  });
});
