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
  type NormalizationProvenance,
  type NormalizedContent,
  type NormalizedInteraction,
  type NormalizedProfile,
} from "../normalized.js";
import {
  decodeLinkedInCursor,
  encodeLinkedInCursor,
  LINKEDIN_MARKETING_API_VERSION,
  LINKEDIN_OAUTH_AUTHORIZE_URL,
  LINKEDIN_OAUTH_TOKEN_URL,
  LINKEDIN_OIDC_USERINFO_URL,
  LinkedInApiClient,
  type LinkedInElementsResponse,
} from "./linkedin-api.js";
import {
  validateNormalizedContent,
  validateNormalizedInteraction,
  validateNormalizedProfile,
} from "../validation.js";

const ADAPTER_VERSION = "linkedin-rest-202608-v1";

export const LINKEDIN_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "r_organization_social",
  "rw_organization_admin",
  "r_organization_admin",
  "r_organization_social_feed",
];

export interface LinkedInAsset {
  platformId: "linkedin";
  assetType: "LINKEDIN_ORGANIZATION";
  assetId: string;
  name: string;
  handle?: string | undefined;
  parentAssetId?: string | undefined;
  tokenKind: "USER";
  accessToken?: string | undefined;
  metadata: Record<string, unknown>;
}

export const LINKEDIN_CAPABILITY_MATRIX: Record<
  ConnectorCapability,
  { scopes: string[]; state: AvailabilityState }
> = {
  profiles: { scopes: ["r_organization_social", "r_organization_admin"], state: "CONFIGURATION_REQUIRED" },
  content: { scopes: ["r_organization_social", "r_organization_social_feed"], state: "CONFIGURATION_REQUIRED" },
  comments: { scopes: ["r_organization_social", "r_organization_social_feed"], state: "CONFIGURATION_REQUIRED" },
  metrics: { scopes: ["r_organization_social", "r_organization_admin"], state: "CONFIGURATION_REQUIRED" },
  followers: { scopes: ["r_organization_social", "r_organization_admin"], state: "CONFIGURATION_REQUIRED" },
  audience_insights: { scopes: ["r_organization_social", "r_organization_admin"], state: "CONFIGURATION_REQUIRED" },
  following: { scopes: [], state: "UNAVAILABLE" },
  search: { scopes: [], state: "UNAVAILABLE" },
  messages: { scopes: [], state: "UNAVAILABLE" },
  publishing: { scopes: [], state: "UNAVAILABLE" },
};

export function evaluateLinkedInCapabilities(
  input: CapabilityEvaluationInput,
): Partial<Record<ConnectorCapability, AvailabilityState>> {
  if (!input.configured) {
    return Object.fromEntries(
      Object.keys(LINKEDIN_CAPABILITY_MATRIX).map((key) => [key, "CONFIGURATION_REQUIRED"]),
    ) as Partial<Record<ConnectorCapability, AvailabilityState>>;
  }

  const granted = new Set(input.grantedScopes ?? []);
  const role = typeof input.access?.organizationRole === "string" ? input.access.organizationRole : undefined;

  const result: Partial<Record<ConnectorCapability, AvailabilityState>> = {};

  for (const [capKey, config] of Object.entries(LINKEDIN_CAPABILITY_MATRIX)) {
    const capability = capKey as ConnectorCapability;
    if (config.state === "UNAVAILABLE") {
      result[capability] = "UNAVAILABLE";
      continue;
    }

    // Role check: ANALYST only permits metrics/insights/profiles, not comments/content administration
    if (role && (capability === "content" || capability === "comments")) {
      const allowedRoles = ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER"];
      if (!allowedRoles.includes(role)) {
        result[capability] = "PERMISSION_REQUIRED";
        continue;
      }
    }

    const hasScopes = config.scopes.length === 0 || config.scopes.some((scope) => granted.has(scope));
    if (!hasScopes) {
      result[capability] = "PERMISSION_REQUIRED";
      continue;
    }

    result[capability] = "AVAILABLE";
  }

  return result;
}

export interface LinkedInConnectorOptions {
  baseUrl?: string | undefined;
  authorizeBaseUrl?: string | undefined;
  oidcBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  apiVersion?: string | undefined;
}

export class LinkedInConnector extends BaseSocialConnector {
  protected manifest: ConnectorManifest = {
    id: "linkedin",
    platformId: "linkedin",
    name: "LinkedIn",
    version: "0.2.0",
    apiVersion: LINKEDIN_MARKETING_API_VERSION,
    capabilities: Object.fromEntries(
      Object.entries(LINKEDIN_CAPABILITY_MATRIX).map(([key, value]) => [key, value.state]),
    ) as Partial<Record<ConnectorCapability, AvailabilityState>>,
    providerConfig: {
      fields: [
        { key: "clientId", label: "Client ID", required: true, secret: false, kind: "string" },
        { key: "clientSecret", label: "Client Secret", required: true, secret: true, kind: "string" },
        { key: "redirectUri", label: "Redirect URI", required: true, secret: false, kind: "url" },
      ],
    },
    oauth: {
      type: "authorization_code_pkce",
      authorizationEndpoint: LINKEDIN_OAUTH_AUTHORIZE_URL,
      tokenEndpoint: LINKEDIN_OAUTH_TOKEN_URL,
      defaultScopes: LINKEDIN_DEFAULT_SCOPES,
      pkceRequired: false,
      supportsRefresh: true,
      supportsRevocation: false,
    },
  };

  private readonly client: LinkedInApiClient;
  private readonly authorizeBaseUrl: string;
  private readonly oidcBaseUrl: string;

  constructor(options: LinkedInConnectorOptions = {}) {
    super();
    this.client = new LinkedInApiClient({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      connectorId: "linkedin",
      apiVersion: options.apiVersion ?? LINKEDIN_MARKETING_API_VERSION,
    });
    this.authorizeBaseUrl = options.authorizeBaseUrl ?? LINKEDIN_OAUTH_AUTHORIZE_URL;
    this.oidcBaseUrl =
      options.oidcBaseUrl ??
      options.baseUrl?.replace(/\/rest\/?$/, "") ??
      process.env.LINKEDIN_REST_BASE_URL?.replace(/\/rest\/?$/, "") ??
      "https://api.linkedin.com";
  }

  override evaluateCapabilities(input: CapabilityEvaluationInput) {
    return evaluateLinkedInCapabilities(input);
  }

  getOAuthAdapter(): OAuthProviderAdapter {
    return {
      buildAuthorizationUrl: (request: OAuthAuthorizationRequest) => {
        const url = new URL(this.authorizeBaseUrl);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", request.providerConfig.clientId);
        url.searchParams.set("redirect_uri", request.providerConfig.redirectUri);
        url.searchParams.set("state", request.state);
        const scopes = request.requestedScopes.length ? request.requestedScopes : LINKEDIN_DEFAULT_SCOPES;
        url.searchParams.set("scope", scopes.join(" "));
        return url;
      },

      exchangeAuthorizationCode: async (
        request: OAuthTokenExchangeRequest,
        signal?: AbortSignal,
      ): Promise<OAuthTokenResult> => {
        const form = new URLSearchParams();
        form.set("grant_type", "authorization_code");
        form.set("code", request.code);
        form.set("redirect_uri", request.redirectUri);
        form.set("client_id", request.providerConfig.clientId);
        if (request.providerConfig.clientSecret) {
          form.set("client_secret", request.providerConfig.clientSecret);
        }

        const res = await this.client.postForm<Record<string, unknown>>(
          request.contract?.tokenEndpoint ?? LINKEDIN_OAUTH_TOKEN_URL,
          form,
          { signal },
        );

        const data = res.body;
        const accessToken = typeof data.access_token === "string" ? data.access_token : "";
        if (!accessToken) {
          throw new AuthenticationError("linkedin", "LinkedIn token endpoint did not return an access_token");
        }

        const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
        const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
        const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : undefined;

        // Scopes: check scope in response or fall back to requested
        const scopeStr = typeof data.scope === "string" ? data.scope : undefined;
        const grantedScopes = scopeStr ? scopeStr.split(/[\s,]+/).filter(Boolean) : request.requestedScopes;

        return {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
          ...(expiresIn !== undefined ? { expiresIn } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          tokenType: typeof data.token_type === "string" ? data.token_type : "Bearer",
          grantedScopes,
          rawProviderMetadata: data,
        };
      },

      refreshAccessToken: async (
        request: OAuthTokenRefreshRequest,
        signal?: AbortSignal,
      ): Promise<OAuthTokenResult> => {
        const form = new URLSearchParams();
        form.set("grant_type", "refresh_token");
        form.set("refresh_token", request.refreshToken);
        form.set("client_id", request.providerConfig.clientId);
        if (request.providerConfig.clientSecret) {
          form.set("client_secret", request.providerConfig.clientSecret);
        }

        const res = await this.client.postForm<Record<string, unknown>>(
          request.contract?.tokenEndpoint ?? LINKEDIN_OAUTH_TOKEN_URL,
          form,
          { signal },
        );

        const data = res.body;
        const accessToken = typeof data.access_token === "string" ? data.access_token : "";
        if (!accessToken) {
          throw new AuthenticationError("linkedin", "LinkedIn token refresh failed to return access_token");
        }

        const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
        const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
        const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : request.refreshToken;

        return {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
          ...(expiresIn !== undefined ? { expiresIn } : {}),
          ...(expiresAt ? { expiresAt } : {}),
          tokenType: typeof data.token_type === "string" ? data.token_type : "Bearer",
          grantedScopes: [],
          rawProviderMetadata: data,
        };
      },

      verifyIdentity: async (
        credentials: ConnectorCredentials,
        context?: ConnectorOperationContext,
      ): Promise<NormalizedProfile> => {
        const token = credentials.accessToken;
        if (!token) throw new AuthenticationError("linkedin", "Missing access token");

        // Identity verification via official OpenID Connect userinfo endpoint
        const res = await this.client.get<Record<string, unknown>>(
          `${this.oidcBaseUrl}/v2/userinfo`,
          token,
          undefined,
          { signal: context?.signal },
        );

        const data = res.body;
        const sub = typeof data.sub === "string" ? data.sub : "";
        if (!sub) {
          throw new AuthenticationError("linkedin", "OpenID Connect userinfo did not return a sub identifier");
        }

        const name = typeof data.name === "string" ? data.name : "LinkedIn Member";
        const email = typeof data.email === "string" ? data.email : undefined;

        const profile: NormalizedProfile = {
          platformId: "linkedin",
          externalId: sub,
          handle: email ?? `member-${sub.slice(0, 8)}`,
          displayName: name,
          followerCount: 0,
          followingCount: 0,
          visibility: "SCOPE_PRIVATE",
          provenance: makeProvenance("linkedin", context),
          metadata: {
            sub,
            email,
            emailVerified: data.email_verified === true,
            providerIdentityType: "LINKEDIN_MEMBER_OIDC",
            raw: data,
          },
        };

        validateNormalizedProfile(profile);
        return profile;
      },
    };
  }

  async listAssets(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<LinkedInAsset[]> {
    const token = credentials.accessToken;
    if (!token) throw new AuthenticationError("linkedin", "Missing access token for asset discovery");

    // 1. Discover organization ACLs where member has assigned role
    const aclRes = await this.client.get<LinkedInElementsResponse<{
      organization: string;
      role: string;
      state: string;
      roleAssignee?: string;
    }>>("/organizationAcls", token, { q: "roleAssignee" }, { signal: context?.signal });

    const acls = Array.isArray(aclRes.body.elements) ? aclRes.body.elements : [];
    const approvedAcls = acls.filter(
      (acl) => acl && acl.state === "APPROVED" && typeof acl.organization === "string",
    );

    const orgMap = new Map<string, { orgId: string; orgUrn: string; roles: string[] }>();
    for (const item of approvedAcls) {
      const urn = item.organization;
      const orgId = urn.replace(/^urn:li:organization:/, "");
      const existing = orgMap.get(orgId) ?? { orgId, orgUrn: urn, roles: [] };
      if (item.role && !existing.roles.includes(item.role)) {
        existing.roles.push(item.role);
      }
      orgMap.set(orgId, existing);
    }

    const assets: LinkedInAsset[] = [];

    // 2. Lookup organization profile for each administered organization
    for (const [orgId, entry] of orgMap) {
      try {
        const orgRes = await this.client.get<Record<string, unknown>>(
          `/organizations/${orgId}`,
          token,
          undefined,
          { signal: context?.signal },
        );

        const org = orgRes.body;
        const name =
          (typeof org.localizedName === "string" ? org.localizedName : undefined) ??
          (typeof org.name === "string" ? org.name : undefined) ??
          `Organization ${orgId}`;
        const vanityName = typeof org.vanityName === "string" ? org.vanityName : undefined;
        const primaryRole = entry.roles[0] ?? "ADMINISTRATOR";

        assets.push({
          platformId: "linkedin",
          assetType: "LINKEDIN_ORGANIZATION",
          assetId: orgId,
          name,
          ...(vanityName ? { handle: vanityName } : { handle: orgId }),
          tokenKind: "USER",
          accessToken: token,
          metadata: {
            organizationUrn: entry.orgUrn,
            numericId: orgId,
            vanityName,
            roles: entry.roles,
            primaryRole,
            organizationType: org.primaryOrganizationType,
            staffCountRange: org.staffCountRange,
          },
        });
      } catch {
        // Tolerant of lookup failure on restricted organizations
        assets.push({
          platformId: "linkedin",
          assetType: "LINKEDIN_ORGANIZATION",
          assetId: orgId,
          name: `Organization ${orgId}`,
          handle: orgId,
          tokenKind: "USER",
          accessToken: token,
          metadata: {
            organizationUrn: entry.orgUrn,
            numericId: orgId,
            roles: entry.roles,
            primaryRole: entry.roles[0] ?? "ADMINISTRATOR",
          },
        });
      }
    }

    return assets;
  }

  override async authenticate(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<AuthResult> {
    try {
      const assetId = (credentials.metadata?.assetId as string) ?? (credentials.metadata?.providerAssetId as string);
      if (assetId) {
        const orgProfile = await this.getProfile(assetId, {
          scopeId: context?.scopeId ?? "auth",
          connectionId: context?.connectionId ?? "auth",
          credentials,
        });
        if (orgProfile) {
          return { success: true, status: "CONNECTED", profile: orgProfile };
        }
      }
      const profile = await this.getOAuthAdapter().verifyIdentity(credentials, context);
      return {
        success: true,
        status: "CONNECTED",
        profile,
      };
    } catch (err) {
      return {
        success: false,
        status: "REAUTH_REQUIRED",
        error: err instanceof Error ? err.message : "Authentication failed",
      };
    }
  }

  override async checkHealth(): Promise<boolean> {
    return true;
  }

  override async disconnect(): Promise<void> {
    // Read-only member delegated authorization disconnect
  }

  override async getAuthenticatedProfile(
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile | null> {
    if (!context?.credentials.accessToken) return null;
    return this.getOAuthAdapter().verifyIdentity(context.credentials, context);
  }

  override async getProfile(
    identifier: string,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedProfile | null> {
    const token = context?.credentials.accessToken;
    if (!token) throw new AuthenticationError("linkedin", "Missing access token");

    const orgId = identifier.replace(/^urn:li:organization:/, "");
    const res = await this.client.get<Record<string, unknown>>(
      `/organizations/${orgId}`,
      token,
      undefined,
      { signal: context?.signal },
    );

    const org = res.body;
    const name =
      (typeof org.localizedName === "string" ? org.localizedName : undefined) ??
      (typeof org.name === "string" ? org.name : undefined) ??
      orgId;
    const vanityName = typeof org.vanityName === "string" ? org.vanityName : undefined;
    const desc = typeof org.localizedDescription === "string" ? org.localizedDescription : undefined;
    const website = typeof org.website === "string" ? org.website : undefined;

    const profile: NormalizedProfile = {
      platformId: "linkedin",
      externalId: orgId,
      handle: vanityName ?? orgId,
      displayName: name,
      ...(desc ? { bio: desc } : {}),
      ...(website ? { website } : {}),
      followerCount: 0,
      followingCount: 0,
      visibility: "SCOPE_PRIVATE",
      provenance: makeProvenance("linkedin", context),
      metadata: {
        organizationUrn: `urn:li:organization:${orgId}`,
        vanityName,
        primaryOrganizationType: org.primaryOrganizationType,
        staffCountRange: org.staffCountRange,
        raw: org,
      },
    };

    validateNormalizedProfile(profile);
    return profile;
  }

  override async getContent(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedContent[]> {
    const page = await this.getContentPage(options, context);
    return page.items;
  }

  override async getContentPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedContent>> {
    const token = context?.credentials.accessToken;
    if (!token) throw new AuthenticationError("linkedin", "Missing access token");

    const rawAccountId =
      options.accountId ??
      (context?.credentials.metadata?.assetId as string) ??
      (context?.credentials.metadata?.providerAssetId as string) ??
      "";
    const orgId = rawAccountId.replace(/^urn:li:organization:/, "");
    const authorUrn = `urn:li:organization:${orgId}`;

    const cursorData = decodeLinkedInCursor(options.cursor);
    const start = cursorData ? cursorData.start : 0;
    const count = options.limit ?? 10;

    const res = await this.client.get<LinkedInElementsResponse<Record<string, unknown>>>(
      "/posts",
      token,
      {
        author: authorUrn,
        q: "author",
        count,
        start,
      },
      { signal: context?.signal },
    );

    const elements = Array.isArray(res.body.elements) ? res.body.elements : [];
    const items: NormalizedContent[] = [];

    for (const post of elements) {
      const postId = typeof post.id === "string" ? post.id : "";
      if (!postId) continue;

      const commentary = typeof post.commentary === "string" ? post.commentary : "";
      const createdAtMs = typeof post.createdAt === "number" ? post.createdAt : Date.now();
      const createdAt = new Date(createdAtMs).toISOString();

      const item: NormalizedContent = {
        platformId: "linkedin",
        authorExternalId: orgId,
        externalId: postId,
        body: commentary,
        externalCreatedAt: createdAt,
        visibility: "SCOPE_PRIVATE",
        provenance: makeProvenance("linkedin", context, createdAt),
        metadata: {
          authorUrn,
          lifecycleState: post.lifecycleState,
          visibility: post.visibility,
          lastModifiedAt: post.lastModifiedAt,
          raw: post,
        },
      };

      validateNormalizedContent(item);
      items.push(item);
    }

    const paging = res.body.paging;
    const total = paging?.total;
    const hasMore =
      total !== undefined
        ? start + elements.length < total
        : elements.length >= count;

    const nextCursor = hasMore
      ? encodeLinkedInCursor({ start: start + elements.length, count })
      : null;

    return {
      items,
      cursor: {
        value: nextCursor,
        hasMore,
      },
      rateLimit: res.rateLimit,
    };
  }

  override async getComments(
    contentId: string,
    options?: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<NormalizedInteraction[]> {
    const page = await this.getInteractionsPage({ ...options, accountId: contentId }, context);
    return page.items;
  }

  override async getInteractionsPage(
    options: ContentQuery,
    context?: ConnectorOperationContext,
  ): Promise<PageResult<NormalizedInteraction>> {
    const token = context?.credentials.accessToken;
    if (!token) throw new AuthenticationError("linkedin", "Missing access token");

    const contentId = options.accountId ?? "";
    const encodedActivityUrn = encodeURIComponent(contentId);

    const cursorData = decodeLinkedInCursor(options.cursor);
    const start = cursorData ? cursorData.start : 0;
    const count = options.limit ?? 10;

    const res = await this.client.get<LinkedInElementsResponse<Record<string, unknown>>>(
      `/socialActions/${encodedActivityUrn}/comments`,
      token,
      { count, start },
      { signal: context?.signal },
    );

    const elements = Array.isArray(res.body.elements) ? res.body.elements : [];
    const items: NormalizedInteraction[] = [];

    for (const comment of elements) {
      const commentId = typeof comment.id === "string" ? comment.id : "";
      if (!commentId) continue;

      const actorUrn = typeof comment.actor === "string" ? comment.actor : "urn:li:unknown";
      const messageObj = comment.message && typeof comment.message === "object" ? (comment.message as Record<string, unknown>) : null;
      const text = messageObj && typeof messageObj.text === "string" ? messageObj.text : "";

      const createdObj = comment.created && typeof comment.created === "object" ? (comment.created as Record<string, unknown>) : null;
      const timeMs = createdObj && typeof createdObj.time === "number" ? createdObj.time : Date.now();
      const occurredAt = new Date(timeMs).toISOString();

      const interaction: NormalizedInteraction = {
        platformId: "linkedin",
        externalId: commentId,
        fromExternalId: actorUrn.replace(/^urn:li:[^:]+:/, ""),
        toContentExternalId: contentId,
        type: "COMMENT",
        body: text,
        occurredAt,
        visibility: "SCOPE_PRIVATE",
        provenance: makeProvenance("linkedin", context, occurredAt),
        metadata: {
          actorUrn,
          lastModified: comment.lastModified,
          raw: comment,
        },
      };

      validateNormalizedInteraction(interaction);
      items.push(interaction);
    }

    const paging = res.body.paging;
    const total = paging?.total;
    const hasMore =
      total !== undefined
        ? start + elements.length < total
        : elements.length >= count;

    const nextCursor = hasMore
      ? encodeLinkedInCursor({ start: start + elements.length, count })
      : null;

    return {
      items,
      cursor: {
        value: nextCursor,
        hasMore,
      },
      rateLimit: res.rateLimit,
    };
  }

  override async getMetrics(
    accountId: string,
    context?: ConnectorOperationContext,
  ): Promise<AccountMetrics> {
    const token = context?.credentials.accessToken;
    if (!token) throw new AuthenticationError("linkedin", "Missing access token");

    const rawAccountId =
      accountId ||
      (context?.credentials.metadata?.assetId as string) ||
      (context?.credentials.metadata?.providerAssetId as string) ||
      "";
    const orgId = rawAccountId.replace(/^urn:li:organization:/, "");
    const orgUrn = `urn:li:organization:${orgId}`;

    let followerCount = 0;
    try {
      // Current official network size endpoint for total organization followers
      const netRes = await this.client.get<{ firstDegreeSize?: number }>(
        `/networkSizes/${encodeURIComponent(orgUrn)}`,
        token,
        { edgeType: "CompanyFollowedByMember" },
        { signal: context?.signal },
      );
      if (typeof netRes.body.firstDegreeSize === "number") {
        followerCount = netRes.body.firstDegreeSize;
      }
    } catch {
      // If networkSizes is unavailable, try aggregate follower statistics
      try {
        const statRes = await this.client.get<LinkedInElementsResponse<Record<string, unknown>>>(
          "/organizationalEntityFollowerStatistics",
          token,
          { q: "organizationalEntity", organizationalEntity: orgUrn },
          { signal: context?.signal },
        );
        const first = statRes.body.elements?.[0];
        if (first && typeof first.totalFollowerCounts === "number") {
          followerCount = first.totalFollowerCounts;
        }
      } catch {
        // Fall back gracefully
      }
    }

    let contentCount = 0;
    let engagementRate: number | undefined;

    try {
      // Organization share statistics (organic engagement)
      const shareRes = await this.client.get<LinkedInElementsResponse<Record<string, unknown>>>(
        "/organizationalEntityShareStatistics",
        token,
        { q: "organizationalEntity", organizationalEntity: orgUrn },
        { signal: context?.signal },
      );
      const first = shareRes.body.elements?.[0];
      const stats = first?.totalShareStatistics && typeof first.totalShareStatistics === "object"
        ? (first.totalShareStatistics as Record<string, unknown>)
        : null;

      if (stats) {
        const shares = typeof stats.shareCount === "number" ? stats.shareCount : 0;
        contentCount = shares;
        if (typeof stats.engagement === "number") {
          engagementRate = stats.engagement;
        }
      }
    } catch {
      // Ignore if share stats not accessible
    }

    const metrics: AccountMetrics = {
      followerCount,
      followingCount: 0, // LinkedIn does not expose following for organizations
      contentCount,
      collectedAt: new Date().toISOString(),
      ...(typeof engagementRate === "number" ? { engagementRate } : {}),
    };

    return metrics;
  }

  override async searchProfiles(): Promise<NormalizedProfile[]> {
    throw new CapabilityUnavailableError(
      "linkedin",
      "search",
      "General member/profile search is not supported by LinkedIn Community Management APIs.",
    );
  }

  override async searchContent(): Promise<NormalizedContent[]> {
    throw new CapabilityUnavailableError(
      "linkedin",
      "search",
      "General content search is not supported by LinkedIn Community Management APIs.",
    );
  }

  override async getFollowers(): Promise<NormalizedProfile[]> {
    throw new CapabilityUnavailableError(
      "linkedin",
      "followers",
      "Individual follower identity listing is not supported by LinkedIn. Only aggregate follower statistics are available.",
    );
  }

  override async getFollowing(): Promise<NormalizedProfile[]> {
    throw new CapabilityUnavailableError(
      "linkedin",
      "following",
      "Following listing is not supported by LinkedIn.",
    );
  }
}

function makeProvenance(
  platformId: string,
  context?: ConnectorOperationContext,
  providerCreatedAt?: string,
): NormalizationProvenance {
  return {
    platformId,
    ...(context?.connectionId ? { connectionId: context.connectionId } : {}),
    ...(context?.scopeId ? { scopeId: context.scopeId } : {}),
    observedAt: new Date().toISOString(),
    ...(providerCreatedAt ? { providerCreatedAt } : {}),
    normalizationVersion: NORMALIZATION_VERSION,
    adapterVersion: ADAPTER_VERSION,
    visibility: "SCOPE_PRIVATE",
  };
}
