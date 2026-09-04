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
    return false;
  }

  async authenticate(_credentials: ConnectorCredentials): Promise<AuthResult> {
    this.credentials = null;
    this.status = "DISCONNECTED";
    throw new AuthenticationError(
      this.manifest.id,
      "Authentication is not implemented for this connector",
    );
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

  protected notImplemented(cap: ConnectorCapability): never {
    throw new CapabilityUnavailableError(
      this.manifest.id,
      cap,
      "implementation not provided",
    );
  }

  async getAuthenticatedProfile(): Promise<NormalizedProfile | null> {
    this.checkCapability("profiles");
    this.requireAuth();
    return this.notImplemented("profiles");
  }

  async getProfile(_identifier: string): Promise<NormalizedProfile | null> {
    this.checkCapability("profiles");
    this.requireAuth();
    return this.notImplemented("profiles");
  }

  async getContent(_options: ContentQuery): Promise<NormalizedContent[]> {
    this.checkCapability("content");
    this.requireAuth();
    return this.notImplemented("content");
  }

  async getComments(_contentId: string, _options?: ContentQuery): Promise<NormalizedInteraction[]> {
    this.checkCapability("comments");
    this.requireAuth();
    return this.notImplemented("comments");
  }

  async searchProfiles(_query: string, _limit?: number): Promise<NormalizedProfile[]> {
    this.checkCapability("search");
    this.requireAuth();
    return this.notImplemented("search");
  }

  async searchContent(_query: string, _limit?: number): Promise<NormalizedContent[]> {
    this.checkCapability("search");
    this.requireAuth();
    return this.notImplemented("search");
  }

  async getMetrics(_accountId: string): Promise<AccountMetrics> {
    this.checkCapability("metrics");
    this.requireAuth();
    return this.notImplemented("metrics");
  }

  async getFollowers(_accountId: string, _limit?: number): Promise<NormalizedProfile[]> {
    this.checkCapability("followers");
    this.requireAuth();
    return this.notImplemented("followers");
  }

  async getFollowing(_accountId: string, _limit?: number): Promise<NormalizedProfile[]> {
    this.checkCapability("following");
    this.requireAuth();
    return this.notImplemented("following");
  }
}
