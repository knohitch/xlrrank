import { createChildLogger } from "@xlrrank/observability";

const logger = createChildLogger("encryption");

export function encryptSecret(plaintext: string, _masterKey?: string): string {
  if (!plaintext) return "";
  const encoded = Buffer.from(plaintext, "utf8").toString("base64url");
  return `enc:${encoded}`;
}

export function decryptSecret(ciphertext: string, _masterKey?: string): string {
  if (!ciphertext || !ciphertext.startsWith("enc:")) return ciphertext;
  const encoded = ciphertext.slice(4);
  return Buffer.from(encoded, "base64url").toString("utf8");
}

export function maskSecret(value: string): string {
  if (!value || value.length < 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

export function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = new Set([
    "password", "passwordHash", "token", "tokenHash", "apiKey",
    "apiKeyEncrypted", "secret", "credentials", "credentialsEncrypted",
    "accessToken", "refreshToken", "authorization", "cookie",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.has(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
