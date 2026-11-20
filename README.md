# moncash-sdk

<p>
  <img src="https://moncashbutton.digicelgroup.com/Moncash-business/resources/assets/images/MonCash.png" alt="MonCash" height="90">
  &nbsp;&nbsp;
  <img src="https://testmerchantpay.natcom.com.ht/merchant/_next/static/images/logo-1689408a84fe0c46831e7ae2d19fe04c.png" alt="NatCash" height="60">
</p>

SDK Node.js simple pour **MonCash** (Digicel) et **NatCash** (Natcom).
Acceptez les paiements mobiles haïtiens sur votre site en quelques lignes.

🇭🇹 [Li an kreyòl](README.ht.md)

- Aucune dépendance (utilise `fetch` de Node 18+)
- Jeton d'accès géré automatiquement (cache + renouvellement)
- Vérification du paiement (statut, commande, montant)
- Types TypeScript inclus
- Mode `sandbox` et `live`
- MonCash **et** NatCash dans le même paquet

> Projet non officiel, sans lien avec Digicel ni Natcom. MonCash et NatCash sont des marques de leurs propriétaires.

## Installation

```bash
npm install github:GuyBastien/moncash-sdk
```

## Démarrage rapide

```js
import { MonCash } from '@guybastien/moncash';

const moncash = new MonCash({
  clientId: process.env.MONCASH_CLIENT_ID,
  clientSecret: process.env.MONCASH_CLIENT_SECRET,
  mode: 'sandbox', // 'live' en production
});

// 1. Créer le paiement et envoyer le client sur MonCash
const paiement = await moncash.createPayment({ amount: 500, orderId: 'CMD-001' });
res.redirect(paiement.redirectUrl);

// 2. Au retour, vérifier le paiement
const { ok, payment } = await moncash.verifyPayment({
  transactionId: req.query.transactionId,
  orderId: 'CMD-001',
  amount: 500,
});
if (ok) {
  // commande payée
}
```

Un exemple complet avec Express se trouve dans [`examples/express.js`](examples/express.js).

## Obtenir vos clés

1. Créez un compte marchand sur le [portail MonCash Business](https://sandbox.moncashbutton.digicelgroup.com/Moncash-business/Login) (sandbox).
2. Créez une « Business » et copiez le **Client ID** et le **Client Secret**.
3. Indiquez votre **URL de retour** (ex. `https://monsite.ht/retour`). MonCash y renvoie le client avec `?transactionId=...`.

Ne mettez jamais vos clés dans le code : utilisez des variables d'environnement.

## Fonctions

| Fonction | Rôle |
|---|---|
| `createPayment({ amount, orderId })` | Crée un paiement, renvoie `{ token, redirectUrl }` |
| `getPaymentByTransactionId(id)` | Infos d'un paiement par numéro de transaction |
| `getPaymentByOrderId(orderId)` | Infos d'un paiement par votre numéro de commande |
| `verifyPayment({ transactionId \| orderId, amount })` | Renvoie `{ ok, payment }` : vrai seulement si payé, bonne commande, bon montant |
| `transfer({ amount, receiver, desc })` | Envoie de l'argent à un client MonCash |
| `customerStatus(numero)` | Statut d'un compte client |
| `prefundedBalance()` | Solde prépayé du compte marchand |
| `getToken()` | Jeton d'accès (géré automatiquement) |

Un paiement renvoyé ressemble à :

```js
{
  reference: 'CMD-001',     // votre orderId
  transactionId: '2151520', // numéro MonCash
  cost: 500,
  message: 'successful',
  payer: '50937000000',
  raw: { ... }              // réponse complète de MonCash
}
```

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
  callbackUrl: 'https://monsite.ht/natcash/retour',
  mode: 'sandbox',   // 'live' en production
  language: 'ht',    // 'ht', 'fr' ou 'en'
});

// 1. Créer le paiement
const paiement = await natcash.createPayment({ amount: 500, orderId: 'CMD-001' });
res.redirect(paiement.redirectUrl);

// 2. Page de retour : NatCash ajoute ?orderNumber=...&code=...&signature=...
const { ok, reason, payment } = await natcash.verifyPayment({ query: req.query, amount: 500 });
```

`verifyPayment` vérifie la signature du retour, demande la transaction à NatCash, puis contrôle le statut et le montant.

| Fonction | Rôle |
|---|---|
| `createPayment({ amount, orderId, msisdn?, skipPhoneInput? })` | Crée un paiement, renvoie `{ redirectUrl }` |
| `getPaymentByOrderId(orderId)` | Infos d'une transaction (`success`, `amount`, `payer`…) |
| `verifyCallback(req.query)` | Vérifie seulement la signature HMAC du retour |
| `verifyPayment({ query, amount })` | Signature + statut + montant, renvoie `{ ok, reason, payment }` |

Exemple complet : [`examples/natcash-express.js`](examples/natcash-express.js).

> **Note :** Natcom ne publie pas de documentation publique. Pour obtenir vos clés (clé privée, code partenaire, code fonction…), contactez Natcom. Cette partie suit le fonctionnement des SDK open source [php-natcash-sdk](https://github.com/midsonlajeanty/php-natcash-sdk) et [natcashify](https://github.com/midsonlajeanty/natcashify) de Louis Midson Lajeanty (MIT). Les signatures sont testées avec des vecteurs générés par le SDK PHP.

## Erreurs

Les erreurs MonCash sont des `MonCashError` (et `NatCashError` pour NatCash) avec `status` (code HTTP) et `body` (réponse de MonCash) :

```js
import { MonCashError } from '@guybastien/moncash';

try {
  await moncash.getPaymentByTransactionId('123');
} catch (err) {
  if (err instanceof MonCashError) console.log(err.status, err.message);
}
```

## Conseils de sécurité

- Vérifiez **toujours** le paiement côté serveur (`verifyPayment`), jamais seulement à partir de l'URL de retour.
- Comparez le montant payé avec le montant de la commande dans votre base.
- Ne validez une commande qu'une seule fois (gardez le `transactionId` déjà utilisé).

## Tests

```bash
npm test
```

## Contribuer

Les issues et pull requests sont les bienvenues. Idées : version Python, middleware Express, tests avec de vraies clés NatCash.

## Licence

MIT

Merci à Louis Midson Lajeanty pour ses SDK NatCash qui ont servi de référence.
