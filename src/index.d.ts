export interface MonCashOptions {
  clientId: string;
  clientSecret: string;
  mode?: 'sandbox' | 'live';
  /** Délai max d'une requête en millisecondes (30000 par défaut) */
  timeout?: number;
  /** Fonction fetch personnalisée (pour les tests) */
  fetch?: typeof fetch;
}

export interface CreatedPayment {
  token: string;
  redirectUrl: string;
  expiresAt?: string;
  raw: any;
}

export interface Payment {
  reference: string;
  transactionId: string;
  cost: number;
  message: string;
  payer: string;
  raw: any;
}

export declare class MonCashError extends Error {
  status?: number;
  body?: any;
}

export declare class MonCash {
  constructor(options: MonCashOptions);
  readonly mode: 'sandbox' | 'live';
  getToken(): Promise<string>;
  createPayment(params: { amount: number; orderId: string | number }): Promise<CreatedPayment>;
  getRedirectUrl(token: string): string;
  getPaymentByTransactionId(transactionId: string): Promise<Payment>;
  getPaymentByOrderId(orderId: string | number): Promise<Payment>;
  verifyPayment(params: {
    transactionId?: string;
    orderId?: string | number;
    amount?: number;
  }): Promise<{ ok: boolean; payment: Payment }>;
  transfer(params: {
    amount: number;
    receiver: string;
    desc?: string;
    reference?: string;
  }): Promise<any>;
  customerStatus(account: string): Promise<any>;
  prefundedBalance(): Promise<any>;
}


// ---------- NatCash ----------

export interface NatCashOptions {
  privateKey: string;
  partnerCode: string;
  functionCode: string;
  username: string;
  password: string;
  callbackUrl: string;
  mode?: 'sandbox' | 'live';
  enableFee?: boolean;
  language?: 'ht' | 'fr' | 'en';
  timeout?: number;
  fetch?: typeof fetch;
}

export interface NatCashPayment {
  orderId: string;
  transactionId: string;
  amount: number;
  payer: string;
  success: boolean;
  raw: any;
}

export interface NatCashCallbackQuery {
  orderNumber?: string;
  code?: string | number;
  signature?: string;
}

export declare const NATCASH_CODE: { SUCCES: 1; ECHEC: -1; INCONNU: -3 };

export declare class NatCashError extends Error {
  status?: number;
  code?: string;
  body?: any;
}

export declare class NatCash {
  constructor(options: NatCashOptions);
  readonly mode: 'sandbox' | 'live';
  createPayment(params: {
    amount: number;
    orderId: string | number;
    msisdn?: string;
    skipPhoneInput?: boolean;
  }): Promise<{ redirectUrl: string; expiresIn?: number; raw: any }>;
  getPaymentByOrderId(orderId: string | number): Promise<NatCashPayment>;
  verifyCallback(query: NatCashCallbackQuery): boolean;
  verifyPayment(params: {
    query?: NatCashCallbackQuery;
    orderId?: string | number;
    amount?: number;
  }): Promise<{ ok: boolean; reason?: string; payment: NatCashPayment | null }>;
}

export default MonCash;
