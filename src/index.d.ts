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

export default MonCash;
