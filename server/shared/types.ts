export const DEFAULT_TURN_TIMEOUT_SECONDS = 1800;
export const DEFAULT_STALL_TIMEOUT_SECONDS = 300;
export const DEFAULT_VERIFY_TIMEOUT_SECONDS = 300;
export const MAX_TURN_TIMEOUT_SECONDS = 7200;
export const MAX_STALL_TIMEOUT_SECONDS = 3600;
export const MAX_VERIFY_TIMEOUT_SECONDS = 1800;

export type WorkerStatus = 'queued' | 'blocked' | 'working' | 'waiting' | 'failed' | 'killed';

export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type WorkspaceMode = 'inherit' | 'worktree';

export type ScopeMode = 'enforce' | 'warn';

export interface ModelCapabilities {
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsFastMode?: boolean;
  defaultFastMode?: boolean;
}

export interface ProviderEntryConfig {
  enabled?: boolean;
  displayName?: string;
  command?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
  defaultFastMode?: boolean;
  models?: string[];
  profile?: string;
  modelProvider?: string;
  args?: string[];
  resumeArgs?: string[];
  listModelsArgs?: string[];
  promptMode?: 'stdin' | 'arg';
  outputFormat?: 'text' | 'ndjson';
  env?: Record<string, string>;
}

export interface CustomProviderConfig extends ProviderEntryConfig {
  command: string;
}

export type DisplayCurrency = 'AUTO' | 'USD' | 'CNY';

export const DEFAULT_USD_TO_CNY_RATE = 7.2;

export interface ModelPricing {
  inputPer1M: number;
  cacheReadPer1M?: number;
  outputPer1M: number;
  currency?: 'USD' | 'CNY';
}

export interface PricingCatalogMeta {
  source: 'litellm' | 'openrouter';
  fetchedAt: string;
  modelCount: number;
}

export interface VerifyCommandResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  outputTail: string;
  ranAt: string;
}

export interface WorktreePatchResult {
  branch: string;
  baseRef: string;
  stat: string;
  patch: string;
  truncated: boolean;
  untrackedFiles: string[];
}

export interface ProviderTestResult {
  providerId: string;
  command: string;
  resolvedPath?: string;
  ok: boolean;
  version?: string;
  latencyMs: number;
  details: string;
  warnings?: string[];
}

export type TaskRoutingCategory =
  | 'complex'
  | 'coding'
  | 'frontend'
  | 'review'
  | 'research'
  | 'batch';

export type OrchestratorDelegationMode = 'balanced' | 'prefer-external' | 'manual-only';

export interface TaskModelTarget {
  provider: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export type TaskRoutingMap = Partial<Record<TaskRoutingCategory, TaskModelTarget[]>>;

export interface ProviderRoutingPolicy {
  writerProviders?: string[];
  readerProviders?: string[];
  autoFailover?: boolean;
  delegationMode?: OrchestratorDelegationMode;
  taskRouting?: TaskRoutingMap;
  routingNotes?: string;
}

export interface ProvidersFileConfig {
  defaultProvider?: string;
  activePool?: string[];
  routingPolicy?: ProviderRoutingPolicy;
  defaultTurnTimeoutSeconds?: number;
  defaultStallTimeoutSeconds?: number;
  providers?: Record<string, ProviderEntryConfig>;
  pricing?: Record<string, ModelPricing>;
  displayCurrency?: DisplayCurrency;
  usdToCnyRate?: number;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  kind: 'builtin' | 'custom';
  enabled: boolean;
  command: string;
  available: boolean;
  resolvedPath?: string;
  supportsSessionResume: boolean;
  supportsStreamEvents: boolean;
  supportsReasoningEffort?: boolean;
  reasoningEffortOptions?: string[];
  supportsFastMode?: boolean;
  defaultModel?: string;
  configuredDefaultModel?: string;
  detectedDefaultModel?: string;
  defaultReasoningEffort?: string;
  configuredDefaultReasoningEffort?: string;
  detectedDefaultReasoningEffort?: string;
  defaultFastMode?: boolean;
  configuredDefaultFastMode?: boolean;
  detectedDefaultFastMode?: boolean;
  detectedModelProvider?: string;
  detectedModelProviders?: string[];
  models: string[];
  configuredModels: string[];
  detectedModels?: string[];
  detectedModelsSource?: string;
  modelCapabilities?: Record<string, ModelCapabilities>;
  profile?: string;
  configuredProfile?: string;
  modelProvider?: string;
  hasOverride: boolean;
  args?: string[];
  resumeArgs?: string[];
  listModelsArgs?: string[];
  promptMode?: 'stdin' | 'arg';
  outputFormat?: 'text' | 'ndjson';
  env?: Record<string, string>;
  notes?: string;
  warnings?: string[];
}

export interface ProvidersConfigSnapshot {
  globalConfigPath: string;
  globalConfigExists: boolean;
  repoConfigPath?: string;
  repoConfigExists: boolean;
  configuredDefaultProvider?: string;
  effectiveDefaultProvider: string;
  activePool?: string[];
  routingPolicy?: ProviderRoutingPolicy;
  defaultTurnTimeoutSeconds?: number;
  defaultStallTimeoutSeconds?: number;
  providers: ProviderDescriptor[];
  cooldowns?: Record<string, ProviderCooldownEntry>;
  pricing?: Record<string, ModelPricing>;
  displayCurrency?: DisplayCurrency;
  usdToCnyRate?: number;
  pricingCatalog?: Record<string, ModelPricing>;
  pricingCatalogMeta?: PricingCatalogMeta;
}

export interface ProviderCooldownEntry {
  providerId: string;
  until: string;
  reason: string;
  triggeredAt: string;
}

export interface WorktreeHooksConfig {
  copyFiles?: string[];
  symlinkDirs?: string[];
  setupCommand?: string;
  teardownCommand?: string;
  portOffsetBase?: number;
  portOffsetStep?: number;
}

export interface CreatePrResult {
  created: boolean;
  workerName: string;
  branch: string;
  baseBranch: string;
  prUrl?: string;
  message: string;
}

export interface UiPrefs {
  locale?: 'zh' | 'en';
  onboardingCompleted?: boolean;
  observedConversationId?: string;
}

export type BoardMessageKind =
  | 'brief'
  | 'message'
  | 'done'
  | 'blocker'
  | 'error'
  | 'warning'
  | 'system';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reportedCostUsd?: number;
}

export interface UsageBreakdown {
  inputTokens: number;
  cacheReadTokens: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  calls: number;
}

export type NativeSubagentStatus = 'working' | 'waiting' | 'failed' | 'killed';

export interface HostConversationEntry {
  id: string;
  title: string;
  updatedAt: string;
  subagentCount: number;
  activeSubagentCount: number;
}

export interface HostUsageBucket {
  sessionTotal: UsageBreakdown;
  sinceSwarmStart: UsageBreakdown;
  byModelSession: Record<string, UsageBreakdown>;
  byModelSinceSwarm: Record<string, UsageBreakdown>;
}

export interface NativeSubagentState {
  id: string;
  shortId: string;
  parentConversationId: string;
  role: string;
  typeName: string;
  status: NativeSubagentStatus;
  statusSource: 'api' | 'transcript';
  rawState?: string;
  model: string;
  models: string[];
  spawnStepIndex: number;
  inCurrentSwarm: boolean;
  turns: number;
  steps: number;
  usage: TokenUsage;
  usageSinceSwarm: TokenUsage;
  activity?: string;
  lastTool?: string;
  lastError?: string;
  lastReplyPreview?: string;
  messagesToParent: number;
  messagesFromParent: number;
  workspaceUris?: string[];
  createdAt: string;
  updatedAt: string;
  lastTurnStartedAt?: string;
  lastTurnFinishedAt?: string;
}

export interface HostSubagentUsageSummary extends HostUsageBucket {
  totalCount: number;
  currentSwarmCount: number;
  runningCount: number;
}

export interface HostTelemetrySnapshot {
  conversationId: string | null;
  conversationTitle?: string;
  transcriptPath?: string;
  coordinator: HostUsageBucket;
  subagents: NativeSubagentState[];
  subagentUsage: HostSubagentUsageSummary;
  availableConversations: HostConversationEntry[];
}

export interface BoardMessage {
  seq: number;
  agent: string;
  text: string;
  kind: BoardMessageKind;
  time: string;
  mentions: string[];
  all: boolean;
  mentionsCoordinator: boolean;
  reportPath?: string;
}

export interface WorktreeDiffSummary {
  branch: string;
  baseRef: string;
  changedFiles: string[];
  dirtyFiles: string[];
  commitCount: number;
  stat: string;
  outOfScopeFiles: string[];
}

export interface MemberState {
  name: string;
  role: string;
  status: WorkerStatus;
  model: string;
  resolvedModel?: string;
  provider: string;
  modelProvider?: string;
  reasoningEffort?: string;
  resolvedReasoningEffort?: string;
  fastMode?: boolean;
  resolvedFastMode?: boolean;
  customConfig?: CustomProviderConfig;
  permissionMode: PermissionMode;
  workspaceMode: WorkspaceMode;
  cwd: string;
  branch?: string;
  baseRef?: string;
  sessionId?: string;
  turns: number;
  steps: number;
  usage: TokenUsage;
  activity?: string;
  lastError?: string;
  lastReadSeq: number;
  pendingWake: boolean;
  allowedFiles?: string[];
  scopeMode?: ScopeMode;
  verifyCommands?: string[];
  autoVerify?: boolean;
  verifyTimeoutSeconds?: number;
  maxVerifyRetries?: number;
  verifyRetriesUsed?: number;
  lastVerifyResults?: VerifyCommandResult[];
  outOfScopeFiles?: string[];
  dependsOn?: string[];
  pendingBrief?: string;
  arenaGroup?: string;
  turnTimeoutSeconds?: number;
  workerIndex?: number;
  portOffset?: number;
  failedProviders?: string[];
  retryTurns: number;
  createdAt: string;
  updatedAt: string;
  lastTurnStartedAt?: string;
  lastTurnFinishedAt?: string;
}

export interface MergePreviewResult {
  workerName: string;
  branch: string;
  targetBranch: string;
  mergeBase: string;
  aheadCommits: number;
  changedFiles: string[];
  dirtyFiles: string[];
  canCleanMerge: boolean;
  conflictFiles: string[];
  conflictDetails: string[];
  stat: string;
}

export interface MergeApplyResult {
  merged: boolean;
  mode: 'squash' | 'cherry-pick' | 'merge';
  workerName: string;
  branch: string;
  targetBranch: string;
  commitSha?: string;
  conflictFiles?: string[];
  message: string;
  worktreeRemoved?: boolean;
}

export interface TemplateWorkerSpec {
  name: string;
  role: string;
  brief: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  workspace?: WorkspaceMode;
  permission?: PermissionMode;
  dependsOn?: string[];
  allowedFiles?: string[];
  scopeMode?: ScopeMode;
  verifyCommands?: string[];
  autoVerify?: boolean;
  verifyTimeoutSeconds?: number;
  maxVerifyRetries?: number;
  turnTimeoutSeconds?: number;
}

export interface SwarmTemplate {
  id: string;
  name: string;
  description: string;
  kind: 'builtin' | 'custom';
  defaultTitle?: string;
  workers: TemplateWorkerSpec[];
}

export interface TemplatesConfigSnapshot {
  globalPath: string;
  repoPath?: string;
  templates: SwarmTemplate[];
}

export interface SwarmState {
  id: string;
  title: string;
  repoRoot: string;
  gitRepoRoot?: string;
  gitCommonDir?: string;
  coordinatorConversationId?: string;
  defaultProvider: string;
  activeProviders?: string[];
  routingPolicy?: ProviderRoutingPolicy;
  rrCursor?: number;
  profile: string;
  maxConcurrency: number;
  maxHops: number;
  turnTimeoutSeconds: number;
  stallTimeoutSeconds: number;
  maxCostUsd?: number;
  budgetPaused?: boolean;
  budgetPausedReason?: string;
  budgetBypassed?: boolean;
  hopCount: number;
  headSeq: number;
  createdAt: string;
  updatedAt: string;
  members: Record<string, MemberState>;
}

export interface SwarmIndexEntry {
  id: string;
  title: string;
  repoRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmIndex {
  latestSwarmId?: string;
  swarms: SwarmIndexEntry[];
}

export interface ModelInfo {
  id: string;
  name: string;
  provider?: string;
  contextWindow?: number;
  maxTokens?: number;
  creditMultiplier?: number;
  description?: string;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface DshProfileProviderCheck {
  ok: boolean;
  profile: string;
  modelProvider?: string;
  reason?: 'missing-plugin' | 'plugin-disabled' | 'missing-pi-ai-provider';
  pluginPackage?: string;
  sourceProfile?: string;
  installCommand?: string;
  warning?: string;
}

export interface ModelsCatalogResult {
  profile: string;
  configPath: string;
  exists: boolean;
  defaultProvider: string;
  defaultModel: string;
  defaultReasoningEffort?: string;
  providers?: string[];
  models: ModelInfo[];
  catalogSourceProfile?: string;
  providerPlugins?: Record<string, string>;
  piAiProviders?: string[];
  disabledPlugins?: string[];
  note?: string;
}

export interface DiscoverModelsResult {
  providerId: string;
  ok: boolean;
  models: string[];
  defaultModel?: string;
  modelCapabilities?: Record<string, ModelCapabilities>;
  source?: string;
  latencyMs: number;
  error?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  count: number;
  viaAll: boolean;
}

export interface SwarmSnapshot {
  swarm: SwarmState;
  messages: BoardMessage[];
  edges: GraphEdge[];
  swarms: SwarmIndexEntry[];
  diffs?: Record<string, WorktreeDiffSummary | null>;
  hostTelemetry?: HostTelemetrySnapshot;
  providers?: ProviderDescriptor[];
  providerConfig?: ProvidersConfigSnapshot;
  templatesConfig?: TemplatesConfigSnapshot;
  uiPrefs?: UiPrefs;
}
