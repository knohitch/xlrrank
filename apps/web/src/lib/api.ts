const API_BASE = "/api";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)xlr_csrf=([^;]*)/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
}

let csrfRequest: Promise<string> | null = null;

async function ensureCsrfToken(): Promise<string> {
  const existing = getCsrfTokenFromCookie();
  if (existing) return existing;

  if (!csrfRequest) {
    csrfRequest = fetch(`${API_BASE}/auth/csrf`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Unable to acquire CSRF token (${res.status})`);
        }
        const payload = (await res.json()) as { csrfToken?: string };
        if (!payload.csrfToken) {
          throw new Error("CSRF endpoint returned no token");
        }
        return payload.csrfToken;
      })
      .finally(() => {
        csrfRequest = null;
      });
  }

  return csrfRequest;
}

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function request<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<{ ok: boolean; status: number; data: T }> {
  const { method = "GET", body, headers: extraHeaders } = opts;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const headers: Record<string, string> = {
    ...extraHeaders,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (UNSAFE_METHODS.has(method.toUpperCase())) {
    headers["X-CSRF-Token"] = await ensureCsrfToken();
  }

  const init: RequestInit = {
    method,
    credentials: "include",
    headers,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${normalizedPath}`, init);

  if (res.status === 401 && typeof window !== "undefined") {
    window.location.href = "/signin";
    return { ok: false, status: 401, data: null as T };
  }

  let data: T;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    data = (await res.json()) as T;
  } else {
    data = (await res.text()) as unknown as T;
  }

  return { ok: res.ok, status: res.status, data };
}

export const api = {
  get: <T = unknown>(path: string) => request<T>(path, { method: "GET" }),
  post: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body }),
  put: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body }),
  patch: <T = unknown>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body }),
  delete: <T = unknown>(path: string) =>
    request<T>(path, { method: "DELETE" }),
};
