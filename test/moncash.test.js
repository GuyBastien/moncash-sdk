import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonCash, MonCashError } from '../src/index.js';

// Faux serveur MonCash : renvoie les réponses prévues dans l'ordre
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    const r = responses.shift();
    if (!r) throw new Error('aucune réponse prévue');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => JSON.stringify(r.body),
    };
  };
  fn.calls = calls;
  return fn;
}

const tokenOk = { status: 200, body: { access_token: 'abc', expires_in: 59 } };

test('refuse une config incomplète', () => {
  assert.throws(() => new MonCash({ clientId: 'x' }), MonCashError);
  assert.throws(() => new MonCash({ clientId: 'x', clientSecret: 'y', mode: 'prod' }), MonCashError);
});

test('createPayment renvoie le lien de redirection', async () => {
  const fetch = fakeFetch([
    tokenOk,
    { status: 202, body: { payment_token: { token: 'TOK123', expired: '2026-01-01' }, status: 202 } },
  ]);
  const mc = new MonCash({ clientId: 'id', clientSecret: 'secret', fetch });
  const p = await mc.createPayment({ amount: 500, orderId: 42 });

  assert.equal(p.token, 'TOK123');
  assert.equal(
    p.redirectUrl,
    'https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware/Payment/Redirect?token=TOK123'
  );
  // Appel du jeton en Basic auth
  assert.match(fetch.calls[0].url, /\/Api\/oauth\/token$/);
  assert.equal(
    fetch.calls[0].options.headers.Authorization,
    'Basic ' + Buffer.from('id:secret').toString('base64')
  );
  // Appel du paiement en Bearer avec orderId en texte
  assert.equal(fetch.calls[1].options.headers.Authorization, 'Bearer abc');
  assert.deepEqual(JSON.parse(fetch.calls[1].options.body), { amount: 500, orderId: '42' });
});

test('le jeton est réutilisé', async () => {
  const fetch = fakeFetch([
    tokenOk,
    { status: 200, body: { balance: 1000 } },
    { status: 200, body: { balance: 900 } },
  ]);
  const mc = new MonCash({ clientId: 'id', clientSecret: 's', fetch });
  await mc.prefundedBalance();
  await mc.prefundedBalance();
  assert.equal(fetch.calls.filter((c) => c.url.endsWith('/oauth/token')).length, 1);
});

test('redemande un jeton après un 401', async () => {
  const fetch = fakeFetch([
    tokenOk,
    { status: 401, body: { error: 'invalid_token' } },
    { status: 200, body: { access_token: 'neuf', expires_in: 59 } },
    { status: 200, body: { balance: 1000 } },
  ]);
  const mc = new MonCash({ clientId: 'id', clientSecret: 's', fetch });
  const r = await mc.prefundedBalance();
  assert.equal(r.balance, 1000);
  assert.equal(fetch.calls[3].options.headers.Authorization, 'Bearer neuf');
});

test('verifyPayment contrôle le message, la commande et le montant', async () => {
  const payment = {
    status: 200,
    body: { payment: { reference: '42', transaction_id: 'T1', cost: 500, message: 'successful', payer: '50937000000' } },
  };
  const mc = new MonCash({
    clientId: 'id',
    clientSecret: 's',
    fetch: fakeFetch([tokenOk, payment, { ...payment }]),
  });

  const bon = await mc.verifyPayment({ transactionId: 'T1', orderId: 42, amount: 500 });
  assert.equal(bon.ok, true);
  assert.equal(bon.payment.transactionId, 'T1');

  const mauvais = await mc.verifyPayment({ transactionId: 'T1', orderId: 42, amount: 5000 });
  assert.equal(mauvais.ok, false);
});

test('les erreurs MonCash deviennent des MonCashError', async () => {
  const mc = new MonCash({
    clientId: 'id',
    clientSecret: 's',
    fetch: fakeFetch([tokenOk, { status: 404, body: { message: 'Transaction not found' } }]),
  });
  await assert.rejects(mc.getPaymentByTransactionId('X'), (err) => {
    assert.ok(err instanceof MonCashError);
    assert.equal(err.status, 404);
    assert.match(err.message, /Transaction not found/);
    return true;
  });
});

test('valide le montant', async () => {
  const mc = new MonCash({ clientId: 'id', clientSecret: 's', fetch: fakeFetch([]) });
  await assert.rejects(mc.createPayment({ amount: -5, orderId: 1 }), MonCashError);
  await assert.rejects(mc.createPayment({ amount: '500', orderId: 1 }), MonCashError);
});

test('verifyPayment répond ok:false si la transaction est introuvable', async () => {
  const mc = new MonCash({
    clientId: 'id',
    clientSecret: 's',
    fetch: fakeFetch([tokenOk, { status: 404, body: { error: 'Not Found', message: 'Transaction Not Found' } }]),
  });
  assert.deepEqual(await mc.verifyPayment({ orderId: 'X', amount: 10 }), { ok: false, payment: null });
});
