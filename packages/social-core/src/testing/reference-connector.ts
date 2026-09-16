import type { ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";
import {
  AuthenticationError,
  CapabilityUnavailableError,
  MalformedProviderResponseError,
  PermanentProviderError,
  RateLimitError,
  TemporaryProviderError,
} from "../connectors/errors.js";
import type {
  AuthResult,
  ConnectorCredentials,
  ConnectorOperationContext,
  ContentQuery,
  PageResult,
  RateLimitInfo,
} from "../connectors/types.js";
import {
  NORMALIZATION_VERSION,
  type NormalizedContent,
  type NormalizedInteraction,
  type NormalizedProfile,
  type SocialVisibility,
} from "../normalized.js";
import { redactProviderMetadata } from "../security/redaction.js";
import {
  validateNormalizedContent,
  validateNormalizedInteraction,
  validateNormalizedProfile,
} from "../validation.js";

interface ProviderProfile {
  id: string;
  handle: string;
  displayName?: string;
  bio?: string;
  visibility?: SocialVisibility;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

interface ProviderContent {
  id: string;
  authorId: string;
  body: string;
  type?: string;
  language?: string;
  visibility?: SocialVisibility;
  createdAt?: string;
  metrics?: NormalizedContent["metrics"];
  metadata?: Record<string, unknown>;
}

interface ProviderInteraction {
  id: string;
  fromId: string;
  toContentId?: string;
  toAccountId?: string;
  type: NormalizedInteraction["type"];
  body?: string;
  visibility?: SocialVisibility;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

function assertTestOnlyEnabled(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Reference connector is test-only and cannot run in production");
  }
}

function baseUrl(credentials: ConnectorCredentials): string {
  const url = credentials.metadata?.fixtureBaseUrl;
  if (typeof url !== "string" || !url.startsWith("http://127.0.0.1:")) {
    throw new AuthenticationError("reference", "Reference connector requires a local fixture URL");
  }
  return url;
}

function token(credentials: ConnectorCredentials): string {
  if (!credentials.accessToken) {
    throw new AuthenticationError("reference", "Missing reference connector access token");
  }
  return credentials.accessToken;
}

function provenance(
  platformId: string,
  context: ConnectorOperationContext | undefined,
  visibility: SocialVisibility,
  providerCreatedAt?: string,
) {
  return {
    platformId,
    connectionId: context?.connectionId,
    scopeId: context?.scopeId,
    observedAt: new Date().toISOString(),
    providerCreatedAt,
    normalizationVersion: NORMALIZATION_VERSION,
    adapterVersion: "reference-http-v1",
    visibility,
  };
}

function rateLimitFrom(response: Response): RateLimitInfo | undefined {
  const remaining = response.headers.get("x-fixture-rate-remaining");
  const resetAt = response.headers.get("x-fixture-rate-reset-at");
  const retryAfter = response.headers.get("retry-after");
  if (remaining === null && resetAt === null && retryAfter === null) return undefined;
  return {
    remaining: remaining === null ? 0 : Number.parseInt(remaining, 10),
    resetAt: resetAt ?? undefined,
    retryAfter: retryAfter === null ? undefined : Number.parseInt(retryAfter, 10),
    providerMetadata: {
      fixture: true,
    },
  };
}

export class ReferenceHttpConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "reference-http",
    platformId: "reference-http",
    name: "Reference HTTP Connector",
    version: "0.1.0",
    apiVersion: "fixture-v1",
    capabilities: {
      profiles: "AVAILABLE",
      content: "AVAILABLE",
      comments: "AVAILABLE",
      search: "CONFIGURATION_REQUIRED",
      metrics: "AVAILABLE",
      followers: "APP_REVIEW_REQUIRED",
      following: "UNAVAILABLE",
    },
  };

  constructor() {
    super();
    assertTestOnlyEnabled();
  }

  override async checkHealth(): Promise<boolean> {
    return process.env.NODE_ENV !== "production";
  }

  override async authenticate(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<AuthResult> {
    const profile = await this.fetchJson<ProviderProfile>("/auth/me", credentials, false, context);
    const normalized = this.normalizeProfile(profile, context);
    validateNormalizedProfile(normalized);
    return { success: true, status: "CONNECTED", profile: normalized };
  }

  override async getAuthenticatedProfile(
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile | null> {
    const credentials = this.requireAuth(context);
    const profile = await this.fetchJson<ProviderProfile>("/auth/me", credentials, false, context);
    return this.normalizeProfile(profile, context);
  }

  override async getContentPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedContent>> {
    this.checkCapability("content");
    const credentials = this.requireAuth(context);
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    const response = await this.fetchJson<{
      items: ProviderContent[];
      nextCursor: string | null;
      hasMore: boolean;
    }>(`/content?${query.toString()}`, credentials, true, context);
    const items = response.body.items.map((item) => this.normalizeContent(item, context));
    for (const item of items) validateNormalizedContent(item);
    return {
      items,
      cursor: { value: response.body.nextCursor, hasMore: response.body.hasMore },
      rateLimit: response.rateLimit,
    };
  }

  override async getContent(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedContent[]> {
    return (await this.getContentPage(options, context)).items;
  }

  override async getInteractionsPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedInteraction>> {
    this.checkCapability("comments");
    const credentials = this.requireAuth(context);
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    const response = await this.fetchJson<{
      items: ProviderInteraction[];
      nextCursor: string | null;
      hasMore: boolean;
    }>(`/interactions?${query.toString()}`, credentials, true, context);
    const items = response.body.items.map((item) => this.normalizeInteraction(item, context));
    for (const item of items) validateNormalizedInteraction(item);
    return {
      items,
      cursor: { value: response.body.nextCursor, hasMore: response.body.hasMore },
      rateLimit: response.rateLimit,
    };
  }

  override async getComments(
    _contentId: string,
    options?: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedInteraction[]> {
    return (await this.getInteractionsPage(options ?? {}, context)).items;
  }

  override async getFollowers(): Promise<NormalizedProfile[]> {
    throw new CapabilityUnavailableError(this.manifest.id, "followers", "app_review_required");
  }

  override async getFollowing(): Promise<NormalizedProfile[]> {
    throw new CapabilityUnavailableError(this.manifest.id, "following", "unavailable");
  }

  private async fetchJson<T>(
    path: string,
    credentials: ConnectorCredentials,
    includeRateLimit: true,
    context?: ConnectorOperationContext,
  ): Promise<{ body: T; rateLimit?: RateLimitInfo }>;
  private async fetchJson<T>(
    path: string,
    credentials: ConnectorCredentials,
    includeRateLimit?: false,
    context?: ConnectorOperationContext,
  ): Promise<T>;
  private async fetchJson<T>(
    path: string,
    credentials: ConnectorCredentials,
    includeRateLimit = false,
    context?: ConnectorOperationContext,
  ): Promise<T | { body: T; rateLimit?: RateLimitInfo }> {
    const init: RequestInit = {
      headers: { authorization: `Bearer ${token(credentials)}` },
    };
    if (context?.signal) init.signal = context.signal;
    const response = await fetch(`${baseUrl(credentials)}${path}`, init);
    if (response.status === 401) throw new AuthenticationError(this.manifest.id);
    if (response.status === 403) throw new AuthenticationError(this.manifest.id, "Forbidden");
    if (response.status === 429) {
      throw new RateLimitError(
        this.manifest.id,
        Number.parseInt(response.headers.get("retry-after") ?? "60", 10),
      );
    }
    if (response.status >= 500) {
      throw new TemporaryProviderError(this.manifest.id, `Provider status ${response.status}`);
    }
    if (response.status >= 400) {
      throw new PermanentProviderError(this.manifest.id, `Provider status ${response.status}`);
    }
    let body: T;
    try {
      body = (await response.json()) as T;
    } catch {
      throw new MalformedProviderResponseError(this.manifest.id);
    }
    if (includeRateLimit) {
      const rateLimit = rateLimitFrom(response);
      return rateLimit ? { body, rateLimit } : { body };
    }
    return body;
  }

  private normalizeProfile(
    profile: ProviderProfile,
    context: ConnectorOperationContext | undefined,
  ): NormalizedProfile {
    if (!profile.id || !profile.handle) {
      throw new MalformedProviderResponseError(this.manifest.id, "Profile missing stable identity");
    }
    const visibility = profile.visibility ?? "UNKNOWN";
    return {
      platformId: this.manifest.platformId,
      externalId: profile.id,
      handle: profile.handle,
      displayName: profile.displayName,
      bio: profile.bio,
      visibility,
      providerCreatedAt: profile.createdAt,
      provenance: provenance(this.manifest.platformId, context, visibility, profile.createdAt),
      metadata: redactProviderMetadata(profile.metadata ?? {}) as Record<string, unknown>,
    };
  }

  private normalizeContent(
    content: ProviderContent,
    context: ConnectorOperationContext | undefined,
  ): NormalizedContent {
    if (!content.id || !content.authorId) {
      throw new MalformedProviderResponseError(this.manifest.id, "Content missing stable identity");
    }
    const visibility = content.visibility ?? "UNKNOWN";
    return {
      platformId: this.manifest.platformId,
      authorExternalId: content.authorId,
      externalId: content.id,
      body: content.body,
      contentType: content.type,
      language: content.language,
      externalCreatedAt: content.createdAt,
      visibility,
      metrics: content.metrics,
      provenance: provenance(this.manifest.platformId, context, visibility, content.createdAt),
      metadata: redactProviderMetadata(content.metadata ?? {}) as Record<string, unknown>,
    };
  }

  private normalizeInteraction(
    interaction: ProviderInteraction,
    context: ConnectorOperationContext | undefined,
  ): NormalizedInteraction {
    if (!interaction.id || !interaction.fromId) {
      throw new MalformedProviderResponseError(
        this.manifest.id,
        "Interaction missing stable identity",
      );
    }
    const visibility = interaction.visibility ?? "UNKNOWN";
    return {
      platformId: this.manifest.platformId,
      fromExternalId: interaction.fromId,
      toContentExternalId: interaction.toContentId,
      toAccountExternalId: interaction.toAccountId,
      externalId: interaction.id,
      type: interaction.type,
      body: interaction.body,
      occurredAt: interaction.occurredAt,
      visibility,
      provenance: provenance(this.manifest.platformId, context, visibility, interaction.occurredAt),
      metadata: redactProviderMetadata(interaction.metadata ?? {}) as Record<string, unknown>,
    };
  }
}
