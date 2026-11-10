// Who receives a fraud proof payout: base channel AA 1.1 (deployed as
// 4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ) vs 1.2.
//
// In 1.1 the `fraud_proof` case pays everything to trigger.address and does not
// check the sender, so the client can close declaring less than it signed and then
// "prove" its own fraud (from a second address or even from its own address) to get
// the whole balance back before the seller's watcher reacts. 1.2 pays the party that
// did not initiate the close, whoever submits the proof.

const path = require('path');
const { expect } = require('chai');
const { Testkit, Utils } = require('aa-testkit');
const { Network } = Testkit();

const CLOSE_TIMEOUT = 2000; // seconds
const DEPOSIT = 1e9;

for (const version of ['1.1', '1.2']) {
  const fixed = version === '1.2';

  const tag = fixed ? 'FIX v1.2' : 'ATTACK v1.1';

  describe(`fraud proof payout, base channel AA ${version} (${fixed ? 'fixed: the wronged party is paid' : 'vulnerable: the submitter is paid'})`, function () {
    this.timeout(600 * 1000);

    before(async () => {
      this.network = await Network.create()
        .with.agent({ base_aa: path.join(__dirname, `../channels_base_aa_${version}.oscript`) })
        .with.wallet({ seller: 1e9 }) // party A
        .with.wallet({ client: 10e9 }) // party B
        .with.wallet({ clientAlt: 1e9 }) // a second address of the same client
        .with.wallet({ stranger: 1e9 }) // unrelated third party
        .run();
      for (const name of ['seller', 'client', 'clientAlt', 'stranger'])
        this[name] = await this.network.wallet[name].getAddress();

      const { address, unit, error } = await this.network.deployer.deployAgent({
        base_aa: this.network.agent.base_aa,
        params: {
          addressA: this.seller,
          addressB: this.client,
          asset: 'base',
          salt: `fraud-${version}`,
          timeout: CLOSE_TIMEOUT,
        },
      });
      expect(error).to.be.null;
      this.aa = address;
      await this.network.witnessUntilStable(unit);
    });

    const vars = async () => (await this.network.deployer.readAAStateVars(this.aa)).vars;

    const call = async (wallet, data) => {
      const { unit, error } = await this.network.wallet[wallet].triggerAaWithData({
        toAddress: this.aa,
        amount: 10000,
        data,
      });
      expect(error).to.be.null;
      return (await this.network.getAaResponseToUnit(unit)).response;
    };

    const payouts = async (response) => {
      const { unitObj } = await this.network.deployer.getUnitInfo({ unit: response.response_unit });
      return Utils.getExternalPayments(unitObj);
    };

    /** Deposits, signs a voucher for `spent`, and starts a client close declaring `declared`. */
    const dishonestClose = async (spent, declared) => {
      const { unit } = await this.network.wallet.client.sendBytes({
        toAddress: this.aa,
        amount: DEPOSIT,
      });
      expect((await this.network.getAaResponseToUnit(unit)).response.bounced).to.be.false;
      const { period } = await vars();
      const { signedPackage } = await this.network.wallet.client.signMessage(
        { aa_address: this.aa, period, amount_spent: spent },
        this.client,
      );
      const close = await call('client', { close: 1, period, transferredFromMe: declared });
      expect(close.bounced, errMsg(close.response.error)).to.be.false;
      return signedPackage;
    };

    const expectAllTo = (paid, winner, loser) => {
      expect(paid.find((p) => p.address === winner)?.amount).to.be.above(DEPOSIT - 20000);
      expect(paid.find((p) => p.address === loser)).to.be.undefined;
    };

    it(`[${tag}] a stranger with a leaked client voucher ${fixed ? 'proves the fraud, but the seller gets the balance' : 'takes the whole balance'}`, async () => {
      const voucher = await dishonestClose(500000, 50000);
      const proof = await call('stranger', { fraud_proof: 1, sentByPeer: voucher });
      expect(proof.bounced, errMsg(proof.response.error)).to.be.false;
      const paid = await payouts(proof);
      if (fixed) expectAllTo(paid, this.seller, this.stranger);
      else expectAllTo(paid, this.stranger, this.seller);
    });

    it(`[${tag}] the client closes declaring 0 and "proves" its own lie from a second address: ${fixed ? 'the seller gets the balance' : 'the client gets everything back, the watcher proof bounces'}`, async () => {
      const voucher = await dishonestClose(800000, 0);
      const proof = await call('clientAlt', { fraud_proof: 1, sentByPeer: voucher });
      expect(proof.bounced, errMsg(proof.response.error)).to.be.false;
      const paid = await payouts(proof);
      if (fixed) expectAllTo(paid, this.seller, this.clientAlt);
      else expectAllTo(paid, this.clientAlt, this.seller);
      // The seller's watcher comes second: the channel is already closed.
      const late = await call('seller', { fraud_proof: 1, sentByPeer: voucher });
      expect(late.bounced).to.be.true;
    });

    it(`[${tag}] the client closes declaring 0 and "proves" its own lie from its own address: ${fixed ? 'the seller gets the balance' : 'the client gets everything back'}`, async () => {
      const voucher = await dishonestClose(700000, 0);
      const proof = await call('client', { fraud_proof: 1, sentByPeer: voucher });
      expect(proof.bounced, errMsg(proof.response.error)).to.be.false;
      const paid = await payouts(proof);
      if (fixed) expectAllTo(paid, this.seller, this.client);
      else expectAllTo(paid, this.client, this.seller);
    });

    it(`[both] the seller watcher proof pays the seller`, async () => {
      const voucher = await dishonestClose(300000, 1000);
      const proof = await call('seller', { fraud_proof: 1, sentByPeer: voucher });
      expect(proof.bounced, errMsg(proof.response.error)).to.be.false;
      expectAllTo(await payouts(proof), this.seller, this.client);
    });

    it(`[both] an honest seller close + confirm pays exactly amount_spent; a client voucher cannot be used against the seller`, async () => {
      const { unit } = await this.network.wallet.client.sendBytes({
        toAddress: this.aa,
        amount: DEPOSIT,
      });
      expect((await this.network.getAaResponseToUnit(unit)).response.bounced).to.be.false;
      const { period } = await vars();
      const { signedPackage } = await this.network.wallet.client.signMessage(
        { aa_address: this.aa, period, amount_spent: 200000 },
        this.client,
      );
      const close = await call('seller', {
        close: 1,
        period,
        transferredFromMe: 0,
        sentByPeer: signedPackage,
      });
      expect(close.bounced, errMsg(close.response.error)).to.be.false;
      // The seller never signs, so there is nothing to prove against it.
      const bogus = await call('stranger', { fraud_proof: 1, sentByPeer: signedPackage });
      expect(bogus.bounced).to.be.true;
      const confirm = await call('client', { confirm: 1, period });
      expect(confirm.bounced, errMsg(confirm.response.error)).to.be.false;
      const paid = await payouts(confirm);
      expect(paid.find((p) => p.address === this.seller)?.amount).to.equal(200000 + 10000);
    });

    after(async () => {
      await this.network.stop();
    });
  });
}
