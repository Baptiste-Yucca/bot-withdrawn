# Bot Withdrawn

Ce projet est un bot automatisé conçu pour fonctionner sur la Gnosis Chain.

## Prérequis

- [Node.js](https://nodejs.org/) installé.
- Un wallet EVM (Rabby, MetaMask, ou généré via une librairie comme ethers.js).

## Installation

1.  Clonez ce dépôt (si ce n'est pas déjà fait).
2.  Installez les dépendances :
    ```bash
    npm install
    ```

## Configuration du Bot

1.  **Récupération de la clé privée** :
    - Si vous utilisez un hot wallet, exportez la clé privée du compte dédié au bot.

2.  **Configuration de l'environnement** :
    - Copiez le fichier d'exemple pour créer votre fichier de configuration :
      ```bash
      cp .env.example .env
      ```
    - Ouvrez le fichier `.env` et collez votre clé privée dans la variable `PRIVATE_KEY` :
      ```env
      PRIVATE_KEY=votre_clé_privée_ici
      RPC_URL_GNOSIS=https://rpc.gnosischain.com
      ```

3.  **Transfert de fonds sur le wallet du bot** :
    - Avant de lancer le bot, transférez des fonds à retirer sur l'adresse publique de votre wallet (celle associée à la clé privée): des ARMMV3USDC et/ou ARMMV3WXDAI.
    - Assurez-vous d'avoir des **xDAI** pour payer les frais de transaction (gas).
    - Le bot détectera seul quels fonds il doit retirer: armmv3usdc, armmv3wxdai ou les deux.


## Utilisation

Pour lancer le bot, exécutez la commande suivante :

```bash
npm start
```

Cette commande lancera le script via `tsx`.
