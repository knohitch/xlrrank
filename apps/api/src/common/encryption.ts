import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ENCRYPTION_PREFIX = "enc:v1";
const IV_BYTES = 12;
const MIN_MASTER_KEY_LENGTH = 32;

function resolveMasterKey(masterKey?: string): Buffer {
  const secret = masterKey ?? process.env.ENCRYPTION_MASTER_KEY ?? "";
  if (secret.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_MASTER_KEY must be set to at least ${MIN_MASTER_KEY_LENGTH} characters`,
    );
  }

  // Normalize user-provided high-entropy secret material to the 32 bytes
  // required by AES-256 without persisting the source secret itself.
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(plaintext: string, masterKey?: string): string {
  if (!plaintext) return "";

  const key = resolveMasterKey(masterKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSecret(ciphertext: string, masterKey?: string): string {
  if (!ciphertext) return "";

  const parts = ciphertext.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== ENCRYPTION_PREFIX) {
    throw new Error("Secret is not stored in the supported encrypted format");
  }

  const [, , ivEncoded, tagEncoded, payloadEncoded] = parts;
  if (!ivEncoded || !tagEncoded || !payloadEncoded) {
    throw new Error("Encrypted secret payload is malformed");
  }

  const key = resolveMasterKey(masterKey);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivEncoded, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payloadEncoded, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function maskSecret(value: string): string {
  if (!value || value.length < 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

export function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = new Set([
    "password",
    "passwordHash",
    "token",
    "tokenHash",
    "apiKey",
    "apiKeyEncrypted",
    "secret",
    "credentials",
    "credentialsEncrypted",
    "accessToken",
    "refreshToken",
    "authorization",
    "cookie",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.has(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
