/* eslint-disable chai-friendly/no-unused-expressions */
// avoid importing `expect` in every test
const chai = require('chai')
const expect = chai.expect
global.expect = expect

const { Utils } = require('aa-testkit')

chai.Assertion.addChainableMethod('validAddress', (address) => {
	new chai.Assertion(Utils.isValidAddress(address)).to.be.true
})

chai.Assertion.addChainableMethod('validUnit', (unit) => {
	new chai.Assertion(Utils.isValidBase64(unit)).to.be.true
})

chai.Assertion.addChainableMethod('validBase64', (b64) => {
	new chai.Assertion(Utils.isValidBase64(b64)).to.be.true
})

// Since ocore "v2 error handling for AA" (byteball/ocore e8d1f31706) the error of a bounced
// AA response is an object { message, formattedContext, codeLines, trace }; before that it was
// a plain string. Returns the error text in both cases.
global.errMsg = (err) => (err && typeof err === 'object' && err.message !== undefined) ? err.message : err
