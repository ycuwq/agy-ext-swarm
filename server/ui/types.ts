import type { Locale } from './i18n.js';

export type WorkerStatus = 'queued' | 'blocked' | 'working' | 'waiting' | 'failed' | 'killed';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
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

export interface CoordinatorConversationEntry {
  id: string;
  title: string;
  updatedAt: string;
}

export interface CoordinatorUsageSummary {
  conversationId: string | null;
  conversationTitle?: string;
  transcriptPath?: string;
  sessionTotal: UsageBreakdown;
  sinceSwarmStart: UsageBreakdown;
  byModelSession: Record<string, UsageBreakdown>;
  byModelSinceSwarm: Record<string, UsageBreakdown>;
}

export interface UiPrefs {
  locale?: Locale;
}

export interface ModelPricing {
  inputPer1M: number;
  cacheReadPer1M?: number;
  outputPer1M: number;
  currency?: 'USD' | 'CNY';
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
  workspace?: 'inherit' | 'worktree';
  permission?: 'read-only' | 'workspace-write' | 'danger-full-access';
  dependsOn?: string[];
  allowedFiles?: string[];
  verifyCommands?: string[];
  autoVerify?: boolean;
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
  defaultModel?: string;
  configuredDefaultModel?: string;
  detectedDefaultModel?: string;
  detectedModelProvider?: string;
  models: string[];
  configuredModels: string[];
  detectedModels?: string[];
  profile?: string;
  modelProvider?: string;
  hasOverride: boolean;
  args?: string[];
  resumeArgs?: string[];
  promptMode?: 'stdin' | 'arg';
  outputFormat?: 'text' | 'ndjson';
  env?: Record<string, string>;
  notes?: string;
}

export interface ProviderRoutingPolicy {
  writerProviders?: string[];
  readerProviders?: string[];
  autoFailover?: boolean;
}

export interface ProvidersConfigSnapshot {
  globalConfigPath: string;
  repoConfigPath?: string;
  repoConfigExists: boolean;
  configuredDefaultProvider?: string;
  effectiveDefaultProvider: string;
  activePool?: string[];
  routingPolicy?: ProviderRoutingPolicy;
  providers: ProviderDescriptor[];
  pricing?: Record<string, ModelPricing>;
}

export interface MemberState {
  name: string;
  role: string;
  status: WorkerStatus;
  model: string;
  provider: string;
  permissionMode: string;
  workspaceMode: string;
  cwd: string;
  branch?: string;
  sessionId?: string;
  turns: number;
  steps: number;
  usage: TokenUsage;
  activity?: string;
  lastError?: string;
  outOfScopeFiles?: string[];
  autoVerify?: boolean;
  lastVerifyResults?: VerifyCommandResult[];
  dependsOn?: string[];
  arenaGroup?: string;
  failedProviders?: string[];
  lastTurnFinishedAt?: string;
}

export interface BoardMessage {
  seq: number;
  agent: string;
  text: string;
  kind: string;
  time: string;
  mentions: string[];
  all: boolean;
  mentionsCoordinator?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  count: number;
  viaAll: boolean;
}

export interface WorktreeDiffSummary {
  branch: string;
  changedFiles: string[];
  dirtyFiles: string[];
  commitCount: number;
  stat: string;
  outOfScopeFiles: string[];
}

export interface SwarmState {
  id: string;
  title: string;
  repoRoot: string;
  coordinatorConversationId?: string;
  defaultProvider?: string;
  activeProviders?: string[];
  routingPolicy?: ProviderRoutingPolicy;
  profile: string;
  maxConcurrency: number;
  maxHops: number;
  hopCount: number;
  headSeq: number;
  members: Record<string, MemberState>;
}

export interface SwarmIndexEntry {
  id: string;
  title: string;
}

export interface Snapshot {
  swarm: SwarmState | null;
  messages: BoardMessage[];
  edges: GraphEdge[];
  swarms: SwarmIndexEntry[];
  diffs?: Record<string, WorktreeDiffSummary | null>;
  coordinatorUsage?: CoordinatorUsageSummary;
  availableConversations?: CoordinatorConversationEntry[];
  providers?: ProviderDescriptor[];
  providerConfig?: ProvidersConfigSnapshot;
  templatesConfig?: TemplatesConfigSnapshot;
  uiPrefs?: UiPrefs;
}
