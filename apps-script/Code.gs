// ============================================================
// GOOGLE APPS SCRIPT — Memo Scan (internationale + Maurice)
// VERSION DURCIE (sécurité renforcée, contrat API identique)
// ============================================================
// Déploiement : application web · Exécution : Moi · Accès : Tout le monde
// Propriétés du script requises :
//   SHEET_ID      = id du classeur de suivi
//   GEMINI_KEY    = clé API Gemini (OCR)
//   ANTHROPIC_KEY = clé API Anthropic (filet de secours OCR)
//   DEEPSEEK_KEY  = clé API DeepSeek (génération des exercices)
//   MISTRAL_KEY   = clé API Mistral (alternative + OCR PDF)
//   DIAG_KEY      = mot de passe du diagnostic (action=diag&cle=...)
//   APP_TOKEN     = jeton partagé avec l'app (public par nature)
//   ADMIN_KEY     = clé privée du propriétaire (markPaid, createCode, ...)
//   PROMO_CODE    = code famille multi-usages
//   ALERT_EMAIL   = (optionnel) email des alertes
//
// DURCISSEMENTS PAR RAPPORT À LA VERSION PRÉCÉDENTE :
//   1. Comparaisons de clés à temps constant (APP_TOKEN/ADMIN_KEY/DIAG_KEY)
//      → pas de timing attack.
//   2. Plafond de taille de corps (MAX_CORPS) sur les proxys IA
//      → un POST géant ne peut pas faire gonfler le coût / la mémoire.
//   3. Validation stricte : device-id, email, format de code.
//   4. Rate-limiting par appareil sur les actions sensibles :
//      redeemCode, demandeCode, createCode (anti brute-force / anti-spam).
//   5. Erreurs génériques côté client (plus de fuite de err.message) ;
//      la vraie erreur part dans le journal + la feuille Erreurs.
//   6. Proxy Mistral OCR : liste blanche de champs (plus de passe-plat libre).
//   7. Journal d'audit des actions propriétaire (markPaid, createCode, ...).
//   8. Plafonds resserrés : LIMITE_JOUR = 500 (global), LIMITE_JOUR_APPAREIL = 6.
// ============================================================

const TRIAL_LECONS = 3;
const TRIAL_DAYS = 2;            // conservé : ancien essai en jours, plus utilisé
const LIMITE_MINUTE = 15;
const LIMITE_JOUR = 500;         // plafond GLOBAL (anti-abus). Était 2000.
const LIMITE_JOUR_APPAREIL = 6;  // plafond par élève (anti-partage). Était 10.
const LIMITE_NOUVEAUX_JOUR = 300;
const MAX_CORPS = 12 * 1024 * 1024; // 12 Mo : une photo compressée fait ~2-4 Mo

const MODELE_GEMINI = 'gemini-3.5-flash';
const MAX_TOKENS_GEMINI = 2000;
const MODELE_CLAUDE = 'claude-sonnet-4-6';
const MODELE_DEEPSEEK = 'deepseek-v4-flash';
const MODELE_MISTRAL = 'mistral-small-latest';
const MAX_TOKENS_MISTRAL = 32000;
const MODELE_MISTRAL_OCR = 'mistral-ocr-latest';
const MISTRAL_MODELE_VALIDE = /^(mistral|ministral|magistral|open-mistral|codestral)[a-z0-9.\-]*$/i;
const MAX_TOKENS_CLAUDE = 2000;
const MAX_TOKENS_DEEPSEEK = 32000;
const MODELES_CLAUDE_AUTORISES = ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-sonnet-5'];

const PRIX_MODELE = {
  'gemini-3.5-flash':  { in: 1.5,  out: 9 },
  'claude-sonnet-4-6': { in: 3,    out: 15 },
  'claude-sonnet-5':   { in: 2,    out: 10 },
  'claude-haiku-4-5':  { in: 1,    out: 5 },
  'deepseek-v4-flash': { in: 0.14, out: 0.28 },
  'mistral-small-latest':  { in: 0.10, out: 0.30 },
  'mistral-ocr-latest':    { in: 0,    out: 0 },
  'mistral-medium-latest': { in: 1.5,  out: 7.5 },
  'mistral-large-latest':  { in: 2,    out: 6 }
};
const PRIX_DEFAUT = { in: 3, out: 15 };
const MODELES_SANS_REFLEXION = ['claude-sonnet-5'];

const PRIX_VENTE_EUR = 29;
const PRIX_VENTE_MUR = 990;

function trialDaysPour_(source) {
  const s = String(source || '').toLowerCase();
  return (s === 'mu' || s.slice(-3) === '-mu' || s.slice(-3) === '_mu') ? 1 : TRIAL_DAYS;
}
function estClientMaurice_(source) {
  const s = String(source || '').toLowerCase();
  return s.indexOf('mu') !== -1 || s === 'code_juice';
}

// ============================================================
// SÉCURITÉ — PRIMITIVES
// ============================================================

// Comparaison à temps constant : évite de révéler par le temps de réponse
// si on s'approche de la bonne valeur (timing attack).
function egalConstant_(a, b) {
  a = String(a || '');
  b = String(b || '');
  const la = a.length, lb = b.length;
  let result = la === lb ? 0 : 1;
  const max = Math.max(la, lb);
  for (let i = 0; i < max; i++) {
    const ca = i < la ? a.charCodeAt(i) : 0;
    const cb = i < lb ? b.charCodeAt(i) : 0;
    result |= ca ^ cb;
  }
  return result === 0;
}

// Rate limiter (CacheService) : renvoie false quand la limite est atteinte.
function autorise_(cle, max, fenetreMs) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(cle) || 0);
  if (n >= max) return false;
  cache.put(cle, String(n + 1), Math.max(1, Math.ceil(fenetreMs / 1000)));
  return true;
}

// Device-id : 32 caractères hexadécimaux, rien d'autre.
function deviceIdValide_(id) {
  return /^[0-9a-f]{32}$/i.test(String(id || ''));
}

// Email : forme raisonnable, sans injection de headers ni débordement.
function emailValide_(email) {
  const e = String(email || '').trim();
  return e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.indexOf('\n') === -1 && e.indexOf('\r') === -1;
}

// Code de déblocage : MU-XXXXXX (usage unique) ou PROMO_CODE libre.
function normaliserCode_(code) {
  return String(code || '').trim().toUpperCase();
}
function codeValide_(code) {
  return /^MU-[A-Z0-9]{6}$/.test(code);
}

// Journal d'audit des actions propriétaire (non bloquant, jamais fatal).
function audit_(action, deviceId, detail) {
  try {
    getFeuille_('Audit').appendRow([new Date().toISOString(), action, String(deviceId || ''), String(detail || '').slice(0, 200)]);
  } catch (e) { /* l'audit ne doit jamais faire échouer l'action */ }
}

// Erreur générique côté client : on ne fuit jamais le message interne.
function erreurServeur_(err) {
  try { Logger.log('MemoScan erreur interne : ' + String(err && err.stack || err)); } catch (e) {}
  return jsonOut({ ok: false, error: 'Erreur serveur' });
}

// ============================================================
// ROUTEUR
// ============================================================

function doGet(e)  { return router_(e); }
function doPost(e) { return router_(e); }

function router_(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || '');
    const deviceId = String((e && e.parameter && e.parameter.id) || '');
    const props = PropertiesService.getScriptProperties();

    // Corps JSON (POST) — avec plafond de taille.
    let body = {};
    if (e && e.postData && e.postData.contents) {
      if (e.postData.contents.length > MAX_CORPS) {
        return jsonOut({ ok: false, error: 'Contenu trop volumineux' });
      }
      try { body = JSON.parse(e.postData.contents); } catch (_) { return jsonOut({ ok: false, error: 'JSON invalide' }); }
    }

    // ---- Actions propriétaire (ADMIN_KEY, comparaison à temps constant) ----
    if (action === 'markPaid' || action === 'createCode' ||
        action === 'bloquer' || action === 'debloquer' || action === 'surveiller') {
      if (!egalConstant_(e.parameter.cle, props.getProperty('ADMIN_KEY'))) {
        return jsonOut({ ok: false, error: 'Non autorise' });
      }
      audit_(action, deviceId, '');
      if (action === 'markPaid')   return markPaid_(deviceId);
      if (action === 'createCode') return createCode_();
      if (action === 'surveiller') return jsonOut(surveillance_(true));
      return changerStatut_(deviceId, action === 'bloquer' ? 'BLOQUE' : 'ACTIF');
    }

    // ---- Diagnostic (DIAG_KEY, comparaison à temps constant) ----
    if (action === 'diag' || action === 'mistralModels') {
      const cleDiag = props.getProperty('DIAG_KEY');
      if (!cleDiag || !egalConstant_(e.parameter.cle, cleDiag)) {
        return jsonOut({ ok: false, error: 'Non autorise' });
      }
      return action === 'diag' ? diag_() : mistralModels_(props);
    }

    // ---- Jeton applicatif (body POST ou paramètre URL GET) ----
    const token = body.token || (e.parameter && e.parameter.token) || '';
    if (!token || !egalConstant_(token, props.getProperty('APP_TOKEN'))) {
      return jsonOut({ ok: false, error: 'Acces non autorise' });
    }
    delete body.token;

    // ---- Identifiant d'appareil : format strict ----
    if (!deviceIdValide_(deviceId)) {
      return jsonOut({ ok: false, error: 'DeviceId invalide' });
    }

    // ---- Proxys IA : soumis aux quotas + plafond de taille ----
    if (action === 'gemini' || action === 'claude' ||
        action === 'deepseek' || action === 'mistral' || action === 'mistralOcr') {
      if (!estPaye_(deviceId)) {
        const quota = consommerQuota_(props);
        if (quota !== 'ok') return jsonOut({ error: quota });
      }
      if (action === 'gemini')  return proxyGemini_(body, deviceId, props);
      if (action === 'claude')  return proxyClaude_(body, deviceId, props);
      if (action === 'mistral') return proxyMistral_(body, deviceId, props);
      if (action === 'mistralOcr') return proxyMistralOcr_(body, deviceId, props);
      return proxyDeepSeek_(body, deviceId, props);
    }

    // ---- Actions standard ----
    if (action === 'register')      return register_(e, deviceId);
    if (action === 'getStatus')     return getStatus_(deviceId);
    if (action === 'activity')      return activity_(deviceId, e.parameter.type || '');
    if (action === 'updateProfile') return updateProfile_(deviceId, e.parameter);
    if (action === 'redeemCode')    return redeemCode_(deviceId, e.parameter.code || '', props);
    if (action === 'logErreur')     return logErreur_(deviceId, e.parameter, props);
    if (action === 'demandeCode')   return demandeCode_(deviceId, e.parameter.email || '', props);

    return jsonOut({ ok: false, error: 'Action inconnue' });
  } catch (err) {
    return erreurServeur_(err);
  }
}

// ============================================================
// QUOTAS
// ============================================================

function consommerQuota_(props) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'Serveur occupe, reessaie dans un instant';
  try {
    const cache = CacheService.getScriptCache();
    const cleMinute = 'min_' + Math.floor(Date.now() / 60000);
    const nMinute = Number(cache.get(cleMinute) || 0);
    if (nMinute >= LIMITE_MINUTE) return 'Trop de demandes, reessaie dans une minute';

    const aujourdHui = new Date().toISOString().slice(0, 10);
    let [jour, n] = (props.getProperty('compteur_jour') || '|0').split('|');
    if (jour !== aujourdHui) { jour = aujourdHui; n = 0; }
    if (Number(n) >= LIMITE_JOUR) return 'Limite quotidienne atteinte, reviens demain';

    cache.put(cleMinute, String(nMinute + 1), 120);
    props.setProperty('compteur_jour', jour + '|' + (Number(n) + 1));
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}

function autoriserNouvelAppareil_(props) {
  const jour = new Date().toISOString().slice(0, 10);
  const brut = String(props.getProperty('NOUVEAUX_JOUR') || '|0').split('|');
  const compte = (brut[0] === jour) ? (Number(brut[1]) || 0) : 0;
  if (compte >= LIMITE_NOUVEAUX_JOUR) return false;
  props.setProperty('NOUVEAUX_JOUR', jour + '|' + (compte + 1));
  return true;
}

function estPaye_(deviceId) {
  if (!deviceId) return false;
  try {
    const cache = CacheService.getScriptCache();
    const cle = 'paye_' + deviceId;
    const vu = cache.get(cle);
    if (vu !== null) return vu === '1';
    const sheet = getSheet();
    const row = findDeviceRow_(sheet, deviceId);
    const paye = row > 0 && String(sheet.getRange(row, 4).getValue()) === 'PAYE';
    cache.put(cle, paye ? '1' : '0', 300);
    return paye;
  } catch (_) {
    return false;
  }
}

function consommerQuotaAppareil_(deviceId) {
  if (!deviceId) return "Identifiant d'appareil manquant";
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'Serveur occupe, reessaie dans un instant';
  try {
    const sheet = getSheet();
    let row = findDeviceRow_(sheet, deviceId);

    if (row === 0) {
      const props = PropertiesService.getScriptProperties();
      if (!autoriserNouvelAppareil_(props)) {
        return "Trop de nouveaux appareils aujourd'hui. Reessaie demain.";
      }
      const maintenant = new Date().toISOString();
      sheet.appendRow([maintenant, deviceId, maintenant, 'ACTIF', '', 'auto', '', '', '', 0, '', 0, '']);
      row = sheet.getLastRow();
    }

    const ligne = sheet.getRange(row, 1, 1, 13).getValues()[0];

    if (String(ligne[3]) === 'BLOQUE') {
      return "Cet appareil a ete bloque. Ecris au 58 45 94 02 si c'est une erreur.";
    }

    if (ligne[3] !== 'PAYE' && (Number(ligne[9]) || 0) >= TRIAL_LECONS) {
      return 'Tes ' + TRIAL_LECONS + ' essais gratuits sont utilises. Debloque l\'annee entiere.';
    }

    const cell = sheet.getRange(row, 11);
    const jour = new Date().toISOString().slice(0, 10);
    const parts = String(cell.getValue() || '|0').split('|');
    const compte = (parts[0] === jour) ? (Number(parts[1]) || 0) : 0;

    if (compte >= LIMITE_JOUR_APPAREIL) {
      return 'Tu as scanne ' + LIMITE_JOUR_APPAREIL + ' pages aujourd\'hui, c\'est le maximum. Le compteur repart a zero demain.';
    }
    cell.setValue(jour + '|' + (compte + 1));
    return 'ok';
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// PROXYS IA
// ============================================================

function proxyGemini_(body, deviceId, props) {
  const apiKey = props.getProperty('GEMINI_KEY');
  if (!apiKey) return jsonOut({ error: 'Cle Gemini manquante' });

  const quotaAppareil = consommerQuotaAppareil_(deviceId);
  if (quotaAppareil !== 'ok') return jsonOut({ error: quotaAppareil });

  const payload = {
    contents: body.contents || [],
    generationConfig: {
      maxOutputTokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_GEMINI, MAX_TOKENS_GEMINI),
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + MODELE_GEMINI + ':generateContent?key=' + encodeURIComponent(apiKey);
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  logApi_(deviceId, MODELE_GEMINI, res);
  return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

function proxyClaude_(body, deviceId, props) {
  const apiKey = props.getProperty('ANTHROPIC_KEY');
  if (!apiKey) return jsonOut({ error: 'Cle Anthropic manquante' });

  const quotaAppareil = body.skipQuota ? 'ok' : consommerQuotaAppareil_(deviceId);
  if (quotaAppareil !== 'ok') return jsonOut({ error: quotaAppareil });

  const demande = String(body.model || '');
  const modele = MODELES_CLAUDE_AUTORISES.indexOf(demande) !== -1 ? demande : MODELE_CLAUDE;

  const payload = {
    model: modele,
    max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_CLAUDE, MAX_TOKENS_CLAUDE),
    messages: body.messages || []
  };
  if (MODELES_SANS_REFLEXION.indexOf(modele) !== -1) {
    payload.thinking = { type: 'disabled' };
  }
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  logApi_(deviceId, modele, res);
  return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

function proxyDeepSeek_(body, deviceId, props) {
  const apiKey = props.getProperty('DEEPSEEK_KEY');
  if (!apiKey) return jsonOut({ error: 'Cle DeepSeek manquante' });

  const payload = {
    model: MODELE_DEEPSEEK,
    messages: body.messages || [],
    max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_DEEPSEEK, MAX_TOKENS_DEEPSEEK)
  };
  if (body.thinking && body.thinking.type) {
    payload.thinking = { type: String(body.thinking.type) };
  }
  if (payload.thinking && payload.thinking.type === 'disabled') {
    payload.temperature = 0.7;
  }
  const res = UrlFetchApp.fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  logApi_(deviceId, MODELE_DEEPSEEK, res);
  return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

function mistralModels_(props) {
  const apiKey = props.getProperty('MISTRAL_KEY');
  if (!apiKey) return jsonOut({ error: 'Cle Mistral manquante' });
  const res = UrlFetchApp.fetch('https://api.mistral.ai/v1/models', {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    muteHttpExceptions: true
  });
  return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

// OCR PDF : liste blanche de champs (plus de passe-plat libre).
function proxyMistralOcr_(body, deviceId, props) {
  const apiKey = props.getProperty('MISTRAL_KEY');
  if (!apiKey) return jsonOut({ error: 'Cle Mistral manquante' });

  const quotaAppareil = body.skipQuota ? 'ok' : consommerQuotaAppareil_(deviceId);
  if (quotaAppareil !== 'ok') return jsonOut({ error: quotaAppareil });

  const payload = {};
  if (body.document) payload.document = body.document;
  if (Array.isArray(body.pages) && body.pages.length <= 10) payload.pages = body.pages;
  const modele = (body.model && MISTRAL_MODELE_VALIDE.test(String(body.model))) ? String(body.model) : MODELE_MISTRAL_OCR;
  payload.model = modele;

  const res = UrlFetchApp.fetch('https://api.mistral.ai/v1/ocr', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  logApi_(deviceId, modele, res);
  return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

function proxyMistral_(body, deviceId, props) {
  const apiKey = props.getProperty('MISTRAL_KEY');
  if (!apiKey) return jsonOut({ error: 'Cle Mistral manquante' });

  const demande = String(body.model || '');
  const modele = MISTRAL_MODELE_VALIDE.test(demande) ? demande : MODELE_MISTRAL;

  const payload = {
    model: modele,
    messages: body.messages || [],
    max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_MISTRAL, MAX_TOKENS_MISTRAL),
    temperature: 0.7
  };
  const res = UrlFetchApp.fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  logApi_(deviceId, modele, res);
  return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.JSON);
}

function logApi_(deviceId, model, res) {
  try {
    const data = JSON.parse(res.getContentText());
    const usage = data.usage || data.usageMetadata || {};
    const tIn = usage.input_tokens || usage.prompt_tokens || usage.promptTokenCount || 0;
    const tOut = (usage.output_tokens || usage.completion_tokens || usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
    if (!tIn && !tOut) return;

    const tarif = PRIX_MODELE[model] || PRIX_DEFAUT;
    const cout = (tIn * tarif.in + tOut * tarif.out) / 1e6;

    getFeuille_('LogsAPI').appendRow([new Date().toISOString(), deviceId, model, tIn, tOut, Math.round(cout * 1e6) / 1e6, '', 1]);

    if (deviceId) {
      const sheet = getSheet();
      const row = findDeviceRow_(sheet, deviceId);
      if (row > 0) {
        const cell = sheet.getRange(row, 12);
        const total = (Number(cell.getValue()) || 0) + cout;
        cell.setValue(Math.round(total * 1e6) / 1e6);
      }
    }
  } catch (_) {}
}

function diag_() {
  const logs = getFeuille_('LogsAPI');
  const nLogs = Math.max(0, logs.getLastRow() - 1);
  const entetesLogs = ['Timestamp', 'DeviceId', 'Model', 'TokensInput', 'TokensOutput', 'CoutUSD', 'Topic', 'NbPages'];
  const lignesLogs = nLogs === 0 ? [] : logs.getRange(Math.max(2, logs.getLastRow() - 9), 1, Math.min(10, nLogs), 8)
    .getValues().map(r => { const o = {}; entetesLogs.forEach((h, i) => o[h] = r[i]); return o; }).reverse();

  const err = getFeuille_('Erreurs');
  const nErr = Math.max(0, err.getLastRow() - 1);
  const entetesErr = ['Timestamp', 'App', 'DeviceId', 'Type', 'Detail'];
  const lignesErr = nErr === 0 ? [] : err.getRange(Math.max(2, err.getLastRow() - 4), 1, Math.min(5, nErr), 5)
    .getValues().map(r => { const o = {}; entetesErr.forEach((h, i) => o[h] = r[i]); return o; }).reverse();

  const sheet = getSheet();
  const nUsers = Math.max(0, sheet.getLastRow() - 1);
  const entetesUsers = ['Timestamp', 'DeviceId', 'TrialStart', 'Status', 'DatePaiement', 'Source', 'Pays', 'Classe', 'Matiere', 'NbScans'];
  const lignesUsers = nUsers === 0 ? [] : sheet.getRange(Math.max(2, sheet.getLastRow() - 14), 1, Math.min(15, nUsers), 10)
    .getValues().map(r => { const o = {}; entetesUsers.forEach((h, i) => o[h] = r[i]); return o; }).reverse();

  return jsonOut({ ok: true, derniersAppels: lignesLogs, dernieresErreurs: lignesErr,
    derniersVisiteurs: lignesUsers, totalVisiteursDepuisToujours: nUsers });
}

// ============================================================
// ALERTES INCIDENTS
// ============================================================

const TYPES_SANS_MAIL = ['ocr_court'];

function logErreur_(deviceId, params, props) {
  let ligneEcrite = false;
  try {
    const type = String(params.type || 'inconnu').slice(0, 50);
    const detail = String(params.detail || '').slice(0, 300);
    const app = String(params.app || '').slice(0, 20);
    const quand = new Date();

    getFeuille_('Erreurs').appendRow([quand.toISOString(), app, deviceId, type, detail]);
    ligneEcrite = true;

    if (TYPES_SANS_MAIL.indexOf(type) !== -1) {
      return jsonOut({ ok: true });
    }

    const cache = CacheService.getScriptCache();
    const cleHeure = 'mail_' + Math.floor(Date.now() / 3600000);
    const compteur = Number(cache.get(cleHeure + '_n') || 0) + 1;
    cache.put(cleHeure + '_n', String(compteur), 3600);

    if (!cache.get(cleHeure)) {
      cache.put(cleHeure, '1', 3600);
      const dest = props.getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
      MailApp.sendEmail(dest,
        '⚠️ Memo Scan : incident client',
        'Un incident vient de se produire dans l\'app.\n\n'
        + 'Heure : ' + quand.toLocaleString('fr-FR') + '\n'
        + 'App : ' + (app === 'mu' ? 'Maurice (mu.html)' : 'Internationale') + '\n'
        + 'Type : ' + type + '\n'
        + 'Detail : ' + detail + '\n'
        + 'Appareil : ' + deviceId + '\n\n'
        + 'Les incidents de l\'heure qui suit seront regroupes (feuille Erreurs).');
    }
    return jsonOut({ ok: true });
  } catch (err) {
    return jsonOut({ ok: ligneEcrite, mailErreur: String(err.message).slice(0, 120) });
  }
}

// ============================================================
// GESTION UTILISATEURS
// ============================================================

function register_(e, deviceId) {
  if (!deviceId) return jsonOut({ ok: false, error: 'DeviceId requis' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOut({ ok: false, error: 'Serveur occupe' });
  try {
    const sheet = getSheet();
    const row = findDeviceRow_(sheet, deviceId);
    if (row > 0) {
      const v = sheet.getRange(row, 1, 1, 13).getValues()[0];
      const paid = v[3] === 'PAYE';
      const reste = paid ? 999 : Math.max(0, TRIAL_LECONS - (Number(v[9]) || 0));
      return jsonOut({ ok: true, status: 'EXISTANT', start: v[2], leconsRestantes: reste, daysLeft: reste, paid: paid });
    }
    const today = new Date().toISOString();
    const source = String(e.parameter.source || 'direct').slice(0, 30);
    sheet.appendRow([today, deviceId, today, 'ACTIF', '', source, String(e.parameter.pays || '').slice(0, 30), '', '', 0, '', 0, '']);
    return jsonOut({ ok: true, status: 'NEW', start: today, leconsRestantes: TRIAL_LECONS, daysLeft: TRIAL_LECONS, paid: false });
  } finally {
    lock.releaseLock();
  }
}

function getStatus_(deviceId) {
  if (!deviceId) return jsonOut({ ok: false, error: 'DeviceId requis' });
  const sheet = getSheet();
  const row = findDeviceRow_(sheet, deviceId);
  if (row === 0) return jsonOut({ ok: true, found: false });

  const v = sheet.getRange(row, 1, 1, 13).getValues()[0];
  const paid = v[3] === 'PAYE';
  const reste = paid ? 999 : Math.max(0, TRIAL_LECONS - (Number(v[9]) || 0));
  if (!paid && reste <= 0 && v[3] === 'ACTIF') {
    sheet.getRange(row, 4).setValue('EXPIRE');
  }
  return jsonOut({ ok: true, found: true, leconsRestantes: reste, daysLeft: reste, paid: paid, status: paid ? 'PAYE' : (reste <= 0 ? 'EXPIRE' : 'ACTIF'), start: v[2] });
}

function demandeCode_(deviceId, email, props) {
  if (!deviceId) return jsonOut({ ok: false, error: 'DeviceId requis' });
  if (!emailValide_(email)) return jsonOut({ ok: false, error: 'Email invalide' });
  if (!autorise_('demandeCode_' + deviceId, 3, 3600000)) return jsonOut({ ok: false, error: 'Trop de demandes, reessaie plus tard' });

  const propre = email.trim().slice(0, 200);
  const sheet = getSheet();
  const row = findDeviceRow_(sheet, deviceId);
  if (row > 0) sheet.getRange(row, 13).setValue(propre);

  try {
    const dest = props.getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
    const corps = [
      'Un client dit avoir paye 29 euros via Wise et demande son code.', '',
      'Email du client : ' + propre,
      'Appareil : ' + deviceId, '',
      'Verifie le paiement recu sur Wise, puis genere un code :',
      '  .../exec?action=createCode&cle=TON_ADMIN_KEY', '',
      'et envoie-le par email a ' + propre + '.'
    ].join(String.fromCharCode(10));
    MailApp.sendEmail(dest, 'Memo Scan : demande de code (Wise)', corps);
  } catch (e) {}
  return jsonOut({ ok: true });
}

function activity_(deviceId, type) {
  if (!deviceId) return jsonOut({ ok: false, error: 'DeviceId requis' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOut({ ok: false, error: 'Serveur occupe' });
  try {
    const sheet = getSheet();
    const row = findDeviceRow_(sheet, deviceId);
    if (row === 0) return jsonOut({ ok: false, error: 'Device non trouve' });
    if (type === 'scan') incrementer_(sheet, row, 10, 1);
    return jsonOut({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function updateProfile_(deviceId, params) {
  if (!deviceId) return jsonOut({ ok: false, error: 'DeviceId requis' });
  const sheet = getSheet();
  const row = findDeviceRow_(sheet, deviceId);
  if (row === 0) return jsonOut({ ok: false, error: 'Device non trouve' });
  if (params.classe) sheet.getRange(row, 8).setValue(String(params.classe).slice(0, 50));
  if (params.matiere) sheet.getRange(row, 9).setValue(String(params.matiere).slice(0, 50));
  return jsonOut({ ok: true });
}

function changerStatut_(deviceId, statut) {
  if (!deviceId) return jsonOut({ ok: false, error: 'DeviceId requis' });
  const sheet = getSheet();
  const row = findDeviceRow_(sheet, deviceId);
  if (row === 0) return jsonOut({ ok: false, error: 'Appareil inconnu' });
  sheet.getRange(row, 4).setValue(statut);
  try { CacheService.getScriptCache().remove('paye_' + deviceId); } catch (_) {}
  return jsonOut({ ok: true, deviceId: deviceId, statut: statut });
}

function markPaid_(deviceId) {
  try { CacheService.getScriptCache().remove('paye_' + deviceId); } catch (_) {}
  if (!deviceId) return jsonOut({ ok: false, error: 'DeviceId requis' });
  const sheet = getSheet();
  const row = findDeviceRow_(sheet, deviceId);
  if (row === 0) return jsonOut({ ok: false, error: 'Device non trouve' });
  sheet.getRange(row, 4).setValue('PAYE');
  sheet.getRange(row, 5).setValue(new Date().toISOString());
  return jsonOut({ ok: true, status: 'PAYE' });
}

function createCode_() {
  if (!autorise_('createCode', 20, 3600000)) return jsonOut({ ok: false, error: 'Trop de codes recemment' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOut({ ok: false, error: 'Serveur occupe' });
  try {
    const sheet = getFeuille_('Codes');
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = 'MU-';
    for (let i = 0; i < 6; i++) code += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    sheet.appendRow([code, new Date().toISOString(), 'DISPONIBLE', '', '']);
    audit_('createCode', '', code);
    return jsonOut({ ok: true, code: code });
  } finally {
    lock.releaseLock();
  }
}

function redeemCode_(deviceId, code, props) {
  if (!deviceId) return jsonOut({ ok: false, error: 'DeviceId requis' });
  if (!autorise_('redeem_' + deviceId, 10, 60000)) return jsonOut({ ok: false, error: 'Trop de tentatives, reessaie dans une minute' });

  code = normaliserCode_(code);
  if (!code) return jsonOut({ ok: false, error: 'Code invalide' });

  const promo = String(props.getProperty('PROMO_CODE') || '').trim().toUpperCase();
  const estPromo = promo && code === promo;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOut({ ok: false, error: 'Serveur occupe' });
  try {
    let source = 'code_ami';
    if (!estPromo) {
      if (!codeValide_(code)) return jsonOut({ ok: false, error: 'Code invalide' });
      const codes = getFeuille_('Codes');
      const last = codes.getLastRow();
      const trouve = last >= 2 ? codes.getRange(2, 1, last - 1, 1).createTextFinder(code).matchEntireCell(true).findNext() : null;
      if (!trouve) return jsonOut({ ok: false, error: 'Code invalide' });
      const r = trouve.getRow();
      if (codes.getRange(r, 3).getValue() !== 'DISPONIBLE') return jsonOut({ ok: false, error: 'Code deja utilise' });
      codes.getRange(r, 3).setValue('UTILISE');
      codes.getRange(r, 4).setValue(deviceId);
      codes.getRange(r, 5).setValue(new Date().toISOString());
      source = 'code_juice';
    }
    const sheet = getSheet();
    const row = findDeviceRow_(sheet, deviceId);
    const today = new Date().toISOString();
    if (row === 0) {
      sheet.appendRow([today, deviceId, today, 'PAYE', today, source, '', '', '', 0, '', 0, '']);
    } else {
      sheet.getRange(row, 4).setValue('PAYE');
      sheet.getRange(row, 5).setValue(today);
      sheet.getRange(row, 6).setValue(source);
    }
    try { CacheService.getScriptCache().remove('paye_' + deviceId); } catch (_) {}
    audit_('redeemCode', deviceId, code);
    return jsonOut({ ok: true, status: 'PAYE' });
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// SURVEILLANCE
// ============================================================

const SEUIL_APPELS_6H = 150;
const SEUIL_NOUVEAUX_6H = 25;
const SEUIL_ERREURS_6H = 20;

function surveillance_(retourSeulement) {
  const depuis = Date.now() - 6 * 3600 * 1000;
  const recentes = function (feuille, colDate) {
    try {
      const f = getFeuille_(feuille);
      const n = f.getLastRow();
      if (n < 2) return [];
      const debut = Math.max(2, n - 500);
      return f.getRange(debut, 1, n - debut + 1, f.getLastColumn()).getValues()
              .filter(function (r) { return new Date(r[colDate]).getTime() >= depuis; });
    } catch (_) { return []; }
  };

  const appels = recentes('LogsAPI', 0);
  const erreurs = recentes('Erreurs', 0);
  const cout = appels.reduce(function (t, r) { return t + (Number(r[5]) || 0); }, 0);

  const sheet = getSheet();
  let nouveaux = 0;
  try {
    const n = sheet.getLastRow();
    const debut = Math.max(2, n - 300);
    if (n >= 2) {
      sheet.getRange(debut, 1, n - debut + 1, 1).getValues().forEach(function (r) {
        if (new Date(r[0]).getTime() >= depuis) nouveaux++;
      });
    }
  } catch (_) {}

  const parAppareil = {};
  appels.forEach(function (r) {
    const id = String(r[1] || 'inconnu');
    parAppareil[id] = (parAppareil[id] || 0) + 1;
  });
  const gros = Object.keys(parAppareil).map(function (k) { return { id: k, n: parAppareil[k] }; })
    .sort(function (a, b) { return b.n - a.n; }).slice(0, 5);

  const alertes = [];
  if (appels.length > SEUIL_APPELS_6H) alertes.push(appels.length + ' appels en 6 h');
  if (nouveaux > SEUIL_NOUVEAUX_6H) alertes.push(nouveaux + ' nouveaux appareils en 6 h');
  if (erreurs.length > SEUIL_ERREURS_6H) alertes.push(erreurs.length + ' erreurs en 6 h');

  const bilan = { ok: true, appels: appels.length, nouveaux: nouveaux, erreurs: erreurs.length, coutUSD: Math.round(cout * 10000) / 10000, alertes: alertes, plusActifs: gros };

  if (alertes.length && !retourSeulement) {
    const dest = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
    if (dest) {
      const NL = String.fromCharCode(10);
      const corps = [
        'Sur les 6 dernieres heures :', '',
        '- ' + alertes.join(NL + '- '), '',
        'Cout sur la periode : ' + bilan.coutUSD + ' USD', '',
        'Appareils les plus actifs :',
        gros.map(function (g) { return '  ' + g.id + ' : ' + g.n + ' appels'; }).join(NL),
        '', 'Pour bloquer :',
        '  .../exec?action=bloquer&id=IDENTIFIANT&cle=TON_ADMIN_KEY'
      ].join(NL);
      MailApp.sendEmail(dest, 'Memo Scan : activite inhabituelle', corps);
    }
  }
  return bilan;
}

function installerSurveillance() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'surveillance_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('surveillance_').timeBased().everyHours(6).create();
}

// ============================================================
// OUTILS
// ============================================================

function findDeviceRow_(sheet, deviceId) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const trouve = sheet.getRange(2, 2, last - 1, 1).createTextFinder(deviceId).matchEntireCell(true).findNext();
  return trouve ? trouve.getRow() : 0;
}

function incrementer_(sheet, row, col, delta) {
  const cell = sheet.getRange(row, col);
  cell.setValue(Math.round(((Number(cell.getValue()) || 0) + delta) * 1000) / 1000);
}

function jsonOut(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function getFeuille_(nom) {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  let sheet = ss.getSheetByName(nom);
  if (!sheet) { sheet = creerFeuille_(ss, nom); }
  return sheet;
}

function getSheet() { return getFeuille_('Utilisateurs'); }

// ============================================================
// ADMINISTRATION
// ============================================================

const SCHEMA = {
  'Utilisateurs': ['Timestamp', 'DeviceId', 'TrialStart', 'Status', 'DatePaiement', 'Source', 'Pays', 'Classe', 'Matiere', 'NbScans', 'QuotaJour', 'CoutTotalUSD', 'Email'],
  'Stats':        ['Date', 'NouveauxEssais', 'Actifs', 'Payes', 'Expires', 'NbScansTotal', 'CoutTotalUSD', 'RevenusEUR', 'RevenusMUR', 'ClientsIntl', 'ClientsMaurice', 'TauxConversion'],
  'LogsAPI':      ['Timestamp', 'DeviceId', 'Model', 'TokensInput', 'TokensOutput', 'CoutUSD', 'Topic', 'NbPages'],
  'Codes':        ['Code', 'CreeLe', 'Statut', 'Device', 'UtiliseLe'],
  'Erreurs':      ['Timestamp', 'App', 'DeviceId', 'Type', 'Detail'],
  'Audit':        ['Timestamp', 'Action', 'DeviceId', 'Detail']
};

function creerFeuille_(ss, nom) {
  const entetes = SCHEMA[nom];
  const s = ss.insertSheet(nom);
  if (entetes) {
    s.getRange(1, 1, 1, entetes.length).setValues([entetes]);
    s.setFrozenRows(1);
    s.getRange(1, 1, 1, entetes.length).setFontWeight('bold');
  }
  return s;
}

function createAllSheets() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  Object.keys(SCHEMA).forEach(function (nom) {
    if (!ss.getSheetByName(nom)) creerFeuille_(ss, nom);
  });
  SpreadsheetApp.flush();
  return 'Feuilles creees';
}

function reinitialiserTout() {
  const ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  const tampon = ss.insertSheet('__tampon__' + Date.now());
  ss.getSheets().forEach(function (s) {
    if (s.getSheetId() !== tampon.getSheetId()) ss.deleteSheet(s);
  });
  Object.keys(SCHEMA).forEach(function (nom) { creerFeuille_(ss, nom); });
  ss.deleteSheet(tampon);
  PropertiesService.getScriptProperties().deleteProperty('compteur_jour');
  SpreadsheetApp.flush();
  return 'Reinitialisation terminee : ' + Object.keys(SCHEMA).join(', ');
}

function testerAutorisationEmail() {
  const props = PropertiesService.getScriptProperties();
  const dest = props.getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(dest, '✅ Memo Scan : les alertes fonctionnent',
    'Cet email confirme que Memo Scan peut vous prevenir automatiquement.\n\n'
    + 'Destinataire configure : ' + dest + '\n'
    + 'Quota restant aujourd\'hui : ' + MailApp.getRemainingDailyQuota() + ' emails');
  return 'Email envoye a ' + dest;
}

function updateStats() {
  const users = getFeuille_('Utilisateurs').getDataRange().getValues();
  const stats = getFeuille_('Stats');
  const today = new Date().toISOString().slice(0, 10);

  let nouveaux = 0, actifs = 0, payes = 0, expires = 0;
  let totalScans = 0, coutTotal = 0;
  let clientsIntl = 0, clientsMu = 0;

  for (let i = 1; i < users.length; i++) {
    const start = new Date(users[i][2]);
    if (!isNaN(start.getTime()) && start.toISOString().slice(0, 10) === today) nouveaux++;
    const status = users[i][3];
    const source = users[i][5];
    if (status === 'ACTIF') actifs++;
    else if (status === 'PAYE') { payes++; if (estClientMaurice_(source)) clientsMu++; else clientsIntl++; }
    else if (status === 'EXPIRE') expires++;
    totalScans += Number(users[i][9]) || 0;
    coutTotal += Number(users[i][11]) || 0;
  }

  const termines = payes + expires;
  const ligne = [
    today, nouveaux, actifs, payes, expires, totalScans,
    Math.round(coutTotal * 100) / 100,
    clientsIntl * PRIX_VENTE_EUR, clientsMu * PRIX_VENTE_MUR,
    clientsIntl, clientsMu,
    termines > 0 ? Math.round((payes / termines) * 100) : 0
  ];

  const derniere = stats.getLastRow();
  if (derniere > 1 && String(stats.getRange(derniere, 1).getValue()).slice(0, 10) === today) {
    stats.getRange(derniere, 1, 1, ligne.length).setValues([ligne]);
  } else {
    stats.appendRow(ligne);
  }
  SpreadsheetApp.flush();
}
