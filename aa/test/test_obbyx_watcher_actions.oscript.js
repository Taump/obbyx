// Executable check of the exact AA triggers sent by the obbyx seller watcher
// (apps/watcher/src/defender.ts) and the buyer CLI (packages/x402-obyte/src/batch/client.ts)
// against the real base channel AA in a local aa-testkit network.
//
//   watcher close:       {close: 1, period, transferredFromMe: 0, sentByPeer: <best voucher>}
//   watcher confirm:     {confirm: 1, period}
//   watcher fraud_proof: {fraud_proof: 1, sentByPeer: <best voucher>}
//   client close (CLI):  {close: 1, period, transferredFromMe: <spent>}
//   each trigger pays 10000 bytes (bounce fee) to the AA.

const path = require('path');
const { expect } = require('chai');
const { Testkit, Utils } = require('aa-testkit');
const { Network } = Testkit();

const TIMEOUT = 3600;
const DEPOSIT = 1e9;
const binding = (n) => String(n).padStart(64, '0');

describe('obbyx watcher/CLI triggers against the real channel AA', function () {
  this.timeout(600 * 1000);

  before(async () => {
    this.network = await Network.create()
      .with.agent({ base_aa: path.join(__dirname, '../channels_base_aa_1.2.oscript') })
      .with.wallet({ seller: 1e9 })
      .with.wallet({ client: 10e9 })
      .run();
    this.seller = await this.network.wallet.seller.getAddress();
    this.client = await this.network.wallet.client.getAddress();
    const { address, unit, error } = await this.network.deployer.deployAgent({
      base_aa: this.network.agent.base_aa,
      params: {
        addressA: this.seller,
        addressB: this.client,
        asset: 'base',
        salt: 'obbyx-watcher',
        timeout: TIMEOUT,
      },
    });
    expect(error).to.be.null;
    this.aa = address;
    await this.network.witnessUntilStable(unit);
  });

  after(async () => this.network.stop());

  const vars = () => this.network.deployer.readAAStateVars(this.aa).then((r) => r.vars);

  const trigger = async (wallet, data) => {
    const { unit, error } = await wallet.triggerAaWithData({
      toAddress: this.aa,
      amount: 10000,
      data,
    });
    expect(error).to.be.null;
    const { response } = await this.network.getAaResponseToUnit(unit);
    return response;
  };

  const depositAndVoucher = async (amountSpent) => {
    const { unit } = await this.network.wallet.client.sendBytes({
      toAddress: this.aa,
      amount: DEPOSIT,
    });
    expect((await this.network.getAaResponseToUnit(unit)).response.bounced).to.be.false;
    const period = (await vars()).period;
    const { signedPackage } = await this.network.wallet.client.signMessage(
      {
        aa_address: this.aa,
        period,
        amount_spent: amountSpent,
        payment_amount: 100,
        binding: binding(amountSpent),
      },
      this.client,
    );
    return { period, pkg: signedPackage };
  };

  const payoutTo = async (response, address) => {
    const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit });
    return Utils.getExternalPayments(unitObj).find((p) => p.address === address);
  };

  it('A. watcher close with the best voucher, confirm after the dispute window → seller paid amount_spent', async () => {
    const { period, pkg } = await depositAndVoucher(300000);
    const closing = await trigger(this.network.wallet.seller, {
      close: 1,
      period,
      transferredFromMe: 0,
      sentByPeer: pkg,
    });
    expect(closing.bounced, errMsg(closing.response.error)).to.be.false;
    expect((await vars()).close_initiated_by).to.equal('A');

    const early = await trigger(this.network.wallet.seller, { confirm: 1, period });
    expect(early.bounced, 'initiator cannot confirm before the window').to.be.true;

    await this.network.timetravel({ shift: `${TIMEOUT + 1}s` });
    const confirmed = await trigger(this.network.wallet.seller, { confirm: 1, period });
    expect(confirmed.bounced, errMsg(confirmed.response.error)).to.be.false;
    expect((await payoutTo(confirmed, this.seller)).amount).to.equal(300000 + 10000);
    expect((await vars()).period).to.equal(period + 1);
  });

  it('B. honest client close (CLI) → watcher confirms at once → seller paid amount_spent', async () => {
    const { period } = await depositAndVoucher(200000);
    const closing = await trigger(this.network.wallet.client, {
      close: 1,
      period,
      transferredFromMe: 200000,
    });
    expect(closing.bounced, errMsg(closing.response.error)).to.be.false;
    expect((await vars()).spentByB).to.equal(200000);

    const confirmed = await trigger(this.network.wallet.seller, { confirm: 1, period });
    expect(confirmed.bounced, errMsg(confirmed.response.error)).to.be.false;
    expect((await payoutTo(confirmed, this.seller)).amount).to.equal(200000 + 10000);
  });

  it('C. client declares less than it signed → watcher fraud_proof → seller takes the whole balance', async () => {
    const { period, pkg } = await depositAndVoucher(500000);
    const before = await vars();
    const closing = await trigger(this.network.wallet.client, {
      close: 1,
      period,
      transferredFromMe: 100,
    });
    expect(closing.bounced, errMsg(closing.response.error)).to.be.false;

    const proof = await trigger(this.network.wallet.seller, { fraud_proof: 1, sentByPeer: pkg });
    expect(proof.bounced, errMsg(proof.response.error)).to.be.false;
    const paid = await payoutTo(proof, this.seller);
    expect(paid.amount).to.be.above(before.balanceB - 20000);
    expect((await vars()).period).to.equal(period + 1);
  });
});
