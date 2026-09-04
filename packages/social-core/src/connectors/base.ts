import type {
  ConnectorCapability,
  ConnectorManifest,
  ConnectorStatus,
  AvailabilityState,
} from "@xlrrank/shared";
import type {
  SocialConnector,
  ConnectorCredentials,
  AuthResult,
  ContentQuery,
  AccountMetrics,
  NormalizedProfile,
  NormalizedContent,
  NormalizedInteraction,
} from "./types.js";
import { CapabilityUnavailableError, AuthenticationError } from "./errors.js";

export abstract class BaseSocialConnector implements SocialConnector {
  protected abstract manifest: ConnectorManifest;
  protected status: ConnectorStatus = "DISCONNECTED";
  protected credentials: ConnectorCredentials | null = null;

  getManifest(): ConnectorManifest {
    return this.manifest;
  }

  getStatus(): ConnectorStatus {
    return this.status;
  }

  getCapabilities(): Partial<Record<ConnectorCapability, AvailabilityState>> {
    return this.manifest.capabilities;
  }

  async checkHealth(): Promise<boolean> {
    return this.status === "CONNECTED" || this.status === "HEALTHY";
  }

  async authenticate(credentials: ConnectorCredentials): Promise<AuthResult> {
    this.credentials = credentials;
    this.status = "CONNECTED";
    return { success: true, status: this.status };
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.status = "DISCONNECTED";
  }

  protected requireAuth(): void {
    if (!this.credentials) {
      throw new AuthenticationError(this.manifest.id, "Connector is not authenticated");
    }
  }

  protected checkCapability(cap: ConnectorCapability): void {
    const state = this.manifest.capabilities[cap];
    if (!state || state === "UNAVAILABLE") {
      throw new CapabilityUnavailableError(this.manifest.id, cap, "not supported");
    }
    if (state !== "AVAILABLE") {
      throw new CapabilityUnavailableError(this.manifest.id, cap, state.toLowerCase());
    }
  }

  async getAuthenticatedProfile(): Promise<NormalizedProfile | null> {
    this.checkCapability("profiles");
    this.requireAuth();
    return null;
  }

  async getProfile(_identifier: string): Promise<NormalizedProfile | null> {
    this.checkCapability("profiles");
    this.requireAuth();
    return null;
  }

  async getContent(_options: ContentQuery): Promise<NormalizedContent[]> {
    this.checkCapability("content");
    this.requireAuth();
    return [];
  }

  async getComments(_contentId: string, _options?: ContentQuery): Promise<NormalizedInteraction[]> {
    this.checkCapability("comments");
    this.requireAuth();
    return [];
  }

  async searchProfiles(_query: string, _limit?: number): Promise<NormalizedProfile[]> {
    this.checkCapability("search");
    this.requireAuth();
    return [];
  }

  async searchContent(_query: string, _limit?: number): Promise<NormalizedContent[]> {
    this.checkCapability("search");
    this.requireAuth();
    return [];
  }

  async getMetrics(_accountId: string): Promise<AccountMetrics> {
    this.checkCapability("metrics");
    this.requireAuth();
    return { followerCount: 0, followingCount: 0, contentCount: 0, collectedAt: new Date().toISOString() };
  }

  async getFollowers(_accountId: string, _limit?: number): Promise<NormalizedProfile[]> {
    this.checkCapability("followers");
    this.requireAuth();
    return [];
  }

  async getFollowing(_accountId: string, _limit?: number): Promise<NormalizedProfile[]> {
    this.checkCapability("following");
    this.requireAuth();
    return [];
  }
}
