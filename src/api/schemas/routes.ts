const API_ROUTES = {
  DEPOSIT: '/deposit',
  WITHDRAW: '/withdraw',
  PAY: '/pay-merchant',
  QUERY_FUNDS: '/query-funds',
  OPEN_HEAD: '/open-head',
  CLOSE_HEAD: '/close-head',
  INCREMENTAL_COMMIT: '/incremental-commit',
  INCREMENTAL_DECOMMIT: '/incremental-decommit',
  HEALTH: '/health',
  ACCOUNTS: '/accounts',
  ACCOUNT_PUBLIC_KEY: '/accounts/me/public-key',
  PAYMENTS: '/payments',
  PAYMENT: '/payments/:id',
  AUTHORIZE_PAYMENT: '/payments/:id/authorize',
  PAYMENT_SIGN_PAYLOAD: '/payments/:id/sign-payload',
  TERMINAL_PENDING_PAYMENT: '/terminal/pending-payment',
  TERMINAL_PAYMENT_BY_ID: '/terminals/:id/pending-payment',
  BTC_DEPOSITS: '/deposits/btc',
  BTC_DEPOSIT: '/deposits/:id',
  DEPOSIT_BTC_TX: '/deposits/:id/btc-tx',
};

export { API_ROUTES };
