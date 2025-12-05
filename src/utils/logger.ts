import winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import { AgentConfig } from '../types/config';

let loggerInstance: winston.Logger | null = null;

export function createLogger(config: AgentConfig): winston.Logger {
  if (loggerInstance) {
    return loggerInstance;
  }

  const logDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = config.logFile || path.join(logDir, 'novaris-agent.log');

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
          return `${timestamp} [${level}]: ${message} ${metaStr}`;
        })
      ),
    }),
  ];

  if (config.logFile || config.logLevel !== 'error') {
    transports.push(
      new winston.transports.File({
        filename: logFile,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
      })
    );
  }

  loggerInstance = winston.createLogger({
    level: config.logLevel,
    transports,
    exceptionHandlers: [
      new winston.transports.File({ filename: path.join(logDir, 'exceptions.log') }),
    ],
    rejectionHandlers: [
      new winston.transports.File({ filename: path.join(logDir, 'rejections.log') }),
    ],
  });

  return loggerInstance;
}

export function getLogger(): winston.Logger {
  if (!loggerInstance) {
    throw new Error('Logger not initialized. Call createLogger first.');
  }
  return loggerInstance;
}

