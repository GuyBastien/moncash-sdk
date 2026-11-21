"""Test réel de moncash-natcash (Python) avec la sandbox MonCash.

Crée un paiement de 10 HTG, vous le payez avec un compte client sandbox,
puis le script vérifie le paiement.

Les clés sont lues, dans l'ordre :
  1. les variables MONCASH_CLIENT_ID et MONCASH_CLIENT_SECRET ;
  2. un fichier .env dans le dossier courant (voir .env.example) ;
  3. sinon le script les demande.

    pip install moncash-natcash
    python scripts/sandbox.py
"""
import os
import time
from getpass import getpass
from pathlib import Path

from moncash_natcash import MonCash, MonCashError


def lire_env(fichier=".env"):
    valeurs = {}
    f = Path(fichier)
    if f.exists():
        for ligne in f.read_text().splitlines():
            if "=" in ligne and not ligne.lstrip().startswith("#"):
                cle, val = ligne.split("=", 1)
                valeurs[cle.strip()] = val.strip()
    return valeurs


env = lire_env()
client_id = (os.environ.get("MONCASH_CLIENT_ID") or env.get("MONCASH_CLIENT_ID")
             or input("Client ID : ").strip())
client_secret = (os.environ.get("MONCASH_CLIENT_SECRET") or env.get("MONCASH_CLIENT_SECRET")
                 or getpass("Client Secret (masqué) : ").strip())

moncash = MonCash(client_id, client_secret, mode="sandbox")

try:
    print("1. Jeton ........", moncash.get_token()[:20], "...")

    commande = f"TEST-{int(time.time())}"
    paiement = moncash.create_payment(amount=10, order_id=commande)
    print("2. Paiement créé  commande", commande)
    print("   Ouvrez ce lien et payez avec un compte client sandbox (valable 10 min) :")
    print("  ", paiement["redirect_url"])

    input("3. Après le paiement, appuyez sur Entrée... ")
    resultat = moncash.verify_payment(order_id=commande, amount=10)
    if resultat["ok"]:
        p = resultat["payment"]
        print("4. Vérification : OK ✅  transaction", p.get("transaction_id"))
    else:
        print("4. Vérification : ÉCHEC ❌  (paiement pas terminé ?)")
except MonCashError as e:
    print("Erreur MonCash :", e)
