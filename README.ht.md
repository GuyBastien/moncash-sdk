# moncash-sdk

SDK Node.js senp pou API **MonCash** (Digicel Ayiti).
Aksepte peman MonCash sou sit ou ak kèk liy kòd.

🇫🇷 [Lire en français](README.md)

- Pa gen okenn depandans (li sèvi ak `fetch` Node 18+)
- Li jere jeton aksè a pou ou otomatikman
- Li verifye peman an (estati, kòmand, montan)
- Tip TypeScript ladan l
- Mòd `sandbox` ak `live`

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

## Sekirite

- **Toujou** verifye peman an sou sèvè a (`verifyPayment`).
- Konpare montan ki peye a ak montan kòmand lan nan baz done w.
- Pa valide menm kòmand lan de fwa (kenbe `transactionId` ou deja itilize yo).

## Kontribye

Issues ak pull request byenveni. Lide : vèsyon Python, NatCash, middleware Express.

## Lisans

MIT
