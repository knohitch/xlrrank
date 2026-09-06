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
  ConnectorOperationContext,
  PageResult,
} from "./types.js";
import { CapabilityUnavailableError, AuthenticationError } from "./errors.js";

export abstract class BaseSocialConnector implements SocialConnector {
  protected abstract manifest: ConnectorManifest;

  getManifest(): ConnectorManifest {
    return this.manifest;
  }

  getStatus(): ConnectorStatus {
    return "DISCONNECTED";
  }

  getCapabilities(): Partial<Record<ConnectorCapability, AvailabilityState>> {
    return this.manifest.capabilities;
  }

  async checkHealth(): Promise<boolean> {
    return false;
  }

  async authenticate(
    _credentials: ConnectorCredentials,
    _context?: ConnectorOperationContext,
  ): Promise<AuthResult> {
    throw new AuthenticationError(
      this.manifest.id,
      "Authentication is not implemented for this connector",
    );
  }

  async disconnect(): Promise<void> {
    return;
  }

  protected requireAuth(context?: ConnectorOperationContext): ConnectorCredentials {
    if (!context?.credentials) {
      throw new AuthenticationError(this.manifest.id, "Connector is not authenticated");
    }
    return context.credentials;
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
    throw new CapabilityUnavailableError(this.manifest.id, cap, "implementation not provided");
  }

  async getAuthenticatedProfile(
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile | null> {
    this.checkCapability("profiles");
    this.requireAuth(context);
    return this.notImplemented("profiles");
  }

  async getProfile(
    _identifier: string,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile | null> {
    this.checkCapability("profiles");
    this.requireAuth(context);
    return this.notImplemented("profiles");
  }

  async getContent(
    _options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedContent[]> {
    this.checkCapability("content");
    this.requireAuth(context);
    return this.notImplemented("content");
  }

  async getContentPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedContent>> {
    const items = await this.getContent(options, context);
    return { items, cursor: { value: null, hasMore: false } };
  }

  async getComments(
    _contentId: string,
    _options?: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedInteraction[]> {
    this.checkCapability("comments");
    this.requireAuth(context);
    return this.notImplemented("comments");
  }

  async getInteractionsPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedInteraction>> {
    const items = await this.getComments(options.accountId ?? "", options, context);
    return { items, cursor: { value: null, hasMore: false } };
  }

  async searchProfiles(
    _query: string,
    _limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    this.checkCapability("search");
    this.requireAuth(context);
    return this.notImplemented("search");
  }

  async searchContent(
    _query: string,
    _limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedContent[]> {
    this.checkCapability("search");
    this.requireAuth(context);
    return this.notImplemented("search");
  }

  async getMetrics(
    _accountId: string,
    context?: ConnectorOperationContext,
  ): Promise<AccountMetrics> {
    this.checkCapability("metrics");
    this.requireAuth(context);
    return this.notImplemented("metrics");
  }

  async getFollowers(
    _accountId: string,
    _limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    this.checkCapability("followers");
    this.requireAuth(context);
    return this.notImplemented("followers");
  }

  async getFollowing(
    _accountId: string,
    _limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    this.checkCapability("following");
    this.requireAuth(context);
    return this.notImplemented("following");
  }
}
