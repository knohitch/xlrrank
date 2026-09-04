import type { Response } from "express";
import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "xlr_session";
export const CSRF_COOKIE = "xlr_csrf";

export interface CookieConfig {
  secure: boolean;
  sameSite: "lax" | "none" | "strict";
  path: string;
}

export function getCookieConfig(envNODE?: string): CookieConfig {
  const isProd = envNODE === "production";
  return {
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  };
}

export interface CookieSerializeOptions {
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "lax" | "none" | "strict";
  maxAge?: number;
  expires?: Date;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieSerializeOptions = {},
): string {
  const parts: string[] = [`${name}=${encode(value)}`];
  if (options.maxAge !== undefined && Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.expires instanceof Date && !Number.isNaN(options.expires.getTime())) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.secure) parts.push("Secure");
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    result[name] = decode(value);
  }
  return result;
}

export function setCookie(
  res: Response,
  name: string,
  value: string,
  options: CookieSerializeOptions,
): void {
  const header = serializeCookie(name, value, options);
  const prev = res.getHeader("Set-Cookie");
  if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, header]);
  } else if (prev) {
    res.setHeader("Set-Cookie", [prev as string, header]);
  } else {
    res.setHeader("Set-Cookie", header);
  }
}

export function clearCookie(
  res: Response,
  name: string,
  options: CookieSerializeOptions,
): void {
  setCookie(res, name, "", { ...options, maxAge: 0, expires: new Date(0) });
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}
