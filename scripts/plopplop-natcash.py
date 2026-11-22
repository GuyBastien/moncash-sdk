"""Test d'un paiement NatCash réel via l'agrégateur PlopPlop.

Attention : la doc PlopPlop ne décrit pas de sandbox, ce paiement utilise
donc de l'argent réel (la doc annonce 20 HTG minimum). Ce script ne fait aucun retrait et
n'utilise pas la classe NatCash du SDK, qui parle directement à Natcom.

Le client_id est lu dans PLOPPLOP_CLIENT_ID, puis dans .env, sinon demandé.

    python scripts/plopplop-natcash.py
    python scripts/plopplop-natcash.py --montant 25
    python scripts/plopplop-natcash.py --ussd 509XXXXXXXX
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal, InvalidOperation
from getpass import getpass
from pathlib import Path

BASE_URL = os.environ.get("PLOPPLOP_BASE_URL", "https://plopplop.solutionip.app/")
INTERVALLE = 5  # secondes entre deux vérifications
DELAI_MAX = 600  # secondes


def lire_env(fichier=".env"):
    valeurs = {}
    f = Path(fichier)
    if f.exists():
        for ligne in f.read_text().splitlines():
            if "=" in ligne and not ligne.lstrip().startswith("#"):
                cle, val = ligne.split("=", 1)
                valeurs[cle.strip()] = val.strip()
    return valeurs


def post(chemin, donnees):
    requete = urllib.request.Request(
        BASE_URL.rstrip("/") + "/" + chemin,
        data=json.dumps(donnees).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(requete, timeout=30) as r:
            statut, texte = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        statut, texte = e.code, e.read().decode(errors="replace")
    try:
        corps = json.loads(texte)
    except ValueError:
        corps = {}
    if not 200 <= statut < 300 or corps.get("status") is not True:
        raise RuntimeError(f"HTTP {statut} : {corps.get('message') or texte[:200]}")
    return corps


def montant_valide(texte):
    try:
        valeur = Decimal(texte)
    except InvalidOperation:
        raise argparse.ArgumentTypeError("montant invalide") from None
    # La doc annonce 20 HTG minimum : c'est le serveur PlopPlop qui tranche
    if not valeur.is_finite() or valeur <= 0:
        raise argparse.ArgumentTypeError("le montant doit être positif")
    if valeur != valeur.quantize(Decimal("0.01")):
        raise argparse.ArgumentTypeError("le montant ne peut pas avoir plus de 2 décimales")
    return valeur


def telephone_valide(texte):
    if not re.fullmatch(r"509\d{8}", texte):
        raise argparse.ArgumentTypeError("le numéro doit avoir la forme 509XXXXXXXX")
    return texte


def controler(reponse, reference, montant):
    """Renvoie la raison du refus, ou None si le paiement est confirmé."""
    if reponse.get("refference_id") != reference:
        return "référence différente"
    if not str(reponse.get("method", "")).startswith("natcash"):
        return f"méthode inattendue : {reponse.get('method')}"
    if Decimal(str(reponse.get("montant"))) != montant:
        return f"montant différent : {reponse.get('montant')}"
    return None


def main():
    parser = argparse.ArgumentParser(description="Test d'un paiement NatCash via PlopPlop")
    parser.add_argument("--montant", type=montant_valide, default=Decimal("20"))
    parser.add_argument("--ussd", type=telephone_valide, metavar="509XXXXXXXX",
                        help="envoie une invite USSD à ce numéro au lieu d'un lien")
    args = parser.parse_args()

    client_id = (os.environ.get("PLOPPLOP_CLIENT_ID") or lire_env().get("PLOPPLOP_CLIENT_ID")
                 or getpass("client_id PlopPlop (masqué) : ").strip())
    reference = f"TEST-NATCASH-{int(time.time())}"

    print(f"Paiement NatCash de {args.montant} HTG, référence {reference}.")
    if input("Ce paiement utilise de l'argent réel. Continuer ? (oui/non) ").strip().lower() != "oui":
        print("Annulé, aucune transaction créée.")
        return 0

    donnees = {
        "client_id": client_id,
        "refference_id": reference,
        "montant": float(args.montant),
        "payment_method": "natcash_ussd" if args.ussd else "natcash",
    }
    if args.ussd:
        donnees["phone_number"] = args.ussd

    try:
        creation = post("api/paiement-marchand", donnees)
        transaction_id = creation.get("transaction_id")
        print("1. Transaction créée :", transaction_id)
        if args.ussd:
            print("2. Validez l'invite USSD sur le téléphone.")
        elif creation.get("url"):
            print("2. Ouvrez ce lien et payez avec NatCash :")
            print("  ", creation["url"])
        else:
            print("Erreur : PlopPlop n'a pas renvoyé de lien de paiement.")
            return 1

        print("3. Attente de la confirmation (Ctrl+C pour arrêter)...")
        fin = time.monotonic() + DELAI_MAX
        while time.monotonic() < fin:
            reponse = post("api/paiement-verify", {"client_id": client_id, "refference_id": reference})
            if reponse.get("trans_status") == "ok":
                raison = controler(reponse, reference, args.montant)
                if raison:
                    print("4. Vérification : ÉCHEC ❌ ", raison)
                    return 1
                print("4. Vérification : OK ✅  transaction", reponse.get("transaction_id"),
                      " NatCash", reponse.get("provider_transac"))
                return 0
            time.sleep(INTERVALLE)
        print("4. Pas de confirmation après 10 min. Référence à vérifier :", reference)
        return 1
    except KeyboardInterrupt:
        print("\nArrêté. Référence à vérifier :", reference)
        return 1
    except (RuntimeError, OSError) as e:
        print("Erreur PlopPlop :", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
