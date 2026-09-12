export { getDb, getPool, checkDatabaseHealth, closeDatabase, schema } from "./client.js";
export { runMigrations } from "./migrate.js";
export {
  seedRbac,
  assignRole,
  getRolesForUser,
  getPermissionsForUser,
  userHasPermission,
} from "./seed-rbac.js";
export {
  authorizeConnection,
  authorizeScope,
  ensureOrganizationScope,
  ensurePersonalScope,
} from "./social/scope.js";
export type { DataScopeType, OrganizationCapability, ScopeContext } from "./social/scope.js";
export { deactivatePersonalSocialAccessForAccountDeletion } from "./social/account-deletion.js";
export type { AccountDeletionSocialCleanupResult } from "./social/account-deletion.js";
export {
  assertConnectionTransition,
  normalizeLegacyConnectionState,
  SOCIAL_CONNECTION_STATES,
} from "./social/connection-state.js";
export type { SocialConnectionState } from "./social/connection-state.js";
export {
  beginSocialIngestionRun,
  completeSocialIngestionRun,
  markSocialIngestionFailed,
  persistSocialSyncPage,
} from "./social/persistence.js";
export type { PersistedSocialPage, SocialSyncPage } from "./social/persistence.js";
export {
  acquireSocialSyncLease,
  claimDueSocialSyncSchedules,
  claimPendingOutboxEntries,
  createDeadLetter,
  createProviderSubscriptionCleanupRequest,
  createProviderSubscriptionCleanupRequestTx,
  createSocialConnectionSyncRequest,
  createSocialWebhookProcessRequest,
  enableSocialSyncSchedule,
  EXECUTABLE_SOCIAL_CONNECTION_STATES,
  getAuthorizedSocialSyncJobStatus,
  loadConnectionForSync,
  loadSocialSyncJob,
  markOutboxDispatched,
  markOutboxFailed,
  markScheduleDispatched,
  reconcileWorkerState,
  releaseSocialSyncLease,
  renewSocialSyncLease,
  safeJobError,
  touchWorkerHeartbeat,
  transitionSocialSyncJob,
} from "./social/jobs.js";
export type {
  ClaimedOutboxEntry,
  DurableSocialSyncRequest,
  SocialConnectionForSync,
  SocialSyncJobRecord,
  SocialSyncJobStatusView,
} from "./social/jobs.js";
export {
  loadProviderRetentionPolicies,
  purgeExpiredProviderData,
  MissingApprovedUseCaseRetentionPolicyError,
} from "./social/retention.js";
export type {
  ProviderRetentionPolicy,
  PurgeRetentionOptions,
  PurgeRetentionResult,
  LoadRetentionPoliciesOptions,
} from "./social/retention.js";
export {
  calculateProviderDataDeletionDeadline,
  createProviderDataDeletionRequest,
  executeProviderDataDeletion,
  MissingProviderDeletionDeadlinePolicyError,
} from "./social/deletion-requests.js";
export type {
  CreateProviderDataDeletionInput,
  CreateProviderDataDeletionResult,
  ExecuteProviderDataDeletionOptions,
  ProviderDataDeletionExecutionResult,
  ProviderDataDeletionRequestRecord,
} from "./social/deletion-requests.js";
export {
  createProviderAuthorizationCleanupRequest,
  createProviderAuthorizationCleanupRequestTx,
  markAuthorizationCleanupCompleted,
  markAuthorizationCleanupTerminal,
} from "./social/authorization-cleanup.js";
export type {
  CreateProviderAuthorizationCleanupInput,
  DurableProviderAuthorizationCleanupRequest,
} from "./social/authorization-cleanup.js";
export {
  claimReconciliationCandidates,
  advanceReconciliationCheckpoint,
  recordReconciliationFailure,
  applyDeletedContentReconciliation,
  applyDeletedInteractionReconciliation,
  applyDeletedAccountAuthorScrubbing,
} from "./social/reconciliation.js";
export type {
  ReconciliationCandidate,
  ClaimReconciliationCandidatesInput,
  ClaimReconciliationCandidatesResult,
} from "./social/reconciliation.js";
export { createAiModelRegistryRefreshRequest } from "./ai/model-registry-jobs.js";
export type {
  CreateAiModelRegistryRefreshInput,
  DurableAiModelRegistryRefreshRequest,
} from "./ai/model-registry-jobs.js";
export {
  invalidateIntelligenceForPeople,
  persistDiscoveryPolicy,
  persistRelationshipIntelligencePolicy,
  recomputeDiscoverySnapshot,
  recomputeRelationshipIntelligence,
} from "./intelligence/discovery-relationship.js";
export type {
  DiscoveryPolicy,
  DiscoverySnapshot,
  PersistDiscoveryPolicyInput,
  PersistRelationshipIntelligencePolicyInput,
  RecomputeDiscoveryInput,
  RecomputeRelationshipInput,
  RelationshipIntelligencePolicy,
  RelationshipSnapshot,
} from "./intelligence/discovery-relationship.js";
export {
  linkIdentityCandidate,
  persistIdentityResolutionPolicy,
  persistSocialDnaPolicy,
  recomputeSocialDnaForPerson,
  rejectIdentityCandidate,
  resolveIdentityCandidate,
  splitIdentityCandidate,
} from "./intelligence/social-intelligence.js";
export type {
  ManualIdentityDecisionInput,
  PersistIdentityResolutionPolicyInput,
  PersistSocialDnaPolicyInput,
  RecomputeSocialDnaInput,
  ResolveIdentityCandidateInput,
} from "./intelligence/social-intelligence.js";
