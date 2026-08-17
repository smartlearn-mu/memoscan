# Sécurité & clé API — ce qui est exposé, ce qui ne l'est pas

## Le point important : aucune clé IA n'est dans le dépôt

Les vraies clés (Gemini, Claude/Anthropic, Mistral, DeepSeek) vivent **uniquement**
dans le backend Apps Script (`script.google.com`), jamais dans les fichiers du site.
Vérifié : aucun `sk-…`, `AIza…`, `x-api-key`, `Bearer …` dans le dépôt.

Ce qui est dans le client, c'est uniquement :

```
APP_TOKEN = "ms_7f3a1e9c4b6d2058"   // jeton applicatif (index.html, mu.html, landing.html)
```

## Pourquoi ce jeton est public (et pourquoi c'est normal)

Une app statique (GitHub Pages) ne peut pas cacher de secret : tout ce qui est dans
le JavaScript est lisible par n'importe qui. Le `APP_TOKEN` est donc **public par
conception** — il ne protège pas contre un usage malveillant, il évite juste les
appels accidentels.

**La vraie protection est côté serveur** (Apps Script) :
- quota par appareil/jour (déjà en place, `LIMITE_JOUR_APPAREIL = 10`),
- comptage d'essai par appareil (déjà en place).

Le risque restant : un fraudeur forge un nouvel `id` à chaque appel → contourne le
quota et fait grimper la facture IA. Le jeton étant public, il ne l'arrête pas.

## Correctif recommandé (côté Apps Script, hors dépôt)

Ajouter un **plafond global** : au-delà de N leçons générées par mois (tous
appareils confondus), on refuse et on alerte. C'est le filet qui protège le budget
quoi qu'il arrive. Exemple à intégrer dans la fonction qui traite `action=deepseek` :

```javascript
// Plafond mensuel global — protège le budget IA même si un fraudeur
// multiplie les device-id. À adapter à ta feuille.
var BUDGET_MENSUEL_LEGONS = 500; // générations max par mois
var FEUILLE = SpreadsheetApp.getActiveSpreadsheet();

function compterEtAutoriser() {
  var mois = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var feuilleUsage = FEUILLE.getSheetByName('Usage') || FEUILLE.insertSheet('Usage');
  // Colonne A = mois, colonne B = compteur
  var trouve = feuilleUsage.createTextFinder(mois).findNext();
  var n = trouve
    ? feuilleUsage.getRange(trouve.getRow(), 2).getValue()
    : 0;
  if (n >= BUDGET_MENSUEL_LEGONS) {
    MailApp.sendEmail(OWNER_EMAIL, '[Memo Scan] Budget mensuel atteint',
      'Le plafond de ' + BUDGET_MENSUEL_LEGONS + ' leçons/mois est atteint.');
    return false;
  }
  if (trouve) feuilleUsage.getRange(trouve.getRow(), 2).setValue(n + 1);
  else feuilleUsage.appendRow([mois, 1]);
  return true;
}

// Dans le handler deepseek, avant l'appel IA :
if (!compterEtAutoriser()) {
  return ContentService.createTextOutput(JSON.stringify({
    error: { message: 'Limite mensuelle atteinte, réessaie le mois prochain.' }
  })).setMimeType(ContentService.MimeType.JSON);
}
```

## Rotation du jeton (optionnel, à faire ensemble)

Si tu penses que `ms_7f3a1e9c4b6d2058` a fuité hors du repo, on peut le changer. Mais
**attention** : il faut le modifier **à la fois** dans le client (3 fichiers) **et**
dans Apps Script, sinon l'app tombe (401 partout). On ne le fait pas à chaud sans
coordination. Dis-moi et je prépare le nouveau jeton côté client pendant que tu le
mets à jour côté Apps Script.

## Autres points de sécurité (corrigés dans ce lot)

- **XSS par injection de prompt** : le `corrected_course` (HTML produit par le
  modèle) était injecté tel quel en `innerHTML`. Un cours photographié hostile
  pouvait faire exécuter du HTML/JS chez tous les utilisateurs. → Ajout de
  `sanitizerHtml()` (supprime `<script>`, `<iframe>`, `onerror=`, `javascript:`…)
  avant affichage, dans `index.html` et `mu.html`.
- **Vie privée** : les photos de cahiers d'enfants partent en base64 vers l'IA.
  Aucune politique de confidentialité n'est encore publiée — à traiter (RGPD /
  Data Protection Act). Ce n'est pas couvert par ce lot.
