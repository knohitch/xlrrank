const API_BASE = "http://localhost:4000/api";

function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)xlr_csrf=([^;]*)/);
  return match && match[1] ? decodeURIComponent(match[1]) : null;
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

  const headers: Record<string, string> = {
    ...extraHeaders,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const csrf = getCsrfToken();
  if (csrf) {
    headers["X-CSRF-Token"] = csrf;
  }

  const init: RequestInit = {
    method,
    credentials: "include",
    headers,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}${path}`, init);

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
