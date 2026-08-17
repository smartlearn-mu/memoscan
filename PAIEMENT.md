# Paiement Wise — procédure manuelle

## Comment ça arrive
Un client paie 29€ sur le lien Wise fixe, remplit son email dans l'app ("✅ J'ai payé"), ça déclenche action=demandeCode côté serveur qui :
- enregistre l'email du client sur sa ligne dans la feuille Utilisateurs (colonne Email)
- envoie un mail à ALERT_EMAIL (ou au compte Google du script si ALERT_EMAIL n'est pas configuré), objet "Memo Scan : demande de code (Wise)", avec l'email du client et son DeviceId.

## Marche à suivre à chaque mail reçu
1. Ouvrir Gmail du compte qui a déployé le script Apps Script.
2. Vérifier sur Wise qu'un paiement de 29€ est bien arrivé, à une date proche du mail, idéalement rapprochable du nom/email du client.
3. Si confirmé, ouvrir dans le navigateur :
   https://script.google.com/macros/s/AKfycbxfrICeVrhpkUg2h7X_PUSQB6BX_Y7tX7VhxVn9wSChSkvFsAwtVhnVqiZkrbSffFZ_ig/exec?action=createCode&cle=TON_ADMIN_KEY
   → réponse du type {"ok":true,"code":"MU-XXXXXX"}
4. Envoyer ce code par email à l'adresse du client (celle du mail de demande).
5. Le client l'entre dans l'app via le bouton "🔓 J'ai un code".
6. Si le paiement Wise n'apparaît pas : ne pas générer de code, répondre au client pour clarifier avant.

## Délai
Objectif : traiter sous 3 jours ouvrables.

## Piste d'automatisation future
Actuellement tout est manuel (pas d'accès à l'API Wise Business pour webhook). Si Wise Business API devient accessible un jour, ce process pourrait être automatisé (webhook Wise -> createCode -> envoi auto du code).
