const SENSITIVE_KEY_PATTERN =
  /authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|cookie|set[_-]?cookie|password|secret/i;

export function redactProviderMetadata(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[REDACTED_DEPTH_LIMIT]";
  if (Array.isArray(value)) {
    return value.map((item) => redactProviderMetadata(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactProviderMetadata(nested, depth + 1);
  }
  return output;
}

export function assertMetadataSize(value: unknown, maxBytes: number, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
}
