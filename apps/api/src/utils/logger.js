'use strict';

const winston = require('winston');
const { env, isProduction, isTest } = require('../config/env');

// In production emit structured JSON; in development use a readable colorized format.
const format = isProduction
  ? winston.format.combine(winston.format.timestamp(), winston.format.json())
  : winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level}: ${message}${rest}`;
      })
    );

const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format,
  transports: [new winston.transports.Console()],
  // Silence log output during tests to keep test runs clean.
  silent: isTest,
});

module.exports = logger;
