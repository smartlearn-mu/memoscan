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

Le risque restant : un fraudeur forge un nouvel `id` à chaque appel. Le jeton étant
public, il ne l'arrête pas — c'est le **plafond journalier global** qui le borne.

## Anti-abus : déjà en place (plafond journalier global)

Le backend Apps Script contient déjà les garde-fous (aucun code à ajouter) :

| Limite | Valeur | Rôle |
|---|---|---|
| `LIMITE_MINUTE` | 15 | appels/minute, toutes machines |
| `LIMITE_JOUR` | 2000 | appels/jour, **global** ← le filet anti-abus |
| `LIMITE_JOUR_APPAREIL` | 10 | pages/jour/élève (anti-partage) |
| `LIMITE_NOUVEAUX_JOUR` | 300 | nouveaux appareils/jour (anti-fabrication d'id) |

C'est `LIMITE_JOUR` (2000 appels/jour, global) qui borne la facture : même en
multipliant les device-id, un fraudeur est bloqué à 2000 appels/jour.

**Coût max par jour ≈ 3 à 10 $** (selon le mix : gemini ~0,0036 $, deepseek ~0,0002
à 0,001 $ par appel). C'est le filet — la facture ne peut pas exploser.

**À vérifier** : 2000/jour est-il le bon chiffre ? À ton volume (~96 visiteurs en
tout, ~2/jour), il ne sera jamais atteint en usage légitime. Si tu veux resserrer,
baisse-le à ~300-500/jour — toujours très large pour toi, abus borné à ~1-2 $/jour.

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
