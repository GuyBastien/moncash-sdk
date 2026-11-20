// SDK MonCash pour Node.js (API REST "MonCash Button" de Digicel Haïti)

const HOSTS = {
  sandbox: {
    api: 'https://sandbox.moncashbutton.digicelgroup.com/Api',
    gateway: 'https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware',
  },
  live: {
    api: 'https://moncashbutton.digicelgroup.com/Api',
    gateway: 'https://moncashbutton.digicelgroup.com/Moncash-middleware',
  },
};

export class MonCashError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'MonCashError';
    this.status = status;
    this.body = body;
  }
}

export class MonCash {
  /**
   * @param {object} options
   * @param {string} options.clientId
   * @param {string} options.clientSecret
   * @param {'sandbox'|'live'} [options.mode='sandbox']
   * @param {number} [options.timeout=30000] délai max d'une requête (ms)
   */
  constructor({ clientId, clientSecret, mode = 'sandbox', timeout = 30000, fetch: customFetch } = {}) {
    if (!clientId || !clientSecret) {
      throw new MonCashError('clientId et clientSecret sont obligatoires');
    }
    if (!HOSTS[mode]) {
      throw new MonCashError(`mode invalide : "${mode}" (utilisez "sandbox" ou "live")`);
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.mode = mode;
    this.timeout = timeout;
    this.hosts = HOSTS[mode];
    this._fetch = customFetch || globalThis.fetch;
    this._token = null;
    this._tokenExpire = 0;
    this._tokenPromise = null;
  }

  // ---------- Jeton d'accès ----------

  async getToken() {
    // On garde le jeton jusqu'à 5 secondes avant son expiration
    if (this._token && Date.now() < this._tokenExpire - 5000) return this._token;
    // Si plusieurs requêtes demandent un jeton en même temps, une seule est envoyée
    if (!this._tokenPromise) {
      this._tokenPromise = this._requestToken().finally(() => {
        this._tokenPromise = null;
      });
    }
    return this._tokenPromise;
  }

  async _requestToken() {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = await this._send(`${this.hosts.api}/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'scope=read,write&grant_type=client_credentials',
    });
    if (!body || !body.access_token) {
      throw new MonCashError("MonCash n'a pas renvoyé de jeton", { body });
    }
    this._token = body.access_token;
    this._tokenExpire = Date.now() + (Number(body.expires_in) || 59) * 1000;
    return this._token;
  }

  // ---------- Paiements ----------

  /**
   * Crée un paiement et renvoie le lien où envoyer le client.
   * @param {{ amount: number, orderId: string|number }} params
   */
  async createPayment({ amount, orderId } = {}) {
    checkAmount(amount);
    if (orderId === undefined || orderId === null || orderId === '') {
      throw new MonCashError('orderId est obligatoire');
    }
    const body = await this._api('POST', '/v1/CreatePayment', { amount, orderId: String(orderId) });
    const token = body?.payment_token?.token;
    if (!token) throw new MonCashError("MonCash n'a pas renvoyé de payment_token", { body });
    return {
      token,
      redirectUrl: this.getRedirectUrl(token),
      expiresAt: body.payment_token.expired,
      raw: body,
    };
  }

  /** Lien de la page MonCash pour un token de paiement */
  getRedirectUrl(token) {
    return `${this.hosts.gateway}/Payment/Redirect?token=${encodeURIComponent(token)}`;
  }

  /** Infos d'un paiement à partir du transactionId (reçu dans l'URL de retour) */
  async getPaymentByTransactionId(transactionId) {
    if (!transactionId) throw new MonCashError('transactionId est obligatoire');
    const body = await this._api('POST', '/v1/RetrieveTransactionPayment', {
      transactionId: String(transactionId),
    });
    return formatPayment(body);
  }

  /** Infos d'un paiement à partir de votre orderId */
  async getPaymentByOrderId(orderId) {
    if (!orderId) throw new MonCashError('orderId est obligatoire');
    const body = await this._api('POST', '/v1/RetrieveOrderPayment', { orderId: String(orderId) });
    return formatPayment(body);
  }

  /**
   * Vérifie qu'un paiement est bien réussi ET correspond au montant attendu.
   * À utiliser avant de valider une commande.
   */
  async verifyPayment({ transactionId, orderId, amount }) {
    let p;
    try {
      p = transactionId
        ? await this.getPaymentByTransactionId(transactionId)
        : await this.getPaymentByOrderId(orderId);
    } catch (err) {
      // Paiement introuvable : ce n'est pas une panne, juste "pas payé"
      if (err instanceof MonCashError && err.status === 404) return { ok: false, payment: null };
      throw err;
    }
    const okMessage = String(p.message || '').toLowerCase() === 'successful';
    const okOrder = orderId === undefined || String(p.reference) === String(orderId);
    const okAmount = amount === undefined || Number(p.cost) === Number(amount);
    return { ok: okMessage && okOrder && okAmount, payment: p };
  }

  // ---------- Transferts et compte marchand ----------

  /** Envoie de l'argent du compte marchand vers un client MonCash */
  async transfer({ amount, receiver, desc = '', reference } = {}) {
    checkAmount(amount);
    if (!receiver) throw new MonCashError('receiver (numéro du client) est obligatoire');
    const data = { amount, receiver: String(receiver), desc };
    if (reference !== undefined) data.reference = String(reference);
    return this._api('POST', '/v1/Transfert', data);
  }

  /** Statut d'un compte client MonCash (existe, KYC, etc.) */
  async customerStatus(account) {
    if (!account) throw new MonCashError('account (numéro du client) est obligatoire');
    return this._api('POST', '/v1/CustomerStatus', { account: String(account) });
  }

  /** Solde prépayé du compte marchand */
  async prefundedBalance() {
    return this._api('GET', '/v1/PrefundedBalance');
  }

  // ---------- Interne ----------

  async _api(method, path, data, retry = true) {
    const token = await this.getToken();
    try {
      return await this._send(`${this.hosts.api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    } catch (err) {
      // Jeton expiré ou refusé : on en redemande un, une seule fois
      if (retry && err instanceof MonCashError && err.status === 401) {
        this._token = null;
        return this._api(method, path, data, false);
      }
      throw err;
    }
  }

  async _send(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let res;
    try {
      res = await this._fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'délai dépassé' : err.message;
      throw new MonCashError(`Impossible de joindre MonCash : ${msg}`);
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
      const msg =
        (body && (body.message || body.error_description || body.error)) || `HTTP ${res.status}`;
      throw new MonCashError(`MonCash : ${msg}`, { status: res.status, body });
    }
    return body;
  }
}

function checkAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new MonCashError('amount doit être un nombre positif');
  }
}

function formatPayment(body) {
  const p = body?.payment;
  if (!p) throw new MonCashError("MonCash n'a pas renvoyé de paiement", { body });
  return {
    reference: p.reference,
    transactionId: p.transaction_id,
    cost: p.cost,
    message: p.message,
    payer: p.payer,
    raw: body,
  };
}

export { NatCash, NatCashError, NATCASH_CODE } from "./natcash.js";

export default MonCash;
