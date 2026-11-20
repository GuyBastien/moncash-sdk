// Exemple complet avec Express
// npm install express moncash-natcash
// MONCASH_CLIENT_ID=... MONCASH_CLIENT_SECRET=... node examples/express.js
import express from 'express';
import { MonCash } from '../src/index.js'; // dans votre projet : from 'moncash-natcash'

const app = express();
const moncash = new MonCash({
  clientId: process.env.MONCASH_CLIENT_ID,
  clientSecret: process.env.MONCASH_CLIENT_SECRET,
  mode: 'sandbox',
});

// Vos commandes (en vrai, une base de données)
const commandes = new Map();

// 1. Le client clique sur "Payer avec MonCash"
app.get('/payer', async (req, res) => {
  const orderId = Date.now().toString();
  const montant = 500;
  commandes.set(orderId, { montant, payee: false });

  try {
    const paiement = await moncash.createPayment({ amount: montant, orderId });
    res.redirect(paiement.redirectUrl);
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur MonCash');
  }
});

// 2. MonCash renvoie le client ici (URL de retour configurée dans votre compte marchand)
app.get('/retour', async (req, res) => {
  const { transactionId } = req.query;
  try {
    const paiement = await moncash.getPaymentByTransactionId(transactionId);
    const commande = commandes.get(String(paiement.reference));

    // Toujours vérifier le montant côté serveur
    if (!commande || Number(paiement.cost) !== commande.montant || paiement.message !== 'successful') {
      return res.status(400).send('Paiement invalide');
    }
    commande.payee = true;
    res.send(`Merci ! Paiement reçu (transaction ${paiement.transactionId})`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Impossible de vérifier le paiement');
  }
});

app.listen(3000, () => console.log('http://localhost:3000/payer'));
