# blazar-hydra

Repository containing all the blckochain onchain/offchain code for the Hydrapay system.

## Hydra / Cardano deployment

The documented Hydra 2.x deployment is maintained on the [hydra-2x-migration branch](https://github.com/blazarlabs-io/blazar-hydra/tree/hydra-2x-migration). Its existing deployment files are available at the following recorded source revision:

- [Docker Compose stack](https://github.com/blazarlabs-io/blazar-hydra/blob/d2bc41827caf0b332136df76c6c139e3d466b1ef/docker-compose.yaml): Cardano node 11.0.1, Hydra node 2.2.0, the Blazar backend and Caddy.
- [Backend Dockerfile](https://github.com/blazarlabs-io/blazar-hydra/blob/d2bc41827caf0b332136df76c6c139e3d466b1ef/Dockerfile).
- [L2 protocol parameters](https://github.com/blazarlabs-io/blazar-hydra/blob/d2bc41827caf0b332136df76c6c139e3d466b1ef/protocol-parameters.json).
- [Migration and operational runbook](https://github.com/blazarlabs-io/blazar-hydra/blob/d2bc41827caf0b332136df76c6c139e3d466b1ef/doc/hydra-2x-migration.md).
- [Configuration and prerequisites](https://github.com/blazarlabs-io/blazar-hydra/blob/d2bc41827caf0b332136df76c6c139e3d466b1ef/README.md#run-with-docker).

Use the source, Compose file and runbook from the same migration checkout. The administrator supplies deployment-specific configuration (`.env`, signing keys and `Caddyfile`); keys and credentials must not be committed. Regenerate protocol cost models as instructed for the target network. The Compose file uses a mutable backend image tag, so record the deployed image digest and corresponding source revision when preparing a deployment.

These links replace the empty `hydra-setup` and `cardano-node` download references for the documented Hydra 2.x route. They do not establish the exact image used in a historical demonstration, or prove that a particular APK was built from the current mobile source. The migration runbook also documents the fan-out-after-decommit limitation.

The branch descriptions below describe the older main/demo flows and should not be mixed with the Hydra 2.x deployment without checking compatibility.

## Run the backend

To run the backend first clone this repository. There are 2 branches we currently use for testing. The first is the `main` branch and the second is the `demo-native-assets` branch.

### Branch: main

This branch has native assets inplemented, supports any cardano native asset as long as the correct asset_unit and value are passed to the validator. More info about that later. This branch also requires the user signature using CIP-30 for deposits and requires and message signature for funds transfers within layer 2. We use this branch to demo a merchant to merchant payment through our web-apps.

```bash
cd blazar-hydra
git checkout main
cd src && npm install
npm run dev
```

### Branch: demo-native-assets

This branch is the same as the main branch but it also supports native assets. The main difference is the removal of signatures from the client-side. Everything is taken care of in the backend. We use this branch to demo the mobile app payment using the BLE contactless terminal.

```bash
cd blazar-hydra
git checkout demo-native-assets
cd src && npm install
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

## License

The project's original source code is licensed under the [Apache License 2.0](LICENSE), consistent with the Project Catalyst 1200128 open-source commitment. See [NOTICE](NOTICE) for attribution and scope. Third-party dependencies, bundled third-party assets and files with separate licence notices retain their respective licences.
