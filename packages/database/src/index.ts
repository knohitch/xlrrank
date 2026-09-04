export { getDb, getPool, checkDatabaseHealth, closeDatabase, schema } from "./client.js";
export {
  seedRbac,
  assignRole,
  getRolesForUser,
  getPermissionsForUser,
  userHasPermission,
} from "./seed-rbac.js";
