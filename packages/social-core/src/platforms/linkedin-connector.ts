import type { AvailabilityState, ConnectorCapability, ConnectorManifest } from "@xlrrank/shared";
import { BaseSocialConnector } from "../connectors/base.js";
import {
  AuthenticationError,
  AuthorizationError,
  CapabilityUnavailableError,
  ConnectorConfigurationError,
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
  ProviderEventSubscriptionRequest,
  ProviderEventSubscriptionResult,
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
  "r_organization_admin",
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
  credentialMetadata?: Record<string, unknown> | undefined;
}

export const LINKEDIN_CAPABILITY_MATRIX: Record<
  ConnectorCapability,
  { scopes: string[]; state: AvailabilityState }
> = {
  profiles: { scopes: ["r_organization_social", "r_organization_admin"], state: "CONFIGURATION_REQUIRED" },
  content: { scopes: ["r_organization_social", "r_organization_social_feed"], state: "CONFIGURATION_REQUIRED" },
  comments: { scopes: ["r_organization_social", "r_organization_social_feed"], state: "CONFIGURATION_REQUIRED" },
  metrics: { scopes: ["r_organization_social", "r_organization_admin"], state: "CONFIGURATION_REQUIRED" },
  followers: { scopes: [], state: "UNAVAILABLE" },
  audience_insights: { scopes: ["rw_organization_admin"], state: "APP_REVIEW_REQUIRED" },
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
  const access = input.access ?? {};

  const result: Partial<Record<ConnectorCapability, AvailabilityState>> = {};

  for (const [capKey, config] of Object.entries(LINKEDIN_CAPABILITY_MATRIX)) {
    const capability = capKey as ConnectorCapability;
    if (config.state === "UNAVAILABLE") {
      result[capability] = "UNAVAILABLE";
      continue;
    }

    if (
      (capability === "profiles" ||
        capability === "content" ||
        capability === "comments" ||
        capability === "metrics") &&
      access.communityManagement !== true
    ) {
      result[capability] = "APP_REVIEW_REQUIRED";
      continue;
    }

    if (capability === "audience_insights" && access.followerStatistics !== true) {
      result[capability] = access.communityManagement === true ? "PERMISSION_REQUIRED" : "APP_REVIEW_REQUIRED";
      continue;
    }

    if (role && (capability === "content" || capability === "comments")) {
      const allowedRoles = ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER"];
      if (!allowedRoles.includes(role)) {
        result[capability] = "PERMISSION_REQUIRED";
        continue;
      }
    }

    if ((capability === "metrics" || capability === "audience_insights") && role && role !== "ADMINISTRATOR") {
      result[capability] = "PERMISSION_REQUIRED";
      continue;
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

  getProviderFamily(): string {
    return "linkedin";
  }

  resolveOAuthDefaultScopes(defaults: string[], providerConfig: ProviderApplicationConfig): string[] {
    const access =
      providerConfig.metadata?.access &&
      typeof providerConfig.metadata.access === "object" &&
      !Array.isArray(providerConfig.metadata.access)
        ? (providerConfig.metadata.access as Record<string, unknown>)
        : {};
    const scopes = [...defaults];
    if (access.organizationSocialActionNotifications === true) scopes.push("rw_organization_admin");
    if (access.restrictedMemberFeed === true) scopes.push("r_organization_social_feed");
    return [...new Set(scopes)];
  }

  getWebhookAdapter() {
    return {
      extractAssetIds: (payload: Record<string, unknown>) => {
        const ids = new Set<string>();
        const addUrn = (value: unknown) => {
          if (typeof value !== "string" || value.length === 0) return;
          ids.add(value);
          ids.add(value.replace(/^urn:li:organization:/, ""));
        };
        const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
        for (const notification of notifications) {
          if (!notification || typeof notification !== "object") continue;
          const record = notification as Record<string, unknown>;
          addUrn(record.organizationalEntity);
          addUrn(record.organization);
          addUrn(record.entityUrn);
          addUrn(record.assetId);
        }
        addUrn(payload.organization);
        addUrn(payload.entityUrn);
        addUrn(payload.organizationalEntity);
        if (typeof payload.assetId === "string") ids.add(payload.assetId);
        return [...ids].filter(Boolean);
      },
    };
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
          visibility: "SCOPE_PRIVATE",
          providerDataCategory: "authenticated_member_profile",
          provenance: makeProvenance("linkedin", context),
          metadata: {
            sub,
            email,
            emailVerified: data.email_verified === true,
            providerIdentityType: "LINKEDIN_MEMBER_OIDC",
            providerDataCategory: "authenticated_member_profile",
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

    const orgMap = new Map<string, { orgId: string; orgUrn: string; roles: string[]; roleAssignee?: string }>();
    for (const item of approvedAcls) {
      const urn = item.organization;
      const orgId = urn.replace(/^urn:li:organization:/, "");
      const existing = orgMap.get(orgId) ?? { orgId, orgUrn: urn, roles: [] };
      if (item.role && !existing.roles.includes(item.role)) {
        existing.roles.push(item.role);
      }
      if (item.roleAssignee && !existing.roleAssignee) existing.roleAssignee = item.roleAssignee;
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
          credentialMetadata: {
            organizationUrn: entry.orgUrn,
            memberUrn: entry.roleAssignee,
            numericId: orgId,
          },
          metadata: {
            organizationUrn: entry.orgUrn,
            memberUrn: entry.roleAssignee,
            numericId: orgId,
            roles: entry.roles,
            primaryRole,
            roleObservedAt: new Date().toISOString(),
            roleProviderDataCategory: "organization_admin_reporting",
            providerDataCategory: "organization_profile",
            providerRetentionBasis: "AUTHENTICATED_ORGANIZATION_ASSET",
          },
        });
      } catch (err) {
        if (!isNonFatalLinkedInProfileDecorationError(err)) throw err;
        assets.push({
          platformId: "linkedin",
          assetType: "LINKEDIN_ORGANIZATION",
          assetId: orgId,
          name: `Organization ${orgId}`,
          handle: orgId,
          tokenKind: "USER",
          accessToken: token,
          credentialMetadata: {
            organizationUrn: entry.orgUrn,
            memberUrn: entry.roleAssignee,
            numericId: orgId,
          },
          metadata: {
            organizationUrn: entry.orgUrn,
            memberUrn: entry.roleAssignee,
            numericId: orgId,
            roles: entry.roles,
            primaryRole: entry.roles[0] ?? "ADMINISTRATOR",
            roleObservedAt: new Date().toISOString(),
            roleProviderDataCategory: "organization_admin_reporting",
            providerDataCategory: "organization_profile",
            providerRetentionBasis: "AUTHENTICATED_ORGANIZATION_ASSET",
          },
        });
      }
    }

    return assets;
  }

  listAuthorizationAssets(
    credentials: ConnectorCredentials,
    context?: ConnectorOperationContext,
  ): Promise<LinkedInAsset[]> {
    return this.listAssets(credentials, context);
  }

  upsertProviderEventSubscription(
    input: ProviderEventSubscriptionRequest,
    context?: ConnectorOperationContext,
  ): Promise<ProviderEventSubscriptionResult | null> {
    const access = input.access ?? {};
    if (access.eventSubscriptionsEnabled !== true && access.organizationSocialActionNotifications !== true) {
      return Promise.resolve(null);
    }
    const eventType = linkedInString(access, "eventType") ?? "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS";
    const webhookUrl = linkedInString(access, "webhookUrl");
    const developerApplicationUrn = linkedInDeveloperApplicationUrn(access);
    const organizationUrn =
      linkedInString(input.assetMetadata, "organizationUrn") ??
      `urn:li:organization:${input.providerAssetId ?? ""}`;
    const memberUrn =
      linkedInString(input.assetMetadata, "memberUrn") ??
      `urn:li:person:${input.providerUserId ?? ""}`;
    const providerKey = {
      applicationKey: developerApplicationUrn ?? "urn:li:developerApplication:unknown",
      actorKey: memberUrn,
      entityKey: organizationUrn,
      eventType,
    };
    if (!developerApplicationUrn || !webhookUrl) {
      return Promise.resolve({
        providerStatus: "CONFIGURATION_REQUIRED",
        eventType,
        providerKey,
        webhookUrl: webhookUrl ?? "",
        metadata: {
          liveRegistrationState: "BLOCKED_EXTERNAL",
          eventSubscriptionAccessState: "BLOCKED_EXTERNAL",
        },
        lastError: {
          message: "Provider event subscription webhook URL or developer application URN is not configured",
        },
        raw: {},
      });
    }
    const roles = input.roles ?? [];
    const grantedScopes = context?.credentials.scopes ?? [];
    if (!roles.includes("ADMINISTRATOR") || !grantedScopes.includes("rw_organization_admin")) {
      return Promise.resolve({
        providerStatus: "ACCESS_LOST",
        eventType,
        providerKey,
        webhookUrl,
        metadata: {
          requiredScope: "rw_organization_admin",
          requiredRole: "ADMINISTRATOR",
        },
        lastError: {
          message: "LinkedIn notification subscription requires ADMINISTRATOR role and rw_organization_admin",
        },
        raw: {},
      });
    }
    return this.upsertOrganizationSocialActionSubscription(
      {
        developerApplicationUrn,
        memberUrn,
        organizationUrn,
        roles,
        webhookUrl,
        eventType,
      },
      context,
    ).then((result) => ({
      providerStatus: result.providerStatus,
      eventType: result.eventType,
      providerKey: {
        applicationKey: result.developerApplicationUrn,
        actorKey: result.memberUrn,
        entityKey: result.organizationUrn,
        eventType: result.eventType,
      },
      webhookUrl: result.webhookUrl,
      expiresAt: result.expiresAt,
      metadata: {
        requiredScope: "rw_organization_admin",
        requiredRole: "ADMINISTRATOR",
        liveRegistrationState: "BLOCKED_EXTERNAL",
        eventSubscriptionAccessState: "BLOCKED_EXTERNAL",
      },
      raw: result.raw,
    }));
  }

  deleteProviderEventSubscription(
    input: ProviderEventSubscriptionRequest,
    context?: ConnectorOperationContext,
  ): Promise<void> {
    const providerKey = input.providerKey ?? {};
    const developerApplicationUrn = linkedInString(providerKey, "applicationKey");
    const memberUrn = linkedInString(providerKey, "actorKey");
    const organizationUrn = linkedInString(providerKey, "entityKey");
    if (!developerApplicationUrn || !memberUrn || !organizationUrn) {
      throw new ConnectorConfigurationError(
        "linkedin",
        "LinkedIn notification subscription cleanup requires provider subscription key",
      );
    }
    return this.deleteOrganizationSocialActionSubscription(
      {
        developerApplicationUrn,
        memberUrn,
        organizationUrn,
        eventType: input.eventType ?? linkedInString(providerKey, "eventType") ?? "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
      },
      context,
    );
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
      visibility: "SCOPE_PRIVATE",
      providerDataCategory: "organization_profile",
      provenance: makeProvenance("linkedin", context),
      metadata: {
        organizationUrn: `urn:li:organization:${orgId}`,
        providerDataCategory: "organization_profile",
        providerRetentionBasis: "AUTHENTICATED_ORGANIZATION_ASSET",
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
        providerDataCategory: "organization_social_activity_authenticated_org",
        provenance: makeProvenance("linkedin", context, createdAt),
        metadata: {
          authorUrn,
          providerDataCategory: "organization_social_activity_authenticated_org",
          providerRetentionBasis: "AUTHENTICATED_ORGANIZATION_ASSET",
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
        providerDataCategory: actorUrn.startsWith("urn:li:person:")
          ? "member_social_activity"
          : "organization_social_activity_authenticated_org",
        provenance: makeProvenance("linkedin", context, occurredAt),
        metadata: {
          actorUrn,
          providerDataCategory: actorUrn.startsWith("urn:li:person:")
            ? "member_social_activity"
            : "organization_social_activity_authenticated_org",
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

    let followerCount: number | undefined;
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
      followerCount = undefined;
    }

    let engagementRate: number | undefined;
    let providerMetrics: Record<string, unknown> | undefined;

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
        if (typeof stats.engagement === "number") {
          engagementRate = stats.engagement;
        }
        providerMetrics = { linkedInShareStatistics: stats };
      }
    } catch {
      // Ignore if share stats not accessible
    }

    const metrics: AccountMetrics = {
      collectedAt: new Date().toISOString(),
      ...(typeof followerCount === "number" ? { followerCount } : {}),
      ...(typeof engagementRate === "number" ? { engagementRate } : {}),
      ...(providerMetrics ? { providerMetrics } : {}),
    };

    return metrics;
  }

  async upsertOrganizationSocialActionSubscription(
    input: LinkedInOrganizationNotificationSubscriptionInput,
    context?: ConnectorOperationContext,
  ): Promise<LinkedInOrganizationNotificationSubscriptionResult> {
    const token = context?.credentials.accessToken ?? input.accessToken;
    if (!token) throw new AuthenticationError("linkedin", "Missing access token");
    const grantedScopes = context?.credentials.scopes ?? [];
    if (!grantedScopes.includes("rw_organization_admin")) {
      throw new AuthorizationError(
        "linkedin",
        "LinkedIn Organization Social Action Notifications require rw_organization_admin",
        "NON_RETRYABLE",
      );
    }
    if (!input.roles.includes("ADMINISTRATOR")) {
      throw new AuthorizationError(
        "linkedin",
        "LinkedIn notification subscriptions require ADMINISTRATOR organization role",
        "NON_RETRYABLE",
      );
    }
    if (!input.developerApplicationUrn || !input.memberUrn || !input.organizationUrn || !input.webhookUrl) {
      throw new ConnectorConfigurationError(
        "linkedin",
        "LinkedIn notification subscription requires developer application, member, organization, and webhook URL",
      );
    }
    const eventType = input.eventType ?? "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS";
    const response = await this.client.put<Record<string, unknown>>(
      linkedInEventSubscriptionPath({
        developerApplicationUrn: input.developerApplicationUrn,
        memberUrn: input.memberUrn,
        organizationUrn: input.organizationUrn,
        eventType,
      }),
      token,
      { webhook: input.webhookUrl },
      { signal: context?.signal },
    );
    return {
      providerStatus: "ACTIVE",
      eventType,
      developerApplicationUrn: input.developerApplicationUrn,
      memberUrn: input.memberUrn,
      organizationUrn: input.organizationUrn,
      webhookUrl: input.webhookUrl,
      expiresAt: typeof response.body.expiresAt === "string" ? response.body.expiresAt : undefined,
      raw: response.body,
    };
  }

  async deleteOrganizationSocialActionSubscription(
    input: Omit<LinkedInOrganizationNotificationSubscriptionInput, "roles" | "webhookUrl">,
    context?: ConnectorOperationContext,
  ): Promise<void> {
    const token = context?.credentials.accessToken ?? input.accessToken;
    if (!token) throw new AuthenticationError("linkedin", "Missing access token");
    const eventType = input.eventType ?? "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS";
    await this.client.delete(
      linkedInEventSubscriptionPath({
        developerApplicationUrn: input.developerApplicationUrn,
        memberUrn: input.memberUrn,
        organizationUrn: input.organizationUrn,
        eventType,
      }),
      token,
      { signal: context?.signal },
    );
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

export interface LinkedInOrganizationNotificationSubscriptionInput {
  accessToken?: string | undefined;
  developerApplicationUrn: string;
  memberUrn: string;
  organizationUrn: string;
  roles: string[];
  webhookUrl: string;
  eventType?: string | undefined;
}

export interface LinkedInOrganizationNotificationSubscriptionResult {
  providerStatus: "ACTIVE";
  eventType: string;
  developerApplicationUrn: string;
  memberUrn: string;
  organizationUrn: string;
  webhookUrl: string;
  expiresAt?: string | undefined;
  raw: Record<string, unknown>;
}

function linkedInEventSubscriptionPath(input: {
  developerApplicationUrn: string;
  memberUrn: string;
  organizationUrn: string;
  eventType: string;
}): string {
  return `/eventSubscriptions/(developerApplication:${encodeURIComponent(input.developerApplicationUrn)},user:${encodeURIComponent(input.memberUrn)},entity:${encodeURIComponent(input.organizationUrn)},eventType:${input.eventType})`;
}

function linkedInString(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function linkedInDeveloperApplicationUrn(access: Record<string, unknown>): string | null {
  const urn = linkedInString(access, "developerApplicationUrn");
  if (urn) return urn;
  const id = linkedInString(access, "developerApplicationId");
  return id ? `urn:li:developerApplication:${id}` : null;
}

function isNonFatalLinkedInProfileDecorationError(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (
    code === "AUTHENTICATION" ||
    code === "AUTHORIZATION" ||
    code === "RATE_LIMIT" ||
    code === "TEMPORARY_PROVIDER_FAILURE" ||
    code === "MALFORMED_PROVIDER_RESPONSE"
  ) {
    return false;
  }
  return err instanceof Error && /not found|field|projection|decoration/i.test(err.message);
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
