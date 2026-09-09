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
import {
  decodeMetaCursor,
  encodeMetaCursor,
  META_DIALOG_BASE_URL,
  META_GRAPH_API_VERSION,
  MetaGraphClient,
  numberValue,
  stringValue,
} from "./meta-api.js";
import { validateNormalizedContent, validateNormalizedInteraction, validateNormalizedProfile } from "../validation.js";

const ADAPTER_VERSION = "facebook-pages-graph-v26-2026-09-08";
const FACEBOOK_AUTHORIZATION_ENDPOINT = `${META_DIALOG_BASE_URL}/${META_GRAPH_API_VERSION}/dialog/oauth`;
const FACEBOOK_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "read_insights",
  "instagram_basic",
  "instagram_manage_insights",
  "instagram_manage_comments",
];

const FACEBOOK_CAPABILITY_MATRIX: Record<ConnectorCapability, { scopes: string[]; state: AvailabilityState }> = {
  profiles: { scopes: ["pages_show_list"], state: "CONFIGURATION_REQUIRED" },
  content: { scopes: ["pages_read_engagement"], state: "CONFIGURATION_REQUIRED" },
  comments: { scopes: ["pages_read_user_content"], state: "CONFIGURATION_REQUIRED" },
  metrics: { scopes: ["pages_read_engagement"], state: "CONFIGURATION_REQUIRED" },
  search: { scopes: [], state: "UNAVAILABLE" },
  followers: { scopes: [], state: "UNAVAILABLE" },
  following: { scopes: [], state: "UNAVAILABLE" },
  audience_insights: { scopes: [], state: "UNAVAILABLE" },
  messages: { scopes: [], state: "UNAVAILABLE" },
  publishing: { scopes: [], state: "UNAVAILABLE" },
};

export interface FacebookConnectorOptions {
  baseUrl?: string | undefined;
  authorizeBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export function evaluateFacebookCapabilities(input: CapabilityEvaluationInput) {
  return evaluateMetaCapabilities(input, FACEBOOK_CAPABILITY_MATRIX);
}

export class FacebookConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "facebook",
    platformId: "facebook",
    name: "Facebook",
    version: "0.2.0",
    apiVersion: META_GRAPH_API_VERSION,
    capabilities: Object.fromEntries(
      Object.entries(FACEBOOK_CAPABILITY_MATRIX).map(([key, value]) => [key, value.state]),
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
      authorizationEndpoint: FACEBOOK_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
      defaultScopes: FACEBOOK_SCOPES,
      pkceRequired: false,
      supportsRefresh: true,
      supportsRevocation: false,
    },
  };

  private readonly client: MetaGraphClient;
  private readonly authorizeBaseUrl: string;

  constructor(options: FacebookConnectorOptions = {}) {
    super();
    this.client = new MetaGraphClient({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      connectorId: "facebook",
    });
    this.authorizeBaseUrl = options.authorizeBaseUrl ?? process.env.META_OAUTH_AUTHORIZE_URL ?? FACEBOOK_AUTHORIZATION_ENDPOINT;
  }

  override getCapabilities() {
    return evaluateFacebookCapabilities({ configured: false });
  }

  override evaluateCapabilities(input: CapabilityEvaluationInput) {
    return evaluateFacebookCapabilities(input);
  }

  getOAuthAdapter(): OAuthProviderAdapter {
    return {
      buildAuthorizationUrl: (request) => this.buildAuthorizationUrl(request),
      exchangeAuthorizationCode: (request, signal) => this.exchangeAuthorizationCode(request, signal),
      refreshAccessToken: (request, signal) => this.refreshAccessToken(request, signal),
      verifyIdentity: (credentials, context) => this.getAuthenticatedProfileOrThrow(credentials, context),
      revoke: async () => ({ providerRevoked: false, reason: "Meta does not provide a connector-specific revocation contract for this read-only Page flow." }),
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
    const response = await this.client.get<{ id?: unknown; name?: unknown; username?: unknown; about?: unknown; website?: unknown; fan_count?: unknown; followers_count?: unknown; picture?: { data?: { url?: unknown } } }>(
      `/${encodeURIComponent(identifier)}`,
      token(this.requireAuth(context)),
      new URLSearchParams({ fields: "id,name,username,about,website,fan_count,followers_count,picture" }),
      this.requestOptions(context),
    );
    const profile = normalizeFacebookPage(response.body, context);
    validateNormalizedProfile(profile);
    return profile;
  }

  override async getContentPage(options: ContentQuery, context?: ConnectorOperationContext): Promise<PageResult<NormalizedContent>> {
    this.assertAvailable("content", context);
    const accountId = this.assetId(context, options.accountId);
    const query = new URLSearchParams({
      fields: "id,message,story,created_time,permalink_url,attachments,shares,comments.summary(true),reactions.summary(true)",
      limit: String(Math.min(Math.max(options.limit ?? 25, 1), 100)),
    });
    const cursor = decodeMetaCursor(options.cursor)?.after;
    if (typeof cursor === "string") query.set("after", cursor);
    const response = await this.client.get<MetaEdge<FacebookPost>>(
      `/${encodeURIComponent(accountId)}/posts`,
      token(this.requireAuth(context)),
      query,
      this.requestOptions(context),
    );
    const items = (response.body.data ?? []).map((post) => normalizeFacebookPost(accountId, post, context));
    for (const item of items) validateNormalizedContent(item);
    const after = stringValue(response.body.paging?.cursors?.after);
    return { items, cursor: { value: after ? encodeMetaCursor({ after }) : null, hasMore: !!after }, rateLimit: response.rateLimit };
  }

  override async getContent(options: ContentQuery, context?: ConnectorOperationContext) {
    return (await this.getContentPage(options, context)).items;
  }

  override async getComments(contentId: string, _options: ContentQuery = {}, context?: ConnectorOperationContext) {
    if (!contentId) return [];
    return (await this.fetchCommentPage(contentId, _options, context)).items;
  }

  override async getInteractionsPage(options: ContentQuery, context?: ConnectorOperationContext): Promise<PageResult<NormalizedInteraction>> {
    if (!options.accountId) return { items: [], cursor: { value: null, hasMore: false } };
    return this.fetchCommentPage(options.accountId, options, context);
  }

  override async getMetrics(accountId: string, context?: ConnectorOperationContext): Promise<AccountMetrics> {
    const profile = await this.getProfile(accountId, context);
    return {
      followerCount: profile?.followerCount ?? 0,
      followingCount: 0,
      contentCount: numberValue(profile?.metadata.contentCount) ?? 0,
      collectedAt: new Date().toISOString(),
    };
  }

  async listAssets(credentials: ConnectorCredentials, context?: ConnectorOperationContext): Promise<MetaAsset[]> {
    const response = await this.client.get<MetaEdge<FacebookPageAsset>>(
      "/me/accounts",
      token(credentials),
      new URLSearchParams({ fields: "id,name,username,category,access_token,tasks,instagram_business_account{id,username,name}" }),
      this.requestOptions(context, credentials),
    );
    return (response.body.data ?? []).flatMap((page) => {
      const pageId = mustString(page.id, "page.id");
      const accessToken = stringValue(page.access_token);
      const assets: MetaAsset[] = [
        {
          platformId: "facebook",
          assetType: "FACEBOOK_PAGE",
          assetId: pageId,
          name: stringValue(page.name) ?? pageId,
          handle: stringValue(page.username),
          tokenKind: "PAGE",
          accessToken,
          metadata: { category: page.category, tasks: page.tasks, instagramBusinessAccount: page.instagram_business_account },
        },
      ];
      const instagram = page.instagram_business_account as
        | { id?: unknown; username?: unknown; name?: unknown; account_type?: unknown }
        | undefined;
      const instagramId = stringValue(instagram?.id);
      if (instagramId) {
        assets.push({
          platformId: "instagram",
          assetType: "INSTAGRAM_PROFESSIONAL_ACCOUNT",
          assetId: instagramId,
          parentAssetId: pageId,
          name: stringValue(instagram?.name) ?? stringValue(instagram?.username) ?? instagramId,
          handle: stringValue(instagram?.username),
          tokenKind: "PAGE",
          accessToken,
          metadata: { parentPageId: pageId, parentPageName: page.name, accountType: instagram?.account_type },
        });
      }
      return assets;
    });
  }

  private async getAuthenticatedProfileOrThrow(credentials: ConnectorCredentials, context?: ConnectorOperationContext): Promise<NormalizedProfile> {
    const assetId = stringValue(credentials.metadata?.assetId) ?? stringValue(credentials.metadata?.pageId);
    if (assetId) return this.getProfile(assetId, contextWithCredentials(credentials, context));
    const response = await this.client.get<{ id?: unknown; name?: unknown }>("/me", token(credentials), new URLSearchParams({ fields: "id,name" }), this.requestOptions(context, credentials));
    const id = mustString(response.body.id, "me.id");
    const profile = normalizeFacebookPage({ id, name: response.body.name, username: id }, context);
    validateNormalizedProfile(profile);
    return profile;
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
    return tokenResult(response.body, FACEBOOK_SCOPES);
  }

  private async refreshAccessToken(request: OAuthTokenRefreshRequest, signal?: AbortSignal): Promise<OAuthTokenResult> {
    const form = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: request.providerConfig.clientId,
      client_secret: request.providerConfig.clientSecret ?? "",
      fb_exchange_token: request.refreshToken,
    });
    const response = await this.client.postForm<{ access_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown }>("/oauth/access_token", form, { signal });
    return tokenResult(response.body, FACEBOOK_SCOPES);
  }

  private assertAvailable(capability: ConnectorCapability, context?: ConnectorOperationContext): void {
    const evaluated = evaluateFacebookCapabilities({ configured: true, grantedScopes: context?.credentials.scopes ?? [] });
    const state = evaluated[capability];
    if (state !== "AVAILABLE") throw new CapabilityUnavailableError("facebook", capability, state ?? "unavailable");
  }

  private assetId(context: ConnectorOperationContext | undefined, explicit?: string): string {
    const value = explicit ?? stringValue(context?.credentials.metadata?.assetId) ?? stringValue(context?.credentials.metadata?.pageId) ?? stringValue(context?.credentials.metadata?.providerUserId);
    if (!value) throw new AuthenticationError("facebook", "Facebook Page asset selection is required");
    return value;
  }

  private requestOptions(context?: ConnectorOperationContext, credentials = context?.credentials) {
    return { appSecret: stringValue(credentials?.metadata?.appSecret), signal: context?.signal };
  }

  private async fetchCommentPage(
    contentId: string,
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedInteraction>> {
    this.assertAvailable("comments", context);
    const query = new URLSearchParams({
      fields: "id,message,created_time,from",
      limit: String(Math.min(Math.max(options.limit ?? 50, 1), 100)),
    });
    const cursor = decodeMetaCursor(options.cursor)?.after;
    if (typeof cursor === "string") query.set("after", cursor);
    const response = await this.client.get<MetaEdge<FacebookComment>>(
      `/${encodeURIComponent(contentId)}/comments`,
      token(this.requireAuth(context)),
      query,
      this.requestOptions(context),
    );
    const items = (response.body.data ?? []).map((comment) => normalizeFacebookComment(contentId, comment, context));
    for (const item of items) validateNormalizedInteraction(item);
    const after = stringValue(response.body.paging?.cursors?.after);
    return { items, cursor: { value: after ? encodeMetaCursor({ after }) : null, hasMore: !!after }, rateLimit: response.rateLimit };
  }
}

export interface MetaAsset {
  platformId: "facebook" | "instagram";
  assetType: "FACEBOOK_PAGE" | "INSTAGRAM_PROFESSIONAL_ACCOUNT";
  assetId: string;
  name: string;
  handle?: string | undefined;
  parentAssetId?: string | undefined;
  tokenKind: "USER" | "PAGE";
  accessToken?: string | undefined;
  metadata: Record<string, unknown>;
}

interface MetaEdge<T> {
  data?: T[];
  paging?: { cursors?: { after?: unknown } };
}

interface FacebookPageAsset {
  id?: unknown;
  name?: unknown;
  username?: unknown;
  category?: unknown;
  access_token?: unknown;
  tasks?: unknown;
  instagram_business_account?: unknown;
}

interface FacebookPost {
  id?: unknown;
  message?: unknown;
  story?: unknown;
  created_time?: unknown;
  permalink_url?: unknown;
  shares?: { count?: unknown };
  comments?: { summary?: { total_count?: unknown } };
  reactions?: { summary?: { total_count?: unknown } };
  attachments?: unknown;
}

interface FacebookComment {
  id?: unknown;
  message?: unknown;
  created_time?: unknown;
  from?: { id?: unknown };
}

function evaluateMetaCapabilities(input: CapabilityEvaluationInput, matrix: Record<ConnectorCapability, { scopes: string[]; state: AvailabilityState }>) {
  const granted = new Set(input.grantedScopes ?? []);
  const output: Partial<Record<ConnectorCapability, AvailabilityState>> = {};
  for (const [capability, details] of Object.entries(matrix) as Array<[ConnectorCapability, { scopes: string[]; state: AvailabilityState }]>) {
    if (details.state === "UNAVAILABLE") output[capability] = "UNAVAILABLE";
    else if (!input.configured) output[capability] = "CONFIGURATION_REQUIRED";
    else if (details.scopes.some((scope) => !granted.has(scope))) output[capability] = "PERMISSION_REQUIRED";
    else output[capability] = "AVAILABLE";
  }
  return output;
}

function normalizeFacebookPage(page: { id?: unknown; name?: unknown; username?: unknown; about?: unknown; website?: unknown; fan_count?: unknown; followers_count?: unknown; picture?: { data?: { url?: unknown } } }, context?: ConnectorOperationContext): NormalizedProfile {
  const id = mustString(page.id, "page.id");
  return {
    platformId: "facebook",
    externalId: id,
    handle: stringValue(page.username) ?? id,
    displayName: stringValue(page.name),
    bio: stringValue(page.about),
    website: stringValue(page.website),
    profileImageUrl: stringValue(page.picture?.data?.url),
    followerCount: numberValue(page.followers_count) ?? numberValue(page.fan_count),
    visibility: "SCOPE_PRIVATE",
    provenance: provenance("facebook", context),
    metadata: { fanCount: numberValue(page.fan_count) },
  };
}

function normalizeFacebookPost(pageId: string, post: FacebookPost, context?: ConnectorOperationContext): NormalizedContent {
  const id = mustString(post.id, "post.id");
  return {
    platformId: "facebook",
    authorExternalId: pageId,
    externalId: id,
    body: stringValue(post.message) ?? stringValue(post.story) ?? id,
    contentType: "post",
    externalCreatedAt: stringValue(post.created_time),
    visibility: "SCOPE_PRIVATE",
    metrics: {
      likes: numberValue(post.reactions?.summary?.total_count),
      comments: numberValue(post.comments?.summary?.total_count),
      shares: numberValue(post.shares?.count),
    },
    provenance: provenance("facebook", context, stringValue(post.created_time)),
    metadata: { permalinkUrl: stringValue(post.permalink_url), attachments: post.attachments },
  };
}

function normalizeFacebookComment(contentId: string, comment: FacebookComment, context?: ConnectorOperationContext): NormalizedInteraction {
  const id = mustString(comment.id, "comment.id");
  return {
    platformId: "facebook",
    fromExternalId: stringValue(comment.from?.id) ?? "unknown",
    toContentExternalId: contentId,
    externalId: id,
    type: "COMMENT",
    body: stringValue(comment.message),
    occurredAt: stringValue(comment.created_time) ?? new Date(0).toISOString(),
    visibility: "SCOPE_PRIVATE",
    provenance: provenance("facebook", context, stringValue(comment.created_time)),
    metadata: {},
  };
}

function token(credentials: ConnectorCredentials): string {
  if (!credentials.accessToken) throw new AuthenticationError("facebook", "Missing Meta access token");
  return credentials.accessToken;
}

function tokenResult(body: { access_token?: unknown; expires_in?: unknown; token_type?: unknown; scope?: unknown }, defaults: string[]): OAuthTokenResult {
  const accessToken = mustString(body.access_token, "access_token");
  const expiresIn = numberValue(body.expires_in);
  const result: OAuthTokenResult = {
    accessToken,
    refreshToken: accessToken,
    tokenType: stringValue(body.token_type),
    expiresIn,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    grantedScopes: typeof body.scope === "string" ? body.scope.split(/[,\s]+/).filter(Boolean) : defaults,
    rawProviderMetadata: {},
  };
  return result;
}

function provenance(platformId: string, context?: ConnectorOperationContext, providerCreatedAt?: string) {
  return {
    platformId,
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
  if (!normalized) throw new AuthenticationError("facebook", `Meta response missing ${field}`);
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
