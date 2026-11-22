// Module de retraits clients MonCash et NatCash.
// Séparé du SDK et non publié avec lui. Montants en centimes (entiers).
// Règle centrale : un retrait envoyé au fournisseur n'est jamais renvoyé.
// En cas de doute, l'argent reste réservé jusqu'à la réconciliation.
// Aucun retrait ne part sans le code OTP envoyé au contact du compte.
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export const STATUT = {
  EN_ATTENTE_OTP: 'en_attente_otp',
  ENVOI: 'envoi',
  A_VERIFIER: 'a_verifier',
  PAYE: 'paye',
  ECHOUE: 'echoue',
  EXPIRE: 'expire',
  ANNULE: 'annule',
};

const METHODES = ['moncash', 'natcash'];
const JOUR = 24 * 3600_000;
const NON_COMPTES = [STATUT.ECHOUE, STATUT.EXPIRE, STATUT.ANNULE];
const OTP_DEFAUT = { dureeMs: 5 * 60_000, maxTentatives: 5, maxEnvois: 3, delaiRenvoiMs: 60_000 };

/** Limite de 50 000 G, par retrait et sur 24 h pour un compte ou un numéro (en centimes). */
export const LIMITE_RETRAIT = 5_000_000;
const REGLES_DEFAUT = { maximum: LIMITE_RETRAIT, plafondJourCompte: LIMITE_RETRAIT, plafondJourNumero: LIMITE_RETRAIT };

export class RetraitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RetraitError';
    this.code = code;
  }
}

const entierPositif = (v) => Number.isSafeInteger(v) && v > 0;

/** Frais de 5 % ajoutés au retrait, arrondis au centime supérieur : 500 G coûtent 525 G. */
export const fraisRetrait = (montant) => Math.ceil((montant * 5) / 100);

/** Stockage en mémoire pour les tests. En production, implémentez la même API avec une base transactionnelle. */
export class MemoryStore {
  #d = { comptes: new Map(), retraits: new Map(), idem: new Map(), credits: new Set(), ecritures: [] };
  #file = Promise.resolve();

  transaction(fn) {
    const execution = this.#file.then(async () => {
      const sauvegarde = structuredClone(this.#d);
      try {
        return await fn(this.#api());
      } catch (err) {
        this.#d = sauvegarde;
        throw err;
      }
    });
    this.#file = execution.catch(() => {});
    return execution;
  }

  #api() {
    const copie = (v) => (v === undefined ? null : structuredClone(v));
    return {
      getCompte: async (id) => copie(this.#d.comptes.get(id)),
      putCompte: async (c) => void this.#d.comptes.set(c.id, copie(c)),
      getRetrait: async (id) => copie(this.#d.retraits.get(id)),
      putRetrait: async (r) => void this.#d.retraits.set(r.id, copie(r)),
      getIdempotence: async (compteId, cle) => this.#d.idem.get(`${compteId}\n${cle}`) ?? null,
      setIdempotence: async (compteId, cle, id) => void this.#d.idem.set(`${compteId}\n${cle}`, id),
      hasCredit: async (reference) => this.#d.credits.has(reference),
      addCredit: async (reference) => void this.#d.credits.add(reference),
      addEcriture: async (e) => void this.#d.ecritures.push(copie(e)),
      getEcritures: async (compteId) => copie(this.#d.ecritures.filter((e) => e.compteId === compteId)),
      retraitsDepuis: async (date) => copie([...this.#d.retraits.values()].filter((r) => r.creeLe >= date)),
      retraitsParStatut: async (statuts) => copie([...this.#d.retraits.values()].filter((r) => statuts.includes(r.statut))),
    };
  }
}

export class ServiceRetraits {
  /**
   * @param {object} o
   * @param {object} o.store      voir MemoryStore
   * @param {{envoyer: Function, verifier: Function}} o.fournisseur
   * @param {{minimum:number, maximum:number, plafondJourCompte:number, plafondJourNumero:number}} o.regles
   * @param {(montant:number, methode:string)=>number} [o.frais=fraisRetrait]  frais en centimes
   * @param {Array<Function>} [o.conditions]  chaque condition renvoie true, ou un message de refus
   * @param {{secret:string, envoyer:Function, dureeMs?:number, maxTentatives?:number, maxEnvois?:number, delaiRenvoiMs?:number}} o.otp
   *   envoyer reçoit { compteId, retraitId, code, ... } et doit écrire au contact enregistré du compte,
   *   jamais au numéro de retrait saisi dans la demande.
   */
  constructor({ store, fournisseur, regles, frais = fraisRetrait, conditions = [], otp, maintenant = Date.now, genererId = randomUUID } = {}) {
    if (!store || typeof fournisseur?.envoyer !== 'function' || typeof fournisseur?.verifier !== 'function') {
      throw new RetraitError('CONFIGURATION', 'store et fournisseur (envoyer, verifier) sont obligatoires');
    }
    regles = { ...REGLES_DEFAUT, ...regles };
    for (const nom of ['minimum', 'maximum', 'plafondJourCompte', 'plafondJourNumero']) {
      if (!entierPositif(regles?.[nom])) throw new RetraitError('CONFIGURATION', `regles.${nom} est obligatoire`);
    }
    if (typeof frais !== 'function') throw new RetraitError('CONFIGURATION', 'frais est obligatoire');
    if (!Array.isArray(conditions) || conditions.some((c) => typeof c !== 'function')) {
      throw new RetraitError('CONFIGURATION', 'conditions doit être une liste de fonctions');
    }
    if (typeof otp?.envoyer !== 'function' || typeof otp?.secret !== 'string' || otp.secret.length < 32) {
      throw new RetraitError('CONFIGURATION', 'otp.envoyer et otp.secret (32 caractères minimum) sont obligatoires');
    }
    const reglesOtp = { ...OTP_DEFAUT, ...otp };
    for (const nom of Object.keys(OTP_DEFAUT)) {
      if (!entierPositif(reglesOtp[nom])) throw new RetraitError('CONFIGURATION', `otp.${nom} est invalide`);
    }
    Object.assign(this, { store, fournisseur, regles, frais, conditions, otp: reglesOtp, maintenant, genererId });
  }

  // ---------- Comptes ----------

  async ouvrirCompte(id) {
    if (!id) throw new RetraitError('COMPTE_INVALIDE', 'id de compte obligatoire');
    return this.store.transaction(async (tx) => {
      if (await tx.getCompte(id)) throw new RetraitError('COMPTE_EXISTANT', 'Ce compte existe déjà');
      const compte = { id, solde: 0, reserve: 0, caution: 0, actif: true };
      await tx.putCompte(compte);
      return compte;
    });
  }

  /** Crédite un compte. Une même référence n'est appliquée qu'une fois. */
  async crediter({ compteId, montant, reference }) {
    if (!entierPositif(montant) || !reference) throw new RetraitError('CREDIT_INVALIDE', 'montant et reference sont obligatoires');
    return this.store.transaction(async (tx) => {
      const compte = await this.#compte(tx, compteId);
      if (await tx.hasCredit(reference)) return compte;
      compte.solde += montant;
      await tx.addCredit(reference);
      await tx.putCompte(compte);
      await tx.addEcriture({ type: 'credit', compteId, montant, reference, date: this.maintenant() });
      return compte;
    });
  }

  async solde(compteId) {
    return this.store.transaction(async (tx) => {
      const c = await this.#compte(tx, compteId);
      return { solde: c.solde, reserve: c.reserve, caution: c.caution, disponible: Math.max(0, c.solde - c.reserve - c.caution) };
    });
  }

  /** Fixe la caution du compte. À appeler seulement depuis le serveur de l'application. */
  async definirCaution({ compteId, montant, motif = null }) {
    if (!Number.isSafeInteger(montant) || montant < 0) throw new RetraitError('CAUTION_INVALIDE', 'Caution invalide');
    return this.store.transaction(async (tx) => {
      const compte = await this.#compte(tx, compteId, { memeInactif: true });
      compte.caution = montant;
      await tx.putCompte(compte);
      await tx.addEcriture({ type: 'caution', compteId, montant, motif, date: this.maintenant() });
      return compte;
    });
  }

  // ---------- Retraits ----------

  /**
   * Réserve l'argent et envoie un code OTP. Rien ne part avant confirmer().
   * compteId doit venir de la session authentifiée, jamais du corps de la requête.
   */
  async demander({ compteId, montant, methode, numero, cleIdempotence }) {
    if (!entierPositif(montant)) throw new RetraitError('MONTANT_INVALIDE', 'Montant invalide');
    if (!METHODES.includes(methode)) throw new RetraitError('METHODE_INVALIDE', 'Méthode invalide');
    if (!/^509\d{8}$/.test(String(numero))) throw new RetraitError('NUMERO_INVALIDE', 'Le numéro doit avoir la forme 509XXXXXXXX');
    if (!cleIdempotence) throw new RetraitError('CLE_OBLIGATOIRE', "cleIdempotence est obligatoire");
    const r = this.regles;
    if (montant < r.minimum || montant > r.maximum) throw new RetraitError('MONTANT_HORS_LIMITES', 'Montant hors limites');
    const frais = this.frais(montant, methode);
    if (!Number.isSafeInteger(frais) || frais < 0) throw new RetraitError('FRAIS_INVALIDES', 'Frais invalides');

    const code = this.#nouveauCode();
    const { retrait, nouveau } = await this.store.transaction(async (tx) => {
      const existant = await tx.getIdempotence(compteId, cleIdempotence);
      if (existant) {
        const deja = await tx.getRetrait(existant);
        if (deja.montant !== montant || deja.methode !== methode || deja.numero !== String(numero)) {
          throw new RetraitError('CLE_REUTILISEE', 'Cette clé a déjà servi pour un autre retrait');
        }
        return { retrait: deja, nouveau: false };
      }

      const compte = await this.#compte(tx, compteId);
      const total = montant + frais;
      if (compte.solde - compte.reserve < total) throw new RetraitError('SOLDE_INSUFFISANT', 'Solde insuffisant');
      if (compte.solde - compte.reserve - compte.caution < total) {
        throw new RetraitError('CAUTION_BLOQUEE', 'Une partie du solde est bloquée par la caution');
      }

      await this.#verifierConditions(compte, { montant, frais, methode, numero: String(numero) });

      const date = this.maintenant();
      const recents = (await tx.retraitsDepuis(date - JOUR)).filter((x) => !NON_COMPTES.includes(x.statut));
      const somme = (liste) => liste.reduce((s, x) => s + x.montant, 0);
      if (somme(recents.filter((x) => x.compteId === compteId)) + montant > r.plafondJourCompte) {
        throw new RetraitError('PLAFOND_COMPTE', 'Plafond journalier du compte atteint');
      }
      if (somme(recents.filter((x) => x.numero === String(numero))) + montant > r.plafondJourNumero) {
        throw new RetraitError('PLAFOND_NUMERO', 'Plafond journalier de ce numéro atteint');
      }

      const id = this.genererId();
      const creation = {
        id,
        compteId,
        montant,
        frais,
        total,
        methode,
        numero: String(numero),
        statut: STATUT.EN_ATTENTE_OTP,
        creeLe: date,
        majLe: date,
        referenceExterne: null,
        motif: null,
        otp: { empreinte: this.#empreinte(id, code), expire: date + this.otp.dureeMs, tentatives: 0, envois: 1, dernierEnvoi: date },
      };
      compte.reserve += total;
      await tx.putCompte(compte);
      await tx.putRetrait(creation);
      await tx.setIdempotence(compteId, cleIdempotence, creation.id);
      await tx.addEcriture({ type: 'reserve', compteId, montant: total, retraitId: creation.id, date });
      return { retrait: creation, nouveau: true };
    });

    if (!nouveau) return this.#public(retrait);
    try {
      await this.#envoyerCode(retrait, code);
    } catch {
      await this.store.transaction(async (tx) => {
        const r = await this.#retrait(tx, retrait.id);
        if (r.statut === STATUT.EN_ATTENTE_OTP) await this.#liberer(tx, { ...r, statut: STATUT.ANNULE, otp: null, motif: 'Code OTP non envoyé' });
      });
      throw new RetraitError('OTP_NON_ENVOYE', "Le code n'a pas pu être envoyé. Réessayez.");
    }
    return this.#public(retrait);
  }

  /** Vérifie le code, puis lance le retrait une seule fois. */
  async confirmer({ retraitId, compteId, code }) {
    const issue = await this.store.transaction(async (tx) => {
      const r = await this.#retraitEnAttente(tx, retraitId, compteId);
      if (this.maintenant() >= r.otp.expire) {
        await this.#liberer(tx, { ...r, statut: STATUT.EXPIRE, otp: null, motif: 'Code OTP expiré' });
        return { erreur: ['OTP_EXPIRE', 'Ce code a expiré. Refaites la demande.'] };
      }
      if (!this.#codeValide(r, code)) {
        const tentatives = r.otp.tentatives + 1;
        if (tentatives >= this.otp.maxTentatives) {
          await this.#liberer(tx, { ...r, statut: STATUT.ANNULE, otp: null, motif: 'Trop de codes incorrects' });
          return { erreur: ['OTP_TENTATIVES', 'Trop de codes incorrects. Le retrait est annulé.'] };
        }
        await this.#maj(tx, { ...r, otp: { ...r.otp, tentatives } });
        return { erreur: ['OTP_INCORRECT', `Code incorrect. Essais restants : ${this.otp.maxTentatives - tentatives}.`] };
      }

      // La situation du compte a pu changer depuis la demande
      const compte = await this.#compte(tx, r.compteId);
      if (compte.solde - compte.reserve < compte.caution) {
        throw new RetraitError('CAUTION_BLOQUEE', 'Une partie du solde est bloquée par la caution');
      }
      await this.#verifierConditions(compte, { montant: r.montant, frais: r.frais, methode: r.methode, numero: r.numero });
      return { retrait: await this.#maj(tx, { ...r, statut: STATUT.ENVOI, otp: null }) };
    });
    if (issue.erreur) throw new RetraitError(...issue.erreur);
    return this.#public(await this.#executer(issue.retrait));
  }

  /** Envoie un nouveau code et invalide l'ancien. Les essais déjà faits restent comptés. */
  async renvoyerOtp({ retraitId, compteId }) {
    const code = this.#nouveauCode();
    const issue = await this.store.transaction(async (tx) => {
      const r = await this.#retraitEnAttente(tx, retraitId, compteId);
      const date = this.maintenant();
      if (date >= r.otp.expire) {
        await this.#liberer(tx, { ...r, statut: STATUT.EXPIRE, otp: null, motif: 'Code OTP expiré' });
        return { erreur: ['OTP_EXPIRE', 'Ce code a expiré. Refaites la demande.'] };
      }
      if (r.otp.envois >= this.otp.maxEnvois) return { erreur: ['OTP_RENVOIS', 'Nombre maximum de codes atteint.'] };
      if (date - r.otp.dernierEnvoi < this.otp.delaiRenvoiMs) return { erreur: ['OTP_TROP_TOT', 'Patientez avant de demander un nouveau code.'] };
      const otp = { ...r.otp, empreinte: this.#empreinte(r.id, code), expire: date + this.otp.dureeMs, envois: r.otp.envois + 1, dernierEnvoi: date };
      return { retrait: await this.#maj(tx, { ...r, otp }) };
    });
    if (issue.erreur) throw new RetraitError(...issue.erreur);
    try {
      await this.#envoyerCode(issue.retrait, code);
    } catch {
      throw new RetraitError('OTP_NON_ENVOYE', "Le code n'a pas pu être envoyé. Réessayez.");
    }
    return this.#public(issue.retrait);
  }

  /** Le client abandonne avant d'avoir confirmé : l'argent redevient disponible. */
  async annuler({ retraitId, compteId }) {
    return this.store.transaction(async (tx) => {
      const r = await this.#retraitEnAttente(tx, retraitId, compteId);
      return this.#public(await this.#liberer(tx, { ...r, statut: STATUT.ANNULE, otp: null, motif: 'Annulé par le client' }));
    });
  }

  /** Libère l'argent des demandes dont le code a expiré. */
  async expirerOtp() {
    return this.store.transaction(async (tx) => {
      const date = this.maintenant();
      const expires = (await tx.retraitsParStatut([STATUT.EN_ATTENTE_OTP])).filter((r) => date >= r.otp.expire);
      for (const r of expires) await this.#liberer(tx, { ...r, statut: STATUT.EXPIRE, otp: null, motif: 'Code OTP expiré' });
      return expires.length;
    });
  }

  /** À lancer périodiquement. Libère les OTP expirés et interroge le fournisseur sans jamais renvoyer un retrait. */
  async reconcilier({ ageMinimumMs = 60_000 } = {}) {
    await this.expirerOtp();
    const limite = this.maintenant() - ageMinimumMs;
    const aTraiter = await this.store.transaction(async (tx) =>
      (await tx.retraitsParStatut([STATUT.ENVOI, STATUT.A_VERIFIER])).filter((r) => r.majLe <= limite));
    const bilan = { verifies: 0, regles: 0, restants: 0 };
    for (const r of aTraiter) {
      bilan.verifies += 1;
      let resultat;
      try {
        resultat = await this.fournisseur.verifier(r.id);
      } catch {
        resultat = { statut: 'inconnu' };
      }
      const apres = await this.#appliquer(r.id, resultat);
      if ([STATUT.PAYE, STATUT.ECHOUE].includes(apres.statut)) bilan.regles += 1;
      else bilan.restants += 1;
    }
    return bilan;
  }

  // ---------- Interne ----------

  #nouveauCode() {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  #empreinte(id, code) {
    return createHmac('sha256', this.otp.secret).update(`${id}:${code}`).digest('hex');
  }

  #codeValide(r, code) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
    return timingSafeEqual(Buffer.from(this.#empreinte(r.id, code)), Buffer.from(r.otp.empreinte));
  }

  #envoyerCode(r, code) {
    return this.otp.envoyer({
      compteId: r.compteId,
      retraitId: r.id,
      code,
      montant: r.montant,
      frais: r.frais,
      total: r.total,
      methode: r.methode,
      numero: r.numero,
      expireDansMs: this.otp.dureeMs,
    });
  }

  #public(r) {
    const { otp, ...retrait } = r;
    return retrait;
  }

  // Une condition en erreur vaut un refus
  async #verifierConditions(compte, demande) {
    for (const condition of this.conditions) {
      let reponse;
      try {
        reponse = await condition({ compte: structuredClone(compte), ...demande });
      } catch {
        reponse = false;
      }
      if (reponse !== true) {
        throw new RetraitError('CONDITION_NON_REMPLIE', typeof reponse === 'string' ? reponse : 'Condition de retrait non remplie');
      }
    }
  }

  async #retraitEnAttente(tx, id, compteId) {
    const r = await this.#retrait(tx, id);
    if (r.compteId !== compteId) throw new RetraitError('RETRAIT_INTROUVABLE', 'Retrait introuvable');
    if (r.statut !== STATUT.EN_ATTENTE_OTP) throw new RetraitError('OTP_DEJA_TRAITE', 'Ce retrait a déjà été traité');
    return r;
  }

  async #executer(r) {
    let resultat;
    try {
      resultat = await this.fournisseur.envoyer({ reference: r.id, montant: r.montant, methode: r.methode, numero: r.numero });
    } catch {
      resultat = { statut: 'inconnu' }; // Le fournisseur a peut-être payé : on ne renvoie pas
    }
    return this.#appliquer(r.id, resultat);
  }

  #appliquer(id, resultat) {
    return this.store.transaction(async (tx) => {
      const r = await this.#retrait(tx, id);
      if (![STATUT.ENVOI, STATUT.A_VERIFIER].includes(r.statut)) return r;
      if (resultat?.statut === 'succes') {
        const compte = await this.#compte(tx, r.compteId, { memeInactif: true });
        compte.solde -= r.total;
        compte.reserve -= r.total;
        await tx.putCompte(compte);
        await tx.addEcriture({ type: 'debit', compteId: r.compteId, montant: r.total, retraitId: r.id, date: this.maintenant() });
        return this.#maj(tx, { ...r, statut: STATUT.PAYE, referenceExterne: resultat.referenceExterne ?? null });
      }
      if (resultat?.statut === 'echec') {
        return this.#liberer(tx, { ...r, statut: STATUT.ECHOUE, motif: resultat.motif ?? 'Échec du fournisseur' });
      }
      return this.#maj(tx, { ...r, statut: STATUT.A_VERIFIER });
    });
  }

  async #liberer(tx, r) {
    const compte = await this.#compte(tx, r.compteId, { memeInactif: true });
    compte.reserve -= r.total;
    await tx.putCompte(compte);
    await tx.addEcriture({ type: 'liberation', compteId: r.compteId, montant: r.total, retraitId: r.id, date: this.maintenant() });
    return this.#maj(tx, r);
  }

  async #maj(tx, r) {
    const retrait = { ...r, majLe: this.maintenant() };
    await tx.putRetrait(retrait);
    return retrait;
  }

  async #compte(tx, id, { memeInactif = false } = {}) {
    const c = await tx.getCompte(id);
    if (!c) throw new RetraitError('COMPTE_INTROUVABLE', 'Compte introuvable');
    if (!c.actif && !memeInactif) throw new RetraitError('COMPTE_INACTIF', 'Compte inactif');
    return c;
  }

  async #retrait(tx, id) {
    const r = await tx.getRetrait(id);
    if (!r) throw new RetraitError('RETRAIT_INTROUVABLE', 'Retrait introuvable');
    return r;
  }
}
