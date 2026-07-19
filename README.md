# Ginse Dice Live

Un téléphone filme de vrais D6 à points et publie un aperçu live. Lorsqu'un client appelle l'API avec un nombre de dés, le serveur garde la connexion ouverte, demande silencieusement au téléphone de détecter ce nombre, puis répond dès que la lecture est stable sur trois images. Un modèle YOLO26n ONNX détecte les dés et lit leurs faces de 1 à 6 directement sur le téléphone.

## Utilisation par un agent IA

Configurer le webhook du canal Discord en secret, puis lancer le workflow complet :

```bash
DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/…/…' npm run throw -- --count 2
```

Le service et le tunnel HTTPS démarrent, le lien téléphone est envoyé sur Discord avec « Throw a dice now! 🎲 », puis la commande attend le lancer réel et imprime son résultat JSON. Voir [AGENT_WORKFLOW.md](./AGENT_WORKFLOW.md) pour le contrat complet destiné aux agents.

## Lancer sur son téléphone

```bash
npm start
```

Cette commande démarre le serveur et crée une URL HTTPS Cloudflare temporaire, sans compte ni mot de passe. Elle affiche dans le terminal un encadré **OUVRE CE LIEN SUR TON TÉLÉPHONE** : ouvrir ce lien (celui qui finit par `.trycloudflare.com`), autoriser la caméra, et garder le terminal actif. Ne pas copier l'adresse locale `10.x.x.x` affichée à titre de secours.

1. Ouvrir le lien HTTPS affiché sur le téléphone et activer la caméra.
   Attendre que l'indicateur passe de `YOLO…` à `YOLO PRÊT`.
2. Ouvrir `http://localhost:3000/watch.html` sur l'ordinateur pour la régie.
3. Cliquer sur « Attendre un lancer », puis lancer les dés devant le téléphone.

Le tunnel change d'adresse à chaque redémarrage et sert uniquement à la démo. `npm run start:local` démarre sans tunnel. Pour la production, utiliser le déploiement Render décrit plus bas.

## Contrat API

Une seule demande peut être active à la fois. Cet appel attend jusqu'à 55 secondes :

```bash
curl -X POST https://VOTRE-DOMAINE/api/roll/wait \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer VOTRE_API_KEY' \
  -d '{"diceType":"d6","count":2}'
```

Lorsque deux dés sont lisibles et stables, la réponse arrive :

```json
{
  "id": "…",
  "diceType": "d6",
  "values": [4, 2],
  "count": 2,
  "source": "live-camera",
  "capturedAt": "2026-07-18T12:00:00.000Z"
}
```

Codes utiles : `409` si une demande est déjà active, `408` si aucun lancer n'est reconnu avant expiration. `GET /api/health` indique si le téléphone est en ligne, et `GET /api/stream/latest.jpg` expose la dernière image du flux.

`API_KEY` protège l'appel public `/api/roll/wait`. Si la variable n'est pas définie, l'API reste ouverte pour le développement. La page régie intégrée fonctionne donc directement en local ; avec une clé en production, saisir l'appel via curl ou votre agent.

## Hébergement Render

Le dépôt contient `render.yaml` et un `Dockerfile` :

1. pousser le dépôt sur GitHub ;
2. dans Render, créer un **Blueprint** depuis ce dépôt ;
3. attendre le déploiement et ouvrir l'URL HTTPS depuis le téléphone ;
4. récupérer `API_KEY` dans les variables d'environnement Render pour le client API.

Le service doit rester sur une seule instance : la demande, la dernière frame et le résultat sont volontairement gardés en mémoire pour une démo à faible latence. Pour plusieurs instances, déplacer cet état dans Redis et remplacer les images JPEG périodiques par WebRTC.

## Limites assumées

- Détection optimisée pour des D6 classiques à points. Des dés suffisamment grands, une lumière diffuse et un arrière-plan peu chargé améliorent la fiabilité.
- Le « live » régie est un flux JPEG à environ 1,4 image/s, beaucoup plus simple et robuste qu'un relais WebRTC pour un hackathon.
- Le téléphone réalise la vision localement ; le serveur ne reçoit qu'un aperçu compressé et les valeurs finales.
- D4, D8 et D20 demandent un modèle OCR dédié.
