// Client NatCash (Natcom Haïti)
// Natcom ne publie pas de documentation publique : ce client suit le
// fonctionnement des SDK open source php-natcash-sdk et natcashify
// (Louis Midson Lajeanty, licence MIT).

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const HOSTS = {
  sandbox: 'https://testmerchantpay.natcom.com.ht/api/online-payment/',
  live: 'https://merchantpay.natcom.com.ht/api/online-payment/',
};

const LANGUES = ['ht', 'fr', 'en'];

/** Codes envoyés par NatCash dans l'URL de retour */
export const NATCASH_CODE = { SUCCES: 1, ECHEC: -1, INCONNU: -3 };

export class NatCashError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'NatCashError';
    this.status = status; // code HTTP ou statut NatCash
    this.code = code;
    this.body = body;
  }
}

const sha256 = (texte) => createHash('sha256').update(texte).digest('hex');
const hmac = (cle, texte) => createHmac('sha256', cle).update(texte).digest('hex');

// Montant écrit comme en PHP : 100 -> "100", 250.5 -> "250.5"
function formatMontant(montant) {
  return Number.isInteger(montant) ? String(montant) : String(Number(montant.toFixed(2)));
}

export class NatCash {
  /**
   * @param {object} options
   * @param {string} options.privateKey   clé privée donnée par Natcom
   * @param {string} options.partnerCode
   * @param {string} options.functionCode
   * @param {string} options.username
   * @param {string} options.password
   * @param {string} options.callbackUrl  URL où NatCash renvoie le client
   * @param {'sandbox'|'live'} [options.mode='sandbox']
   * @param {boolean} [options.enableFee=true]
   * @param {'ht'|'fr'|'en'} [options.language='ht']
   */
  constructor({
    privateKey,
    partnerCode,
    functionCode,
    username,
    password,
    callbackUrl,
    mode = 'sandbox',
    enableFee = true,
    language = 'ht',
    timeout = 30000,
    fetch: customFetch,
  } = {}) {
    const requis = { privateKey, partnerCode, functionCode, username, password, callbackUrl };
    for (const [nom, valeur] of Object.entries(requis)) {
      if (!valeur) throw new NatCashError(`${nom} est obligatoire`);
    }
    try {
      new URL(callbackUrl);
    } catch {
      throw new NatCashError('callbackUrl doit être une URL valide');
    }
    if (!HOSTS[mode]) throw new NatCashError(`mode invalide : "${mode}" (utilisez "sandbox" ou "live")`);
    if (!LANGUES.includes(language)) throw new NatCashError('language doit être "ht", "fr" ou "en"');

    this.config = { privateKey, partnerCode, functionCode, username, password, callbackUrl, enableFee: Boolean(enableFee), language };
    this.mode = mode;
    this.baseUrl = HOSTS[mode];
    this.timeout = timeout;
    this._fetch = customFetch || globalThis.fetch;
  }

  /**
   * Crée un paiement et renvoie le lien de la page NatCash.
   * @param {{ amount: number, orderId: string|number, msisdn?: string, skipPhoneInput?: boolean }} params
   */
  async createPayment({ amount, orderId, msisdn, skipPhoneInput = false } = {}) {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new NatCashError('amount doit être un nombre positif');
    }
    if (Math.round(amount * 100) / 100 !== amount) {
      throw new NatCashError('amount ne peut pas avoir plus de 2 décimales');
    }
    if (orderId === undefined || orderId === null || orderId === '') {
      throw new NatCashError('orderId est obligatoire');
    }
    if (msisdn !== undefined && !/^509\d{8}$/.test(String(msisdn))) {
      throw new NatCashError('msisdn doit avoir la forme 509XXXXXXXX');
    }
    if (skipPhoneInput && !msisdn) {
      throw new NatCashError('msisdn est obligatoire quand skipPhoneInput est vrai');
    }

    const body = await this._post('credential', this._paymentPayload({
      orderNumber: String(orderId),
      amount,
      msisdn: msisdn === undefined ? undefined : String(msisdn),
      skipPhoneInput: Boolean(skipPhoneInput),
    }));
    if (!body?.url) throw new NatCashError("NatCash n'a pas renvoyé de lien de paiement", { body });
    return { redirectUrl: body.url, expiresIn: body.expiredAt, raw: body };
  }

  /** Infos d'une transaction à partir de votre orderId */
  async getPaymentByOrderId(orderId) {
    if (!orderId) throw new NatCashError('orderId est obligatoire');
    const body = await this._post('merchant/checkTransaction', this._transactionPayload(String(orderId)));
    const d = body?.data;
    if (!d) throw new NatCashError("NatCash n'a pas renvoyé de transaction", { body });
    return {
      orderId: d.orderNumber,
      transactionId: d.transId,
      // NatCash peut écrire le montant avec des virgules : "3,162.00"
      amount: typeof d.amount === 'string' ? Number(d.amount.replace(/[, ]/g, '')) : Number(d.amount),
      payer: d.toPhone,
      success: Number(d.responseCode) === NATCASH_CODE.SUCCES,
      raw: body,
    };
  }

  /**
   * Vérifie la signature de l'URL de retour (?orderNumber=..&code=..&signature=..).
   * Ne suffit pas seul : appelez ensuite verifyPayment pour confirmer le montant.
   */
  verifyCallback({ orderNumber, code, signature } = {}) {
    if (!orderNumber || code === undefined || !signature) return false;
    const attendu = this._callbackSignature(String(orderNumber), Number(code));
    const recu = String(signature).trim().toLowerCase();
    if (recu.length !== attendu.length) return false;
    return timingSafeEqual(Buffer.from(attendu), Buffer.from(recu));
  }

  /**
   * Vérifie la signature, puis demande la transaction à NatCash
   * et contrôle le montant. À utiliser dans votre page de retour.
   * @param {{ query?: object, orderId?: string, amount?: number }} params
   */
  async verifyPayment({ query, orderId, amount } = {}) {
    if (query) {
      if (!this.verifyCallback(query)) return { ok: false, reason: 'signature invalide', payment: null };
      if (orderId !== undefined && String(query.orderNumber) !== String(orderId)) {
        return { ok: false, reason: 'commande différente', payment: null };
      }
      orderId = query.orderNumber;
    }
    const payment = await this.getPaymentByOrderId(orderId);
    if (!payment.success) return { ok: false, reason: 'paiement non réussi', payment };
    if (String(payment.orderId) !== String(orderId)) return { ok: false, reason: 'commande différente', payment };
    if (amount !== undefined && Math.abs(payment.amount - amount) > 0.001) {
      return { ok: false, reason: 'montant différent', payment };
    }
    return { ok: true, payment };
  }

  // ---------- Signatures ----------

  _paymentPayload({ orderNumber, amount, msisdn, skipPhoneInput }, { requestId = randomUUID(), timestamp = Date.now() } = {}) {
    const c = this.config;
    const signature = hmac(
      c.privateKey,
      sha256(c.privateKey + requestId) +
        c.partnerCode + c.username + c.password +
        timestamp + requestId + orderNumber + formatMontant(amount)
    );
    const data = {
      partnerCode: c.partnerCode,
      username: c.username,
      password: c.password,
      callbackUrl: c.callbackUrl,
      enableFee: c.enableFee,
      language: c.language,
      orderNumber,
      amount,
      timestamp,
      requestId,
      skipPhoneInput,
    };
    if (msisdn !== undefined) data.msisdn = msisdn;
    data.signature = signature;
    return data;
  }

  _transactionPayload(orderNumber, requestId = randomUUID()) {
    const c = this.config;
    return {
      requestId,
      username: c.username,
      password: c.password,
      partnerCode: c.partnerCode,
      orderNumber,
      signature: hmac(
        c.privateKey,
        sha256(c.privateKey + requestId) + c.partnerCode + c.username + c.password + orderNumber + requestId
      ),
    };
  }

  _callbackSignature(orderNumber, code) {
    const f = this.config.functionCode;
    return hmac(f, sha256(f + orderNumber) + orderNumber + code);
  }

  // ---------- HTTP ----------

  async _post(chemin, data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let res;
    try {
      res = await this._fetch(this.baseUrl + chemin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'délai dépassé' : err.message;
      throw new NatCashError(`Impossible de joindre NatCash : ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new NatCashError(`NatCash : ${body?.message || `HTTP ${res.status}`}`, {
        status: res.status,
        code: body?.code,
        body,
      });
    }
    // NatCash répond 200 avec status != 0 en cas d'erreur
    if (!body || body.status !== 0) {
      throw new NatCashError(`NatCash : ${body?.message || 'réponse invalide'}`, {
        status: body?.status,
        code: body?.code,
        body,
      });
    }
    return body;
  }
}

export default NatCash;
