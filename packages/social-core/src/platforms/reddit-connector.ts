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
} from "../normalized.js";
import {
  validateNormalizedContent,
  validateNormalizedInteraction,
  validateNormalizedProfile,
} from "../validation.js";
import {
  RedditHttpClient,
  validateRedditUserAgent,
  type RedditHttpClientOptions,
} from "./reddit-api.js";

const ADAPTER_VERSION = "reddit-api-v1-2026-09-10";
const REDDIT_AUTHORIZATION_ENDPOINT = "https://www.reddit.com/api/v1/authorize";
const REDDIT_TOKEN_PATH = "/api/v1/access_token";
const REDDIT_REVOKE_PATH = "/api/v1/revoke_token";
const REDDIT_DEFAULT_SCOPES = ["identity", "read", "history"] as const;
const REDDIT_PROFILE_CATEGORY = "reddit_authenticated_user_profile";
const REDDIT_PUBLIC_PROFILE_CATEGORY = "reddit_public_user_profile";
const REDDIT_CONTENT_CATEGORY = "reddit_user_content";
const REDDIT_COMMENT_CATEGORY = "reddit_comment";
const MAX_LISTING_LIMIT = 100;

type RedditCapabilityDetails = {
  scopes: string[];
  defaultState: AvailabilityState;
};

const REDDIT_CAPABILITY_MATRIX: Record<ConnectorCapability, RedditCapabilityDetails> = {
  profiles: { scopes: ["identity", "read"], defaultState: "CONFIGURATION_REQUIRED" },
  content: { scopes: ["history"], defaultState: "CONFIGURATION_REQUIRED" },
  comments: { scopes: ["history", "read"], defaultState: "CONFIGURATION_REQUIRED" },
  search: { scopes: ["read"], defaultState: "CONFIGURATION_REQUIRED" },
  metrics: { scopes: ["identity", "read"], defaultState: "CONFIGURATION_REQUIRED" },
  followers: { scopes: [], defaultState: "UNAVAILABLE" },
  following: { scopes: [], defaultState: "UNAVAILABLE" },
  audience_insights: { scopes: [], defaultState: "UNAVAILABLE" },
  messages: { scopes: [], defaultState: "UNAVAILABLE" },
  publishing: { scopes: [], defaultState: "UNAVAILABLE" },
};

export interface RedditConnectorOptions extends RedditHttpClientOptions {
  authorizeBaseUrl?: string;
}

interface RedditUser {
  id?: unknown;
  name?: unknown;
  subreddit?: {
    display_name_prefixed?: unknown;
    public_description?: unknown;
    subscribers?: unknown;
    url?: unknown;
  };
  icon_img?: unknown;
  snoovatar_img?: unknown;
  link_karma?: unknown;
  comment_karma?: unknown;
  created_utc?: unknown;
  is_suspended?: unknown;
  is_employee?: unknown;
  is_mod?: unknown;
  verified?: unknown;
}

interface RedditListing<T> {
  kind?: unknown;
  data?: {
    after?: unknown;
    before?: unknown;
    children?: Array<{ kind?: unknown; data?: T }>;
  };
}

interface RedditThing {
  id?: unknown;
  name?: unknown;
  author_fullname?: unknown;
  author?: unknown;
  title?: unknown;
  selftext?: unknown;
  body?: unknown;
  created_utc?: unknown;
  permalink?: unknown;
  subreddit?: unknown;
  score?: unknown;
  num_comments?: unknown;
  ups?: unknown;
  downs?: unknown;
  removed_by_category?: unknown;
}

export class RedditConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "reddit",
    platformId: "reddit",
    name: "Reddit",
    version: "0.2.0",
    apiVersion: "v1",
    capabilities: Object.fromEntries(
      Object.entries(REDDIT_CAPABILITY_MATRIX).map(([key, value]) => [key, value.defaultState]),
    ) as Partial<Record<ConnectorCapability, AvailabilityState>>,
    providerConfig: {
      fields: [
        { key: "clientId", label: "Client ID", required: true, secret: false, kind: "string" },
        { key: "clientSecret", label: "Client Secret", required: true, secret: true, kind: "string" },
        { key: "redirectUri", label: "Redirect URI", required: true, secret: false, kind: "url" },
        { key: "userAgent", label: "User-Agent", required: true, secret: false, kind: "string" },
      ],
    },
    oauth: {
      type: "authorization_code_pkce",
      authorizationEndpoint: REDDIT_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: "https://www.reddit.com/api/v1/access_token",
      defaultScopes: [...REDDIT_DEFAULT_SCOPES],
      pkceRequired: false,
      supportsRefresh: true,
      supportsRevocation: true,
    },
  };

  private readonly client: RedditHttpClient;
  private readonly authorizeBaseUrl: string;

  constructor(options: RedditConnectorOptions = {}) {
    super();
    this.client = new RedditHttpClient(options);
    this.authorizeBaseUrl =
      options.authorizeBaseUrl ?? process.env.REDDIT_OAUTH_AUTHORIZE_URL ?? REDDIT_AUTHORIZATION_ENDPOINT;
  }

  override getCapabilities(): Partial<Record<ConnectorCapability, AvailabilityState>> {
    return evaluateRedditCapabilities({ configured: false });
  }

  override evaluateCapabilities(
    input: CapabilityEvaluationInput,
  ): Partial<Record<ConnectorCapability, AvailabilityState>> {
    return evaluateRedditCapabilities(input);
  }

  resolveOAuthDefaultScopes(
    defaults: string[],
    _providerConfig: ProviderApplicationConfig,
  ): string[] {
    const allowed = new Set(REDDIT_DEFAULT_SCOPES);
    return defaults.filter((scope) => allowed.has(scope as (typeof REDDIT_DEFAULT_SCOPES)[number]));
  }

  getOAuthAdapter(): OAuthProviderAdapter {
    return {
      buildAuthorizationUrl: (request) => this.buildAuthorizationUrl(request),
      exchangeAuthorizationCode: (request, signal) =>
        this.exchangeAuthorizationCode(request, signal),
      refreshAccessToken: (request, signal) => this.refreshAccessToken(request, signal),
      verifyIdentity: (credentials, context) =>
        this.getAuthenticatedProfileOrThrow(credentials, context),
      revoke: (credentials, providerConfig, signal) => this.revoke(credentials, providerConfig, signal),
    };
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
    const username = identifier.replace(/^u\//, "").replace(/^\/u\//, "").replace(/^@/, "");
    const response = await this.client.get<{ data?: RedditUser }>(
      `/user/${encodeURIComponent(username)}/about.json`,
      token(credentials),
      redditUserAgent(credentials),
      undefined,
      context?.signal,
    );
    if (!response.body.data) return null;
    const profile = normalizeProfile(response.body.data, context, REDDIT_PUBLIC_PROFILE_CATEGORY);
    validateNormalizedProfile(profile);
    return profile;
  }

  override async getContentPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedContent>> {
    this.assertCapabilityAvailable("content", context);
    const credentials = this.requireAuth(context);
    const username = contentUsername(options, credentials);
    const query = listingQuery(options);
    const response = await this.client.get<RedditListing<RedditThing>>(
      `/user/${encodeURIComponent(username)}/submitted.json`,
      token(credentials),
      redditUserAgent(credentials),
      query,
      context?.signal,
    );
    const items = listingChildren(response.body)
      .map((thing) => normalizeContent(thing, context))
      .filter((item): item is NormalizedContent => item !== null);
    for (const item of items) validateNormalizedContent(item);
    return {
      items,
      cursor: cursorFromListing(response.body),
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
    this.assertCapabilityAvailable("comments", context);
    const credentials = this.requireAuth(context);
    if (options.accountId) {
      return {
        items: await this.getComments(options.accountId, options, context),
        cursor: { value: null, hasMore: false },
      };
    }
    const username = contentUsername(options, credentials);
    const query = listingQuery(options);
    const response = await this.client.get<RedditListing<RedditThing>>(
      `/user/${encodeURIComponent(username)}/comments.json`,
      token(credentials),
      redditUserAgent(credentials),
      query,
      context?.signal,
    );
    const items = listingChildren(response.body)
      .map((thing) => normalizeComment(thing, undefined, context))
      .filter((item): item is NormalizedInteraction => item !== null);
    for (const item of items) validateNormalizedInteraction(item);
    return {
      items,
      cursor: cursorFromListing(response.body),
      rateLimit: response.rateLimit,
    };
  }

  override async getComments(
    contentId: string,
    _options: ContentQuery = {},
    context?: ConnectorOperationContext,
  ): Promise<NormalizedInteraction[]> {
    this.assertCapabilityAvailable("comments", context);
    const credentials = this.requireAuth(context);
    const articleId = contentId.replace(/^t3_/, "");
    const response = await this.client.get<unknown>(
      `/comments/${encodeURIComponent(articleId)}.json`,
      token(credentials),
      redditUserAgent(credentials),
      undefined,
      context?.signal,
    );
    const comments = extractCommentsTree(response.body)
      .map((thing) => normalizeComment(thing, articleId, context))
      .filter((item): item is NormalizedInteraction => item !== null);
    for (const comment of comments) validateNormalizedInteraction(comment);
    return comments;
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
    const trimmed = (options.query ?? "").trim();
    if (!trimmed) return { items: [], cursor: { value: null, hasMore: false } };
    const query = listingQuery(options);
    query.set("q", trimmed);
    query.set("type", "link");
    const response = await this.client.get<RedditListing<RedditThing>>(
      "/search.json",
      token(credentials),
      redditUserAgent(credentials),
      query,
      context?.signal,
    );
    const items = listingChildren(response.body)
      .map((thing) => normalizeContent(thing, context))
      .filter((item): item is NormalizedContent => item !== null);
    for (const item of items) validateNormalizedContent(item);
    return {
      items,
      cursor: cursorFromListing(response.body),
      rateLimit: response.rateLimit,
    };
  }

  override async searchProfiles(
    _query: string,
    _limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    this.requireAuth(context);
    throw new CapabilityUnavailableError(
      this.manifest.id,
      "searchProfiles",
      "Reddit user search is not part of the approved production connector surface",
    );
  }

  override async getFollowers(
    _accountId: string,
    _limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    this.requireAuth(context);
    throw new CapabilityUnavailableError(this.manifest.id, "followers", "unavailable");
  }

  override async getFollowing(
    _accountId: string,
    _limit?: number,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile[]> {
    this.requireAuth(context);
    throw new CapabilityUnavailableError(this.manifest.id, "following", "unavailable");
  }

  override async getMetrics(
    accountId: string,
    context?: ConnectorOperationContext,
  ): Promise<AccountMetrics> {
    const profile = accountId
      ? await this.getProfile(accountId, context)
      : await this.getAuthenticatedProfile(context);
    if (!profile) {
      throw new MalformedProviderResponseError(this.manifest.id, "Reddit profile missing");
    }
    const linkKarma = numberOrUndefined(profile.metadata.linkKarma);
    const commentKarma = numberOrUndefined(profile.metadata.commentKarma);
    return {
      contentCount: undefined,
      providerMetrics: {
        linkKarma,
        commentKarma,
      },
      collectedAt: new Date().toISOString(),
    };
  }

  private buildAuthorizationUrl(request: OAuthAuthorizationRequest): URL {
    assertProviderConfig(request.providerConfig);
    const url = new URL(this.authorizeBaseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", request.providerConfig.clientId);
    url.searchParams.set("redirect_uri", request.providerConfig.redirectUri);
    url.searchParams.set("duration", "permanent");
    url.searchParams.set("scope", request.requestedScopes.join(","));
    url.searchParams.set("state", request.state);
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
    const response = await this.client.postTokenForm<Record<string, unknown>>(
      REDDIT_TOKEN_PATH,
      form,
      {
        clientId: request.providerConfig.clientId,
        clientSecret: request.providerConfig.clientSecret,
        signal,
      },
    );
    return tokenResultFrom(response.body, request.requestedScopes, request.providerConfig);
  }

  private async refreshAccessToken(
    request: OAuthTokenRefreshRequest,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResult> {
    assertProviderConfig(request.providerConfig);
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", request.refreshToken);
    const response = await this.client.postTokenForm<Record<string, unknown>>(
      REDDIT_TOKEN_PATH,
      form,
      {
        clientId: request.providerConfig.clientId,
        clientSecret: request.providerConfig.clientSecret,
        signal,
      },
    );
    return tokenResultFrom(response.body, [], request.providerConfig);
  }

  private async revoke(
    credentials: ConnectorCredentials,
    providerConfig: ProviderApplicationConfig,
    signal?: AbortSignal,
  ): Promise<{ providerRevoked: boolean; reason?: string }> {
    assertProviderConfig(providerConfig);
    const tokenValue = credentials.refreshToken ?? credentials.accessToken;
    if (!tokenValue) return { providerRevoked: false, reason: "No Reddit token was available" };
    const form = new URLSearchParams();
    form.set("token", tokenValue);
    form.set("token_type_hint", credentials.refreshToken ? "refresh_token" : "access_token");
    await this.client.postTokenForm<Record<string, unknown>>(REDDIT_REVOKE_PATH, form, {
      clientId: providerConfig.clientId,
      clientSecret: providerConfig.clientSecret,
      signal,
    });
    return { providerRevoked: true };
  }

  private async getAuthenticatedProfileOrThrow(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile> {
    if (!credentials.accessToken) {
      throw new AuthenticationError(this.manifest.id, "Missing Reddit access token");
    }
    const response = await this.client.get<RedditUser>(
      "/api/v1/me",
      credentials.accessToken,
      redditUserAgent(credentials),
      undefined,
      context?.signal,
    );
    const profile = normalizeProfile(response.body, context, REDDIT_PROFILE_CATEGORY);
    validateNormalizedProfile(profile);
    return profile;
  }

  private assertCapabilityAvailable(
    capability: ConnectorCapability,
    context?: ConnectorOperationContext,
  ): void {
    const configured = !!context?.credentials.accessToken;
    const evaluationInput: CapabilityEvaluationInput = {
      configured,
      grantedScopes: context?.credentials.scopes ?? [],
    };
    const access = context?.credentials.metadata?.access;
    if (access && typeof access === "object") {
      evaluationInput.access = access as Record<string, unknown>;
    }
    const state = evaluateRedditCapabilities(evaluationInput)[capability];
    if (state !== "AVAILABLE") {
      throw new CapabilityUnavailableError(this.manifest.id, capability, state ?? "unavailable");
    }
  }
}

export function evaluateRedditCapabilities(
  input: CapabilityEvaluationInput,
): Partial<Record<ConnectorCapability, AvailabilityState>> {
  const granted = new Set(input.grantedScopes ?? []);
  const access = input.access ?? {};
  const approved = access.redditDataApiApproved === true || access.dataApiApproved === true;
  const commercialRequired = access.commercialApprovalRequired === true;
  const commercialApproved =
    access.redditCommercialApproved === true || access.commercialApproved === true;
  const output: Partial<Record<ConnectorCapability, AvailabilityState>> = {};
  for (const [capability, details] of Object.entries(REDDIT_CAPABILITY_MATRIX) as Array<
    [ConnectorCapability, RedditCapabilityDetails]
  >) {
    if (details.defaultState === "UNAVAILABLE") {
      output[capability] = "UNAVAILABLE";
    } else if (!input.configured) {
      output[capability] = "CONFIGURATION_REQUIRED";
    } else if (!approved) {
      output[capability] = "APP_REVIEW_REQUIRED";
    } else if (commercialRequired && !commercialApproved) {
      output[capability] = "ACCESS_REQUIRED";
    } else if (details.scopes.some((scope) => !granted.has(scope))) {
      output[capability] = "PERMISSION_REQUIRED";
    } else {
      output[capability] = "AVAILABLE";
    }
  }
  return output;
}

function assertProviderConfig(config: ProviderApplicationConfig): asserts config is ProviderApplicationConfig & {
  clientSecret: string;
} {
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    throw new ConnectorConfigurationError(
      "reddit",
      "Reddit OAuth requires clientId, clientSecret, and redirectUri",
    );
  }
  validateRedditUserAgent(config.metadata?.userAgent ?? config.metadata?.redditUserAgent);
}

function token(credentials: ConnectorCredentials): string {
  if (!credentials.accessToken) throw new AuthenticationError("reddit", "Missing Reddit access token");
  return credentials.accessToken;
}

function redditUserAgent(credentials: ConnectorCredentials): string {
  return validateRedditUserAgent(
    credentials.metadata?.userAgent ?? credentials.metadata?.redditUserAgent,
  );
}

function tokenResultFrom(
  body: Record<string, unknown>,
  requestedScopes: string[],
  providerConfig: ProviderApplicationConfig,
): OAuthTokenResult {
  const accessToken = stringOrUndefined(body.access_token);
  if (!accessToken) {
    throw new MalformedProviderResponseError("reddit", "Reddit token response omitted access_token");
  }
  const expiresIn = numberOrUndefined(body.expires_in);
  const scopeValue = stringOrUndefined(body.scope);
  const scopes = scopeValue
    ? scopeValue.split(/[,\s]+/).filter(Boolean)
    : requestedScopes;
  const result: OAuthTokenResult = {
    accessToken,
    tokenType: stringOrUndefined(body.token_type) ?? "bearer",
    expiresIn,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    grantedScopes: scopes,
    rawProviderMetadata: {
      userAgent: validateRedditUserAgent(
        providerConfig.metadata?.userAgent ?? providerConfig.metadata?.redditUserAgent,
      ),
      access: providerConfig.metadata?.access ?? {},
      sourcePolicy: {
        provider: "reddit",
        modelTrainingAllowed: false,
        fineTuningAllowed: false,
        seedDataAllowed: false,
      },
    },
  };
  const refreshToken = stringOrUndefined(body.refresh_token);
  if (refreshToken) result.refreshToken = refreshToken;
  return result;
}

function normalizeProfile(
  user: RedditUser,
  context: ConnectorOperationContext | undefined,
  category: string,
): NormalizedProfile {
  const id = stringOrUndefined(user.id);
  const name = stringOrUndefined(user.name);
  if (!id || !name) {
    throw new MalformedProviderResponseError("reddit", "Reddit profile response missing id/name");
  }
  const observedAt = new Date().toISOString();
  const profile: NormalizedProfile = {
    platformId: "reddit",
    externalId: id,
    handle: name,
    displayName: name,
    bio: stringOrUndefined(user.subreddit?.public_description),
    profileImageUrl:
      cleanRedditImageUrl(stringOrUndefined(user.icon_img)) ??
      cleanRedditImageUrl(stringOrUndefined(user.snoovatar_img)),
    followerCount: numberOrUndefined(user.subreddit?.subscribers),
    visibility: user.is_suspended === true ? "RESTRICTED" : "PUBLIC",
    providerCreatedAt: timestampFromUtc(user.created_utc),
    providerDataCategory: category,
    provenance: {
      platformId: "reddit",
      connectionId: context?.connectionId,
      scopeId: context?.scopeId,
      observedAt,
      providerCreatedAt: timestampFromUtc(user.created_utc),
      normalizationVersion: NORMALIZATION_VERSION,
      adapterVersion: ADAPTER_VERSION,
      visibility: user.is_suspended === true ? "RESTRICTED" : "PUBLIC",
    },
    metadata: {
      providerDataCategory: category,
      providerRetentionBasis: "REDDIT_APPROVED_USE_CASE",
      handle: name,
      linkKarma: numberOrUndefined(user.link_karma),
      commentKarma: numberOrUndefined(user.comment_karma),
      verified: booleanOrUndefined(user.verified),
      isEmployee: booleanOrUndefined(user.is_employee),
      isModerator: booleanOrUndefined(user.is_mod),
      sourcePolicy: {
        provider: "reddit",
        modelTrainingAllowed: false,
        fineTuningAllowed: false,
        seedDataAllowed: false,
      },
    },
  };
  if (!profile.bio) delete profile.bio;
  if (!profile.profileImageUrl) delete profile.profileImageUrl;
  if (!profile.followerCount) delete profile.followerCount;
  if (!profile.providerCreatedAt) delete profile.providerCreatedAt;
  if (!profile.provenance.providerCreatedAt) delete profile.provenance.providerCreatedAt;
  return profile;
}

function normalizeContent(
  thing: RedditThing,
  context: ConnectorOperationContext | undefined,
): NormalizedContent | null {
  if (isDeletedOrRemoved(thing)) return null;
  const externalId = stringOrUndefined(thing.name) ?? prefixedId("t3", stringOrUndefined(thing.id));
  const authorExternalId = stringOrUndefined(thing.author_fullname) ?? stringOrUndefined(thing.author);
  const title = stringOrUndefined(thing.title);
  const selftext = stringOrUndefined(thing.selftext);
  const body = [title, selftext].filter((part) => part && !isPlaceholderText(part)).join("\n\n");
  if (!externalId || !authorExternalId || !body) return null;
  const created = timestampFromUtc(thing.created_utc);
  return {
    platformId: "reddit",
    externalId,
    authorExternalId,
    body,
    contentType: "post",
    externalCreatedAt: created,
    visibility: "PUBLIC",
    metrics: {
      likes: numberOrUndefined(thing.ups) ?? numberOrUndefined(thing.score),
      comments: numberOrUndefined(thing.num_comments),
    },
    providerDataCategory: REDDIT_CONTENT_CATEGORY,
    provenance: {
      platformId: "reddit",
      connectionId: context?.connectionId,
      scopeId: context?.scopeId,
      observedAt: new Date().toISOString(),
      providerCreatedAt: created,
      normalizationVersion: NORMALIZATION_VERSION,
      adapterVersion: ADAPTER_VERSION,
      visibility: "PUBLIC",
    },
    metadata: {
      providerDataCategory: REDDIT_CONTENT_CATEGORY,
      providerRetentionBasis: "REDDIT_APPROVED_USE_CASE",
      subreddit: stringOrUndefined(thing.subreddit),
      permalink: stringOrUndefined(thing.permalink),
      sourcePolicy: {
        provider: "reddit",
        modelTrainingAllowed: false,
        fineTuningAllowed: false,
        seedDataAllowed: false,
      },
    },
  };
}

function normalizeComment(
  thing: RedditThing,
  articleId: string | undefined,
  context: ConnectorOperationContext | undefined,
): NormalizedInteraction | null {
  if (isDeletedOrRemoved(thing)) return null;
  const externalId = stringOrUndefined(thing.name) ?? prefixedId("t1", stringOrUndefined(thing.id));
  const fromExternalId = stringOrUndefined(thing.author_fullname) ?? stringOrUndefined(thing.author);
  const body = stringOrUndefined(thing.body);
  const occurredAt = timestampFromUtc(thing.created_utc) ?? new Date().toISOString();
  if (!externalId || !fromExternalId || !body || isPlaceholderText(body)) return null;
  const interaction: NormalizedInteraction = {
    platformId: "reddit",
    externalId,
    fromExternalId,
    toContentExternalId: articleId ? prefixedId("t3", articleId) : undefined,
    type: "COMMENT",
    body,
    occurredAt,
    visibility: "PUBLIC",
    providerDataCategory: REDDIT_COMMENT_CATEGORY,
    provenance: {
      platformId: "reddit",
      connectionId: context?.connectionId,
      scopeId: context?.scopeId,
      observedAt: new Date().toISOString(),
      providerCreatedAt: occurredAt,
      normalizationVersion: NORMALIZATION_VERSION,
      adapterVersion: ADAPTER_VERSION,
      visibility: "PUBLIC",
    },
    metadata: {
      providerDataCategory: REDDIT_COMMENT_CATEGORY,
      providerRetentionBasis: "REDDIT_APPROVED_USE_CASE",
      subreddit: stringOrUndefined(thing.subreddit),
      score: numberOrUndefined(thing.score),
      permalink: stringOrUndefined(thing.permalink),
      sourcePolicy: {
        provider: "reddit",
        modelTrainingAllowed: false,
        fineTuningAllowed: false,
        seedDataAllowed: false,
      },
    },
  };
  if (!interaction.toContentExternalId) delete interaction.toContentExternalId;
  return interaction;
}

function listingQuery(options: ContentQuery): URLSearchParams {
  const query = new URLSearchParams();
  query.set("raw_json", "1");
  query.set("limit", String(Math.max(1, Math.min(MAX_LISTING_LIMIT, options.limit ?? 25))));
  if (options.cursor) query.set("after", options.cursor);
  if (options.since) query.set("after_timestamp", options.since);
  return query;
}

function contentUsername(options: ContentQuery, credentials: ConnectorCredentials): string {
  const username =
    options.accountId ??
    stringOrUndefined(credentials.metadata?.providerUsername) ??
    stringOrUndefined(credentials.metadata?.providerUserHandle);
  if (!username) {
    throw new AuthenticationError("reddit", "Reddit username is required for history sync");
  }
  return username.replace(/^u\//, "").replace(/^\/u\//, "").replace(/^@/, "");
}

function listingChildren<T>(listing: RedditListing<T>): T[] {
  const children = listing.data?.children;
  if (!Array.isArray(children)) return [];
  return children.map((child) => child.data).filter((item): item is T => !!item);
}

function cursorFromListing<T>(listing: RedditListing<T>) {
  const after = stringOrUndefined(listing.data?.after) ?? null;
  return { value: after, hasMore: !!after };
}

function extractCommentsTree(body: unknown): RedditThing[] {
  if (!Array.isArray(body)) return [];
  const commentsListing = body[1] as RedditListing<RedditThing> | undefined;
  return flattenCommentListing(commentsListing);
}

function flattenCommentListing(listing: RedditListing<RedditThing> | undefined): RedditThing[] {
  const children = listing?.data?.children;
  if (!Array.isArray(children)) return [];
  const output: RedditThing[] = [];
  for (const child of children) {
    if (child.kind === "more") continue;
    if (child.data) output.push(child.data);
    const replies = (child.data as { replies?: unknown } | undefined)?.replies;
    if (replies && typeof replies === "object") {
      output.push(...flattenCommentListing(replies as RedditListing<RedditThing>));
    }
  }
  return output;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timestampFromUtc(value: unknown): string | undefined {
  const seconds = numberOrUndefined(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function cleanRedditImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const decoded = value.replace(/&amp;/g, "&");
  return decoded.startsWith("http://") || decoded.startsWith("https://") ? decoded : undefined;
}

function prefixedId(prefix: string, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;
}

function isDeletedOrRemoved(thing: RedditThing): boolean {
  return (
    stringOrUndefined(thing.removed_by_category) !== undefined ||
    isPlaceholderText(stringOrUndefined(thing.author)) ||
    isPlaceholderText(stringOrUndefined(thing.title)) ||
    isPlaceholderText(stringOrUndefined(thing.body))
  );
}

function isPlaceholderText(value: string | undefined): boolean {
  return value === "[deleted]" || value === "[removed]";
}
