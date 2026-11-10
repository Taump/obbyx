// The base AA address obbyx uses (packages/obyte/src/channel/definition.ts) must be
// the address of channels_base_aa_1.2.oscript, and the legacy one that of v1.1.
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const parseOjson = require('ocore/formula/parse_ojson');
const objectHash = require('ocore/object_hash');

const src = fs.readFileSync(
  path.join(__dirname, '../../packages/obyte/src/channel/definition.ts'),
  'utf8',
);
const constant = src.match(/export const CHANNEL_BASE_AA = '([A-Z2-7]{32})'/)[1];
const legacy = src.match(/LEGACY_CHANNEL_BASE_AAS[^=]*= \[\s*'([A-Z2-7]{32})'/)[1];

const addressOf = (file) =>
  new Promise((resolve, reject) =>
    parseOjson.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), (err, def) =>
      err ? reject(new Error(err)) : resolve(objectHash.getChash160(def)),
    ),
  );

describe('base AA address used by obbyx', function () {
  it('CHANNEL_BASE_AA is the address of channels_base_aa_1.2.oscript', async () => {
    expect(await addressOf('channels_base_aa_1.2.oscript')).to.equal(constant);
  });
  it('the legacy base AA is the deployed v1.1, not the 1.1 oscript rewrite', () => {
    expect(legacy).to.equal('4IRUGAUUCAQ6QRQLG4SNOLOE6VW2STWZ');
  });
});
