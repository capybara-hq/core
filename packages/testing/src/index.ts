/**
 * Kernel names an extension's kernel-level tests need, re-exported so they import only this
 * package and the SDK: the database helpers and types, and model-visible texts, queue names and
 * keys the kernel owns (assert on them instead of copying their values).
 */
export {
  type ConversationEvent,
  createDb,
  gatewayReplicasKey,
  type Kernel,
  type KernelConfig,
  type KernelDb,
  kernelDb,
  MAINTENANCE_QUEUE_NAME,
  runJobId,
  SANDBOX_LOCK_TTL_MS,
  SANDBOX_RECREATED_NOTICE,
  SANDBOX_STARTED_NOTICE,
  SANDBOX_SUSPEND_JOB,
  UNKNOWN_RESULT_TEXT,
} from "@capybara-hq/kernel";
export {
  createFreshDatabase,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  TEST_S3_IMAGE,
  type TestContainer,
  type TestS3,
} from "./containers.js";
export {
  createDualReplicaHarness,
  type DualReplicaOptions,
  type ExtraReplicaHandle,
  type Harness,
  REPLICA_HEADER,
  type ReplicaHandle,
  type ReplicaResponse,
  replicaOf,
} from "./dual-replica.js";
export {
  assertExtensionSecretsReachable,
  extensionDeploymentSecretValues,
} from "./extension-config.js";
export {
  FAKE_CHANNEL_BAD_SECRET,
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  type FakeChannelPost,
  type FakeChannelSent,
  type FakeChannelServer,
  type FakeChannelServerOptions,
  type FakeChannelStream,
  type FakeChannelUser,
  type FakeDirectoryBook,
  type FakeSenderProfile,
  fakeCardAction,
  fakeDirectoryMember,
  fakeDm,
  fakeGroupMessage,
  fakeWebhookChallenge,
  fakeWebhookEvents,
  signFakeWebhook,
  startFakeChannelServer,
} from "./fake-channel.js";
export {
  type FakeE2BCall,
  type FakeE2BMatch,
  type FakeE2BOptions,
  type FakeE2BSandbox,
  type FakeE2BServer,
  startFakeE2B,
} from "./fake-e2b.js";
export {
  type FakeGitCommitOptions,
  type FakeGitRequest,
  type FakeGitServer,
  startFakeGitServer,
} from "./fake-git-server.js";
export {
  encryptLarkWebhook,
  type FakeLarkAck,
  type FakeLarkApi,
  type FakeLarkButton,
  type FakeLarkCall,
  type FakeLarkDepartment,
  type FakeLarkFailure,
  type FakeLarkMessage,
  type FakeLarkOptions,
  type FakeLarkServer,
  type FakeLarkUser,
  findLarkButton,
  larkCardAction,
  larkMessageEvent,
  signLarkWebhook,
  startFakeLark,
} from "./fake-lark.js";
export {
  type FakeMarketplace,
  type FakeMarketplaceRequest,
  startFakeMarketplace,
} from "./fake-marketplace.js";
export {
  type FakeMcpCallInfo,
  type FakeMcpHandlerContext,
  type FakeMcpPrompt,
  type FakeMcpRequest,
  type FakeMcpResource,
  FakeMcpRpcError,
  type FakeMcpServer,
  type FakeMcpServerOptions,
  type FakeMcpTool,
  startFakeMcpServer,
} from "./fake-mcp-server.js";
export {
  type FakeModelServer,
  type FakeRequest,
  type FakeResponse,
  startFakeModelServer,
} from "./fake-model-server.js";
export {
  type FakeNpmPackage,
  type FakeNpmRegistry,
  npmProvenanceAttestations,
  startFakeNpmRegistry,
} from "./fake-npm-registry.js";
export {
  type FakeOAuthClient,
  type FakeOAuthServer,
  type FakeOAuthServerOptions,
  type FakeTokenRequest,
  startFakeOAuthServer,
} from "./fake-oauth-server.js";
export {
  defaultFakeOpenApiSpec,
  type FakeOpenApiRequest,
  type FakeOpenApiServer,
  type FakeOpenApiServerOptions,
  type FakePet,
  startFakeOpenApiServer,
} from "./fake-openapi-server.js";
export {
  type FakeSlackAck,
  type FakeSlackCall,
  type FakeSlackFailure,
  type FakeSlackMessage,
  type FakeSlackOptions,
  type FakeSlackServer,
  type FakeSlackUser,
  findSlackButton,
  signSlackWebhook,
  slackBlockAction,
  slackDmEvent,
  slackEventCallback,
  slackInteractiveForm,
  slackMentionEvent,
  startFakeSlack,
} from "./fake-slack.js";
export {
  FAKE_EXTENSIONS,
  type FakeExtensionName,
  fakeExtensionDir,
  fakeExtensionEntry,
  type PackedFixture,
  packFixture,
} from "./fixtures.js";
export {
  cardRecorded,
  cookieRequest,
  createAgent,
  createConversation,
  createLocalAccount,
  createOrg,
  eventsOf,
  joinOrg,
  type KernelRequest,
  type KernelRequestOptions,
  type KernelResponse,
  login,
  pidOwningLocalPort,
  postMessage,
  sleep,
  startTestKernel,
  TEST_PASSWORD,
  testKernelConfig,
  truncateTables,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "./kernel-helpers.js";
export {
  isPngBase64,
  pdfBase64,
  pdfSampleWord,
  redPngBase64,
  solidPngBase64,
} from "./media-samples.js";
export {
  type ConformanceTarget,
  checkDeclaredParameters,
  describeModelProviderConformance,
  MEDIA_SAMPLES,
  thinkingReplayParams,
} from "./model-conformance.js";
export { openSse, type SseClient, type SseMessage } from "./sse.js";
