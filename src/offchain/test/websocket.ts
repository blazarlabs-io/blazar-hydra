import Websocket from "ws";
import axios from "axios";
import {
  Blockfrost,
  CBORHex,
  CML,
  Lucid,
  LucidEvolution,
  Network,
} from "@lucid-evolution/lucid";
import { env } from "../../config";
import { HydraHandler } from "../lib/hydra";

const utxo1: any = {
  address: "addr_test1wrpxxntp7h3nu2l4q86qt96n2ke96mm8ugydhyms5vg664g7r40yc",
  datum: null,
  inlineDatum: {
    constructor: 0,
    fields: [
      {
        constructor: 0,
        fields: [
          {
            constructor: 0,
            fields: [
              {
                bytes:
                  "96193fda4f4cfbc6e4f3336b8b9f82b226fad78ec37eccd72d6a4e5e",
              },
            ],
          },
          {
            constructor: 0,
            fields: [
              {
                constructor: 0,
                fields: [
                  {
                    constructor: 0,
                    fields: [
                      {
                        bytes:
                          "ddf6ba798b55c603c80ca07bbc0f596a166a56d5abe1e9aaf55b547b",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        int: 2000000,
      },
      {
        constructor: 0,
        fields: [
          {
            bytes:
              "145562a792f2ca28ae87f1f7afd25b126f76547103204f62432999bcc2b5c542",
          },
        ],
      },
    ],
  },
  inlineDatumhash:
    "e51434ee5781ab45308e0a6f730492e643c68c272b5bd7d2990d5e4d5d6e2eea",
  referenceScript: null,
  value: {
    c2634d61f5e33e2bf501f405975355b25d6f67e208db9370a311ad55: {
      "8b0768c18d204cb0dab1804d1d43f2da944aec262ed48da8bf1db6d690845c75": 1,
    },
    lovelace: 12000000,
  },
};

const utxo2: any = {
  address: "addr_test1wrpxxntp7h3nu2l4q86qt96n2ke96mm8ugydhyms5vg664g7r40yc",
  datum: null,
  inlineDatum: {
    constructor: 0,
    fields: [
      {
        constructor: 0,
        fields: [
          {
            constructor: 0,
            fields: [
              {
                bytes:
                  "96193fda4f4cfbc6e4f3336b8b9f82b226fad78ec37eccd72d6a4e5e",
              },
            ],
          },
          {
            constructor: 0,
            fields: [
              {
                constructor: 0,
                fields: [
                  {
                    constructor: 0,
                    fields: [
                      {
                        bytes:
                          "ddf6ba798b55c603c80ca07bbc0f596a166a56d5abe1e9aaf55b547b",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        int: 2000000,
      },
      {
        constructor: 0,
        fields: [
          {
            bytes:
              "145562a792f2ca28ae87f1f7afd25b126f76547103204f62432999bcc2b5c542",
          },
        ],
      },
    ],
  },
  inlineDatumhash:
    "e51434ee5781ab45308e0a6f730492e643c68c272b5bd7d2990d5e4d5d6e2eea",
  referenceScript: null,
  value: {
    c2634d61f5e33e2bf501f405975355b25d6f67e208db9370a311ad55: {
      "6990711435d405e1ecc6c7a3861e45abc417767727fd094a395ec5bf7948cf95": 1,
    },
    lovelace: 12000000,
  },
};

const lucid = await Lucid(
  new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID),
  env.NETWORK as Network
);
lucid.selectWallet.fromSeed(env.SEED);

const url = "ws://127.0.0.1:4001?history=no";
const hydraWs = new HydraHandler(lucid, url);
const receivedTag = await hydraWs.abort();
