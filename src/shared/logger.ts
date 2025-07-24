import Logger from '@ptkdev/logger';

// to direct pretty logs to stdout
const options = {
  language: 'en' as const,
  colors: true,
  debug: true,
  info: true,
  warning: true,
  error: true,
  write: true,
  type: 'log' as const,
  rotate: {
    size: '10M' as const,
    encoding: 'utf8',
  },
  path: {
    // remember: add string *.log to .gitignore
    debug_log: './debug.log',
    error_log: './errors.log',
  },
  palette: {
    info: {
      // method name
      label: '#ffffff',
      text: '#ffffff',
      background: '#4CAF50',
    },
  },
};

export const logger = new Logger(options);
