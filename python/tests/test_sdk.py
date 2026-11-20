import base64
import json
import unittest
from pathlib import Path

from moncash_sdk import MonCash, MonCashError, NatCash, NatCashError

VECTEURS = json.loads((Path(__file__).parent / "fixtures" / "natcash-php-vectors.json").read_text())

NATCASH = dict(
    private_key="private-key-1",
    partner_code="PARTNER1",
    function_code="FUNC1",
    username="merchant",
    password="s3cr3t",
    callback_url="https://shop.example/natcash/callback",
)


class FakeTransport:
    """Faux serveur : renvoie les réponses prévues dans l'ordre."""

    def __init__(self, *reponses):
        self.reponses = list(reponses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        status, data = self.reponses.pop(0)
        return status, json.dumps(data)


TOKEN_OK = (200, {"access_token": "abc", "expires_in": 59})


class TestMonCash(unittest.TestCase):
    def test_config(self):
        with self.assertRaises(MonCashError):
            MonCash("x", "")
        with self.assertRaises(MonCashError):
            MonCash("x", "y", mode="prod")

    def test_create_payment(self):
        t = FakeTransport(TOKEN_OK, (202, {"payment_token": {"token": "TOK123", "expired": "x"}}))
        mc = MonCash("id", "secret", transport=t)
        p = mc.create_payment(500, 42)
        self.assertEqual(p["token"], "TOK123")
        self.assertEqual(
            p["redirect_url"],
            "https://sandbox.moncashbutton.digicelgroup.com/Moncash-middleware/Payment/Redirect?token=TOK123",
        )
        self.assertTrue(t.calls[0]["url"].endswith("/Api/oauth/token"))
        self.assertEqual(
            t.calls[0]["headers"]["Authorization"], "Basic " + base64.b64encode(b"id:secret").decode()
        )
        self.assertEqual(t.calls[1]["headers"]["Authorization"], "Bearer abc")
        self.assertEqual(json.loads(t.calls[1]["body"]), {"amount": 500, "orderId": "42"})

    def test_token_cache_et_401(self):
        t = FakeTransport(
            TOKEN_OK,
            (200, {"balance": 1}),
            (401, {"error": "invalid_token"}),
            (200, {"access_token": "neuf", "expires_in": 59}),
            (200, {"balance": 2}),
        )
        mc = MonCash("id", "s", transport=t)
        mc.prefunded_balance()
        self.assertEqual(mc.prefunded_balance()["balance"], 2)
        self.assertEqual(sum(c["url"].endswith("/oauth/token") for c in t.calls), 2)
        self.assertEqual(t.calls[-1]["headers"]["Authorization"], "Bearer neuf")

    def test_verify_payment(self):
        paiement = (
            200,
            {"payment": {"reference": "42", "transaction_id": "T1", "cost": 500, "message": "successful", "payer": "509"}},
        )
        mc = MonCash("id", "s", transport=FakeTransport(TOKEN_OK, paiement, paiement))
        self.assertTrue(mc.verify_payment(transaction_id="T1", order_id=42, amount=500)["ok"])
        self.assertFalse(mc.verify_payment(transaction_id="T1", order_id=42, amount=5000)["ok"])

    def test_erreur(self):
        mc = MonCash("id", "s", transport=FakeTransport(TOKEN_OK, (404, {"message": "Transaction not found"})))
        with self.assertRaises(MonCashError) as ctx:
            mc.get_payment_by_transaction_id("X")
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn("Transaction not found", str(ctx.exception))

    def test_montant(self):
        mc = MonCash("id", "s", transport=FakeTransport())
        for mauvais in (-5, "500", True, 0):
            with self.assertRaises(MonCashError):
                mc.create_payment(mauvais, 1)


class TestNatCash(unittest.TestCase):
    def test_signatures_paiement_php(self):
        for v in VECTEURS["payments"]:
            i, attendu = v["inputs"], v["payload"]
            nc = NatCash(**NATCASH, enable_fee=i["enableFee"], language=i["language"])
            from moncash_sdk.natcash import _to_decimal

            data = nc._payment_payload(
                i["orderNumber"],
                _to_decimal(i["amount"]),
                i["msisdn"],
                i["skipPhoneInput"],
                request_id=attendu["requestId"],
                timestamp=i["timestamp"],
            )
            self.assertEqual(data, attendu, i["orderNumber"])

    def test_signatures_transaction_php(self):
        nc = NatCash(**NATCASH)
        for v in VECTEURS["transactions"]:
            self.assertEqual(nc._transaction_payload(v["inputs"]["orderNumber"], v["payload"]["requestId"]), v["payload"])

    def test_verify_callback(self):
        nc = NatCash(**NATCASH)
        for c in VECTEURS["callbacks"]:
            q = {"orderNumber": c["order_number"], "code": str(c["code"]), "signature": c["signature"]}
            self.assertTrue(nc.verify_callback(q))
            self.assertFalse(nc.verify_callback({**q, "code": "1" if c["code"] != 1 else "-1"}))
        self.assertFalse(nc.verify_callback({}))

    def test_create_payment(self):
        t = FakeTransport((200, {"status": 0, "code": "MSG_SUCCESS", "message": "ok", "url": "https://pay/abc", "expiredAt": 600}))
        nc = NatCash(**NATCASH, transport=t)
        p = nc.create_payment(500, 42)
        self.assertEqual(p["redirect_url"], "https://pay/abc")
        self.assertEqual(t.calls[0]["url"], "https://testmerchantpay.natcom.com.ht/api/online-payment/credential")
        self.assertEqual(json.loads(t.calls[0]["body"])["orderNumber"], "42")

    def test_erreur_status(self):
        t = FakeTransport((200, {"status": 101, "code": "ERR_TRANSACTION_NOT_FOUND", "message": "Transaction not found"}))
        nc = NatCash(**NATCASH, transport=t)
        with self.assertRaises(NatCashError) as ctx:
            nc.get_payment_by_order_id("X")
        self.assertEqual(ctx.exception.code, "ERR_TRANSACTION_NOT_FOUND")

    def test_verify_payment(self):
        cb = VECTEURS["callbacks"][0]
        tx = (
            200,
            {
                "status": 0,
                "code": "MSG_SUCCESS",
                "message": "ok",
                "data": {"orderNumber": "ORDER-001", "transId": "T9", "amount": "3,162.00", "toPhone": "509", "responseCode": 1},
            },
        )
        nc = NatCash(**NATCASH, transport=FakeTransport(tx, tx))
        q = {"orderNumber": cb["order_number"], "code": "1", "signature": cb["signature"]}
        bon = nc.verify_payment(query=q, amount=3162)
        self.assertTrue(bon["ok"])
        mauvais = nc.verify_payment(query=q, amount=10)
        self.assertEqual((mauvais["ok"], mauvais["reason"]), (False, "montant différent"))
        faux = nc.verify_payment(query={**q, "signature": "0" * 64})
        self.assertEqual(faux["reason"], "signature invalide")

    def test_validation(self):
        with self.assertRaises(NatCashError):
            NatCash(**{**NATCASH, "private_key": ""})
        with self.assertRaises(NatCashError):
            NatCash(**{**NATCASH, "callback_url": "pas une url"})
        nc = NatCash(**NATCASH, transport=FakeTransport())
        with self.assertRaises(NatCashError):
            nc.create_payment(10.123, 1)
        with self.assertRaises(NatCashError):
            nc.create_payment(10, 1, msisdn="123")
        with self.assertRaises(NatCashError):
            nc.create_payment(10, 1, skip_phone_input=True)


if __name__ == "__main__":
    unittest.main()
