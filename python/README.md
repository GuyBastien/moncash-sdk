# moncash-sdk (Python)

SDK Python simple pour **MonCash** (Digicel) et **NatCash** (Natcom). Aucune dépendance, Python 3.10+.

> Projet non officiel, sans lien avec Digicel ni Natcom.

```bash
pip install moncash-natcash
```

## MonCash

```python
import os
from moncash_natcash import MonCash

moncash = MonCash(os.environ["MONCASH_CLIENT_ID"], os.environ["MONCASH_CLIENT_SECRET"], mode="sandbox")

# 1. Créer le paiement et rediriger le client
paiement = moncash.create_payment(amount=500, order_id="CMD-001")
print(paiement["redirect_url"])

# 2. Au retour (?transactionId=...), vérifier
resultat = moncash.verify_payment(transaction_id="...", order_id="CMD-001", amount=500)
if resultat["ok"]:
    print("Commande payée")
```

Autres fonctions : `get_payment_by_transaction_id`, `get_payment_by_order_id`, `transfer`, `customer_status`, `prefunded_balance`.

## NatCash

```python
from moncash_natcash import NatCash

natcash = NatCash(
    private_key="...", partner_code="...", function_code="...",
    username="...", password="...",
    callback_url="https://monsite.ht/natcash/retour",
    mode="sandbox", language="ht",
)

paiement = natcash.create_payment(amount=500, order_id="CMD-001")
print(paiement["redirect_url"])

# Page de retour : NatCash ajoute ?orderNumber=...&code=...&signature=...
resultat = natcash.verify_payment(query=request.args, amount=500)
if resultat["ok"]:
    print("Commande payée")
else:
    print(resultat["reason"])
```

Natcom ne publie pas de documentation publique : la partie NatCash suit les SDK [php-natcash-sdk](https://github.com/midsonlajeanty/php-natcash-sdk) et [natcashify](https://github.com/midsonlajeanty/natcashify) de Louis Midson Lajeanty (MIT).

## Tests

```bash
cd python
python -m unittest discover -s tests -v
```

Documentation complète et version Node.js : https://github.com/GuyBastien/moncash-sdk
