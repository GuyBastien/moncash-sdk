"""Client NatCash (Natcom Haïti).

Natcom ne publie pas de documentation publique : ce client suit le
fonctionnement des SDK open source php-natcash-sdk et natcashify
(Louis Midson Lajeanty, licence MIT).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, Mapping, Optional, Union
from urllib.parse import urlparse

from ._http import Transport, parse_json, urllib_transport

HOSTS = {
    "sandbox": "https://testmerchantpay.natcom.com.ht/api/online-payment/",
    "live": "https://merchantpay.natcom.com.ht/api/online-payment/",
}
LANGUES = ("ht", "fr", "en")

CODE_SUCCES = 1
CODE_ECHEC = -1
CODE_INCONNU = -3

Montant = Union[int, float, Decimal, str]


class NatCashError(Exception):
    def __init__(self, message: str, status: Any = None, code: Optional[str] = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


def _sha256(texte: str) -> str:
    return hashlib.sha256(texte.encode()).hexdigest()


def _hmac(cle: str, texte: str) -> str:
    return hmac.new(cle.encode(), texte.encode(), hashlib.sha256).hexdigest()


def _to_decimal(amount: Montant) -> Decimal:
    if isinstance(amount, bool):
        raise NatCashError("amount doit être un nombre positif")
    try:
        value = Decimal(str(amount))
    except (InvalidOperation, ValueError):
        raise NatCashError("amount doit être un nombre positif") from None
    if not value.is_finite() or value <= 0:
        raise NatCashError("amount doit être un nombre positif")
    if value != value.quantize(Decimal("0.01")):
        raise NatCashError("amount ne peut pas avoir plus de 2 décimales")
    return value


def _format_montant(value: Decimal) -> str:
    # Comme en PHP : 100 -> "100", 250.50 -> "250.5"
    if value == value.to_integral_value():
        return str(int(value))
    return format(value.normalize(), "f")


def _wire_montant(value: Decimal) -> Union[int, float]:
    return int(value) if value == value.to_integral_value() else float(value)


class NatCash:
    def __init__(
        self,
        private_key: str,
        partner_code: str,
        function_code: str,
        username: str,
        password: str,
        callback_url: str,
        mode: str = "sandbox",
        enable_fee: bool = True,
        language: str = "ht",
        timeout: float = 30,
        transport: Optional[Transport] = None,
    ):
        requis = {
            "private_key": private_key,
            "partner_code": partner_code,
            "function_code": function_code,
            "username": username,
            "password": password,
            "callback_url": callback_url,
        }
        for nom, valeur in requis.items():
            if not valeur:
                raise NatCashError(f"{nom} est obligatoire")
        url = urlparse(callback_url)
        if not url.scheme or not url.netloc:
            raise NatCashError("callback_url doit être une URL valide")
        if mode not in HOSTS:
            raise NatCashError(f'mode invalide : "{mode}" (utilisez "sandbox" ou "live")')
        if language not in LANGUES:
            raise NatCashError('language doit être "ht", "fr" ou "en"')

        self.private_key = private_key
        self.partner_code = partner_code
        self.function_code = function_code
        self.username = username
        self.password = password
        self.callback_url = callback_url
        self.enable_fee = bool(enable_fee)
        self.language = language
        self.mode = mode
        self.base_url = HOSTS[mode]
        self.timeout = timeout
        self._transport = transport or urllib_transport

    # ---------- Paiements ----------

    def create_payment(
        self,
        amount: Montant,
        order_id: Any,
        msisdn: Optional[str] = None,
        skip_phone_input: bool = False,
    ) -> Dict[str, Any]:
        """Crée un paiement et renvoie {redirect_url, expires_in, raw}."""
        value = _to_decimal(amount)
        if order_id is None or order_id == "":
            raise NatCashError("order_id est obligatoire")
        if msisdn is not None and not re.fullmatch(r"509\d{8}", str(msisdn)):
            raise NatCashError("msisdn doit avoir la forme 509XXXXXXXX")
        if skip_phone_input and not msisdn:
            raise NatCashError("msisdn est obligatoire quand skip_phone_input est vrai")

        body = self._post(
            "credential",
            self._payment_payload(str(order_id), value, None if msisdn is None else str(msisdn), bool(skip_phone_input)),
        )
        if not body.get("url"):
            raise NatCashError("NatCash n'a pas renvoyé de lien de paiement", body=body)
        return {"redirect_url": body["url"], "expires_in": body.get("expiredAt"), "raw": body}

    def get_payment_by_order_id(self, order_id: Any) -> Dict[str, Any]:
        if not order_id:
            raise NatCashError("order_id est obligatoire")
        body = self._post("merchant/checkTransaction", self._transaction_payload(str(order_id)))
        d = body.get("data")
        if not isinstance(d, dict):
            raise NatCashError("NatCash n'a pas renvoyé de transaction", body=body)
        montant = d.get("amount")
        if isinstance(montant, str):
            # NatCash peut écrire le montant avec des virgules : "3,162.00"
            montant = montant.replace(",", "").replace(" ", "")
        return {
            "order_id": d.get("orderNumber"),
            "transaction_id": d.get("transId"),
            "amount": float(montant or 0),
            "payer": d.get("toPhone"),
            "success": _int(d.get("responseCode")) == CODE_SUCCES,
            "raw": body,
        }

    def verify_callback(self, query: Mapping[str, Any]) -> bool:
        """Vérifie la signature de l'URL de retour (?orderNumber=..&code=..&signature=..)."""
        order = query.get("orderNumber")
        code = _int(query.get("code"))
        signature = query.get("signature")
        if not order or code is None or not signature:
            return False
        attendu = self._callback_signature(str(order), code)
        return hmac.compare_digest(attendu.encode(), str(signature).strip().lower().encode())

    def verify_payment(
        self,
        query: Optional[Mapping[str, Any]] = None,
        order_id: Any = None,
        amount: Optional[Montant] = None,
    ) -> Dict[str, Any]:
        """Signature + statut + montant. Renvoie {ok, reason, payment}."""
        if query is not None:
            if not self.verify_callback(query):
                return {"ok": False, "reason": "signature invalide", "payment": None}
            if order_id is not None and str(query.get("orderNumber")) != str(order_id):
                return {"ok": False, "reason": "commande différente", "payment": None}
            order_id = query.get("orderNumber")
        payment = self.get_payment_by_order_id(order_id)
        if not payment["success"]:
            return {"ok": False, "reason": "paiement non réussi", "payment": payment}
        if str(payment["order_id"]) != str(order_id):
            return {"ok": False, "reason": "commande différente", "payment": payment}
        if amount is not None and abs(Decimal(str(payment["amount"])) - Decimal(str(amount))) > Decimal("0.001"):
            return {"ok": False, "reason": "montant différent", "payment": payment}
        return {"ok": True, "reason": None, "payment": payment}

    # ---------- Signatures ----------

    def _payment_payload(
        self,
        order_number: str,
        amount: Decimal,
        msisdn: Optional[str],
        skip_phone_input: bool,
        request_id: Optional[str] = None,
        timestamp: Optional[int] = None,
    ) -> Dict[str, Any]:
        request_id = request_id or str(uuid.uuid4())
        timestamp = timestamp if timestamp is not None else int(time.time() * 1000)
        signature = _hmac(
            self.private_key,
            _sha256(self.private_key + request_id)
            + self.partner_code
            + self.username
            + self.password
            + str(timestamp)
            + request_id
            + order_number
            + _format_montant(amount),
        )
        data: Dict[str, Any] = {
            "partnerCode": self.partner_code,
            "username": self.username,
            "password": self.password,
            "callbackUrl": self.callback_url,
            "enableFee": self.enable_fee,
            "language": self.language,
            "orderNumber": order_number,
            "amount": _wire_montant(amount),
            "timestamp": timestamp,
            "requestId": request_id,
            "skipPhoneInput": skip_phone_input,
        }
        if msisdn is not None:
            data["msisdn"] = msisdn
        data["signature"] = signature
        return data

    def _transaction_payload(self, order_number: str, request_id: Optional[str] = None) -> Dict[str, Any]:
        request_id = request_id or str(uuid.uuid4())
        return {
            "requestId": request_id,
            "username": self.username,
            "password": self.password,
            "partnerCode": self.partner_code,
            "orderNumber": order_number,
            "signature": _hmac(
                self.private_key,
                _sha256(self.private_key + request_id)
                + self.partner_code
                + self.username
                + self.password
                + order_number
                + request_id,
            ),
        }

    def _callback_signature(self, order_number: str, code: int) -> str:
        f = self.function_code
        return _hmac(f, _sha256(f + order_number) + order_number + str(code))

    # ---------- HTTP ----------

    def _post(self, chemin: str, data: Dict[str, Any]) -> Dict[str, Any]:
        try:
            status, texte = self._transport(
                "POST",
                self.base_url + chemin,
                {"Content-Type": "application/json", "Accept": "application/json"},
                json.dumps(data).encode(),
                self.timeout,
            )
        except Exception as err:
            raise NatCashError(f"Impossible de joindre NatCash : {err}") from err
        body = parse_json(texte)
        if not 200 <= status < 300:
            msg = body.get("message") if isinstance(body, dict) else None
            raise NatCashError(f"NatCash : {msg or f'HTTP {status}'}", status=status, body=body)
        # NatCash répond 200 avec status != 0 en cas d'erreur
        if not isinstance(body, dict) or body.get("status") != 0:
            msg = body.get("message") if isinstance(body, dict) else None
            raise NatCashError(
                f"NatCash : {msg or 'réponse invalide'}",
                status=body.get("status") if isinstance(body, dict) else None,
                code=body.get("code") if isinstance(body, dict) else None,
                body=body,
            )
        return body


def _int(valeur: Any) -> Optional[int]:
    try:
        return int(valeur)
    except (TypeError, ValueError):
        return None
