import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const baseUrl = process.env.API_PUBLIC_URL;
  if (!baseUrl) {
    return Response.json(
      { message: "API upstream is not configured." },
      { status: 503 },
    );
  }

  const { path } = await context.params;
  const upstream = new URL(
    `/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`,
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    cache: "no-store",
  };

  if (METHODS_WITH_BODY.has(request.method.toUpperCase())) {
    const body = await request.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }

  try {
    const response = await fetch(upstream, init);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("transfer-encoding");
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      { message: "API upstream is unavailable." },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
