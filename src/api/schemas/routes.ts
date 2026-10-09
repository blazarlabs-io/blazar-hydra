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
  PAYMENTS: '/payments',
  PAYMENT: '/payments/:id',
  AUTHORIZE_PAYMENT: '/payments/:id/authorize',
  TERMINAL_PENDING_PAYMENT: '/terminal/pending-payment',
  BTC_DEPOSITS: '/deposits/btc',
  BTC_DEPOSIT: '/deposits/:id',
  DEPOSIT_BTC_TX: '/deposits/:id/btc-tx',
};

export { API_ROUTES };
