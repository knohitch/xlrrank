import type { AvailabilityState, ConnectorCapability, ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";
import { AuthenticationError, CapabilityUnavailableError } from "../connectors/errors.js";
import type {
  AccountMetrics,
  AuthResult,
  CapabilityEvaluationInput,
  ConnectorCredentials,
  ConnectorOperationContext,
  ContentQuery,
  OAuthAuthorizationRequest,
  OAuthProviderAdapter,
  OAuthTokenExchangeRequest,
  OAuthTokenRefreshRequest,
  OAuthTokenResult,
  PageResult,
} from "../connectors/types.js";
import {
  NORMALIZATION_VERSION,
  type NormalizedContent,
  type NormalizedInteraction,
  type NormalizedProfile,
} from "../normalized.js";
import { validateNormalizedContent, validateNormalizedInteraction, validateNormalizedProfile } from "../validation.js";
import {
  decodeMetaCursor,
  encodeMetaCursor,
  META_DIALOG_BASE_URL,
  META_GRAPH_API_VERSION,
  MetaGraphClient,
  numberValue,
  stringValue,
} from "./meta-api.js";
import type { MetaAsset } from "./facebook-connector.js";

const ADAPTER_VERSION = "instagram-graph-v26-2026-09-08";
const INSTAGRAM_AUTHORIZATION_ENDPOINT = `${META_DIALOG_BASE_URL}/${META_GRAPH_API_VERSION}/dialog/oauth`;
const INSTAGRAM_SCOPES = [
  "public_profile",
  "pages_show_list",
  "instagram_basic",
  "instagram_manage_insights",
  "instagram_manage_comments",
];

const INSTAGRAM_CAPABILITY_MATRIX: Record<ConnectorCapability, { scopes: string[]; state: AvailabilityState }> = {
  profiles: { scopes: ["instagram_basic"], state: "CONFIGURATION_REQUIRED" },
  content: { scopes: ["instagram_basic"], state: "CONFIGURATION_REQUIRED" },
  comments: { scopes: ["instagram_manage_comments"], state: "CONFIGURATION_REQUIRED" },
  metrics: { scopes: ["instagram_manage_insights"], state: "CONFIGURATION_REQUIRED" },
  search: { scopes: [], state: "UNAVAILABLE" },
  followers: { scopes: [], state: "UNAVAILABLE" },
  following: { scopes: [], state: "UNAVAILABLE" },
  audience_insights: { scopes: [], state: "UNAVAILABLE" },
  messages: { scopes: [], state: "UNAVAILABLE" },
  publishing: { scopes: [], state: "UNAVAILABLE" },
};

export interface InstagramConnectorOptions {
  baseUrl?: string | undefined;
  authorizeBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export function evaluateInstagramCapabilities(input: CapabilityEvaluationInput) {
  const granted = new Set(input.grantedScopes ?? []);
  const output: Partial<Record<ConnectorCapability, AvailabilityState>> = {};
  for (const [capability, details] of Object.entries(INSTAGRAM_CAPABILITY_MATRIX) as Array<[ConnectorCapability, { scopes: string[]; state: AvailabilityState }]>) {
    if (details.state === "UNAVAILABLE") output[capability] = "UNAVAILABLE";
    else if (!input.configured) output[capability] = "CONFIGURATION_REQUIRED";
    else if (details.scopes.some((scope) => !granted.has(scope))) output[capability] = "PERMISSION_REQUIRED";
    else output[capability] = "AVAILABLE";
  }
  return output;
}

export class InstagramConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "instagram",
    platformId: "instagram",
    name: "Instagram",
    version: "0.2.0",
    apiVersion: META_GRAPH_API_VERSION,
    capabilities: Object.fromEntries(
      Object.entries(INSTAGRAM_CAPABILITY_MATRIX).map(([key, value]) => [key, value.state]),
    ) as Partial<Record<ConnectorCapability, AvailabilityState>>,
    providerConfig: {
      fields: [
        { key: "clientId", label: "App ID", required: true, secret: false, kind: "string" },
        { key: "clientSecret", label: "App Secret", required: true, secret: true, kind: "string" },
        { key: "redirectUri", label: "Redirect URI", required: true, secret: false, kind: "url" },
      ],
    },
    oauth: {
      type: "authorization_code_pkce",
      authorizationEndpoint: INSTAGRAM_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
      defaultScopes: INSTAGRAM_SCOPES,
      pkceRequired: false,
      supportsRefresh: true,
      supportsRevocation: false,
    },
  };

  private readonly client: MetaGraphClient;
  private readonly authorizeBaseUrl: string;

  constructor(options: InstagramConnectorOptions = {}) {
    super();
    this.client = new MetaGraphClient({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      connectorId: "instagram",
    });
    this.authorizeBaseUrl = options.authorizeBaseUrl ?? process.env.META_OAUTH_AUTHORIZE_URL ?? INSTAGRAM_AUTHORIZATION_ENDPOINT;
  }

  override getCapabilities() {
    return evaluateInstagramCapabilities({ configured: false });
  }

  override evaluateCapabilities(input: CapabilityEvaluationInput) {
    return evaluateInstagramCapabilities(input);
  }

  getOAuthAdapter(): OAuthProviderAdapter {
    return {
      buildAuthorizationUrl: (request) => this.buildAuthorizationUrl(request),
      exchangeAuthorizationCode: (request, signal) => this.exchangeAuthorizationCode(request, signal),
      refreshAccessToken: (request, signal) => this.refreshAccessToken(request, signal),
      verifyIdentity: (credentials, context) => this.getAuthenticatedProfileOrThrow(credentials, context),
      revoke: async () => ({ providerRevoked: false, reason: "Meta does not provide a connector-specific revocation contract for this read-only Instagram flow." }),
    };
  }

  override async authenticate(credentials: ConnectorCredentials, context?: ConnectorOperationContext): Promise<AuthResult> {
    try {
      const profile = await this.getAuthenticatedProfileOrThrow(credentials, context);
      return { success: true, status: "CONNECTED", profile };
    } catch (err) {
      if (err instanceof AuthenticationError) return { success: false, status: "REAUTH_REQUIRED", error: err.message };
      throw err;
    }
  }

  override async getAuthenticatedProfile(context?: ConnectorOperationContext) {
    return this.getAuthenticatedProfileOrThrow(this.requireAuth(context), context);
  }

  override async getProfile(identifier: string, context?: ConnectorOperationContext) {
    this.assertAvailable("profiles", context);
    const response = await this.client.get<InstagramAccount>(
      `/${encodeURIComponent(identifier)}`,
      token(this.requireAuth(context)),
      new URLSearchParams({ fields: "id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,account_type" }),
      this.requestOptions(context),
    );
    const profile = normalizeInstagramProfile(response.body, context);
    validateNormalizedProfile(profile);
    return profile;
  }

  override async getContentPage(options: ContentQuery, context?: ConnectorOperationContext): Promise<PageResult<NormalizedContent>> {
    this.assertAvailable("content", context);
    const accountId = this.assetId(context, options.accountId);
    const query = new URLSearchParams({
      fields: "id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,like_count,comments_count",
      limit: String(Math.min(Math.max(options.limit ?? 25, 1), 100)),
    });
    const cursor = decodeMetaCursor(options.cursor)?.after;
    if (typeof cursor === "string") query.set("after", cursor);
    const response = await this.client.get<MetaEdge<InstagramMedia>>(
      `/${encodeURIComponent(accountId)}/media`,
      token(this.requireAuth(context)),
      query,
      this.requestOptions(context),
    );
    const items = (response.body.data ?? []).map((media) => normalizeInstagramMedia(accountId, media, context));
    for (const item of items) validateNormalizedContent(item);
    const after = stringValue(response.body.paging?.cursors?.after);
    return { items, cursor: { value: after ? encodeMetaCursor({ after }) : null, hasMore: !!after }, rateLimit: response.rateLimit };
  }

  override async getContent(options: ContentQuery, context?: ConnectorOperationContext) {
    return (await this.getContentPage(options, context)).items;
  }

  override async getComments(contentId: string, _options: ContentQuery = {}, context?: ConnectorOperationContext) {
    this.assertAvailable("comments", context);
    if (!contentId) return [];
    const response = await this.client.get<MetaEdge<InstagramComment>>(
      `/${encodeURIComponent(contentId)}/comments`,
      token(this.requireAuth(context)),
      new URLSearchParams({ fields: "id,text,timestamp,username" }),
      this.requestOptions(context),
    );
    const items = (response.body.data ?? []).map((comment) => normalizeInstagramComment(contentId, comment, context));
    for (const item of items) validateNormalizedInteraction(item);
    return items;
  }

  override async getInteractionsPage(options: ContentQuery, context?: ConnectorOperationContext): Promise<PageResult<NormalizedInteraction>> {
    if (!options.accountId) return { items: [], cursor: { value: null, hasMore: false } };
    return { items: await this.getComments(options.accountId, options, context), cursor: { value: null, hasMore: false } };
  }

  override async getMetrics(accountId: string, context?: ConnectorOperationContext): Promise<AccountMetrics> {
    const profile = await this.getProfile(accountId, context);
    return {
      followerCount: profile?.followerCount ?? 0,
      followingCount: profile?.followingCount ?? 0,
      contentCount: numberValue(profile?.metadata.mediaCount) ?? 0,
      collectedAt: new Date().toISOString(),
    };
  }

  async listAssets(credentials: ConnectorCredentials, context?: ConnectorOperationContext): Promise<MetaAsset[]> {
    const response = await this.client.get<MetaEdge<{ id?: unknown; name?: unknown; username?: unknown; access_token?: unknown; instagram_business_account?: InstagramAccount }>>(
      "/me/accounts",
      token(credentials),
      new URLSearchParams({ fields: "id,name,username,access_token,instagram_business_account{id,username,name,account_type}" }),
      this.requestOptions(context, credentials),
    );
    return (response.body.data ?? [])
      .filter((page) => !!page.instagram_business_account?.id)
      .map((page) => ({
        platformId: "instagram",
        assetType: "INSTAGRAM_PROFESSIONAL_ACCOUNT",
        assetId: mustString(page.instagram_business_account?.id, "instagram_business_account.id"),
        parentAssetId: stringValue(page.id),
        name: stringValue(page.instagram_business_account?.name) ?? stringValue(page.instagram_business_account?.username) ?? mustString(page.instagram_business_account?.id, "instagram_business_account.id"),
        handle: stringValue(page.instagram_business_account?.username),
        tokenKind: "PAGE",
        accessToken: stringValue(page.access_token),
        metadata: { parentPageName: page.name, accountType: page.instagram_business_account?.account_type },
      }));
  }

  private async getAuthenticatedProfileOrThrow(credentials: ConnectorCredentials, context?: ConnectorOperationContext): Promise<NormalizedProfile> {
    const assetId = stringValue(credentials.metadata?.assetId) ?? stringValue(credentials.metadata?.instagramAccountId) ?? stringValue(credentials.metadata?.providerUserId);
    if (!assetId) throw new AuthenticationError("instagram", "Instagram Professional account asset selection is required");
    return this.getProfile(assetId, contextWithCredentials(credentials, context));
  }

  private buildAuthorizationUrl(request: OAuthAuthorizationRequest): URL {
    const url = new URL(this.authorizeBaseUrl);
    url.searchParams.set("client_id", request.providerConfig.clientId);
    url.searchParams.set("redirect_uri", request.providerConfig.redirectUri);
    url.searchParams.set("state", request.state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", request.requestedScopes.join(","));
    return url;
  }

  private async exchangeAuthorizationCode(request: OAuthTokenExchangeRequest, signal?: AbortSignal): Promise<OAuthTokenResult> {
    const form = new URLSearchParams({
      client_id: request.providerConfig.clientId,
      redirect_uri: request.redirectUri,
      client_secret: request.providerConfig.clientSecret ?? "",
      code: request.code,
    });
    const response = await this.client.postForm<{ access_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown }>("/oauth/access_token", form, { signal });
    return tokenResult(response.body);
  }

  private async refreshAccessToken(request: OAuthTokenRefreshRequest, signal?: AbortSignal): Promise<OAuthTokenResult> {
    const form = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: request.providerConfig.clientId,
      client_secret: request.providerConfig.clientSecret ?? "",
      fb_exchange_token: request.refreshToken,
    });
    const response = await this.client.postForm<{ access_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown }>("/oauth/access_token", form, { signal });
    return tokenResult(response.body);
  }

  private assertAvailable(capability: ConnectorCapability, context?: ConnectorOperationContext): void {
    const evaluated = evaluateInstagramCapabilities({ configured: true, grantedScopes: context?.credentials.scopes ?? [] });
    const state = evaluated[capability];
    if (state !== "AVAILABLE") throw new CapabilityUnavailableError("instagram", capability, state ?? "unavailable");
  }

  private assetId(context: ConnectorOperationContext | undefined, explicit?: string): string {
    const value = explicit ?? stringValue(context?.credentials.metadata?.assetId) ?? stringValue(context?.credentials.metadata?.instagramAccountId) ?? stringValue(context?.credentials.metadata?.providerUserId);
    if (!value) throw new AuthenticationError("instagram", "Instagram Professional account asset selection is required");
    return value;
  }

  private requestOptions(context?: ConnectorOperationContext, credentials = context?.credentials) {
    return { appSecret: stringValue(credentials?.metadata?.appSecret), signal: context?.signal };
  }
}

interface MetaEdge<T> {
  data?: T[];
  paging?: { cursors?: { after?: unknown } };
}

interface InstagramAccount {
  id?: unknown;
  username?: unknown;
  name?: unknown;
  biography?: unknown;
  website?: unknown;
  profile_picture_url?: unknown;
  followers_count?: unknown;
  follows_count?: unknown;
  media_count?: unknown;
  account_type?: unknown;
}

interface InstagramMedia {
  id?: unknown;
  caption?: unknown;
  media_type?: unknown;
  media_product_type?: unknown;
  timestamp?: unknown;
  permalink?: unknown;
  thumbnail_url?: unknown;
  like_count?: unknown;
  comments_count?: unknown;
}

interface InstagramComment {
  id?: unknown;
  text?: unknown;
  timestamp?: unknown;
  username?: unknown;
}

function normalizeInstagramProfile(account: InstagramAccount, context?: ConnectorOperationContext): NormalizedProfile {
  const id = mustString(account.id, "account.id");
  return {
    platformId: "instagram",
    externalId: id,
    handle: mustString(account.username, "account.username"),
    displayName: stringValue(account.name),
    bio: stringValue(account.biography),
    website: stringValue(account.website),
    profileImageUrl: stringValue(account.profile_picture_url),
    followerCount: numberValue(account.followers_count),
    followingCount: numberValue(account.follows_count),
    visibility: "SCOPE_PRIVATE",
    provenance: provenance(context),
    metadata: { mediaCount: numberValue(account.media_count), accountType: stringValue(account.account_type) },
  };
}

function normalizeInstagramMedia(accountId: string, media: InstagramMedia, context?: ConnectorOperationContext): NormalizedContent {
  const id = mustString(media.id, "media.id");
  return {
    platformId: "instagram",
    authorExternalId: accountId,
    externalId: id,
    body: stringValue(media.caption) ?? id,
    contentType: stringValue(media.media_type)?.toLowerCase() ?? "media",
    externalCreatedAt: stringValue(media.timestamp),
    visibility: "SCOPE_PRIVATE",
    metrics: {
      likes: numberValue(media.like_count),
      comments: numberValue(media.comments_count),
    },
    provenance: provenance(context, stringValue(media.timestamp)),
    metadata: {
      mediaProductType: stringValue(media.media_product_type),
      permalinkUrl: stringValue(media.permalink),
      thumbnailUrl: stringValue(media.thumbnail_url),
    },
  };
}

function normalizeInstagramComment(contentId: string, comment: InstagramComment, context?: ConnectorOperationContext): NormalizedInteraction {
  const id = mustString(comment.id, "comment.id");
  return {
    platformId: "instagram",
    fromExternalId: stringValue(comment.username) ?? "unknown",
    toContentExternalId: contentId,
    externalId: id,
    type: "COMMENT",
    body: stringValue(comment.text),
    occurredAt: stringValue(comment.timestamp) ?? new Date(0).toISOString(),
    visibility: "SCOPE_PRIVATE",
    provenance: provenance(context, stringValue(comment.timestamp)),
    metadata: {},
  };
}

function token(credentials: ConnectorCredentials): string {
  if (!credentials.accessToken) throw new AuthenticationError("instagram", "Missing Meta access token");
  return credentials.accessToken;
}

function tokenResult(body: { access_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown }): OAuthTokenResult {
  const accessToken = mustString(body.access_token, "access_token");
  const expiresIn = numberValue(body.expires_in);
  return {
    accessToken,
    refreshToken: accessToken,
    tokenType: stringValue(body.token_type),
    expiresIn,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    grantedScopes: typeof body.scope === "string" ? body.scope.split(/[,\s]+/).filter(Boolean) : INSTAGRAM_SCOPES,
    rawProviderMetadata: {},
  };
}

function provenance(context?: ConnectorOperationContext, providerCreatedAt?: string) {
  return {
    platformId: "instagram",
    connectionId: context?.connectionId,
    scopeId: context?.scopeId,
    observedAt: new Date().toISOString(),
    providerCreatedAt,
    normalizationVersion: NORMALIZATION_VERSION,
    adapterVersion: ADAPTER_VERSION,
    visibility: "SCOPE_PRIVATE" as const,
  };
}

function mustString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new AuthenticationError("instagram", `Meta response missing ${field}`);
  return normalized;
}

function contextWithCredentials(
  credentials: ConnectorCredentials,
  context?: ConnectorOperationContext,
): ConnectorOperationContext {
  return {
    scopeId: context?.scopeId ?? "meta-oauth-verification",
    connectionId: context?.connectionId ?? "meta-oauth-verification",
    credentials,
    ...(context?.signal ? { signal: context.signal } : {}),
  };
}
