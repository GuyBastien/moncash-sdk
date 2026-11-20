# moncash-sdk

SDK Node.js simple pour l'API **MonCash** (Digicel Haïti).
Acceptez des paiements MonCash sur votre site en quelques lignes.

🇭🇹 [Li an kreyòl](README.ht.md)

- Aucune dépendance (utilise `fetch` de Node 18+)
- Jeton d'accès géré automatiquement (cache + renouvellement)
- Vérification du paiement (statut, commande, montant)
- Types TypeScript inclus
- Mode `sandbox` et `live`

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

## Erreurs

Toutes les erreurs sont des `MonCashError` avec `status` (code HTTP) et `body` (réponse de MonCash) :

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

Les issues et pull requests sont les bienvenues. Idées : version Python, support NatCash, middleware Express.

## Licence

MIT
