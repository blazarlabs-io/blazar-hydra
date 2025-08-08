# blazar-hydra

Repository containing all the blckochain onchain/offchain code for the Hydrapay system.

## Additional Resources

Wee need to start by downloading the [hydra-setup]() folder containing the nodes and the hydra protocol and the [cardano-node]() folder. Once downloaded unzip the contents of both files and place the `cardano-node` filder inside the hydra-setup folder.

## Run the setup

To run the hydra system use these command on your terminal:

```bash
cd hydra-setup && sudo docker compose up
```

This might take a while. The nodes will be running and the hydra protocol will be deployed.

## Run the backend

To run the backend first clone this repository. There are 2 branches we currently use for testing. The first is the `main` branch and the second is the `demo-native-assets` branch.

### Branch: main

This branch has native assets inplemented, supports any cardano native asset as long as the correct asset_unit and value are passed to the validator. More info about that later. This branch also requires the user signature using CIP-30 for deposits and requires and message signature for funds transfers within layer 2. We use this branch to demo a merchant to merchant payment through our web-apps.

```bash
cd blazar-hydra
git checkout main
npm install
npm run dev
```

### Branch: demo-native-assets

This branch is the same as the main branch but it also supports native assets. The main difference is the removal of signatures from the client-side. Everything is taken care of in the backend. We use this branch to demo the mobile app payment using the BLE contactless terminal.

```bash
cd blazar-hydra
git checkout demo-native-assets
npm install
npm run dev
```

## Debugging Tools

To monitor the websocket we can use the following command on a terminal:

```bash
sudo websocat -B 2000000 "ws://127.0.0.1:4001/?history=yes
```

To see current processes and their states use:

```bash
npx prisma studio
```

## Run the Merchant App.
