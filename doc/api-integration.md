# Hydra Protocol API Integration Guide

This document serves as a guide for integrating with the Hydra Payments API. It provides detailed information on each endpoint, including its purpose, request parameters, response structures, and important integration notes.

## Architecture Details

Several components are involved in this flow:

* **The Webapp:** Your client-side application that will integrate with this API.
* **This Server:** Exposes the API and manages the Hydra Head connection.
* **An Indexer (e.g., Blockfrost):** Acts as middleware between Layer 1 (L1) and this server, providing necessary blockchain data.
* **Hydra Nodes:** Act as validating nodes for transactions submitted to the Hydra Head.
* **A Cardano Node:** Handles Layer 1 transaction submissions and queries as requested by the Hydra peer nodes.

**Important Notes:**

* This server is **not** responsible for managing the Hydra peer nodes or the Cardano node; these components must be managed externally.
* This server **does not** directly connect to the Cardano node; its interaction with Layer 1 occurs solely through the Hydra peer nodes.

### Understanding a Hydra Head

When we refer to a "Hydra Head," we mean an off-chain system managed by Hydra peer nodes. Its representation on the Cardano blockchain is a smart contract.

### Hydra Head Lifecycle

Some of the most important stages in the lifecycle of a Hydra Head are:

* **Initialization:** The head is created.
* **Commitment of UTxOs:** UTxOs are committed to the head. Each Hydra node must receive a commit transaction for the head to transition to an "Opened" state.
* **Off-chain Transactions:** Once opened, transactions can be made inside the head without directly reflecting on the Cardano blockchain. These transactions update an off-chain ledger managed by the peer nodes.
* **Closure:** When the head is to be closed, the final state of the ledger held by the peers is committed to the L1 smart contract. After potentially multiple transactions, the smart contract is closed, and the UTxOs from that ledger are replicated on L1.

---

## Common Error Responses

The following error structures are common across multiple endpoints:

* **400 Bad Request**
    * **Description:** The request body contained invalid data, or the operation could not be completed due to invalid input (e.g., malformed address, insufficient funds, or an "Inputs Exhausted Error" indicating a lack of available UTxOs for the transaction).
    * **Content Type:** `application/json`
    * **Schema:**
        ```json
        {
          "error": "string" // e.g., "Bad Request: InputsExhaustedError" or "Bad Request: Invalid userAddress format."
        }
        ```

* **500/520 Internal Server Error**
    * **Description:** An unexpected or unhandled error occurred on the server. Could also indicate an issue with an underlying blockchain interaction.
    * **Content Type:** `application/json`
    * **Schema:**
        ```json
        {
          "error": "string" // e.g., "Internal Server Error: Failed to build transaction."
        }
        ```
---
## Terminology
* **L1**: Layer 1, refers to the Cardano blockchain
* **L2**: Layer 2, refers to a Hydra head.

## Endpoints

### 1. `GET /query-funds`

---

* **Purpose:** This endpoint allows checking the current assets balance for a given address across both L1 and L2 within the Blazar Hydra protocol.

* **Query Parameters:**
    * `address` (string, required): The blockchain address of the user or merchant you want to query. This should be a valid Cardano address format.

* **Responses:**

    * **200 OK - Query Funds Successful**
        * **Description:** The query was successful, and the balances are returned.
        * **Content Type:** `application/json`
        * **Schema (`QueryFundsResponse`):**
            ```json
            {
              "fundsInL1": UTxO[],   // UTxOs owned by the user on the Cardano blockchain.
              "totalInL1": Assets,     // An object with the assets locked in the user's fund UTxOs on the Cardano blockchain.
              "fundsInL2": UTxO[],   // UTxOs owned by the user in the Hydra Head.
              "totalInL2": Assets      // An object with the assets  locked in the user's fund UTxOs in the Hydra Head.
            }
            ```
        * **Example:**
            ```json
            {
              "fundsInL1": [],
              "totalInL1": {},
              "fundsInL2": [],
              "totalInL2": {}
            }
            ```

    * **See "Common Error Responses" for `500 Internal Server Error`**

* **Integration Notes:**
    * Always validate the `address` query parameter is a valid Cardano address before making this API call to minimize errors.
    * There must be Hydra head open in order for this endpoint to work.

### 2. `POST /deposit`

---

* **Purpose:** Allows a user to create a Funds UTxO that will be collected and committed into a Hydra Head. This UTxO enables users to engage with the protocol and make payments within the head.

* **Request Body (`DepositSchema`):**
    * **Content Type:** `application/json`
    ```json
    {
      "user_address": "string",     // The user's Cardano address from which the deposit will originate.
      "public_key": "string",       // The public key associated to the user_address, in hex
      "amount": ["string", "bigint"][],             // List of [assetUnit, amount] to deposit in the funds UTxO.
      "fundsUtxoRef": {             // (Optional) The output reference of an existing user funds UTxO on the Cardano blockchain to consolidate.
        "hash": "string",
        "index": number
      } | null
    }
    ```

* **Responses:**

    * **200 OK - Transaction Built Successfully**
        * **Description:** The deposit transaction has been successfully built and is ready for signing.
        * **Content Type:** `application/json`
        * **Schema (`TxBuiltResponse`):**
            ```json
            {
              "cborHex": "string",     // The CBOR-encoded unsigned transaction. This is meant to be signed by the user and then submitted to the Cardano blockchain.
              "fundsUtxoRef": {        // The output reference of the new Funds UTxO created by this deposit.
                "hash": "string",
                "index": number
              }
            }
            ```
        * **Example:**
            ```json
            {
              "cborHex": "a1020304...",
              "fundsUtxoRef": {
                "hash": "b2e4f7a1...",
                "index": 0
              }
            }
            ```

    * **See "Common Error Responses" for `400 Bad Request`** (e.g., if the wallet lacks necessary funds for the transaction).
    * **See "Common Error Responses" for `500/520 Internal Server Error`**

* **Integration Notes:**
    * The transaction received in the `cborHex` must be signed by the user who requested the deposit.
    * Once signed, the transaction needs to be submitted to L1. This API **does not** include a submit functionality.
    * The `fundsUtxoRef` in the response identifies the new UTxO created by this deposit. Keep track of this UTxO reference for the user, especially for future withdraws.

### 3. `POST /withdraw`

---


* **Purpose:** This endpoint builds a transaction for a user to withdraw funds from their Funds UTxO on L1.

* **Request Body (`WithdrawSchema`):**
    * **Content Type:** `application/json`
    ```json
    {
      "address": "string",         // The user's Cardano address requesting the withdrawal (destination address).
      "owner": "user",             // the owner kind of the order
      "funds_utxos": {
        signature: "string",       // A signature from the user's wallet, signing the Funds UTxO reference being spent.
        ref: {                     // the output reference of the Funds UTxO being spent
          hash: "string",
          index: bigint
        }
      }[],      // An array of output references of the Funds UTxOs to withdraw.
      "network_layer": "L1"        // Must be "L1". This endpoint is for L1 withdrawals only.
    }
    ```

* **Responses:**

    * **200 OK - Transaction Built Successfully**
        * **Description:** The withdrawal transaction has been successfully built and is ready for signing.
        * **Content Type:** `application/json`
        * **Schema (`TxBuiltResponse`):**
            ```json
            {
              "cborHex": "string" // The CBOR-encoded unsigned transaction.
            }
            ```
        * **Example:**
            ```json
            {
              "cborHex": "a1020304..."
            }
            ```

    * **See "Common Error Responses" for `400 Bad Request`** (e.g., if the wallet lacks necessary funds or the provided UTxOs are invalid).
    * **See "Common Error Responses" for `500/520 Internal Server Error`**

* **Integration Notes:**
    * Similar to the deposit, the `cborHex` must be signed by the user's wallet and then submitted to L1.
    * **Important Note on Signature:** The `signature` field is crucial for proving the user's authorization to withdraw funds from the specified `fundsUtxoRef`. Ensure your client-side application handles the signing process correctly. Currently, CIP-8 signatures (implemented by CIP-30 Wallets like Eternl, Nami, etc.) are **not supported**. The message must be signed natively, specifically by signing the CBOR representation of the following object:
    ```json
    {
      ref: {
        transaction_id: "string",
        output_index: bigint
      }
    }
    ```
    where `ref` is the output reference of the Funds UTxO being spent.
    * The `network_layer` parameter must be set to "L1" because this endpoint is specifically designed for user withdrawals *only* allowed on Layer 1.

### 4. `POST /pay-merchant`

---


* **Purpose:** This endpoint builds a transaction allowing a user to pay a merchant within an active Hydra Head.


* **Request Body (`PayMerchantSchema`):**
    * **Content Type:** `application/json`
    ```json
    {
      "merchant_address": "string",  // The merchant's address receiving the payment.
      "funds_utxo_ref": {             // The output reference of the user's funds UTxO within the Hydra Head.
        "hash": "string",
        "index": bigint
      },
      "amount": ["string", "bigint"][],             // List of [assetUnit, amount] to pay to the merchant.
      "signature": "string",        // A signature from the user's wallet, authorizing the L2 payment.
      "merchant_funds_utxo": {      // (Optional) The output reference of the merchant's funds UTxO in the Hydra Head, if applicable.
        "hash": "string",
        "index": bigint
      } | null
    }
    ```

* **Responses:**

    * **200 OK - Transaction Successful**
        * **Description:** The L2 payment transaction has been successfully built and submitted.
        * **Content Type:** `application/json`
        * **Schema** (`PayMerchantResult`):
            ```json
            {
                "fundsUtxoRef": {       // The output reference of the new user funds UTxO in the head.
                    "hash": "string",
                    "index": number
                },
                "merchUtxo": {          // The output reference of the new merchant UTxO in the head.
                    "hash": "string",
                    "index": number
                }
            }
            ```
        * **Example:**
            ```json
            {
                "fundsUtxoRef": {
                    "hash": "c5d7e9f2a1b2c3d4e5f6...",
                    "index": 1
                },
                "merchUtxo": {
                    "hash": "d4e5f6a1b2c3c5d7e9f2...",
                    "index": 0
                }
            }
            ```

    * **See "Common Error Responses" for `400 Bad Request`** (e.g., if the wallet lacks necessary funds for the transaction).
    * **See "Common Error Responses" for `500/520 Internal Server Error`**

* **Integration Notes:**
    * The `merchant_funds_utxo` field in the request should always be non-null if an existing merchant UTxO for that address is already in the head. This helps reduce the number of merchant outputs and optimizes processes during head closure.
    * These transactions are only submitted to L2. The user is not required to sign the transaction as the payment is authorized by the `signature` provided in the request body.
    * For the `signature` field on this endpoint, the user must sign the CBOR hex representation of the following object:
    ```json
     {
      amount: bigint,
      merchant_addr: "string",
      ref: { transaction_id: "string", output_index: bigint },
     }
    ```
    * Ensure the `fundsUtxoRef` correctly points to the user's current UTxO within the active Hydra Head.
    * Upon successful payment, the `fundsUtxoRef` in the response will reflect the new state of the user's funds within the Hydra Head. Likewise, `merchUtxo` will point to the new merchant UTxO in the head.

### 5. `POST /open-head`

---

* **Purpose:** This endpoint initiates the process of opening a Hydra Head.

* **Request Body (`ManageHeadSchema`):**
    * **Content Type:** `application/json`
    ```json
    {
      "peer_api_urls": [       // An array of API URLs for the participants in the Hydra Head.
        "string"
      ]
    }
    ```

* **Responses:**

    * **200 OK**
        * **Description:** The Hydra Head initialization process has begun.
        * **Content Type:** `application/json`
        * **Schema:**
            ```json
            {
              "operationId": "string" // An ID to track the asynchronous head opening process.
            }
            ```
        * **Example:**
            ```json
            {
              "operationId": "c0ffee-babe-0123-4567"
            }
            ```

    * **See "Common Error Responses" for `400 Bad Request`** (e.g., if the wallet lacks necessary funds for the transaction).
    * **See "Common Error Responses" for `500/520 Internal Server Error`**

* **Integration Notes:**
    * Opening a Hydra Head is a multi-step, **asynchronous process** that involves on-chain transactions. This endpoint triggers the initial steps and returns before the head is fully "open."
    * To track a head's status, an `operationId` is returned when this endpoint is called. The `operationId` is stored in a minimal database that tracks the most relevant statuses of a head.
    * The `peer_api_urls` are the URLs of the Hydra peer nodes that will manage consensus within the Hydra Head.

### 6. `POST /close-head`

---

* **Purpose:** This endpoint initiates the process of closing a Hydra Head.

* **Query Parameters:**
    * `id` (string, required): A unique identifier for the Hydra Head process to be closed. This `id` is obtained when the head was opened (e.g., the `operationId` from `/open-head`).

* **Responses:**

    * **200 OK - Hydra Head Closed Successfully (Initiated)**
        * **Description:** The Hydra Head closure process has begun. This implies that the final state is being committed to L1.
        * **Content Type:** `application/json`
        * **Schema:**
            ```json
            {
              "status": "CLOSING" // Indicates the head has transitioned to the CLOSING state.
            }
            ```
        * **Example:**
            ```json
            {
                "status": "CLOSING"
            }
            ```

    * **See "Common Error Responses" for `400 Bad Request`** (e.g., if the wallet lacks necessary funds for the transaction).
    * **See "Common Error Responses" for `500/520 Internal Server Error`**

* **Integration Notes:**
    * Closing a Hydra Head also involves on-chain transactions and a settlement period. The `200 OK` response indicates the *initiation* of the closure, not its immediate finalization on L1.
    * Closing a head might take a long time. There are known Hydra bugs, including issues with redundant "Close" commands. This server handles those conflicts internally,you'll only need to call this endpoint once per closure.
    * You should use the `GET /state` endpoint with the `id` (process ID) to monitor the head's final status.

### 7. `GET /state`

---

* **Purpose:** This endpoint is used to query the current status of an ongoing Hydra process.

* **Query Parameters:**
    * `id` (string, required): The unique process ID (e.g., the `operationId` returned by `/open-head`).

* **Responses:**

    * **200 OK - State Retrieved Successfully**
        * **Description:** The current status of the requested process.
        * **Content Type:** `application/json`
        * **Schema:**
            ```json
            {
              "status": "string" // The current status of the process (e.g., "OPENING", "COMMITTING", "FAILED", etc.)
            }
            ```
        * **Example:**
            ```json
            {
              "status": "COMMITTING"
            }
            ```

* **Integration Notes:**
    * This endpoint provides information about a head's status. This is useful specially during its opening or closing, allowing for quick checks and avoiding the need to wait for these long, asynchronous processes to finalize.