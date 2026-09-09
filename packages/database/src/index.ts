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
} from "./social/retention.js";
export type {
  ProviderRetentionPolicy,
  PurgeRetentionOptions,
  PurgeRetentionResult,
} from "./social/retention.js";
