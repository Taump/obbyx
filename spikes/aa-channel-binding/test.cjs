/* eslint-disable */
// Phase-0 executable check (docs/adr/0003, docs/adr/0001).
//
// Runs the deployed base channel AA (channels_base_aa_1.1.ojson, identical to
// 4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ on mainnet/testnet) in a local aa-testkit
// network and checks two assumptions of the obbyx design:
//
//  1. A client-signed package may carry extra fields (`binding`,
//     `payment_amount`) and still be accepted by the AA as `sentByPeer`
//     when the seller (party A) closes the channel; payouts follow
//     `amount_spent` (unidirectional channel: only B deposits and pays).
//  2. Trust-model risk (ADR-0001): while a close initiated by the client is
//     pending, ANY third party holding a higher client-signed package can
//     submit a fraud proof and receives the whole channel balance.

const path = require('path');
const { expect } = require('chai');
const { Testkit, Utils } = require('aa-testkit');
const { Network } = Testkit();

const BINDING = 'a3f1c2d4e5b6978899aabbccddeeff00112233445566778899aabbccddeeff00';
const CLOSE_TIMEOUT = 2000; // seconds

async function trigger(wallet, aa, data, amount = 10000) {
  const { unit, error } = await wallet.triggerAaWithData({ toAddress: aa, amount, data });
  expect(error).to.be.null;
  const { response } = await this.network.getAaResponseToUnit(unit);
  return response;
}

function dataOf(unitObj) {
  return unitObj.messages.find((m) => m.app === 'data').payload;
}

describe('obbyx: base channel AA with extra fields in signed packages', function () {
  before(async () => {
    this.network = await Network.create()
      .with.agent({ base_aa: path.join(__dirname, 'channels_base_aa_1.1.ojson') })
      .with.wallet({ seller: 1e9 }) // party A (payTo)
      .with.wallet({ client: 10e9 }) // party B (payer)
      .with.wallet({ stranger: 1e9 }) // unrelated third party (e.g. a facilitator)
      .run();
    this.seller = await this.network.wallet.seller.getAddress();
    this.client = await this.network.wallet.client.getAddress();
    this.stranger = await this.network.wallet.stranger.getAddress();

    const { address, unit, error } = await this.network.deployer.deployAgent({
      base_aa: this.network.agent.base_aa,
      params: {
        addressA: this.seller,
        addressB: this.client,
        asset: 'base',
        salt: 'obbyx-spike',
        timeout: CLOSE_TIMEOUT,
      },
    });
    expect(error).to.be.null;
    this.aa = address;
    await this.network.witnessUntilStable(unit);
  });

  const call = (wallet, data, amount) => trigger.call(this, wallet, this.aa, data, amount);

  async function clientSigned(ctx, fields) {
    const { signedPackage } = await ctx.network.wallet.client.signMessage(fields, ctx.client);
    return signedPackage;
  }

  it('1. seller closes with a client package carrying `binding`; payouts follow amount_spent', async () => {
    const deposit = 1e9;
    const { unit } = await this.network.wallet.client.sendBytes({
      toAddress: this.aa,
      amount: deposit,
    });
    const opened = (await this.network.getAaResponseToUnit(unit)).response;
    expect(opened.bounced).to.be.false;

    const period = (await this.network.deployer.readAAStateVars(this.aa)).vars.period;
    const amountSpent = 300000;
    const pkg = await clientSigned(this, {
      aa_address: this.aa,
      period,
      amount_spent: amountSpent,
      payment_amount: 100000,
      binding: BINDING,
    });
    expect(pkg.signed_message.binding).to.equal(BINDING);

    const closing = await call(this.network.wallet.seller, {
      close: 1,
      period,
      transferredFromMe: 0,
      sentByPeer: pkg,
    });
    expect(closing.bounced, closing.response.error).to.be.false;
    const vars = (await this.network.deployer.readAAStateVars(this.aa)).vars;
    expect(vars.spentByB).to.equal(amountSpent);
    expect(vars.close_initiated_by).to.equal('A');

    // The non-initiator (client) may confirm at any time.
    const confirmed = await call(this.network.wallet.client, { confirm: 1, period });
    expect(confirmed.bounced, confirmed.response.error).to.be.false;
    const { unitObj } = await this.network.deployer.getUnitInfo({ unit: confirmed.response_unit });
    expect(dataOf(unitObj).closed).to.equal(1);
    const toSeller = Utils.getExternalPayments(unitObj).find((p) => p.address === this.seller);
    // The party with the smaller final balance gets exactly its balance plus a
    // refund of the 10000-byte bounce fee it paid for `close` (AA line 151);
    // the larger party receives the rest and pays the AA response fees.
    expect(toSeller.amount).to.equal(amountSpent + 10000);
  });

  it('1b. tampering with `binding` after signing is rejected by the AA', async () => {
    const { unit } = await this.network.wallet.client.sendBytes({
      toAddress: this.aa,
      amount: 1e9,
    });
    expect((await this.network.getAaResponseToUnit(unit)).response.bounced).to.be.false;
    const period = (await this.network.deployer.readAAStateVars(this.aa)).vars.period;

    const pkg = await clientSigned(this, {
      aa_address: this.aa,
      period,
      amount_spent: 200000,
      binding: BINDING,
    });
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.signed_message.binding = BINDING.replace('a3', 'ff');

    const res = await call(this.network.wallet.seller, {
      close: 1,
      period,
      transferredFromMe: 0,
      sentByPeer: tampered,
    });
    expect(res.bounced).to.be.true;
  });

  it('2. (ADR-0001 risk) a third party with a higher client package takes the whole balance during a client-initiated close', async () => {
    const period = (await this.network.deployer.readAAStateVars(this.aa)).vars.period;
    const before = (await this.network.deployer.readAAStateVars(this.aa)).vars;
    const total = before.balanceB + (before.balanceA || 0);

    // The client starts a dishonest close, declaring it spent less than it did.
    const dishonest = await call(this.network.wallet.client, {
      close: 1,
      period,
      transferredFromMe: 50000,
    });
    expect(dishonest.bounced, dishonest.response.error).to.be.false;

    // Someone who saw the real package (amount_spent 500000) submits a fraud proof.
    const realPkg = await clientSigned(this, {
      aa_address: this.aa,
      period,
      amount_spent: 500000,
      binding: BINDING,
    });
    const proof = await call(this.network.wallet.stranger, { fraud_proof: 1, sentByPeer: realPkg });
    expect(proof.bounced, proof.response.error).to.be.false;

    const { unitObj } = await this.network.deployer.getUnitInfo({ unit: proof.response_unit });
    const payments = Utils.getExternalPayments(unitObj);
    const toStranger = payments.find((p) => p.address === this.stranger);
    expect(toStranger, 'payout goes to trigger.address').to.exist;
    // Whole balance minus AA fees goes to the stranger, nothing to the seller.
    expect(toStranger.amount).to.be.above(total - 20000);
    expect(payments.find((p) => p.address === this.seller)).to.be.undefined;
  });

  after(async () => {
    await this.network.stop();
  });
});
