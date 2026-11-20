import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NatCash, NatCashError } from '../src/index.js';

// Vecteurs générés avec le SDK PHP php-natcash-sdk (repris du projet natcashify, MIT)
const vecteurs = JSON.parse(readFileSync(new URL('./fixtures/natcash-php-vectors.json', import.meta.url)));

const base = {
  privateKey: 'private-key-1',
  partnerCode: 'PARTNER1',
  functionCode: 'FUNC1',
  username: 'merchant',
  password: 's3cr3t',
  callbackUrl: 'https://shop.example/natcash/callback',
};

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const r = responses.shift();
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
}

test('signatures de paiement identiques au SDK PHP', () => {
  for (const { inputs, payload } of vecteurs.payments) {
    const nc = new NatCash({ ...base, enableFee: inputs.enableFee, language: inputs.language });
    const data = nc._paymentPayload(
      {
        orderNumber: inputs.orderNumber,
        amount: Number(inputs.amount),
        msisdn: inputs.msisdn ?? undefined,
        skipPhoneInput: inputs.skipPhoneInput,
      },
      { requestId: payload.requestId, timestamp: inputs.timestamp }
    );
    assert.deepEqual(data, payload, inputs.orderNumber);
  }
});

test('signatures de transaction identiques au SDK PHP', () => {
  const nc = new NatCash(base);
  for (const { inputs, payload } of vecteurs.transactions) {
    assert.deepEqual(nc._transactionPayload(inputs.orderNumber, payload.requestId), payload);
  }
});

test('verifyCallback accepte les bonnes signatures et refuse les mauvaises', () => {
  const nc = new NatCash(base);
  for (const c of vecteurs.callbacks) {
    assert.equal(nc.verifyCallback({ orderNumber: c.order_number, code: String(c.code), signature: c.signature }), true);
    assert.equal(nc.verifyCallback({ orderNumber: c.order_number, code: '1' === String(c.code) ? '-1' : '1', signature: c.signature }), false);
  }
  assert.equal(nc.verifyCallback({ orderNumber: 'X', code: 1, signature: 'abc' }), false);
  assert.equal(nc.verifyCallback({}), false);
});

test('createPayment renvoie le lien NatCash', async () => {
  const fetch = fakeFetch([{ status: 200, body: { status: 0, code: 'MSG_SUCCESS', message: 'ok', url: 'https://pay/abc', expiredAt: 600 } }]);
  const nc = new NatCash({ ...base, fetch });
  const p = await nc.createPayment({ amount: 500, orderId: 42 });
  assert.equal(p.redirectUrl, 'https://pay/abc');
  assert.equal(fetch.calls[0].url, 'https://testmerchantpay.natcom.com.ht/api/online-payment/credential');
  assert.equal(fetch.calls[0].body.orderNumber, '42');
  assert.match(fetch.calls[0].body.signature, /^[0-9a-f]{64}$/);
});

test('une erreur NatCash (status != 0) devient NatCashError', async () => {
  const nc = new NatCash({
    ...base,
    fetch: fakeFetch([{ status: 200, body: { status: 101, code: 'ERR_TRANSACTION_NOT_FOUND', message: 'Transaction not found' } }]),
  });
  await assert.rejects(nc.getPaymentByOrderId('X'), (err) => {
    assert.ok(err instanceof NatCashError);
    assert.equal(err.code, 'ERR_TRANSACTION_NOT_FOUND');
    return true;
  });
});

test('une erreur HTTP garde le code NatCash', async () => {
  const nc = new NatCash({
    ...base,
    fetch: fakeFetch([{ status: 403, body: { status: 403, code: 'ERR_PERMISSION_DENIED', message: 'Permission denied' } }]),
  });
  await assert.rejects(nc.createPayment({ amount: 10, orderId: 1 }), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.code, 'ERR_PERMISSION_DENIED');
    return true;
  });
});

test('verifyPayment : signature, succès et montant', async () => {
  const cb = vecteurs.callbacks[0]; // ORDER-001, code 1
  const transaction = {
    status: 200,
    body: { status: 0, code: 'MSG_SUCCESS', message: 'ok', data: { orderNumber: 'ORDER-001', transId: 'T9', amount: '3,162.00', toPhone: '50912345678', responseCode: 1 } },
  };
  const nc = new NatCash({ ...base, fetch: fakeFetch([transaction, { ...transaction }]) });
  const query = { orderNumber: cb.order_number, code: '1', signature: cb.signature };

  const bon = await nc.verifyPayment({ query, amount: 3162 });
  assert.equal(bon.ok, true);
  assert.equal(bon.payment.amount, 3162);

  const mauvais = await nc.verifyPayment({ query, amount: 10 });
  assert.deepEqual([mauvais.ok, mauvais.reason], [false, 'montant différent']);

  const faux = await nc.verifyPayment({ query: { ...query, signature: '0'.repeat(64) } });
  assert.deepEqual([faux.ok, faux.reason], [false, 'signature invalide']);
});

test('valide la configuration et le paiement', async () => {
  assert.throws(() => new NatCash({ ...base, privateKey: '' }), NatCashError);
  assert.throws(() => new NatCash({ ...base, callbackUrl: 'pas une url' }), NatCashError);
  assert.throws(() => new NatCash({ ...base, language: 'es' }), NatCashError);
  const nc = new NatCash({ ...base, fetch: fakeFetch([]) });
  await assert.rejects(nc.createPayment({ amount: 10.123, orderId: 1 }), NatCashError);
  await assert.rejects(nc.createPayment({ amount: 10, orderId: 1, msisdn: '123' }), NatCashError);
  await assert.rejects(nc.createPayment({ amount: 10, orderId: 1, skipPhoneInput: true }), NatCashError);
});
