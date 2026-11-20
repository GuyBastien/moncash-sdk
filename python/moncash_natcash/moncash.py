"""Client MonCash (API REST "MonCash Button" de Digicel Haïti)."""

from __future__ import annotations

import base64
import json
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import quote

from ._http import Transport, parse_json, urllib_transport

HOSTS = {
    "sandbox": {
        "api": "https://sandbox.moncashbutton.digicelgroup.com/Api",
        "gateway": "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware",
    },
    "live": {
        "api": "https://moncashbutton.digicelgroup.com/Api",
        "gateway": "https://moncashbutton.digicelgroup.com/Moncash-middleware",
    },
}


class MonCashError(Exception):
    def __init__(self, message: str, status: Optional[int] = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


def _check_amount(amount: Any) -> None:
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount <= 0 or amount != amount:
        raise MonCashError("amount doit être un nombre positif")


class MonCash:
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        mode: str = "sandbox",
        timeout: float = 30,
        transport: Optional[Transport] = None,
    ):
        if not client_id or not client_secret:
            raise MonCashError("client_id et client_secret sont obligatoires")
        if mode not in HOSTS:
            raise MonCashError(f'mode invalide : "{mode}" (utilisez "sandbox" ou "live")')
        self.client_id = client_id
        self.client_secret = client_secret
        self.mode = mode
        self.timeout = timeout
        self.hosts = HOSTS[mode]
        self._transport = transport or urllib_transport
        self._token: Optional[str] = None
        self._token_expire = 0.0
        self._lock = threading.Lock()

    # ---------- Jeton d'accès ----------

    def get_token(self) -> str:
        with self._lock:
            if self._token and time.time() < self._token_expire - 5:
                return self._token
            basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
            body = self._send(
                "POST",
                f"{self.hosts['api']}/oauth/token",
                {
                    "Authorization": f"Basic {basic}",
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                b"scope=read,write&grant_type=client_credentials",
            )
            if not isinstance(body, dict) or not body.get("access_token"):
                raise MonCashError("MonCash n'a pas renvoyé de jeton", body=body)
            self._token = body["access_token"]
            self._token_expire = time.time() + float(body.get("expires_in") or 59)
            return self._token

    # ---------- Paiements ----------

    def create_payment(self, amount: float, order_id: Any) -> Dict[str, Any]:
        """Crée un paiement et renvoie {token, redirect_url, expires_at, raw}."""
        _check_amount(amount)
        if order_id is None or order_id == "":
            raise MonCashError("order_id est obligatoire")
        body = self._api("POST", "/v1/CreatePayment", {"amount": amount, "orderId": str(order_id)})
        token = ((body or {}).get("payment_token") or {}).get("token")
        if not token:
            raise MonCashError("MonCash n'a pas renvoyé de payment_token", body=body)
        return {
            "token": token,
            "redirect_url": self.get_redirect_url(token),
            "expires_at": body["payment_token"].get("expired"),
            "raw": body,
        }

    def get_redirect_url(self, token: str) -> str:
        return f"{self.hosts['gateway']}/Payment/Redirect?token={quote(token, safe='')}"

    def get_payment_by_transaction_id(self, transaction_id: Any) -> Dict[str, Any]:
        if not transaction_id:
            raise MonCashError("transaction_id est obligatoire")
        body = self._api("POST", "/v1/RetrieveTransactionPayment", {"transactionId": str(transaction_id)})
        return _format_payment(body)

    def get_payment_by_order_id(self, order_id: Any) -> Dict[str, Any]:
        if not order_id:
            raise MonCashError("order_id est obligatoire")
        body = self._api("POST", "/v1/RetrieveOrderPayment", {"orderId": str(order_id)})
        return _format_payment(body)

    def verify_payment(
        self,
        transaction_id: Any = None,
        order_id: Any = None,
        amount: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Renvoie {ok, payment} : ok vrai seulement si payé, bonne commande, bon montant."""
        try:
            if transaction_id:
                p = self.get_payment_by_transaction_id(transaction_id)
            else:
                p = self.get_payment_by_order_id(order_id)
        except MonCashError as err:
            # Paiement introuvable : ce n'est pas une panne, juste "pas payé"
            if err.status == 404:
                return {"ok": False, "payment": None}
            raise
        ok_message = str(p.get("message") or "").lower() == "successful"
        ok_order = order_id is None or str(p.get("reference")) == str(order_id)
        ok_amount = amount is None or float(p.get("cost") or 0) == float(amount)
        return {"ok": ok_message and ok_order and ok_amount, "payment": p}

    # ---------- Transferts et compte marchand ----------

    def transfer(self, amount: float, receiver: str, desc: str = "", reference: Any = None) -> Any:
        _check_amount(amount)
        if not receiver:
            raise MonCashError("receiver (numéro du client) est obligatoire")
        data = {"amount": amount, "receiver": str(receiver), "desc": desc}
        if reference is not None:
            data["reference"] = str(reference)
        return self._api("POST", "/v1/Transfert", data)

    def customer_status(self, account: str) -> Any:
        if not account:
            raise MonCashError("account (numéro du client) est obligatoire")
        return self._api("POST", "/v1/CustomerStatus", {"account": str(account)})

    def prefunded_balance(self) -> Any:
        return self._api("GET", "/v1/PrefundedBalance")

    # ---------- Interne ----------

    def _api(self, method: str, path: str, data: Any = None, retry: bool = True) -> Any:
        token = self.get_token()
        try:
            return self._send(
                method,
                f"{self.hosts['api']}{path}",
                {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                None if data is None else json.dumps(data).encode(),
            )
        except MonCashError as err:
            # Jeton expiré ou refusé : on en redemande un, une seule fois
            if retry and err.status == 401:
                with self._lock:
                    self._token = None
                return self._api(method, path, data, retry=False)
            raise

    def _send(self, method: str, url: str, headers: Dict[str, str], body: Optional[bytes]) -> Any:
        try:
            status, texte = self._transport(method, url, headers, body, self.timeout)
        except Exception as err:  # réseau, délai dépassé...
            raise MonCashError(f"Impossible de joindre MonCash : {err}") from err
        data = parse_json(texte)
        if not 200 <= status < 300:
            msg = None
            if isinstance(data, dict):
                msg = data.get("message") or data.get("error_description") or data.get("error")
            raise MonCashError(f"MonCash : {msg or f'HTTP {status}'}", status=status, body=data)
        return data


def _format_payment(body: Any) -> Dict[str, Any]:
    p = body.get("payment") if isinstance(body, dict) else None
    if not p:
        raise MonCashError("MonCash n'a pas renvoyé de paiement", body=body)
    return {
        "reference": p.get("reference"),
        "transaction_id": p.get("transaction_id"),
        "cost": p.get("cost"),
        "message": p.get("message"),
        "payer": p.get("payer"),
        "raw": body,
    }
