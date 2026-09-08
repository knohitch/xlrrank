import type { AvailabilityState, ConnectorCapability, ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";
import {
  AuthenticationError,
  CapabilityUnavailableError,
  ConnectorConfigurationError,
  MalformedProviderResponseError,
} from "../connectors/errors.js";
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
  ProviderApplicationConfig,
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
import { XHttpClient, type XHttpClientOptions } from "./x-api.js";

const ADAPTER_VERSION = "x-api-v2-2026-09-08";
const X_AUTHORIZATION_ENDPOINT = "https://x.com/i/oauth2/authorize";
const X_TOKEN_PATH = "/2/oauth2/token";

const USER_FIELDS = [
  "created_at",
  "description",
  "entities",
  "id",
  "is_identity_verified",
  "location",
  "name",
  "profile_image_url",
  "protected",
  "public_metrics",
  "url",
  "username",
  "verified",
  "verified_type",
  "withheld",
].join(",");

const POST_FIELDS = [
  "author_id",
  "conversation_id",
  "created_at",
  "entities",
  "id",
  "in_reply_to_user_id",
  "lang",
  "possibly_sensitive",
  "public_metrics",
  "referenced_posts",
  "reply_settings",
  "text",
  "withheld",
].join(",");

const POST_EXPANSIONS = ["author_id", "referenced_tweets.id", "in_reply_to_user_id"].join(",");

const X_CAPABILITY_MATRIX: Record<
  ConnectorCapability,
  {
    endpoints: string[];
    scopes: string[];
    authMode: "OAuth 2.0 Authorization Code with PKCE";
    providerAccess: "configured-v2-access" | "elevated-access-tier";
    pagination: "meta.next_token" | "none";
    fields: string[];
    defaultState: AvailabilityState;
  }
> = {
  profiles: {
    endpoints: [
      "GET /2/users/me",
      "GET /2/users/:id",
      "GET /2/users",
      "GET /2/users/by/username/:username",
      "GET /2/users/by",
    ],
    scopes: ["tweet.read", "users.read"],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "configured-v2-access",
    pagination: "none",
    fields: USER_FIELDS.split(","),
    defaultState: "CONFIGURATION_REQUIRED",
  },
  content: {
    endpoints: ["GET /2/users/:id/tweets"],
    scopes: ["tweet.read", "users.read"],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "configured-v2-access",
    pagination: "meta.next_token",
    fields: POST_FIELDS.split(","),
    defaultState: "CONFIGURATION_REQUIRED",
  },
  comments: {
    endpoints: ["GET /2/tweets/search/recent"],
    scopes: ["tweet.read", "users.read"],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "configured-v2-access",
    pagination: "meta.next_token",
    fields: POST_FIELDS.split(","),
    defaultState: "CONFIGURATION_REQUIRED",
  },
  search: {
    endpoints: ["GET /2/tweets/search/recent", "GET /2/tweets/search/all"],
    scopes: ["tweet.read", "users.read"],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "elevated-access-tier",
    pagination: "meta.next_token",
    fields: POST_FIELDS.split(","),
    defaultState: "CONFIGURATION_REQUIRED",
  },
  metrics: {
    endpoints: ["public_metrics on User and Post objects"],
    scopes: ["tweet.read", "users.read"],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "configured-v2-access",
    pagination: "none",
    fields: ["public_metrics"],
    defaultState: "CONFIGURATION_REQUIRED",
  },
  followers: {
    endpoints: ["GET /2/users/:id/followers"],
    scopes: ["tweet.read", "users.read", "follows.read"],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "configured-v2-access",
    pagination: "meta.next_token",
    fields: USER_FIELDS.split(","),
    defaultState: "CONFIGURATION_REQUIRED",
  },
  following: {
    endpoints: ["GET /2/users/:id/following"],
    scopes: ["tweet.read", "users.read", "follows.read"],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "configured-v2-access",
    pagination: "meta.next_token",
    fields: USER_FIELDS.split(","),
    defaultState: "CONFIGURATION_REQUIRED",
  },
  audience_insights: {
    endpoints: [],
    scopes: [],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "elevated-access-tier",
    pagination: "none",
    fields: [],
    defaultState: "UNAVAILABLE",
  },
  messages: {
    endpoints: [],
    scopes: [],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "elevated-access-tier",
    pagination: "none",
    fields: [],
    defaultState: "UNAVAILABLE",
  },
  publishing: {
    endpoints: [],
    scopes: [],
    authMode: "OAuth 2.0 Authorization Code with PKCE",
    providerAccess: "configured-v2-access",
    pagination: "none",
    fields: [],
    defaultState: "UNAVAILABLE",
  },
};

interface XUser {
  id?: unknown;
  username?: unknown;
  name?: unknown;
  description?: unknown;
  location?: unknown;
  url?: unknown;
  profile_image_url?: unknown;
  created_at?: unknown;
  protected?: unknown;
  verified?: unknown;
  verified_type?: unknown;
  is_identity_verified?: unknown;
  public_metrics?: {
    followers_count?: unknown;
    following_count?: unknown;
    post_count?: unknown;
    listed_count?: unknown;
    like_count?: unknown;
    media_count?: unknown;
  };
  withheld?: unknown;
  entities?: unknown;
}

interface XPost {
  id?: unknown;
  text?: unknown;
  author_id?: unknown;
  created_at?: unknown;
  lang?: unknown;
  conversation_id?: unknown;
  in_reply_to_user_id?: unknown;
  referenced_tweets?: Array<{ type?: unknown; id?: unknown }>;
  reply_settings?: unknown;
  possibly_sensitive?: unknown;
  public_metrics?: {
    like_count?: unknown;
    reply_count?: unknown;
    repost_count?: unknown;
    quote_count?: unknown;
    impression_count?: unknown;
    bookmark_count?: unknown;
  };
  withheld?: unknown;
  entities?: unknown;
}

interface XApiEnvelope<T> {
  data?: T;
  includes?: {
    users?: XUser[];
    tweets?: XPost[];
    posts?: XPost[];
  };
  meta?: {
    next_token?: unknown;
    result_count?: unknown;
    newest_id?: unknown;
    oldest_id?: unknown;
  };
  errors?: unknown[];
}

interface XConnectorOptions extends XHttpClientOptions {
  authorizeBaseUrl?: string;
}

export function getXCapabilityMatrix() {
  return X_CAPABILITY_MATRIX;
}

export function evaluateXCapabilities(input: {
  configured: boolean;
  grantedScopes?: string[];
  access?: { fullArchiveSearch?: boolean };
}): Partial<Record<ConnectorCapability, AvailabilityState>> {
  const granted = new Set(input.grantedScopes ?? []);
  const output: Partial<Record<ConnectorCapability, AvailabilityState>> = {};
  for (const [capability, details] of Object.entries(X_CAPABILITY_MATRIX) as Array<
    [ConnectorCapability, (typeof X_CAPABILITY_MATRIX)[ConnectorCapability]]
  >) {
    if (details.defaultState === "UNAVAILABLE") {
      output[capability] = "UNAVAILABLE";
      continue;
    }
    if (!input.configured) {
      output[capability] = "CONFIGURATION_REQUIRED";
      continue;
    }
    const missingScope = details.scopes.some((scope) => !granted.has(scope));
    if (missingScope) {
      output[capability] = "PERMISSION_REQUIRED";
      continue;
    }
    if (capability === "search" && input.access?.fullArchiveSearch !== true) {
      output[capability] = "AVAILABLE";
      continue;
    }
    output[capability] = "AVAILABLE";
  }
  return output;
}

export class XConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "x",
    platformId: "x",
    name: "X (Twitter)",
    version: "0.2.0",
    apiVersion: "2",
    capabilities: Object.fromEntries(
      Object.entries(X_CAPABILITY_MATRIX).map(([key, value]) => [key, value.defaultState]),
    ) as Partial<Record<ConnectorCapability, AvailabilityState>>,
    providerConfig: {
      fields: [
        {
          key: "clientId",
          label: "Client ID",
          required: true,
          secret: false,
          kind: "string",
        },
        {
          key: "clientSecret",
          label: "Client Secret",
          required: false,
          secret: true,
          kind: "string",
        },
        {
          key: "redirectUri",
          label: "Redirect URI",
          required: true,
          secret: false,
          kind: "url",
        },
      ],
    },
    oauth: {
      type: "authorization_code_pkce",
      authorizationEndpoint: X_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: "https://api.x.com/2/oauth2/token",
      defaultScopes: ["tweet.read", "users.read", "follows.read", "offline.access"],
      pkceRequired: true,
      supportsRefresh: true,
      supportsRevocation: false,
    },
  };

  private readonly client: XHttpClient;
  private readonly authorizeBaseUrl: string;

  constructor(options: XConnectorOptions = {}) {
    super();
    this.client = new XHttpClient(options);
    this.authorizeBaseUrl =
      options.authorizeBaseUrl ?? process.env.X_OAUTH_AUTHORIZE_URL ?? X_AUTHORIZATION_ENDPOINT;
  }

  override getCapabilities(): Partial<Record<ConnectorCapability, AvailabilityState>> {
    return evaluateXCapabilities({ configured: false });
  }

  override evaluateCapabilities(
    input: CapabilityEvaluationInput,
  ): Partial<Record<ConnectorCapability, AvailabilityState>> {
    const evaluationInput: {
      configured: boolean;
      grantedScopes?: string[];
      access?: { fullArchiveSearch?: boolean };
    } = {
      configured: input.configured,
      access: {
        fullArchiveSearch: input.access?.fullArchiveSearch === true,
      },
    };
    if (input.grantedScopes) evaluationInput.grantedScopes = input.grantedScopes;
    return evaluateXCapabilities(evaluationInput);
  }

  getOAuthAdapter(): OAuthProviderAdapter {
    return {
      buildAuthorizationUrl: (request) => this.buildAuthorizationUrl(request),
      exchangeAuthorizationCode: (request, signal) =>
        this.exchangeAuthorizationCode(request, signal),
      refreshAccessToken: (request, signal) => this.refreshAccessToken(request, signal),
      verifyIdentity: (credentials, context) =>
        this.getAuthenticatedProfileOrThrow(credentials, context),
      revoke: async () => ({
        providerRevoked: false,
        reason:
          "Official OAuth 2.0 user-token revocation endpoint was not documented for this flow.",
      }),
    };
  }

  override async checkHealth(): Promise<boolean> {
    return false;
  }

  override async authenticate(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<AuthResult> {
    try {
      const profile = await this.getAuthenticatedProfileOrThrow(credentials, context);
      return { success: true, status: "CONNECTED", profile };
    } catch (err) {
      if (err instanceof AuthenticationError) {
        return { success: false, status: "REAUTH_REQUIRED", error: err.message };
      }
      throw err;
    }
  }

  override async getAuthenticatedProfile(
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile | null> {
    return this.getAuthenticatedProfileOrThrow(this.requireAuth(context), context);
  }

  override async getProfile(
    identifier: string,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile | null> {
    this.assertCapabilityAvailable("profiles", context);
    const credentials = this.requireAuth(context);
    const query = userFieldQuery();
    const isNumericId = /^[0-9]{1,19}$/.test(identifier);
    const path = isNumericId
      ? `/2/users/${encodeURIComponent(identifier)}`
      : `/2/users/by/username/${encodeURIComponent(identifier.replace(/^@/, ""))}`;
    const response = await this.client.get<XApiEnvelope<XUser>>(
      path,
      token(credentials),
      query,
      context?.signal,
    );
    if (!response.body.data) return null;
    const profile = this.normalizeProfile(response.body.data, context);
    validateNormalizedProfile(profile);
    return profile;
  }

  async getProfilesByIds(
    ids: string[],
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    this.assertCapabilityAvailable("profiles", context);
    const credentials = this.requireAuth(context);
    if (ids.length === 0) return [];
    const query = userFieldQuery();
    query.set("ids", ids.slice(0, 100).join(","));
    const response = await this.client.get<XApiEnvelope<XUser[]>>(
      "/2/users",
      token(credentials),
      query,
      context?.signal,
    );
    const profiles = (response.body.data ?? []).map((user) => this.normalizeProfile(user, context));
    for (const profile of profiles) validateNormalizedProfile(profile);
    return profiles;
  }

  override async getContentPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedContent>> {
    this.assertCapabilityAvailable("content", context);
    const credentials = this.requireAuth(context);
    const accountId =
      options.accountId ??
      credentials.metadata?.providerUserId ??
      (await this.getAuthenticatedProfile(context))?.externalId;
    if (typeof accountId !== "string" || !accountId) {
      throw new AuthenticationError(
        this.manifest.id,
        "X user identity is required for timeline sync",
      );
    }
    const query = postPageQuery(options);
    const cursor = decodeCursor(options.cursor);
    if (cursor?.timeline) query.set("pagination_token", cursor.timeline);
    else if (options.cursor) query.set("pagination_token", options.cursor);
    const response = await this.client.get<XApiEnvelope<XPost[]>>(
      `/2/users/${encodeURIComponent(accountId)}/tweets`,
      token(credentials),
      query,
      context?.signal,
    );
    const authors = usersById(response.body.includes?.users);
    const items = (response.body.data ?? []).map((post) =>
      this.normalizeContent(post, context, authors),
    );
    for (const item of items) validateNormalizedContent(item);
    const nextToken = stringOrUndefined(response.body.meta?.next_token) ?? null;
    return {
      items,
      cursor: {
        value: nextToken ? encodeCursor({ timeline: nextToken }) : null,
        hasMore: !!nextToken,
      },
      rateLimit: response.rateLimit,
    };
  }

  override async getContent(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedContent[]> {
    return (await this.getContentPage(options, context)).items;
  }

  override async searchContent(
    query: string,
    limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedContent[]> {
    const options: ContentQuery = { query };
    if (limit !== undefined) options.limit = limit;
    return (await this.searchContentPage(options, context)).items;
  }

  async searchContentPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedContent>> {
    this.assertCapabilityAvailable("search", context);
    const credentials = this.requireAuth(context);
    const query = postPageQuery(options, 10);
    query.set("query", buildRecentSearchQuery(options.query ?? ""));
    const cursor = decodeCursor(options.cursor);
    if (cursor?.search) query.set("next_token", cursor.search);
    else if (options.cursor) query.set("next_token", options.cursor);
    const response = await this.client.get<XApiEnvelope<XPost[]>>(
      "/2/tweets/search/recent",
      token(credentials),
      query,
      context?.signal,
    );
    const authors = usersById(response.body.includes?.users);
    const items = (response.body.data ?? []).map((post) =>
      this.normalizeContent(post, context, authors),
    );
    for (const item of items) validateNormalizedContent(item);
    const nextToken = stringOrUndefined(response.body.meta?.next_token) ?? null;
    return {
      items,
      cursor: {
        value: nextToken ? encodeCursor({ search: nextToken }) : null,
        hasMore: !!nextToken,
      },
      rateLimit: response.rateLimit,
    };
  }

  override async getInteractionsPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedInteraction>> {
    if (!options.accountId && !options.query) {
      return { items: [], cursor: { value: null, hasMore: false } };
    }
    const contentId = options.accountId ?? "";
    return {
      items: await this.getComments(contentId, options, context),
      cursor: { value: null, hasMore: false },
    };
  }

  override async getComments(
    contentId: string,
    options: ContentQuery = {},
    context?: ConnectorOperationContext,
  ): Promise<NormalizedInteraction[]> {
    this.assertCapabilityAvailable("comments", context);
    const credentials = this.requireAuth(context);
    if (!contentId) return [];
    const query = postPageQuery(options, 10);
    query.set("query", `conversation_id:${contentId} is:reply`);
    const response = await this.client.get<XApiEnvelope<XPost[]>>(
      "/2/tweets/search/recent",
      token(credentials),
      query,
      context?.signal,
    );
    const items = (response.body.data ?? []).map((post) =>
      this.normalizeReply(post, contentId, context),
    );
    for (const item of items) validateNormalizedInteraction(item);
    return items;
  }

  override async getFollowers(
    accountId: string,
    limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    const options: ContentQuery = {};
    if (limit !== undefined) options.limit = limit;
    return (await this.getFollowPage("followers", accountId, options, context)).items;
  }

  override async getFollowing(
    accountId: string,
    limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    const options: ContentQuery = {};
    if (limit !== undefined) options.limit = limit;
    return (await this.getFollowPage("following", accountId, options, context)).items;
  }

  override async getMetrics(
    accountId: string,
    context?: ConnectorOperationContext,
  ): Promise<AccountMetrics> {
    const profile = await this.getProfile(accountId, context);
    if (!profile) {
      throw new MalformedProviderResponseError(this.manifest.id, "X profile missing for metrics");
    }
    const metrics = profile.metadata.publicMetrics as
      { postCount?: number; listedCount?: number; likeCount?: number } | undefined;
    return {
      followerCount: profile.followerCount ?? 0,
      followingCount: profile.followingCount ?? 0,
      contentCount: metrics?.postCount ?? 0,
      collectedAt: new Date().toISOString(),
    };
  }

  override async searchProfiles(
    query: string,
    limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    const trimmed = query.trim().replace(/^@/, "");
    if (!trimmed) return [];
    const profile = await this.getProfile(trimmed, context);
    return profile ? [profile].slice(0, limit ?? 1) : [];
  }

  private async getFollowPage(
    kind: "followers" | "following",
    accountId: string,
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedProfile>> {
    this.assertCapabilityAvailable(kind, context);
    const credentials = this.requireAuth(context);
    const query = userPageQuery(options);
    const cursor = decodeCursor(options.cursor);
    if (cursor?.[kind]) query.set("pagination_token", cursor[kind]);
    else if (options.cursor) query.set("pagination_token", options.cursor);
    const response = await this.client.get<XApiEnvelope<XUser[]>>(
      `/2/users/${encodeURIComponent(accountId)}/${kind}`,
      token(credentials),
      query,
      context?.signal,
    );
    const items = (response.body.data ?? []).map((user) => this.normalizeProfile(user, context));
    for (const item of items) validateNormalizedProfile(item);
    const nextToken = stringOrUndefined(response.body.meta?.next_token) ?? null;
    return {
      items,
      cursor: {
        value: nextToken ? encodeCursor({ [kind]: nextToken }) : null,
        hasMore: !!nextToken,
      },
      rateLimit: response.rateLimit,
    };
  }

  private buildAuthorizationUrl(request: OAuthAuthorizationRequest): URL {
    assertProviderConfig(request.providerConfig);
    const url = new URL(this.authorizeBaseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", request.providerConfig.clientId);
    url.searchParams.set("redirect_uri", request.providerConfig.redirectUri);
    url.searchParams.set("scope", request.requestedScopes.join(" "));
    url.searchParams.set("state", request.state);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  private async exchangeAuthorizationCode(
    request: OAuthTokenExchangeRequest,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResult> {
    assertProviderConfig(request.providerConfig);
    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("code", request.code);
    form.set("redirect_uri", request.redirectUri);
    form.set("code_verifier", request.codeVerifier);
    if (!request.providerConfig.clientSecret)
      form.set("client_id", request.providerConfig.clientId);
    const requestOptions: {
      basicAuth?: { clientId: string; clientSecret: string };
      signal?: AbortSignal;
    } = {};
    if (request.providerConfig.clientSecret) {
      requestOptions.basicAuth = {
        clientId: request.providerConfig.clientId,
        clientSecret: request.providerConfig.clientSecret,
      };
    }
    if (signal) requestOptions.signal = signal;
    const response = await this.client.postForm<Record<string, unknown>>(
      X_TOKEN_PATH,
      form,
      requestOptions,
    );
    return tokenResultFrom(response.body);
  }

  private async refreshAccessToken(
    request: OAuthTokenRefreshRequest,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResult> {
    assertProviderConfig(request.providerConfig);
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", request.refreshToken);
    if (!request.providerConfig.clientSecret)
      form.set("client_id", request.providerConfig.clientId);
    const requestOptions: {
      basicAuth?: { clientId: string; clientSecret: string };
      signal?: AbortSignal;
    } = {};
    if (request.providerConfig.clientSecret) {
      requestOptions.basicAuth = {
        clientId: request.providerConfig.clientId,
        clientSecret: request.providerConfig.clientSecret,
      };
    }
    if (signal) requestOptions.signal = signal;
    const response = await this.client.postForm<Record<string, unknown>>(
      X_TOKEN_PATH,
      form,
      requestOptions,
    );
    return tokenResultFrom(response.body);
  }

  private async getAuthenticatedProfileOrThrow(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile> {
    if (!credentials.accessToken) {
      throw new AuthenticationError(this.manifest.id, "Missing X access token");
    }
    const response = await this.client.get<XApiEnvelope<XUser>>(
      "/2/users/me",
      credentials.accessToken,
      userFieldQuery(),
      context?.signal,
    );
    if (!response.body.data) {
      throw new MalformedProviderResponseError(this.manifest.id, "X authenticated user missing");
    }
    const profile = this.normalizeProfile(response.body.data, context);
    validateNormalizedProfile(profile);
    return profile;
  }

  private assertCapabilityAvailable(
    capability: ConnectorCapability,
    context?: ConnectorOperationContext,
  ): void {
    const input: {
      configured: boolean;
      grantedScopes?: string[];
      access?: { fullArchiveSearch?: boolean };
    } = {
      configured: true,
    };
    if (context?.credentials.scopes) input.grantedScopes = context.credentials.scopes;
    if (context?.credentials.metadata?.access) {
      input.access = context.credentials.metadata.access as { fullArchiveSearch?: boolean };
    }
    const capabilities = evaluateXCapabilities(input);
    const state = capabilities[capability];
    if (state !== "AVAILABLE") {
      throw new CapabilityUnavailableError(this.manifest.id, capability, state ?? "unavailable");
    }
  }

  private normalizeProfile(
    user: XUser,
    context: ConnectorOperationContext | undefined,
  ): NormalizedProfile {
    const id = stringOrUndefined(user.id);
    const username = stringOrUndefined(user.username);
    if (!id || !username) {
      throw new MalformedProviderResponseError(
        this.manifest.id,
        "X user missing stable id or username",
      );
    }
    const visibility = visibilityFromUser(user);
    return {
      platformId: this.manifest.platformId,
      externalId: id,
      handle: username,
      displayName: stringOrUndefined(user.name),
      bio: stringOrUndefined(user.description),
      location: stringOrUndefined(user.location),
      website: stringOrUndefined(user.url),
      profileImageUrl: stringOrUndefined(user.profile_image_url),
      followerCount: numberOrUndefined(user.public_metrics?.followers_count),
      followingCount: numberOrUndefined(user.public_metrics?.following_count),
      visibility,
      providerCreatedAt: stringOrUndefined(user.created_at),
      provenance: provenance(
        this.manifest.platformId,
        context,
        visibility,
        stringOrUndefined(user.created_at),
      ),
      metadata: redactProviderMetadata({
        verified: user.verified,
        verifiedType: user.verified_type,
        isIdentityVerified: user.is_identity_verified,
        protected: user.protected,
        withheld: user.withheld,
        entities: user.entities,
        publicMetrics: {
          postCount: numberOrUndefined(user.public_metrics?.post_count),
          listedCount: numberOrUndefined(user.public_metrics?.listed_count),
          likeCount: numberOrUndefined(user.public_metrics?.like_count),
          mediaCount: numberOrUndefined(user.public_metrics?.media_count),
        },
      }) as Record<string, unknown>,
    };
  }

  private normalizeContent(
    post: XPost,
    context: ConnectorOperationContext | undefined,
    authors: Map<string, XUser>,
  ): NormalizedContent {
    const id = stringOrUndefined(post.id);
    const authorId = stringOrUndefined(post.author_id);
    const text = stringOrUndefined(post.text);
    if (!id || !authorId || text === undefined) {
      throw new MalformedProviderResponseError(
        this.manifest.id,
        "X post missing id, author, or text",
      );
    }
    const visibility = visibilityFromPost(post, authors.get(authorId));
    const metrics = post.public_metrics;
    return {
      platformId: this.manifest.platformId,
      authorExternalId: authorId,
      externalId: id,
      body: text,
      contentType: "post",
      language: stringOrUndefined(post.lang),
      externalCreatedAt: stringOrUndefined(post.created_at),
      visibility,
      metrics: metrics
        ? {
            likes: numberOrUndefined(metrics.like_count),
            comments: numberOrUndefined(metrics.reply_count),
            shares: sumDefined(metrics.repost_count, metrics.quote_count),
            impressions: numberOrUndefined(metrics.impression_count),
            snapshotKey: `${id}:public_metrics:${new Date().toISOString().slice(0, 10)}`,
          }
        : undefined,
      provenance: provenance(
        this.manifest.platformId,
        context,
        visibility,
        stringOrUndefined(post.created_at),
      ),
      metadata: redactProviderMetadata({
        conversationId: stringOrUndefined(post.conversation_id),
        inReplyToUserId: stringOrUndefined(post.in_reply_to_user_id),
        referencedPosts: post.referenced_tweets,
        replySettings: post.reply_settings,
        possiblySensitive: post.possibly_sensitive,
        withheld: post.withheld,
        entities: post.entities,
        publicMetrics: metrics,
      }) as Record<string, unknown>,
    };
  }

  private normalizeReply(
    post: XPost,
    parentContentId: string,
    context: ConnectorOperationContext | undefined,
  ): NormalizedInteraction {
    const id = stringOrUndefined(post.id);
    const authorId = stringOrUndefined(post.author_id);
    if (!id || !authorId) {
      throw new MalformedProviderResponseError(this.manifest.id, "X reply missing id or author");
    }
    const occurredAt = stringOrUndefined(post.created_at) ?? new Date().toISOString();
    const visibility: SocialVisibility = post.withheld ? "RESTRICTED" : "PUBLIC";
    return {
      platformId: this.manifest.platformId,
      fromExternalId: authorId,
      toContentExternalId: parentContentId,
      toAccountExternalId: stringOrUndefined(post.in_reply_to_user_id),
      externalId: id,
      type: "REPLY",
      body: stringOrUndefined(post.text),
      occurredAt,
      visibility,
      provenance: provenance(this.manifest.platformId, context, visibility, occurredAt),
      metadata: redactProviderMetadata({
        conversationId: stringOrUndefined(post.conversation_id),
        referencedPosts: post.referenced_tweets,
        publicMetrics: post.public_metrics,
      }) as Record<string, unknown>,
    };
  }
}

function token(credentials: ConnectorCredentials): string {
  if (!credentials.accessToken) throw new AuthenticationError("x", "Missing X access token");
  if (credentials.expiresAt) {
    const expiresAt = Date.parse(credentials.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      throw new AuthenticationError("x", "X access token is expired and requires refresh");
    }
  }
  return credentials.accessToken;
}

function assertProviderConfig(config: ProviderApplicationConfig): void {
  if (!config.enabled) throw new ConnectorConfigurationError("x", "X provider app is disabled");
  if (!config.clientId) throw new ConnectorConfigurationError("x", "X client ID is required");
  if (!config.redirectUri) throw new ConnectorConfigurationError("x", "X redirect URI is required");
  const redirect = new URL(config.redirectUri);
  if (!["https:", "http:"].includes(redirect.protocol)) {
    throw new ConnectorConfigurationError("x", "X redirect URI must be http or https");
  }
}

function tokenResultFrom(body: Record<string, unknown>): OAuthTokenResult {
  const accessToken = stringOrUndefined(body.access_token);
  if (!accessToken)
    throw new MalformedProviderResponseError("x", "X token response missing access token");
  const expiresIn = numberOrUndefined(body.expires_in);
  const scope = stringOrUndefined(body.scope);
  const result: OAuthTokenResult = {
    accessToken,
    grantedScopes: scope ? scope.split(/\s+/).filter(Boolean) : [],
    rawProviderMetadata: redactProviderMetadata({
      tokenType: body.token_type,
      expiresIn,
      scope,
    }) as Record<string, unknown>,
  };
  const refreshToken = stringOrUndefined(body.refresh_token);
  const tokenType = stringOrUndefined(body.token_type);
  if (refreshToken) result.refreshToken = refreshToken;
  if (tokenType) result.tokenType = tokenType;
  if (expiresIn !== undefined) {
    result.expiresIn = expiresIn;
    result.expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  }
  return result;
}

function userFieldQuery(): URLSearchParams {
  const query = new URLSearchParams();
  query.set("user.fields", USER_FIELDS);
  return query;
}

function userPageQuery(options: ContentQuery): URLSearchParams {
  const query = userFieldQuery();
  query.set("max_results", String(clamp(options.limit ?? 100, 1, 1000)));
  return query;
}

function postPageQuery(options: ContentQuery, min = 5): URLSearchParams {
  const query = new URLSearchParams();
  query.set("max_results", String(clamp(options.limit ?? 100, min, 100)));
  query.set("tweet.fields", POST_FIELDS);
  query.set("user.fields", USER_FIELDS);
  query.set("expansions", POST_EXPANSIONS);
  if (options.since) query.set("start_time", options.since);
  if (options.until) query.set("end_time", options.until);
  return query;
}

export function buildRecentSearchQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new CapabilityUnavailableError("x", "search", "query_required");
  if (trimmed.length > 4096) {
    throw new CapabilityUnavailableError("x", "search", "query_too_long");
  }
  return trimmed;
}

function usersById(users?: XUser[]): Map<string, XUser> {
  const map = new Map<string, XUser>();
  for (const user of users ?? []) {
    const id = stringOrUndefined(user.id);
    if (id) map.set(id, user);
  }
  return map;
}

function visibilityFromUser(user: XUser): SocialVisibility {
  if (user.withheld) return "RESTRICTED";
  if (user.protected === true) return "SCOPE_PRIVATE";
  return "PUBLIC";
}

function visibilityFromPost(post: XPost, author?: XUser): SocialVisibility {
  if (post.withheld) return "RESTRICTED";
  if (author?.protected === true) return "SCOPE_PRIVATE";
  return "PUBLIC";
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
    adapterVersion: ADAPTER_VERSION,
    visibility,
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumDefined(...values: unknown[]): number | undefined {
  let hasValue = false;
  let total = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      hasValue = true;
      total += value;
    }
  }
  return hasValue ? total : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value?: string): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const out: Record<string, string> = {};
    for (const [key, nested] of Object.entries(parsed)) {
      if (typeof nested === "string") out[key] = nested;
    }
    return out;
  } catch {
    return null;
  }
}
