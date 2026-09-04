import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TOKEN_SECRET_ENV = "SESSION_SIGNING_SECRET";

function getSecret(): Buffer {
  const secret = process.env[TOKEN_SECRET_ENV] ?? "";
  if (secret.length < 32) {
    throw new Error(
      `env ${TOKEN_SECRET_ENV} must be set to a value of at least 32 characters`,
    );
  }
  return Buffer.from(secret, "utf8");
}

export function generateRandomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export interface SessionToken {
  sessionId: string;
  secret: string;
}

export function createSessionToken(sessionId: string): SessionToken {
  return { sessionId, secret: generateRandomToken(32) };
}

export function parseSessionToken(token: string): SessionToken {
  const dot = token.indexOf(".");
  if (dot <= 0) throw new Error("Malformed session token.");
  return {
    sessionId: token.slice(0, dot),
    secret: token.slice(dot + 1),
  };
}

export function tokenHash(secret: string): string {
  return sha256Hex(secret);
}

function sign(value: string): string {
  return createHmac("sha256", getSecret()).update(value).digest("base64url");
}

export function signToken(payload: string): string {
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export function verifySignature(payload: string, signature: string): boolean {
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseSignedToken(token: string): string | null {
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  if (!verifySignature(payload, signature)) return null;
  return payload;
}
