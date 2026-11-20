// Test réel contre la sandbox MonCash (et NatCash si les clés sont là)
//
// node scripts/sandbox.js   (le script demande les clés)
// ou : MONCASH_CLIENT_ID=... MONCASH_CLIENT_SECRET=... node scripts/sandbox.js
//
// Pour NatCash, ajoutez aussi : NATCASH_PRIVATE_KEY, NATCASH_PARTNER_CODE,
// NATCASH_FUNCTION_CODE, NATCASH_USERNAME, NATCASH_PASSWORD
import { createInterface } from 'node:readline/promises';
import { MonCash, NatCash } from '../src/index.js';

const e = process.env;

// Si les clés ne sont pas dans l'environnement, on les demande
if (!e.MONCASH_CLIENT_ID && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  e.MONCASH_CLIENT_ID = (await rl.question('Client ID MonCash : ')).trim();
  e.MONCASH_CLIENT_SECRET = (await rl.question('Client Secret MonCash : ')).trim();
  rl.close();
}
const orderId = `TEST-${Date.now()}`;

async function etape(nom, fn) {
  try {
    const r = await fn();
    console.log(`✔ ${nom}`, r === undefined ? '' : r);
    return r;
  } catch (err) {
    console.log(`✖ ${nom} : ${err.message}`);
    if (err.body) console.log('  réponse :', JSON.stringify(err.body));
  }
}

if (e.MONCASH_CLIENT_ID && e.MONCASH_CLIENT_SECRET) {
  console.log('--- MonCash (sandbox) ---');
  const mc = new MonCash({ clientId: e.MONCASH_CLIENT_ID, clientSecret: e.MONCASH_CLIENT_SECRET });
  await etape('jeton', async () => `${(await mc.getToken()).slice(0, 12)}...`);
  const p = await etape('createPayment', async () => (await mc.createPayment({ amount: 10, orderId })).redirectUrl);
  await etape('prefundedBalance', () => mc.prefundedBalance());
  await etape('getPaymentByOrderId (doit échouer : pas encore payé)', () => mc.getPaymentByOrderId(orderId));
  if (p) {
    console.log(`\nOuvrez ce lien, payez avec un compte sandbox, puis relancez :`);
    console.log(`  ORDER_ID=${orderId} node scripts/sandbox.js\n`);
  }
  if (e.ORDER_ID) {
    await etape(`verifyPayment ${e.ORDER_ID}`, () => mc.verifyPayment({ orderId: e.ORDER_ID, amount: 10 }));
  }
} else {
  console.log('MonCash ignoré : MONCASH_CLIENT_ID / MONCASH_CLIENT_SECRET manquants');
}

if (e.NATCASH_PRIVATE_KEY) {
  console.log('--- NatCash (sandbox) ---');
  const nc = new NatCash({
    privateKey: e.NATCASH_PRIVATE_KEY,
    partnerCode: e.NATCASH_PARTNER_CODE,
    functionCode: e.NATCASH_FUNCTION_CODE,
    username: e.NATCASH_USERNAME,
    password: e.NATCASH_PASSWORD,
    callbackUrl: 'https://example.com/natcash/retour',
  });
  await etape('createPayment', async () => (await nc.createPayment({ amount: 10, orderId })).redirectUrl);
} else {
  console.log('NatCash ignoré : NATCASH_PRIVATE_KEY manquant');
}
