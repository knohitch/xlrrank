import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;

interface SafeResolution {
  address: string;
  family: number;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a = 0, b = 0, c = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped.split(".").map((part) => Number(part)));
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("2001:db8:")
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

function normalizeLookupResults(url: URL, addresses: Array<{ address: string; family?: number }>): SafeResolution[] {
  if (addresses.length > 0) {
    return addresses.map((item) => {
      const family = item.family ?? isIP(item.address);
      if (family !== 4 && family !== 6) {
        throw new Error("Provider request hostname resolved to an invalid address");
      }
      return { address: item.address, family };
    });
  }
  const family = isIP(url.hostname);
  if (family !== 4 && family !== 6) {
    throw new Error("Provider request hostname did not resolve");
  }
  return [{ address: url.hostname.replace(/^\[(.*)\]$/, "$1"), family }];
}

export async function resolveSafeProviderRequestUrl(
  rawUrl: string,
  options: { allowPrivateNetwork?: boolean | undefined; lookup?: DnsLookup | undefined } = {},
): Promise<{ url: URL; addresses: SafeResolution[] }> {
  const url = new URL(rawUrl);
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  if (url.protocol !== "https:" && !(allowPrivateNetwork && url.protocol === "http:")) {
    throw new Error("Provider request URL must use HTTPS unless private-network access is trusted");
  }
  let addresses: SafeResolution[];
  if (isPrivateOrReservedHost(url.hostname)) {
    if (!allowPrivateNetwork) throw new Error("Provider request URL targets private/local network space");
    addresses = normalizeLookupResults(url, []);
  } else {
    const resolver = options.lookup ?? (async (hostname: string) => dnsLookup(hostname, { all: true }));
    addresses = normalizeLookupResults(url, await resolver(url.hostname));
    if (!allowPrivateNetwork && addresses.some((item) => isPrivateOrReservedHost(item.address))) {
      throw new Error("Provider request hostname resolves to private/reserved network space");
    }
  }
  return { url, addresses };
}

export async function assertSafeProviderRequestUrl(
  rawUrl: string,
  options: { allowPrivateNetwork?: boolean | undefined; lookup?: DnsLookup | undefined } = {},
): Promise<void> {
  await resolveSafeProviderRequestUrl(rawUrl, options);
}

function headersInitToRecord(headers: RequestInit["headers"] | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.join(", ") : String(value),
    ]),
  );
}

export async function fetchProviderUrl(
  rawUrl: string,
  options: RequestInit & {
    allowPrivateNetwork?: boolean | undefined;
    lookup?: DnsLookup | undefined;
  } = {},
): Promise<Response> {
  const { allowPrivateNetwork, lookup, ...requestOptions } = options;
  const { url, addresses } = await resolveSafeProviderRequestUrl(rawUrl, {
    allowPrivateNetwork,
    lookup,
  });
  const target = addresses[0];
  if (!target) throw new Error("Provider request hostname did not resolve");
  const headers = headersInitToRecord(requestOptions.headers);
  headers.Host = url.host;
  const method = requestOptions.method ?? "GET";
  const body = requestOptions.body;
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    if (requestOptions.signal?.aborted) {
      reject(new Error("Provider request aborted"));
      return;
    }
    const req = transport(
      {
        protocol: url.protocol,
        hostname: target.address,
        family: target.family,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        servername: isIP(url.hostname) ? undefined : url.hostname,
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else if (value !== undefined) {
            responseHeaders.set(key, String(value));
          }
        }
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          }),
        );
      },
    );
    const abort = () => req.destroy(new Error("Provider request aborted"));
    requestOptions.signal?.addEventListener("abort", abort, { once: true });
    req.on("error", reject);
    req.on("close", () => requestOptions.signal?.removeEventListener("abort", abort));
    if (body !== undefined && body !== null) {
      if (typeof body === "string" || body instanceof Uint8Array) {
        req.write(body);
      } else {
        req.destroy(new Error("Unsupported provider request body type"));
        return;
      }
    }
    req.end();
  });
}
