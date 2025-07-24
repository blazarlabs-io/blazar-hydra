import Logger from '@ptkdev/logger';
import { env } from '../config';

// to direct pretty logs to stdout
const defaultOptions = {
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
};

switch (env.LOGGER_LEVEL) {
  case 'debug':
    defaultOptions.debug = true;
    defaultOptions.info = true;
    defaultOptions.warning = true;
    defaultOptions.error = true;
    break;
  case 'info':
    defaultOptions.debug = false;
    defaultOptions.info = true;
    defaultOptions.warning = true;
    defaultOptions.error = true;
    break;
  case 'warn':
    defaultOptions.debug = false;
    defaultOptions.info = false;
    defaultOptions.warning = true;
    defaultOptions.error = true;
    break;
  case 'error':
    defaultOptions.debug = false;
    defaultOptions.info = false;
    defaultOptions.warning = false;
    defaultOptions.error = true;
    break;
  default:
    throw new Error(`Invalid logger level: ${env.LOGGER_LEVEL}`);
}

export const logger = new Logger(defaultOptions);
