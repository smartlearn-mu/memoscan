# Chantier 1 — Instrumentation de l'entonnoir

Ce document décrit l'instrumentation ajoutée aux trois pages (`index.html`, `mu.html`,
`landing.html`) et **ce qu'il reste à faire côté serveur Apps Script** (hors dépôt)
pour que les événements soient consignés.

## Objectif

Savoir **où** le parcours visiteur casse, au lieu de supposer. Avant ce chantier,
seuls 3 événements existaient : `register` (chargement), `scan` (fin de génération
réussie), `logErreur` (erreurs). Entre « la page se charge » et « la leçon est
générée », rien n'était mesuré.

## Règle d'or (identique à l'existant)

- Fire-and-forget : `fetch(...).catch(() => {})` — un événement perdu ne doit
  **jamais** bloquer ni ralentir l'expérience.
- **Aucun contenu** (photo, transcription, texte de cours) n'est envoyé : uniquement
  des compteurs, des modes et des durées.
- Ne pas toucher à `register` ni `scan` : on **ajoute**, on ne remplace pas.

## Format de l'événement (GET)

```
SCRIPT_URL?action=activity
          &id={deviceId}      ← partagé entre landing et app (même localStorage)
          &session={uuid}     ← nouveau par chargement de page (visites ≠ visiteurs)
          &token={APP_TOKEN}
          &app={int | mu | landing}
          &type={event}
          &detail={JSON court ≤ 200 car.}
```

`register` reçoit en plus `&session=` et `&utm=` (JSON `{"source":"facebook",...}`
stocké par la landing dans `localStorage['ms_landing_utm']`).

## Événements envoyés

| type | Étape | Détail |
|---|---|---|
| `landing_vue` | Landing affichée | `{source, medium, campaign}` (utm ou `facebook` via fbclid) |
| `landing_cta` | Clic sur un CTA « Essayer » (header, hero, pricing) | `{}` |
| `register` | Chargement de l'app (existant, enrichi session+utm) | — |
| `mode_photo_tap` | Tap sur la grande carte orange « Prendre une photo » | `{}` |
| `camere_lancee` | Appel à l'ouverture de l'appareil photo | `{}` |
| `photo_prise` | Fichier(s) sélectionné(s) par la caméra ou la galerie | `{mode:'camera'\|'gallery', n}` |
| `photo_ajoutee` | Compression/lecture terminée (photo exploitable) | `{pages, mode}` (mode `pdf` pour un PDF) |
| `generation_lancee` | Clic « Générer » accepté (essai non expiré) | `{mode, pages}` |
| `generation_terminee` | Succès (nouveau ; l'ancien `scan` est conservé tel quel) | `{mode, pages, duree_ms}` |
| `abandon_chargement` | Page quittée pendant le spinner (visibilitychange/pagehide) | `{duree_ms}` |
| `mode_autre_tap` | Tap galerie ou copier-coller | `{mode:'gallery'\|'text'}` |
| `quota_atteint` | Plafond journalier de pages atteint | `{}` |
| `essai_epuise_bloque` | Clic « Générer » refusé : essai épuisé | `{}` |

## À faire côté serveur (Apps Script, hors dépôt)

Le backend actuel connaît `action=activity&type=scan`. Extension minimale :
accepter **n'importe quel `type`** et écrire une ligne par événement.

```javascript
// Feuille "Activités" : colonnes
//   A timestamp | B session | C device_id | D app | E type | F detail
function doGet(e) {
  const p = e.parameter || {};
  if (p.action === 'activity') {
    try {
      const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Activités');
      s.appendRow([
        new Date(), p.session || '', p.id || '', p.app || '',
        p.type || '', (p.detail || '').slice(0, 200)
      ]);
    } catch (err) { /* jamais bloquant */ }
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // ... traitement existant inchangé (register, scan, logErreur, gemini, deepseek...)
}
```

> `register` lit désormais un paramètre `utm` optionnel : le stocker sur le même
> device (ex. colonne G de la feuille de registre) pour joindre la source au funnel.

## Tableau de bord (feuille pivot)

Une feuille par semaine, ou un TCD groupé par semaine :

| Semaine | Sessions | % mode_photo_tap | % camere_lancee | % photo_prise | % photo_ajoutee | % generation_lancee | % generation_terminee | % abandon_chargement |
|---|---|---|---|---|---|---|---|---|
| … | =NB.SI.ENS(B:B; app; type=…)* | … | … | … | … | … | … | … |

*Tous les % ont le même dénominateur (nombre de sessions de la semaine) pour lire
l'entonnoir : `visite → tap → caméra → photo → exploitable → génération lancée →
génération terminée`.

Durées médianes entre étapes (timestamp des lignes, par `session`) : elles valident
ou infirment l'hypothèse latence (chantier 4).

## Table de décision (lecture après 1 semaine de collecte)

| Configuration observée | Diagnostic | Action |
|---|---|---|
| `landing_vue` élevé, `landing_cta` faible | Le marketing ne vend pas / offre incohérente | Aligner la landing (« 3 leçons » vs « 2 jours ») |
| `landing_cta` élevé, `mode_photo_tap` faible | Perte au passage landing→app | Reprendre le message de la landing dans l'app |
| `mode_photo_tap` élevé, `camere_lancee` ≈ 0 | Dead tap confirmé | Chantier 3a (la carte ouvre la caméra) |
| `camere_lancee` élevé, `photo_prise` faible | Abandon dans l'appareil photo (permission, hésitation, cahier absent) | Chantier 2 (démo sans cahier) |
| `photo_prise` élevé, `photo_ajoutee` ≈ 0 | Échec silencieux de format (HEIC, etc.) | Fix onerror + message JPEG |
| `photo_ajoutee` élevé, `generation_lancee` faible | Le bouton Générer n'est pas trouvé/compris, ou 1 page seulement | Bouton explicite + multi-pages (chantier 3c) |
| `generation_lancee` élevé, `generation_terminee` faible + `abandon_chargement` élevé | Latence confirmée | Chantier 4 (affichage progressif, OCR parallèle) |
| Tout faible dès le début | Trafic non qualifié | Mesurer par source (utm), pas conclure sur l'UX |
| `essai_epuise_bloque` > 0 sans `generation_terminee` antérieure | Compteur d'essai incohérent | Auditer `syncEssaiServeur` et le comptage serveur |

## Discipline de mesure

- **1 semaine de collecte sans autre modification** (ni chantier 2, 3 ou 4) : sinon
  impossible de savoir ce qui a produit l'effet.
- À n=14, l'incertitude est énorme (intervalle de Wilson 0-19 % pour 0/14) : viser
  **≥ 50-100 sessions** avant de trancher.
- Les événements perdus (adblock, iOS ITP) font des chiffres des **bornes basses** :
  comparer les étapes entre elles, ne jamais prendre un zéro isolé comme preuve.
- Une métrique de sortie unique par chantier, avant/après sur semaines comparables
  (ex. chantier 3 → `photo_ajoutee / mode_photo_tap` ; chantier 4 →
  `generation_terminee / generation_lancee`).
