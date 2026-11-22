// Simulateur : faux solde, faux fournisseur, faux SMS. Aucun appel réseau.
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { MemoryStore, RetraitError, ServiceRetraits, STATUT, fraisRetrait } from './index.js';

const rl = createInterface({ input: process.stdin });
const lignes = rl[Symbol.asyncIterator]();
const lire = async (question) => {
  process.stdout.write(question);
  const { value, done } = await lignes.next();
  return done ? null : value.trim();
};
const G = (c) => `${(c / 100).toLocaleString('fr-FR')} G`;

let dernierCode = null;
const service = new ServiceRetraits({
  store: new MemoryStore(),
  fournisseur: {
    envoyer: async () => ({ statut: 'succes', referenceExterne: `SIMU-${Date.now()}` }),
    verifier: async () => ({ statut: 'succes' }),
  },
  regles: { minimum: 2000 },
  otp: {
    secret: randomBytes(32).toString('hex'),
    envoyer: async ({ code, total }) => {
      dernierCode = code;
      console.log(`\n  [FAUX SMS] Code ${code} pour confirmer un débit de ${G(total)}. Valable 5 min.`);
    },
  },
});

const compteId = 'client-essai';
await service.ouvrirCompte(compteId);
await service.crediter({ compteId, montant: 6_000_000, reference: 'depot-essai' });
console.log('SIMULATION : aucun argent réel. Minimum d\'essai : 20 G. Limite : 50 000 G.');

async function retrait(montant) {
  const m = (await lire('Méthode, 1 MonCash ou 2 NatCash [1] : ')) === '2' ? 'natcash' : 'moncash';
  const numero = (await lire('Numéro [50912345678] : ')) || '50912345678';
  console.log(`  Le client reçoit ${G(montant)}, frais ${G(fraisRetrait(montant))}, débit ${G(montant + fraisRetrait(montant))}.`);
  const r = await service.demander({ compteId, montant, methode: m, numero, cleIdempotence: randomUUID() });
  for (;;) {
    const code = await lire('Code OTP, ou "annuler" : ');
    if (code === null || code === 'annuler') {
      await service.annuler({ retraitId: r.id, compteId });
      return console.log('  Retrait annulé, argent libéré.');
    }
    try {
      const fin = await service.confirmer({ retraitId: r.id, compteId, code });
      return console.log(fin.statut === STATUT.PAYE ? `  Retrait payé (simulation), réf. ${fin.referenceExterne}.` : `  Statut : ${fin.statut}`);
    } catch (e) {
      console.log(`  ${e.message}`);
      if (e.code !== 'OTP_INCORRECT') return;
    }
  }
}

for (;;) {
  const s = await service.solde(compteId);
  console.log(`\nSolde ${G(s.solde)} | disponible ${G(s.disponible)}`);
  const saisie = await lire('Montant à retirer en gourdes (Entrée pour quitter) : ');
  if (!saisie) break;
  const montant = Math.round(Number(saisie.replace(',', '.')) * 100);
  try {
    await retrait(montant);
  } catch (e) {
    if (!(e instanceof RetraitError)) throw e;
    console.log(`  Refusé : ${e.message}`);
  }
}
rl.close();
