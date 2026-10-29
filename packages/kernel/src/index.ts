export { SetupService } from "./admin/setup.service.js";
export {
  closeKernelApp,
  createKernelApp,
  type KernelAppOptions,
  startKernelApp,
} from "./app.js";
export { type CatalogCli, openCatalogCli } from "./catalog/cli.js";
// The git reader marketplaces use; core's check:bootstrap reads the official marketplace with it.
export {
  GitSourceError,
  type ReadGitTreeOptions,
  readGitTree,
} from "./catalog/git-source.js";
export type { PluginConfirmResult, PluginReview } from "./catalog/plugin-import.js";
export {
  LEGACY_FORMAT_MESSAGE,
  type PluginPackage,
  PluginPackageError,
  type ReadPluginPackageOptions,
  readPluginPackage,
} from "./catalog/plugin-package.js";
export { gatewayReplicasKey } from "./channels/supervisor.js";
export { envName, renderConfigDocs } from "./config/docs.js";
export { envOverrides } from "./config/env.js";
export { type ConfigField, changedPaths, configFields, secretValues } from "./config/fields.js";
export { fileSource } from "./config/file-source.js";
export {
  ConfigError,
  type ConfigSource,
  loadConfig,
  loadConfigWithSources,
  resolveConfig,
  selectConfigSource,
} from "./config/load.js";
export { createNacosSource, type NacosSourceOptions } from "./config/nacos-source.js";
export {
  type FieldMeta,
  type KernelConfig,
  KernelConfigSchema,
  MARKETPLACE_OFFICIAL_URL_DEFAULT,
  meta,
  PACKAGES_MAX_BYTES_DEFAULT,
} from "./config/schema.js";
export {
  type ConfigSourceKind,
  configSourceKind,
  extensionConfigSources,
} from "./config/sources.js";
export type { ConversationEvent } from "./conversations/events.js";
export { type BusSubscriber, createBus, createBusSubscriber } from "./ctx/bus.js";
export {
  createExtensionContext,
  type KernelDeps,
  pluginSchemaName,
  type Route,
} from "./ctx/create-ctx.js";
export { createKv } from "./ctx/kv.js";
export { createLock } from "./ctx/lock.js";
export { createQueue } from "./ctx/queue.js";
export {
  createKeyring,
  createSecrets,
  type DerivedKeys,
  type Keyring,
  rewrapDataKeys,
} from "./ctx/secrets.js";
export { type KernelDatabase, type KernelSchemaDb, kernelDb } from "./db/kernel-schema.js";
export { type MigrationOwner, migrate } from "./db/migrator.js";
export { createDb } from "./db/pool.js";
export {
  destructiveStatements,
  isDestructiveBody,
  isDestructiveSql,
  type SqlStatement,
  splitSqlStatements,
} from "./db/sql-statements.js";
export { ApiError, ERROR_CODES, type ErrorCode } from "./errors.js";
export { ExtensionAdminOps } from "./extensions/admin-ops.js";
export { ExtensionAdmin, PLUGINS_CHANGED_TOPIC } from "./extensions/admin-view.js";
export {
  type ApprovalDecision,
  ExtensionApprovals,
  type PendingExtension,
  type PermissionSnapshot,
  planApprovals,
  snapshotCovers,
  withPreApproved,
} from "./extensions/approvals.js";
export {
  blobKey,
  ExtensionBlobIntegrityError,
  type ExtensionBlobSource,
  ExtensionBlobs,
} from "./extensions/blobs.js";
export {
  BOOTSTRAP_MANIFEST_FILE,
  type BootstrapEntryResult,
  BootstrapFailedError,
  type BootstrapFailure,
  type BootstrapResolveOptions,
  type BootstrapResult,
  BootstrapService,
  bootstrapManifestSha256,
  readBootstrapManifest,
  resolveBootstrapPackages,
} from "./extensions/bootstrap.js";
export { type ExtensionCli, openExtensionCli } from "./extensions/cli.js";
export {
  DEPLOYMENT_SECRETS_ORG,
  type DeploymentConfigField,
  type DeploymentConfigView,
  ExtensionDeploymentConfigService,
  mergeDeploymentConfig,
  PLUGIN_DEPLOYMENT_CONFIG_TOPIC,
  readStoredDeploymentConfig,
} from "./extensions/deployment-config.js";
export {
  assertSecretsReachable,
  ExtensionHost,
  type ExtensionLoadPlan,
  type InspectedExtension,
  type InstalledExtensionLoader,
  type InstallFailureReason,
} from "./extensions/host.js";
export {
  ExtensionUnloadedError,
  type InflightEntry,
  InflightTracker,
  PLUGIN_UNLOADED_TOOL_ERROR,
  type TrackOptions,
  trackCalls,
} from "./extensions/inflight.js";
export {
  type DesiredExtension,
  type ExtensionInstallRow,
  ExtensionInstalls,
  type IngestSource,
  type PackageReview,
} from "./extensions/installs.js";
export {
  DEFAULT_DISPOSE_TIMEOUT_MS,
  type DisposeOptions,
  ExtensionInstance,
  ImportTracker,
  type LoadDeps,
  loadInstance,
  ManifestMismatchError,
  type Registration,
  type RegistrationKind,
  UPGRADE_WARN_THRESHOLD,
} from "./extensions/instance.js";
export {
  ExtensionLifecycle,
  PLUGINS_RECONCILE_JOB,
  PLUGINS_RECONCILE_TOPIC,
} from "./extensions/lifecycle.js";
export {
  ensureMigrated,
  MIGRATE_LOCK_PREFIX,
  type MigrateLockDeps,
  PLUGINS_MIGRATED_TOPIC,
  unrunMigrations,
} from "./extensions/migrate-lock.js";
export {
  EXTENSION_PACKAGE_LIMITS,
  type ExtensionPackage,
  ExtensionPackageError,
  type ExtensionPackageLimits,
  type ExtensionPackageSection,
  extractExtensionPackage,
  HOST_ZOD_VERSION,
  permissionSetOfPackage,
  type ReadExtensionPackageOptions,
  readExtensionPackage,
} from "./extensions/package.js";
export {
  blockingKeys,
  computePermissionSet,
  diffPermissions,
  type PermissionSet,
  permissionKeys,
  WARNINGS_KEY_PREFIX,
} from "./extensions/permission-set.js";
export {
  type AdminExtensionView,
  type DeploymentExtensionStatus,
  isSensitivePermissionKey,
  type PermissionGroup,
  type PermissionItem,
  permissionGroups,
  permissionKeyItems,
  reviewHash,
  SENSITIVE_EXTENSION_POINTS,
  type SensitiveReason,
} from "./extensions/permission-view.js";
export { ExtensionRegistry } from "./extensions/registry.js";
export { ExtensionResolveError, resolveExtensions } from "./extensions/resolve.js";
export {
  type ExtensionLoadStatus,
  type ExtensionSource,
  newReplicaId,
  type PendingReason,
  ReplicaStatusStore,
} from "./extensions/sources.js";
export { syncPackage } from "./extensions/sync.js";
export {
  type CreateHttpAppOptions,
  createHttpApp,
  type HealthOptions,
  type KernelHttp,
  type KernelHttpApp,
} from "./http/app.js";
export { type Account, AccountsService } from "./identity/accounts.js";
export { type ApiTokenRecord, ApiTokenService } from "./identity/api-tokens.js";
export { audit } from "./identity/audit.js";
export { normalizeLogin, validatePassword } from "./identity/login.js";
export { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./identity/passwords.js";
export {
  type IssuedSession,
  REFRESH_RACE_GRACE_MS,
  SessionService,
} from "./identity/sessions.js";
export {
  DEPLOYMENT_SETTINGS,
  type DeploymentSettings,
  SettingsService,
} from "./identity/settings.js";
export { type StandaloneDatabase, standaloneDatabase } from "./infra/database/standalone.js";
export {
  GUARD_CIRCUIT_LIMIT,
  GUARD_CIRCUIT_WINDOW_MS,
  installProcessGuards,
  type ProcessGuardDeps,
} from "./infra/lifecycle/process-guards.js";
export {
  handleShutdownSignals,
  type ShutdownSignalHandle,
  type ShutdownSignalOptions,
} from "./infra/lifecycle/shutdown-signals.js";
export {
  createKernel,
  KERNEL_MIGRATIONS_DIR,
  KERNEL_SCHEMA,
  type Kernel,
  type KernelOptions,
  type KernelRuns,
  migrateAll,
} from "./kernel.js";
export { KernelLifecycle } from "./lifecycle/kernel-lifecycle.js";
export {
  createLogger,
  type KernelLogger,
  LOG_FORMATS,
  LOG_LEVELS,
  type LogFormat,
  type LoggerOptions,
  type LogLevel,
  type LogOutput,
} from "./log.js";
export { createConfiguredLogger, loggerOptionsFromConfig } from "./log-config.js";
export {
  type ContextJob,
  type JobWrapper,
  type LogContext,
  logContext,
  setJobWrapper,
  setTraceContextSource,
  withJobContext,
  withLogContext,
} from "./log-context.js";
export { type Org, OrgsService } from "./orgs/orgs.service.js";
export {
  fetchNpmPackage,
  IntegrityMismatchError,
  type NpmFetchConfig,
  NpmFetchError,
  PackageTooLargeError,
} from "./packages/npm.js";
export { UNKNOWN_RESULT_TEXT } from "./runtime/context/pairing.js";
export type { AgentLoop, LoopContext, LoopOutcome } from "./runtime/loop.js";
export { MAINTENANCE_QUEUE_NAME } from "./runtime/maintenance-queue.js";
export { runJobId } from "./runtime/run-queue.js";
export {
  SANDBOX_DESTROY_JOB,
  SANDBOX_SUSPEND_JOB,
} from "./sandbox/jobs.js";
export {
  SANDBOX_LOCK_TTL_MS,
  SandboxService,
  type SandboxUseInfo,
} from "./sandbox/sandbox.service.js";
export {
  MAX_STORAGE_KEY_BYTES,
  StorageKeyError,
} from "./storage/prefix.js";
export {
  PrefixedStorage,
  StorageService,
  type StorageSource,
} from "./storage/storage.service.js";
export {
  SANDBOX_RECREATED_NOTICE,
  SANDBOX_STARTED_NOTICE,
} from "./tools/builtins/sandbox/common.js";
