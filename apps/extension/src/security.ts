export const SUPPORTED_SOCIAL_HOSTS = [
  "x.com",
  "twitter.com",
  "www.linkedin.com",
  "www.instagram.com",
  "www.reddit.com",
] as const;

const SUPPORTED_SOCIAL_HOST_SET = new Set<string>(SUPPORTED_SOCIAL_HOSTS);

export const MAX_PROFILE_TEXT_LENGTH = 280;
export const MAX_BIO_TEXT_LENGTH = 1_000;
export const MAX_CONTENT_TEXT_LENGTH = 2_000;

export type ExtensionMessageType =
  | "xlrrank:ping"
  | "xlrrank:api-status"
  | "xlrrank:clear-auth"
  | "xlrrank:detect-profile"
  | "xlrrank:detect-content"
  | "xlrrank:extract-profile"
  | "xlrrank:extract-content";

export interface ExtensionMessage {
  type: ExtensionMessageType;
}

const MESSAGE_TYPES = new Set<ExtensionMessageType>([
  "xlrrank:ping",
  "xlrrank:api-status",
  "xlrrank:clear-auth",
  "xlrrank:detect-profile",
  "xlrrank:detect-content",
  "xlrrank:extract-profile",
  "xlrrank:extract-content",
]);

export function boundedText(value: string | null | undefined, maxLength: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function parseExtensionMessage(message: unknown): ExtensionMessage | null {
  if (!message || typeof message !== "object") return null;
  const type = (message as { type?: unknown }).type;
  if (typeof type !== "string" || !MESSAGE_TYPES.has(type as ExtensionMessageType)) {
    return null;
  }
  if (Object.keys(message).length !== 1) return null;
  return { type: type as ExtensionMessageType };
}

export function isTrustedExtensionSender(
  sender: Pick<chrome.runtime.MessageSender, "id"> | undefined,
  extensionId: string | undefined,
): boolean {
  return Boolean(sender?.id && extensionId && sender.id === extensionId);
}

export function isSupportedSocialUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && SUPPORTED_SOCIAL_HOST_SET.has(url.hostname);
  } catch {
    return false;
  }
}

export function detectPlatformFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return isSupportedSocialUrl(rawUrl) ? url.hostname : null;
  } catch {
    return null;
  }
}
