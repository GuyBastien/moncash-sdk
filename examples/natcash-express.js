// Exemple NatCash avec Express
// NATCASH_PRIVATE_KEY=... NATCASH_PARTNER_CODE=... node examples/natcash-express.js
import express from 'express';
import { NatCash } from '../src/index.js'; // dans votre projet : from '@guybastien/moncash'

const app = express();
const natcash = new NatCash({
  privateKey: process.env.NATCASH_PRIVATE_KEY,
  partnerCode: process.env.NATCASH_PARTNER_CODE,
  functionCode: process.env.NATCASH_FUNCTION_CODE,
  username: process.env.NATCASH_USERNAME,
  password: process.env.NATCASH_PASSWORD,
  callbackUrl: 'http://localhost:3000/natcash/retour',
  mode: 'sandbox',
});

const commandes = new Map();

// 1. Le client clique sur "Payer avec NatCash"
app.get('/natcash/payer', async (req, res) => {
  const orderId = Date.now().toString();
  commandes.set(orderId, { montant: 500, payee: false });
  try {
    const paiement = await natcash.createPayment({ amount: 500, orderId });
    res.redirect(paiement.redirectUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur NatCash');
  }
});

// 2. NatCash renvoie le client ici avec ?orderNumber=...&code=...&signature=...
app.get('/natcash/retour', async (req, res) => {
  const commande = commandes.get(String(req.query.orderNumber));
  if (!commande) return res.status(404).send('Commande inconnue');
  try {
    const { ok, reason, payment } = await natcash.verifyPayment({ query: req.query, amount: commande.montant });
    if (!ok) return res.status(400).send(`Paiement refusé : ${reason}`);
    if (commande.payee) return res.send('Commande déjà payée');
    commande.payee = true;
    res.send(`Merci ! Paiement reçu (transaction ${payment.transactionId})`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Impossible de vérifier le paiement');
  }
});

app.listen(3000, () => console.log('http://localhost:3000/natcash/payer'));
