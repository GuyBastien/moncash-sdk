// Page de démo : MonCash en sandbox (via ce SDK) et NatCash réel (via PlopPlop).
// Sans dépendance. Les clés restent sur le serveur. Le navigateur ne reçoit
// qu'un lien de paiement et un statut, jamais le numéro du payeur ni la référence.
//
//   node examples/plopplop-demo.js
//
// Configurez au moins un moyen de paiement (variables ou fichier .env) :
//   MONCASH_CLIENT_ID + MONCASH_CLIENT_SECRET   clés SANDBOX, sans argent réel
//   PLOPPLOP_CLIENT_ID                          NatCash, argent réel
//
// Variables optionnelles :
//   DEMO_MONCASH_AMOUNT=10   montant fixe MonCash en HTG
//   DEMO_AMOUNT=20           montant fixe NatCash en HTG
//   DEMO_MAX_IP=3            paiements par moyen, par adresse IP et par heure
//   DEMO_MAX_JOUR=30         paiements par moyen et par jour, tous visiteurs confondus
//   HOST=0.0.0.0 PORT=3000
//   TRUST_PROXY=1            nombre de proxys de confiance devant le serveur
//   DEMO_DEBUG_PROXY=1       journalise le nombre d'entrées X-Forwarded-For (sans IP)
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { MonCash } from '../src/index.js'; // dans votre projet : from 'moncash-natcash'

if (existsSync('.env')) {
  for (const ligne of readFileSync('.env', 'utf8').split('\n')) {
    const i = ligne.indexOf('=');
    if (i < 1 || ligne.trimStart().startsWith('#')) continue;
    const cle = ligne.slice(0, i).trim();
    if (process.env[cle] === undefined) process.env[cle] = ligne.slice(i + 1).trim();
  }
}

const e = process.env;
const BASE_PLOPPLOP = (e.PLOPPLOP_BASE_URL || 'https://plopplop.solutionip.app/').replace(/\/?$/, '/');
const MAX_IP = Number(e.DEMO_MAX_IP || 3);
const MAX_JOUR = Number(e.DEMO_MAX_JOUR || 30);
const HOST = e.HOST || '127.0.0.1';
const PORT = Number(e.PORT || 3000);
const TRUST_PROXY = Number(e.TRUST_PROXY || 0);
const DEBUG_PROXY = e.DEMO_DEBUG_PROXY === '1';

if (!Number.isInteger(TRUST_PROXY) || TRUST_PROXY < 0) {
  console.error('TRUST_PROXY doit être un nombre entier positif ou 0.');
  process.exit(1);
}

const HEURE = 3600_000;
const JOUR = 24 * HEURE;
const DUREE_PAIEMENT = 15 * 60_000;
const CACHE_STATUT = 4000;

function lireMontant(nom, defaut) {
  const montant = Number(e[nom] || defaut);
  if (!Number.isFinite(montant) || montant <= 0 || Math.round(montant * 100) / 100 !== montant) {
    console.error(`${nom} doit être un montant positif avec 2 décimales au maximum.`);
    process.exit(1);
  }
  return montant;
}

async function plopplop(chemin, donnees) {
  const res = await fetch(BASE_PLOPPLOP + chemin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: e.PLOPPLOP_CLIENT_ID, ...donnees }),
    signal: AbortSignal.timeout(15000),
  });
  const corps = await res.json().catch(() => null);
  if (!res.ok || corps?.status !== true) throw new Error(`PlopPlop HTTP ${res.status}`);
  return corps;
}

const fournisseurs = {};

if (e.MONCASH_CLIENT_ID && e.MONCASH_CLIENT_SECRET) {
  // Toujours en sandbox : cette démo ne doit jamais encaisser sur MonCash live
  const moncash = new MonCash({
    clientId: e.MONCASH_CLIENT_ID,
    clientSecret: e.MONCASH_CLIENT_SECRET,
    mode: 'sandbox',
    timeout: 15000,
  });
  const montant = lireMontant('DEMO_MONCASH_AMOUNT', 10);
  fournisseurs.moncash = {
    nom: 'MonCash',
    montant,
    reel: false,
    hote: 'sandbox.moncashbutton.digicelgroup.com',
    creer: async (reference) => (await moncash.createPayment({ amount: montant, orderId: reference })).redirectUrl,
    statut: async (p) => {
      const { ok, payment } = await moncash.verifyPayment({ orderId: p.reference, amount: montant });
      if (ok) return 'paye';
      return String(payment?.message || '').toLowerCase() === 'successful' ? 'anomalie' : 'attente';
    },
  };
}

if (e.PLOPPLOP_CLIENT_ID) {
  const montant = lireMontant('DEMO_AMOUNT', 20);
  fournisseurs.natcash = {
    nom: 'NatCash',
    montant,
    reel: true,
    hote: 'merchantpay.natcom.com.ht',
    creer: async (reference) =>
      (await plopplop('api/paiement-marchand', { refference_id: reference, montant, payment_method: 'natcash' })).url,
    statut: async (p) => {
      const r = await plopplop('api/paiement-verify', { refference_id: p.reference });
      if (r.trans_status !== 'ok') return 'attente';
      const conforme = r.refference_id === p.reference
        && String(r.method || '').startsWith('natcash')
        && Math.abs(Number(r.montant) - montant) < 0.001;
      return conforme ? 'paye' : 'anomalie';
    },
  };
}

if (!Object.keys(fournisseurs).length) {
  console.error('Aucun moyen de paiement : ajoutez MONCASH_CLIENT_ID + MONCASH_CLIENT_SECRET ou PLOPPLOP_CLIENT_ID.');
  process.exit(1);
}

const paiements = new Map(); // id opaque -> { methode, reference, expire, statut, verifie, enCours }
const essaisParIp = new Map(); // "methode:ip" -> dates
const essaisJour = new Map(); // methode -> dates

function nettoyer(maintenant) {
  for (const [id, p] of paiements) if (p.expire <= maintenant) paiements.delete(id);
  for (const [cle, dates] of essaisParIp) {
    const recentes = dates.filter((d) => d > maintenant - HEURE);
    if (recentes.length) essaisParIp.set(cle, recentes);
    else essaisParIp.delete(cle);
  }
  for (const [methode, dates] of essaisJour) essaisJour.set(methode, dates.filter((d) => d > maintenant - JOUR));
}

function reserverEssai(methode, ip) {
  const maintenant = Date.now();
  nettoyer(maintenant);
  const cle = `${methode}:${ip}`;
  const dates = essaisParIp.get(cle) || [];
  const jour = essaisJour.get(methode) || [];
  if (dates.length >= MAX_IP) return 'Limite atteinte pour cette connexion. Réessayez dans une heure.';
  if (jour.length >= MAX_JOUR) return 'Limite de la démo atteinte pour aujourd’hui.';
  essaisParIp.set(cle, [...dates, maintenant]);
  essaisJour.set(methode, [...jour, maintenant]);
  return null;
}

function lienValide(url, hote) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === hote;
  } catch {
    return false;
  }
}

async function creerPaiement(methode) {
  const f = fournisseurs[methode];
  const reference = `DEMO-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const url = await f.creer(reference);
  if (!lienValide(url, f.hote)) throw new Error('Lien de paiement inattendu');
  const id = randomBytes(16).toString('hex');
  paiements.set(id, { methode, reference, expire: Date.now() + DUREE_PAIEMENT, statut: 'attente', verifie: 0, enCours: null });
  return { id, methode, url };
}

async function statutPaiement(p) {
  if (p.statut !== 'attente' || Date.now() - p.verifie < CACHE_STATUT) return p.statut;
  p.enCours ||= fournisseurs[p.methode].statut(p)
    .then((statut) => {
      p.statut = statut;
      p.verifie = Date.now();
    })
    .finally(() => {
      p.enCours = null;
    });
  await p.enCours;
  return p.statut;
}

function adresseIp(req) {
  const chaine = String(req.headers['x-forwarded-for'] || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (DEBUG_PROXY) console.log(`X-Forwarded-For : ${chaine.length} entrée(s)`);
  // Lire depuis la droite : les entrées de gauche peuvent être inventées par le client
  if (TRUST_PROXY && chaine.length >= TRUST_PROXY) return chaine[chaine.length - TRUST_PROXY];
  return req.socket.remoteAddress || 'inconnue';
}

function memeOrigine(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function json(res, code, donnees) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(donnees));
}

function page(res) {
  const nonce = randomBytes(16).toString('base64');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  res.end(html(nonce));
}

const server = createServer(async (req, res) => {
  req.resume();
  const { pathname, searchParams } = new URL(req.url, 'http://demo.local');
  try {
    if (pathname === '/' && req.method === 'GET') return page(res);

    if (pathname === '/api/paiements') {
      if (req.method !== 'POST') return json(res, 405, { erreur: 'Méthode non autorisée.' });
      if (!memeOrigine(req)) return json(res, 403, { erreur: 'Origine refusée.' });
      const methode = searchParams.get('methode');
      if (!Object.hasOwn(fournisseurs, methode ?? '')) return json(res, 400, { erreur: 'Moyen de paiement indisponible.' });
      const limite = reserverEssai(methode, adresseIp(req));
      if (limite) return json(res, 429, { erreur: limite });
      return json(res, 201, await creerPaiement(methode));
    }

    const m = pathname.match(/^\/api\/paiements\/([0-9a-f]{32})$/);
    if (m && req.method === 'GET') {
      const p = paiements.get(m[1]);
      if (!p || p.expire <= Date.now()) return json(res, 404, { erreur: 'Paiement expiré.' });
      return json(res, 200, { statut: await statutPaiement(p) });
    }

    json(res, 404, { erreur: 'Introuvable.' });
  } catch (err) {
    console.error('Erreur démo :', err.message);
    if (!res.headersSent) json(res, 502, { erreur: 'Service de paiement indisponible. Réessayez plus tard.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Démo : http://${HOST}:${PORT}/  (${Object.values(fournisseurs).map((f) => f.nom).join(', ')})`);
});

function html(nonce) {
  const config = {};
  for (const [cle, f] of Object.entries(fournisseurs)) {
    config[cle] = { nom: f.nom, montant: f.montant.toLocaleString('fr-FR'), reel: f.reel };
  }
  const choix = Object.entries(config).map(([cle, f]) =>
    `<label class="choix"><input type="radio" name="methode" value="${cle}"><span>${f.nom}<small>${f.reel ? 'Argent réel' : 'Test gratuit'}</small></span></label>`
  ).join('');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Démo Paiements Haïti</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --fond:#f6f4ef; --carte:#fff; --texte:#1f2421; --doux:#5d655f; --ligne:#dfdcd3; --accent:#b4232c; --accent-texte:#fff; --ok:#17693f; --alerte:#8a4b00; --selection:#fbeeee; }
@media (prefers-color-scheme: dark) { :root { --fond:#161817; --carte:#212422; --texte:#eef0ec; --doux:#a8afa9; --ligne:#393e3a; --accent:#e5484d; --accent-texte:#190506; --ok:#5fd394; --alerte:#f2b45c; --selection:#352223; } }
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--fond); color:var(--texte); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { width:100%; max-width:420px; background:var(--carte); border:1px solid var(--ligne); border-radius:12px; padding:24px; }
h1 { margin:0 0 4px; font-size:1.35rem; }
p { margin:0; }
fieldset { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:8px; margin:20px 0 0; padding:0; border:0; }
legend { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
.choix { position:relative; display:block; cursor:pointer; }
.choix input { position:absolute; opacity:0; }
.choix span { display:block; padding:10px 12px; border:1px solid var(--ligne); border-radius:8px; font-weight:650; }
.choix small { display:block; color:var(--doux); font-size:.78rem; font-weight:450; }
.choix input:checked + span { border-color:var(--accent); background:var(--selection); }
.choix input:focus-visible + span { outline:3px solid var(--texte); outline-offset:2px; }
.doux { color:var(--doux); font-size:.9rem; }
.montant { margin:20px 0 4px; font-size:2.4rem; line-height:1.2; font-weight:700; letter-spacing:-.02em; }
.montant span { font-size:1rem; font-weight:500; letter-spacing:0; color:var(--doux); }
#note { margin-bottom:16px; }
.accord { display:flex; gap:10px; align-items:flex-start; margin-bottom:16px; font-size:.92rem; cursor:pointer; }
.accord input { width:18px; height:18px; margin-top:3px; flex:none; accent-color:var(--accent); }
button, a.bouton { display:block; width:100%; padding:12px 16px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-texte); font:inherit; font-weight:650; text-align:center; text-decoration:none; cursor:pointer; }
button:disabled { opacity:.45; cursor:not-allowed; }
button:focus-visible, a.bouton:focus-visible { outline:3px solid var(--texte); outline-offset:2px; }
#etat { min-height:1.5em; margin-top:14px; font-size:.95rem; }
#etat.ok { color:var(--ok); font-weight:650; }
#etat.alerte { color:var(--alerte); }
[hidden] { display:none !important; }
footer { margin-top:20px; padding-top:14px; border-top:1px solid var(--ligne); color:var(--doux); font-size:.8rem; }
footer .source { margin-top:8px; }
footer a { color:var(--texte); font-weight:600; text-underline-offset:2px; }
footer a:focus-visible { outline:3px solid var(--texte); outline-offset:2px; }
</style>
</head>
<body>
<main>
  <h1>Démo Paiements Haïti</h1>
  <p class="doux">Testez un paiement avec le SDK moncash-natcash.</p>
  <div id="depart">
    <fieldset id="choix"><legend>Moyen de paiement</legend>${choix}</fieldset>
    <p class="montant"><b id="valeur"></b> <span>HTG</span></p>
    <p id="note" class="doux"></p>
    <label id="zone-accord" class="accord"><input id="accord" type="checkbox"> Je comprends qu’il s’agit d’argent réel et que ce paiement de test n’est pas remboursé automatiquement.</label>
    <button id="payer"></button>
  </div>
  <a id="lien" class="bouton" target="_blank" rel="noopener noreferrer" hidden></a>
  <p id="etat" role="status" aria-live="polite"></p>
  <footer>
    <p>Projet indépendant utilisant la sandbox MonCash et le service PlopPlop pour NatCash. Il n'est ni édité ni approuvé par Digicel ou Natcom. Cette page ne vous demandera jamais votre code.</p>
    <p class="source"><a href="https://github.com/GuyBastien/moncash-sdk" target="_blank" rel="noopener noreferrer">Code source sur GitHub</a></p>
  </footer>
</main>
<script nonce="${nonce}">
const CONFIG = ${JSON.stringify(config)};
const $ = (id) => document.getElementById(id);
const CLE = 'demo-paiement';
let methode, minuteur;
const lire = () => { try { return JSON.parse(sessionStorage.getItem(CLE)); } catch { return null; } };
const ecrire = (v) => { try { v ? sessionStorage.setItem(CLE, JSON.stringify(v)) : sessionStorage.removeItem(CLE); } catch {} };
function etat(texte, classe = '') { $('etat').textContent = texte; $('etat').className = classe; }
function majBouton() { $('payer').disabled = CONFIG[methode].reel && !$('accord').checked; }
function choisir(m) {
  methode = m;
  const f = CONFIG[m];
  document.querySelector('input[name="methode"][value="' + m + '"]').checked = true;
  $('valeur').textContent = f.montant;
  $('note').textContent = f.reel ? 'Paiement réel via PlopPlop.' : 'Sandbox : aucun argent réel. Il faut un compte client sandbox MonCash.';
  $('zone-accord').hidden = !f.reel;
  $('accord').checked = false;
  $('payer').textContent = 'Payer avec ' + f.nom;
  majBouton();
}
function terminer(texte, classe) { clearTimeout(minuteur); ecrire(null); $('lien').hidden = true; etat(texte, classe); }
function recommencer(texte) { terminer(texte, 'alerte'); $('depart').hidden = false; choisir(methode); }
async function suivre(p) {
  const f = CONFIG[p.methode];
  methode = p.methode;
  $('depart').hidden = true;
  $('lien').href = p.url;
  $('lien').textContent = 'Ouvrir la page ' + f.nom + (f.reel ? '' : ' sandbox');
  $('lien').hidden = false;
  etat('En attente de votre paiement sur ' + f.nom + '…');
  try {
    const r = await fetch('/api/paiements/' + p.id, { cache: 'no-store' });
    if (r.status === 404) return recommencer('Ce paiement a expiré. Aucune confirmation reçue.');
    const d = await r.json();
    if (r.ok && d.statut === 'paye') return terminer(f.reel ? 'Paiement confirmé. Merci d’avoir testé !' : 'Paiement de test confirmé. Aucun argent réel utilisé.', 'ok');
    if (r.ok && d.statut === 'anomalie') return terminer('Paiement reçu, mais ses détails ne correspondent pas. Contactez le responsable de la démo.', 'alerte');
    if (!r.ok) etat('Vérification momentanément indisponible, nouvel essai…', 'alerte');
  } catch { etat('Connexion perdue, nouvel essai…', 'alerte'); }
  minuteur = setTimeout(() => suivre(p), 4000);
}
document.querySelectorAll('input[name="methode"]').forEach((r) => r.addEventListener('change', () => { etat(''); choisir(r.value); }));
$('accord').addEventListener('change', majBouton);
$('payer').addEventListener('click', async () => {
  $('payer').disabled = true;
  etat('Création du paiement…');
  try {
    const r = await fetch('/api/paiements?methode=' + encodeURIComponent(methode), { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { etat(d.erreur || 'Paiement impossible.', 'alerte'); majBouton(); return; }
    ecrire(d);
    suivre(d);
  } catch { etat('Connexion impossible. Réessayez.', 'alerte'); majBouton(); }
});
$('choix').hidden = Object.keys(CONFIG).length < 2;
choisir(Object.keys(CONFIG)[0]);
const enCours = lire();
if (enCours && CONFIG[enCours.methode]) suivre(enCours);
</script>
</body>
</html>`;
}
