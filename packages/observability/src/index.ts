import pino from "pino";
import { getEnv } from "@xlrrank/config";

export type Logger = pino.Logger;

let _logger: Logger | null = null;

export function getLogger(): Logger {
  if (_logger) return _logger;
  const env = getEnv();
  _logger = pino({
    level: env.LOG_LEVEL,
    base: {
      service: "xlrrank",
      env: env.NODE_ENV,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        "password",
        "passwordHash",
        "*.password",
        "apiKey",
        "apiKeyEncrypted",
        "*.apiKey",
        "*.apiKeyEncrypted",
        "token",
        "tokenHash",
        "*.token",
        "credentials",
        "credentialsEncrypted",
        "*.credentials",
        "authorization",
        "Authorization",
        "cookie",
        "Cookie",
        "secret",
        "*.secret",
      ],
      censor: "[REDACTED]",
    },
  });
  return _logger;
}

export function createChildLogger(service: string): Logger {
  return getLogger().child({ service });
}

export function getMetrics() {
  let registeredMetrics: Record<string, number> = {};
  return {
    increment(name: string, by = 1) {
      registeredMetrics[name] = (registeredMetrics[name] ?? 0) + by;
    },
    gauge(name: string, value: number) {
      registeredMetrics[name] = value;
    },
    snapshot() {
      return { ...registeredMetrics };
    },
    reset() {
      registeredMetrics = {};
    },
  };
}
