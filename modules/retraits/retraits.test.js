import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fraisRetrait, LIMITE_RETRAIT, MemoryStore, RetraitError, ServiceRetraits, STATUT } from './index.js';

const regles = { minimum: 2000, maximum: 500000, plafondJourCompte: 300000, plafondJourNumero: 300000 };
const NUM = '50912345678';
const SECRET = 'secret-de-test-assez-long-pour-otp-0123456789';

function fauxFournisseur(envoi = { statut: 'succes', referenceExterne: '123' }, verification = { statut: 'inconnu' }) {
  const f = {
    envois: [],
    envoi,
    verification,
    envoyer: async (d) => {
      f.envois.push(d);
      if (f.envoi instanceof Error) throw f.envoi;
      return f.envoi;
    },
    verifier: async () => f.verification,
  };
  return f;
}

async function monter(fournisseur = fauxFournisseur(), solde = 200000, options = {}, conditions = [], frais = fraisRetrait) {
  let t = 1_000_000;
  let n = 0;
  const boite = { messages: [], panne: false };
  const store = new MemoryStore();
  const service = new ServiceRetraits({
    store,
    fournisseur,
    regles: { ...regles, ...options },
    frais,
    conditions,
    otp: {
      secret: SECRET,
      envoyer: async (m) => {
        if (boite.panne) throw new Error('SMS en panne');
        boite.messages.push(m);
      },
    },
    maintenant: () => t,
    genererId: () => `r${++n}`,
  });
  await service.ouvrirCompte('a');
  await service.crediter({ compteId: 'a', montant: solde, reference: 'depot-a' });
  const dernierCode = (id) => boite.messages.filter((m) => m.retraitId === id).at(-1).code;
  const retirer = async (o = {}) => {
    const r = await service.demander(demande(o));
    return service.confirmer({ retraitId: r.id, compteId: r.compteId, code: dernierCode(r.id) });
  };
  return { service, store, fournisseur, boite, dernierCode, retirer, avancer: (ms) => { t += ms; } };
}

const demande = (o = {}) => ({ compteId: 'a', montant: 50000, methode: 'natcash', numero: NUM, cleIdempotence: 'k1', ...o });
const code = (c) => (e) => e instanceof RetraitError && e.code === c;
const intact = { solde: 200000, reserve: 0, caution: 0, disponible: 200000 };
const faux = (bon) => (bon === '000000' ? '000001' : '000000');

test('rien ne part avant le bon code OTP', async () => {
  const { service, fournisseur, boite, dernierCode } = await monter();
  const r = await service.demander(demande());
  assert.equal(r.statut, STATUT.EN_ATTENTE_OTP);
  assert.equal(fournisseur.envois.length, 0);
  assert.equal((await service.solde('a')).reserve, 52500);
  assert.match(boite.messages[0].code, /^\d{6}$/);
  assert.deepEqual([boite.messages[0].total, boite.messages[0].numero], [52500, NUM]);

  const paye = await service.confirmer({ retraitId: r.id, compteId: 'a', code: dernierCode(r.id) });
  assert.equal(paye.statut, STATUT.PAYE);
  assert.equal(fournisseur.envois.length, 1);
  assert.equal(fournisseur.envois[0].montant, 50000);
  assert.deepEqual(await service.solde('a'), { solde: 147500, reserve: 0, caution: 0, disponible: 147500 });
});

test('le code et son empreinte ne sont jamais renvoyés au client ni stockés en clair', async () => {
  const { service, store, dernierCode } = await monter();
  const r = await service.demander(demande());
  assert.equal(r.otp, undefined);
  const brut = await store.transaction((tx) => tx.getRetrait(r.id));
  assert.equal(JSON.stringify(brut).includes(`"${dernierCode(r.id)}"`), false);
  assert.match(brut.otp.empreinte, /^[0-9a-f]{64}$/);
  assert.equal((await service.demander(demande())).otp, undefined);
});

test('un mauvais code ne paie pas et cinq erreurs annulent le retrait', async () => {
  const { service, fournisseur, dernierCode } = await monter();
  const r = await service.demander(demande());
  const mauvais = faux(dernierCode(r.id));
  for (let i = 0; i < 4; i++) {
    await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: mauvais }), code('OTP_INCORRECT'));
  }
  await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: mauvais }), code('OTP_TENTATIVES'));
  await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: dernierCode(r.id) }), code('OTP_DEJA_TRAITE'));
  assert.equal(fournisseur.envois.length, 0);
  assert.deepEqual(await service.solde('a'), intact);
});

test('des essais simultanés ne dépassent pas la limite', async () => {
  const { service, dernierCode } = await monter();
  const r = await service.demander(demande());
  const mauvais = faux(dernierCode(r.id));
  const res = await Promise.allSettled(Array.from({ length: 20 }, () => service.confirmer({ retraitId: r.id, compteId: 'a', code: mauvais })));
  assert.equal(res.filter((x) => x.reason?.code === 'OTP_INCORRECT').length, 4);
  assert.equal(res.filter((x) => x.reason?.code === 'OTP_TENTATIVES').length, 1);
  assert.equal(res.filter((x) => x.reason?.code === 'OTP_DEJA_TRAITE').length, 15);
});

test('un code valide ne paie qu’une fois, même envoyé en même temps', async () => {
  const { service, fournisseur, dernierCode } = await monter();
  const r = await service.demander(demande());
  const c = dernierCode(r.id);
  const res = await Promise.allSettled([1, 2, 3].map(() => service.confirmer({ retraitId: r.id, compteId: 'a', code: c })));
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(fournisseur.envois.length, 1);
});

test('un autre compte ne peut ni confirmer ni annuler', async () => {
  const { service, fournisseur, dernierCode } = await monter();
  const r = await service.demander(demande());
  await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'b', code: dernierCode(r.id) }), code('RETRAIT_INTROUVABLE'));
  await assert.rejects(service.annuler({ retraitId: r.id, compteId: 'b' }), code('RETRAIT_INTROUVABLE'));
  assert.equal(fournisseur.envois.length, 0);
});

test('un code expiré libère l’argent', async () => {
  const { service, fournisseur, dernierCode, avancer } = await monter();
  const r = await service.demander(demande());
  avancer(5 * 60_000);
  await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: dernierCode(r.id) }), code('OTP_EXPIRE'));
  assert.equal(fournisseur.envois.length, 0);
  assert.deepEqual(await service.solde('a'), intact);
});

test('la réconciliation libère les demandes jamais confirmées', async () => {
  const { service, avancer } = await monter();
  await service.demander(demande());
  avancer(5 * 60_000);
  await service.reconcilier();
  assert.deepEqual(await service.solde('a'), intact);
});

test('un nouveau code invalide l’ancien, avec délai et maximum', async () => {
  const { service, fournisseur, boite, dernierCode, avancer } = await monter();
  const r = await service.demander(demande());
  const ancien = dernierCode(r.id);
  await assert.rejects(service.renvoyerOtp({ retraitId: r.id, compteId: 'a' }), code('OTP_TROP_TOT'));
  avancer(60_000);
  await service.renvoyerOtp({ retraitId: r.id, compteId: 'a' });
  assert.equal(boite.messages.length, 2);
  if (dernierCode(r.id) !== ancien) {
    await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: ancien }), code('OTP_INCORRECT'));
  }
  avancer(60_000);
  await service.renvoyerOtp({ retraitId: r.id, compteId: 'a' });
  avancer(60_000);
  await assert.rejects(service.renvoyerOtp({ retraitId: r.id, compteId: 'a' }), code('OTP_RENVOIS'));
  assert.equal((await service.confirmer({ retraitId: r.id, compteId: 'a', code: dernierCode(r.id) })).statut, STATUT.PAYE);
  assert.equal(fournisseur.envois.length, 1);
});

test('renvoyer un code ne remet pas les essais à zéro', async () => {
  const { service, dernierCode, avancer } = await monter();
  const r = await service.demander(demande());
  const mauvais = () => faux(dernierCode(r.id));
  for (let i = 0; i < 4; i++) await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: mauvais() }));
  avancer(60_000);
  await service.renvoyerOtp({ retraitId: r.id, compteId: 'a' });
  await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: mauvais() }), code('OTP_TENTATIVES'));
});

test('si le code ne peut pas être envoyé, l’argent est libéré', async () => {
  const { service, boite } = await monter();
  boite.panne = true;
  await assert.rejects(service.demander(demande()), code('OTP_NON_ENVOYE'));
  assert.deepEqual(await service.solde('a'), intact);
});

test('le client peut annuler avant de confirmer', async () => {
  const { service, fournisseur, dernierCode } = await monter();
  const r = await service.demander(demande());
  assert.equal((await service.annuler({ retraitId: r.id, compteId: 'a' })).statut, STATUT.ANNULE);
  await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: dernierCode(r.id) }), code('OTP_DEJA_TRAITE'));
  assert.equal(fournisseur.envois.length, 0);
  assert.deepEqual(await service.solde('a'), intact);
});

test('une caution ou une condition survenue après la demande bloque la confirmation', async () => {
  let autorise = true;
  const { service, fournisseur, dernierCode } = await monter(fauxFournisseur(), 200000, {}, [() => autorise || 'Compte suspendu']);
  const r = await service.demander(demande());
  autorise = false;
  await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: dernierCode(r.id) }), code('CONDITION_NON_REMPLIE'));
  autorise = true;
  await service.definirCaution({ compteId: 'a', montant: 190000 });
  await assert.rejects(service.confirmer({ retraitId: r.id, compteId: 'a', code: dernierCode(r.id) }), code('CAUTION_BLOQUEE'));
  assert.equal(fournisseur.envois.length, 0);
  await service.definirCaution({ compteId: 'a', montant: 0 });
  assert.equal((await service.confirmer({ retraitId: r.id, compteId: 'a', code: dernierCode(r.id) })).statut, STATUT.PAYE);
});

test('aucune validation admin, même pour un gros montant', async () => {
  const { service, fournisseur, retirer } = await monter();
  assert.equal((await retirer({ montant: 120000 })).statut, STATUT.PAYE);
  assert.equal(fournisseur.envois.length, 1);
  assert.equal(service.approuver, undefined);
});

test('la caution reste bloquée puis redevient disponible', async () => {
  const { service, fournisseur, retirer } = await monter();
  await service.definirCaution({ compteId: 'a', montant: 160000, motif: 'garantie' });
  assert.equal((await service.solde('a')).disponible, 40000);
  await assert.rejects(service.demander(demande()), code('CAUTION_BLOQUEE'));
  assert.equal(fournisseur.envois.length, 0);
  assert.equal((await retirer({ montant: 30000, cleIdempotence: 'k2' })).statut, STATUT.PAYE);
  assert.deepEqual(await service.solde('a'), { solde: 168500, reserve: 0, caution: 160000, disponible: 8500 });
  await service.definirCaution({ compteId: 'a', montant: 0 });
  assert.equal((await service.solde('a')).disponible, 168500);
  await assert.rejects(service.definirCaution({ compteId: 'a', montant: -1 }), code('CAUTION_INVALIDE'));
});

test('une condition non remplie bloque la demande sans rien réserver', async () => {
  for (const condition of [() => false, () => 'Identité non vérifiée', () => { throw new Error('panne'); }, () => undefined]) {
    const { service, fournisseur, boite } = await monter(fauxFournisseur(), 200000, {}, [condition]);
    await assert.rejects(service.demander(demande()), code('CONDITION_NON_REMPLIE'));
    assert.equal(fournisseur.envois.length, 0);
    assert.equal(boite.messages.length, 0);
    assert.deepEqual(await service.solde('a'), intact);
  }
});

test('frais de 5 % arrondis au centime supérieur', () => {
  assert.equal(fraisRetrait(10000), 500);
  assert.equal(fraisRetrait(50000), 2500);
  assert.equal(fraisRetrait(100000), 5000);
  assert.equal(fraisRetrait(2350), 118);
});

test('un retrait de 500 G envoie 500 G et débite 525 G', async () => {
  const { service, fournisseur, retirer } = await monter(fauxFournisseur(), 60000);
  const r = await retirer();
  assert.deepEqual([r.montant, r.frais, r.total], [50000, 2500, 52500]);
  assert.equal(fournisseur.envois[0].montant, 50000);
  assert.equal((await service.solde('a')).solde, 7500);
});

test('500 G de solde ne suffisent pas pour retirer 500 G', async () => {
  const pauvre = await monter(fauxFournisseur(), 50000);
  await assert.rejects(pauvre.service.demander(demande()), code('SOLDE_INSUFFISANT'));
  const juste = await monter(fauxFournisseur(), 52500);
  assert.equal((await juste.retirer()).statut, STATUT.PAYE);
  assert.equal((await juste.service.solde('a')).solde, 0);
});

test('la même clé ne crée ni second retrait ni second code', async () => {
  const { service, fournisseur, boite, dernierCode } = await monter();
  const a = await service.demander(demande());
  const b = await service.demander(demande());
  assert.equal(a.id, b.id);
  assert.equal(boite.messages.length, 1);
  await assert.rejects(service.demander(demande({ montant: 60000 })), code('CLE_REUTILISEE'));
  await service.confirmer({ retraitId: a.id, compteId: 'a', code: dernierCode(a.id) });
  assert.equal((await service.demander(demande())).statut, STATUT.PAYE);
  assert.equal(fournisseur.envois.length, 1);
});

test('des demandes simultanées ne dépassent jamais le disponible', async () => {
  const { service } = await monter(fauxFournisseur(), 100000);
  const res = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => service.demander(demande({ cleIdempotence: `c${i}`, montant: 40000 }))));
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 2);
  assert.equal((await service.solde('a')).disponible, 16000);
});

test('un échec certain rend montant et frais', async () => {
  const { service, retirer } = await monter(fauxFournisseur({ statut: 'echec', motif: 'numéro invalide' }));
  assert.equal((await retirer()).statut, STATUT.ECHOUE);
  assert.deepEqual(await service.solde('a'), intact);
});

test('une panne garde l’argent réservé et ne renvoie jamais', async () => {
  const { service, fournisseur, avancer, retirer } = await monter(fauxFournisseur(new Error('délai dépassé')));
  assert.equal((await retirer()).statut, STATUT.A_VERIFIER);
  assert.equal((await service.solde('a')).reserve, 52500);

  avancer(120_000);
  assert.deepEqual(await service.reconcilier(), { verifies: 1, regles: 0, restants: 1 });
  assert.equal((await service.solde('a')).reserve, 52500);

  fournisseur.verification = { statut: 'succes', referenceExterne: '999' };
  avancer(120_000);
  assert.deepEqual(await service.reconcilier(), { verifies: 1, regles: 1, restants: 0 });
  assert.equal(fournisseur.envois.length, 1);
  assert.deepEqual(await service.solde('a'), { solde: 147500, reserve: 0, caution: 0, disponible: 147500 });
});

test('la réconciliation rend l’argent si le fournisseur confirme l’échec', async () => {
  const { service, fournisseur, avancer, retirer } = await monter(fauxFournisseur({ statut: 'en_attente' }));
  await retirer();
  fournisseur.verification = { statut: 'echec' };
  avancer(120_000);
  await service.reconcilier();
  assert.equal(fournisseur.envois.length, 1);
  assert.deepEqual(await service.solde('a'), intact);
});

test('plafonds par compte et par numéro sur 24 h', async () => {
  const { service, avancer, retirer } = await monter(fauxFournisseur(), 500000, { plafondJourCompte: 100000, plafondJourNumero: 150000 });
  await retirer({ montant: 80000 });
  await assert.rejects(service.demander(demande({ montant: 30000, cleIdempotence: 'k2' })), code('PLAFOND_COMPTE'));

  await service.ouvrirCompte('b');
  await service.crediter({ compteId: 'b', montant: 500000, reference: 'depot-b' });
  await assert.rejects(service.demander(demande({ compteId: 'b', montant: 80000, cleIdempotence: 'k3' })), code('PLAFOND_NUMERO'));

  avancer(24 * 3600_000 + 1);
  assert.equal((await retirer({ montant: 30000, cleIdempotence: 'k4' })).statut, STATUT.PAYE);
});

test('une demande abandonnée ne consomme plus le plafond', async () => {
  const { service, avancer, retirer } = await monter(fauxFournisseur(), 500000, { plafondJourCompte: 100000 });
  await service.demander(demande({ montant: 80000 }));
  avancer(5 * 60_000);
  await service.expirerOtp();
  assert.equal((await retirer({ montant: 80000, cleIdempotence: 'k2' })).statut, STATUT.PAYE);
});

test('limite par défaut de 50 000 G par retrait et sur 24 h', async () => {
  assert.equal(LIMITE_RETRAIT, 5_000_000);
  const messages = [];
  const service = new ServiceRetraits({
    store: new MemoryStore(),
    fournisseur: fauxFournisseur(),
    regles: { minimum: 2000 },
    otp: { secret: SECRET, envoyer: async (m) => { messages.push(m); } },
  });
  await service.ouvrirCompte('a');
  await service.crediter({ compteId: 'a', montant: 20_000_000, reference: 'gros-depot' });
  await assert.rejects(service.demander(demande({ montant: 5_000_001 })), code('MONTANT_HORS_LIMITES'));
  const r = await service.demander(demande({ montant: 5_000_000 }));
  assert.equal(r.total, 5_250_000);
  assert.equal((await service.confirmer({ retraitId: r.id, compteId: 'a', code: messages[0].code })).statut, STATUT.PAYE);
  await assert.rejects(service.demander(demande({ montant: 2000, cleIdempotence: 'k2' })), code('PLAFOND_COMPTE'));
});

test('un crédit répété ne compte qu’une fois', async () => {
  const { service } = await monter();
  await service.crediter({ compteId: 'a', montant: 200000, reference: 'depot-a' });
  assert.equal((await service.solde('a')).solde, 200000);
});

test('refuse les données invalides et une configuration incomplète', async () => {
  const { service } = await monter();
  await assert.rejects(service.demander(demande({ montant: 10.5 })), code('MONTANT_INVALIDE'));
  await assert.rejects(service.demander(demande({ montant: 1000 })), code('MONTANT_HORS_LIMITES'));
  await assert.rejects(service.demander(demande({ numero: '123' })), code('NUMERO_INVALIDE'));
  await assert.rejects(service.demander(demande({ methode: 'carte' })), code('METHODE_INVALIDE'));
  await assert.rejects(service.demander(demande({ cleIdempotence: '' })), code('CLE_OBLIGATOIRE'));
  await assert.rejects(service.demander(demande({ compteId: 'x' })), code('COMPTE_INTROUVABLE'));
  const base = { store: new MemoryStore(), fournisseur: fauxFournisseur(), regles, otp: { secret: SECRET, envoyer: async () => {} } };
  assert.throws(() => new ServiceRetraits({ ...base, regles: {} }), code('CONFIGURATION'));
  assert.throws(() => new ServiceRetraits({ ...base, conditions: ['kyc'] }), code('CONFIGURATION'));
  assert.throws(() => new ServiceRetraits({ ...base, otp: undefined }), code('CONFIGURATION'));
  assert.throws(() => new ServiceRetraits({ ...base, otp: { secret: 'court', envoyer: async () => {} } }), code('CONFIGURATION'));
  assert.throws(() => new ServiceRetraits({ ...base, otp: { ...base.otp, maxTentatives: 0 } }), code('CONFIGURATION'));
});
