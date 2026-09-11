import { isIP } from "node:net";

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

function isPrivateIpv4(parts: number[]): boolean {
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

export function validateProviderBaseUrl(
  rawBaseUrl: string | null | undefined,
  options: { allowPrivateNetwork?: boolean } = {},
): string {
  if (!rawBaseUrl) {
    throw new Error("Provider base URL is not configured");
  }

  const url = new URL(rawBaseUrl);
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  if (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) {
    throw new Error("Provider base URL must use HTTPS unless private-network access is trusted");
  }

  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const ipVersion = isIP(hostname);
  const isPrivate =
    LOCAL_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".local") ||
    (ipVersion === 4 && isPrivateIpv4(hostname.split(".").map((part) => Number(part)))) ||
    (ipVersion === 6 && isPrivateIpv6(hostname));

  if (isPrivate && !allowPrivateNetwork) {
    throw new Error("Provider base URL resolves to private/local network space");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

