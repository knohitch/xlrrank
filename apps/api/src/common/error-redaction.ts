import { redactSensitive } from "./encryption.js";

export function safeLoggableError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return redactSensitive({
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  }
  if (typeof error === "string") {
    return redactSensitive({ message: error });
  }
  if (error && typeof error === "object") {
    return redactSensitive(error as Record<string, unknown>);
  }
  return { message: String(error) };
}
