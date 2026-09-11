import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

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

function isPrivateOrReservedHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const ipVersion = isIP(normalized);
  return (
    LOCAL_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".local") ||
    (ipVersion === 4 && isPrivateIpv4(normalized.split(".").map((part) => Number(part)))) ||
    (ipVersion === 6 && isPrivateIpv6(normalized))
  );
}

export function validateProviderBaseUrl(
  rawBaseUrl: string | null | undefined,
  options: { allowPrivateNetwork?: boolean | undefined } = {},
): string {
  if (!rawBaseUrl) {
    throw new Error("Provider base URL is not configured");
  }

  const url = new URL(rawBaseUrl);
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  if (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) {
    throw new Error("Provider base URL must use HTTPS unless private-network access is trusted");
  }

  if (isPrivateOrReservedHost(url.hostname) && !allowPrivateNetwork) {
    throw new Error("Provider base URL resolves to private/local network space");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export async function assertSafeProviderRequestUrl(
  rawUrl: string,
  options: { allowPrivateNetwork?: boolean | undefined; lookup?: DnsLookup | undefined } = {},
): Promise<void> {
  const url = new URL(rawUrl);
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  if (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) {
    throw new Error("Provider request URL must use HTTPS unless private-network access is trusted");
  }
  if (isPrivateOrReservedHost(url.hostname)) {
    if (!allowPrivateNetwork) throw new Error("Provider request URL targets private/local network space");
    return;
  }
  const resolver = options.lookup ?? (async (hostname: string) => dnsLookup(hostname, { all: true }));
  const addresses = await resolver(url.hostname);
  if (!allowPrivateNetwork && addresses.some((item) => isPrivateOrReservedHost(item.address))) {
    throw new Error("Provider request hostname resolves to private/reserved network space");
  }
}
