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
  markSocialIngestionFailed,
  persistSocialSyncPage,
} from "./social/persistence.js";
export type { PersistedSocialPage, SocialSyncPage } from "./social/persistence.js";
