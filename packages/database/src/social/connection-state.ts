export const SOCIAL_CONNECTION_STATES = [
  "DISCONNECTED",
  "CONNECTING",
  "CONNECTED",
  "DEGRADED",
  "REAUTH_REQUIRED",
  "ERROR",
  "DISABLED",
] as const;

export type SocialConnectionState = (typeof SOCIAL_CONNECTION_STATES)[number];

const allowedTransitions: Record<SocialConnectionState, SocialConnectionState[]> = {
  DISCONNECTED: ["CONNECTING", "DISABLED"],
  CONNECTING: ["CONNECTED", "REAUTH_REQUIRED", "ERROR", "DISCONNECTED"],
  CONNECTED: ["DEGRADED", "REAUTH_REQUIRED", "ERROR", "DISCONNECTED", "DISABLED"],
  DEGRADED: ["CONNECTED", "REAUTH_REQUIRED", "ERROR", "DISCONNECTED", "DISABLED"],
  REAUTH_REQUIRED: ["CONNECTING", "DISCONNECTED", "DISABLED"],
  ERROR: ["CONNECTING", "DISCONNECTED", "DISABLED"],
  DISABLED: ["CONNECTING", "DISCONNECTED"],
};

export function assertConnectionTransition(
  from: SocialConnectionState,
  to: SocialConnectionState,
): void {
  if (from === to) return;
  if (!allowedTransitions[from]?.includes(to)) {
    throw new Error(`Illegal social connection transition from ${from} to ${to}`);
  }
}

export function normalizeLegacyConnectionState(
  status: string | null | undefined,
): SocialConnectionState {
  if (status === "CONNECTED" || status === "HEALTHY") return "CONNECTED";
  if (status === "AUTHENTICATION_EXPIRED" || status === "PERMISSION_MISSING") {
    return "REAUTH_REQUIRED";
  }
  if (status === "RATE_LIMITED" || status === "DEGRADED") return "DEGRADED";
  if (status === "DEMO") return "DISABLED";
  if (status === "CONFIGURATION_UNAVAILABLE") return "ERROR";
  return "DISCONNECTED";
}
