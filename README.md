# blazar-hydra

## Configuration
### 1. Install dependencies:
```bash
$> npm i
```

### 2. Configure environment variables:
Following the env.template:
```bash
PORT=1                   # port on which you'll be running this API
PROVIDER_PROJECT_ID=""   # Blockfrost API key
PROVIDER_URL=""          # Blofrost API URL
NETWORK=""               # Mainnet | Preprod
VALIDATOR_REF=""         # Hash of the transaction which deploys the Blazar validator
SEED=""                  # 24-word mnemonic of the wallet acting as Admin, which will sign transactions involved in the head's management
HYDRA_KEY=""             # Script Hash of the Hydra Initial validator, also parameter of our validator
ADMIN_NODE_WS_URL=""     # Websocket url of a Hydra node linked to the admin
ADMIN_NODE_API_URL=""    # API url of a Hydra node linked to the admin
LOGGER_LEVEL=""          # debug
DATABASE_URL=""          # URL to the db (can point to local db file)
```

>**Note:** The demo scripts require other optional environment variables, which are not necessary to run the server.

### 3. Run the server:
```bash
$> npm run dev
```
