# moncash-sdk

<p>
  <img src="https://moncashbutton.digicelgroup.com/Moncash-business/resources/assets/images/MonCash.png" alt="MonCash" height="90">
  &nbsp;&nbsp;
  <img src="https://testmerchantpay.natcom.com.ht/merchant/_next/static/images/logo-1689408a84fe0c46831e7ae2d19fe04c.png" alt="NatCash" height="60">
</p>

[![Tests](https://github.com/GuyBastien/moncash-sdk/actions/workflows/tests.yml/badge.svg)](https://github.com/GuyBastien/moncash-sdk/actions/workflows/tests.yml)

SDK Node.js ak Python senp pou **MonCash** (Digicel) ak **NatCash** (Natcom).
Aksepte peman mobil ayisyen sou sit ou ak kèk liy kòd.

🇫🇷 [Lire en français](README.md)

- Pa gen okenn depandans (li sèvi ak `fetch` Node 18+)
- Li jere jeton aksè a pou ou otomatikman
- Li verifye peman an (estati, kòmand, montan)
- Tip TypeScript ladan l
- Mòd `sandbox` ak `live`
- MonCash **ak** NatCash nan menm pake a

> **Estati :** MonCash verifye ak vrè sandbox la (jeton, adrès API yo, erè yo). Peman konplè a poko teste. NatCash verifye sou sèvè tès Natcom (adrès, fòma repons), san kle.

> Pwojè sa a pa ofisyèl, li pa gen lyen ak Digicel ni Natcom. MonCash ak NatCash se mak pwopriyetè yo.

## Enstalasyon

```bash
npm install github:GuyBastien/moncash-sdk
```

## Kòmanse rapid

```js
import { MonCash } from '@guybastien/moncash';

const moncash = new MonCash({
  clientId: process.env.MONCASH_CLIENT_ID,
  clientSecret: process.env.MONCASH_CLIENT_SECRET,
  mode: 'sandbox', // 'live' lè w an pwodiksyon
});

// 1. Kreye peman an epi voye kliyan an sou MonCash
const peman = await moncash.createPayment({ amount: 500, orderId: 'CMD-001' });
res.redirect(peman.redirectUrl);

// 2. Lè l tounen, verifye peman an
const { ok, payment } = await moncash.verifyPayment({
  transactionId: req.query.transactionId,
  orderId: 'CMD-001',
  amount: 500,
});
if (ok) {
  // kòmand lan peye
}
```

Gen yon egzanp konplè ak Express nan [`examples/express.js`](examples/express.js).

## Kijan pou jwenn kle ou yo

1. Kreye yon kont machann sou [pòtay MonCash Business](https://sandbox.moncashbutton.digicelgroup.com/Moncash-business/Login) (sandbox).
2. Kreye yon « Business » epi kopye **Client ID** ak **Client Secret** la.
3. Mete **URL retou** ou (egz. `https://sitou.ht/retou`). MonCash ap voye kliyan an la ak `?transactionId=...`.

Pa janm mete kle ou yo nan kòd la : sèvi ak varyab anviwònman.

## Fonksyon yo

| Fonksyon | Sa l fè |
|---|---|
| `createPayment({ amount, orderId })` | Kreye yon peman, li bay `{ token, redirectUrl }` |
| `getPaymentByTransactionId(id)` | Enfòmasyon sou yon peman ak nimewo tranzaksyon an |
| `getPaymentByOrderId(orderId)` | Enfòmasyon sou yon peman ak nimewo kòmand ou |
| `verifyPayment({ transactionId \| orderId, amount })` | Bay `{ ok, payment }` : `ok` vre sèlman si l peye, bon kòmand, bon montan |
| `transfer({ amount, receiver, desc })` | Voye kòb bay yon kliyan MonCash |
| `customerStatus(nimewo)` | Estati kont yon kliyan |
| `prefundedBalance()` | Balans kont machann lan |

## NatCash

<p><img src="https://testmerchantpay.natcom.com.ht/merchant/_next/static/images/logo-1689408a84fe0c46831e7ae2d19fe04c.png" alt="NatCash" height="60"></p>

```js
import { NatCash } from '@guybastien/moncash';

const natcash = new NatCash({
  privateKey: process.env.NATCASH_PRIVATE_KEY,
  partnerCode: process.env.NATCASH_PARTNER_CODE,
  functionCode: process.env.NATCASH_FUNCTION_CODE,
  username: process.env.NATCASH_USERNAME,
  password: process.env.NATCASH_PASSWORD,
  callbackUrl: 'https://sitou.ht/natcash/retou',
  mode: 'sandbox',
  language: 'ht',
});

// 1. Kreye peman an
const peman = await natcash.createPayment({ amount: 500, orderId: 'CMD-001' });
res.redirect(peman.redirectUrl);

// 2. Paj retou a : NatCash ajoute ?orderNumber=...&code=...&signature=...
const { ok, reason, payment } = await natcash.verifyPayment({ query: req.query, amount: 500 });
```

`verifyPayment` verifye siyati retou a, mande NatCash tranzaksyon an, epi tcheke estati ak montan an.

Egzanp konplè : [`examples/natcash-express.js`](examples/natcash-express.js).

> **Nòt :** Natcom pa pibliye dokimantasyon piblik. Pou jwenn kle ou yo, kontakte Natcom. Pati sa a swiv fonksyònman SDK [php-natcash-sdk](https://github.com/midsonlajeanty/php-natcash-sdk) ak [natcashify](https://github.com/midsonlajeanty/natcashify) Louis Midson Lajeanty (MIT).

## Sekirite

- **Toujou** verifye peman an sou sèvè a (`verifyPayment`).
- Konpare montan ki peye a ak montan kòmand lan nan baz done w.
- Pa valide menm kòmand lan de fwa (kenbe `transactionId` ou deja itilize yo).

## Python

Gen yon vèsyon Python (3.9+, san depandans) nan dosye [`python/`](python/) :

```bash
pip install moncash-sdk
```

## Tès

```bash
npm test                                              # Node.js
cd python && python -m unittest discover -s tests     # Python
```

Tès reyèl ak kle sandbox ou :

```bash
MONCASH_CLIENT_ID=... MONCASH_CLIENT_SECRET=... node scripts/sandbox.js
```

## Kontribye

Issues ak pull request byenveni. Lide : middleware Express, Django/Flask, teste ak vrè kle NatCash.

## Lisans

MIT
