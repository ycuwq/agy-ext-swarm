/**
 * Shared mutable UI state for the AGY Ext Swarm board.
 *
 * These bindings used to be module-scope `let` declarations inside `app.ts`.
 * They now live on one exported `state` object so the extracted view modules
 * can read *and* update them without importing the entrypoint, keeping the
 * module graph acyclic.
 */
import type {
  CreatePrResult,
  MergePreviewResult,
  OrchestratorDelegationMode,
  ProviderTestResult,
  ProvidersConfigSnapshot,
  Snapshot,
  TaskModelTarget,
  TaskRoutingCategory,
  TemplatesConfigSnapshot,
  WorktreePatchResult,
} from './types.js';
import { detectDefaultLocale, type Locale } from './i18n.js';

export type DataTab = 'board' | 'graph' | 'workers' | 'usage';
export type TabName = DataTab | 'settings';
export type WorkerStatusFilter = 'all' | 'attention' | 'running' | 'mergeable';
export type SwitchDraft = { provider: string; model: string; prompt: string };
export type MergeDraft = {
  mode: 'squash' | 'cherry-pick' | 'merge';
  removeWt: boolean;
  commitMsg: string;
  draftPr?: boolean;
};
export type DiffInlineComment = {
  id: string;
  file: string;
  line: number;
  lineType: '+' | '-' | ' ';
  code: string;
  comment: string;
};
export type DiffCommentTarget = Omit<DiffInlineComment, 'id' | 'comment'>;

interface UiState {
  currentLocale: Locale;
  localeOverriddenByUser: boolean;
  currentSwarmId: string | undefined;
  latestSnapshot: Snapshot | null;
  lastRenderSignature: string;
  lastBoardSignature: string;
  lastCommanderConfigSignature: string;
  pollInFlight: boolean;
  activeTab: TabName;
  dirtyTabs: Set<DataTab>;
  prevSnapForUsage: Snapshot | null;
  lastDiffFetchAt: number;
  lastDiffSwarmId: string | undefined;
  workersDeferredRender: boolean;
  commanderDeferredSync: boolean;
  selectedAgentFilter: string | null;
  selectedKindFilter: 'all' | 'done' | 'alerts';
  workerStatusFilter: WorkerStatusFilter;
  usageScope: 'swarm' | 'session';
  expandedSeqs: Set<number>;
  seenSeqs: Set<number>;
  seenWorkerNames: Set<string>;
  prevGaugePcts: Map<string, number>;
  initialBoardLoaded: boolean;
  pendingKillAction: { name: string; removeWorktree: boolean } | null;
  pendingKillTimer: number | null;
  pendingKillAll: boolean;
  pendingKillAllTimer: number | null;
  globalToastTimer: number | null;
  replaySeq: number | null;
  replayPlaying: boolean;
  replayTimer: number | null;
  hoveredNode: string | null;
  activeLogWorker: string | null;
  logRawMode: boolean;
  cachedLogLines: string[];
  activeDiffWorker: string | null;
  cachedDiffData: WorktreePatchResult | null;
  diffComments: DiffInlineComment[];
  activeDiffCommentTarget: DiffCommentTarget | null;
  switchOpenWorker: string | null;
  switchDrafts: Map<string, SwitchDraft>;
  mergeOpenWorker: string | null;
  mergePreviews: Map<string, { loading: boolean; data?: MergePreviewResult; error?: string }>;
  mergeDrafts: Map<string, MergeDraft>;
  prResults: Map<string, CreatePrResult>;
  pendingDeleteSwarm: boolean;
  activeCommanderPanel: 'create' | 'add' | 'arena' | 'templates' | null;
  latestTemplatesConfig: TemplatesConfigSnapshot | null;
  arenaSlots: Array<{ provider: string; model: string }>;
  createPoolDraft: string[] | null;
  lastKnownPoolBaseline: string;
  addProvidersDraft: Set<string>;
  tplRoleOverrides: Map<string, { provider?: string; model?: string }>;
  latestProviderConfig: ProvidersConfigSnapshot | null;
  settingsExpanded: Set<string>;
  settingsDraftModels: Map<string, string[]>;
  settingsModelFilters: Map<string, string>;
  settingsTestResults: Map<string, ProviderTestResult>;
  testingProviders: Set<string>;
  discoveringProviders: Set<string>;
  pricingExpanded: boolean;
  activeSettingsSubtab: 'clis' | 'routing';
  routingDraftActive: Set<string>;
  routingDraftWriter: Set<string>;
  routingDraftReader: Set<string>;
  routingDraftDelegation: OrchestratorDelegationMode;
  routingDraftTasks: Map<TaskRoutingCategory, TaskModelTarget[]>;
  routingDraftNotes: string;
  routingDraftTurnTimeout: string;
  routingDraftStallTimeout: string;
  routingDraftSynced: boolean;
  routingDraftDirty: boolean;
  routingPoolsAutoInit: boolean;
  pendingDeleteProvider: string | null;
  onboardingForceOpen: boolean;
  onboardingDismissedThisSession: boolean;
  onboardingVisible: boolean;
  onboardingDraftInitialized: boolean;
  onboardingStep: 1 | 2 | 3;
  onboardingTestingAll: boolean;
  onboardingSaving: boolean;
  onboardingSelectedClis: Set<string>;
  onboardingDefaultModels: Map<string, string>;
  onboardingModelsRaw: Map<string, string>;
  onboardingDefaultCli: string;
  onboardingUsePool: boolean;
  onboardingFailover: boolean;
  onboardingWriterPool: Set<string>;
  onboardingReaderPool: Set<string>;
}

export const state: UiState = {
  currentLocale: detectDefaultLocale() as Locale,
  localeOverriddenByUser: false,
  currentSwarmId: undefined as string | undefined,
  latestSnapshot: null as Snapshot | null,
  lastRenderSignature: '',
  lastBoardSignature: '',
  lastCommanderConfigSignature: '',
  pollInFlight: false,
  activeTab: 'board' as DataTab | 'settings',
  dirtyTabs: new Set<DataTab>(['board', 'graph', 'workers', 'usage']),
  prevSnapForUsage: null as Snapshot | null,
  lastDiffFetchAt: 0,
  lastDiffSwarmId: undefined as string | undefined,
  workersDeferredRender: false,
  commanderDeferredSync: false,
  selectedAgentFilter: null as string | null,
  selectedKindFilter: 'all' as 'all' | 'done' | 'alerts',
  workerStatusFilter: 'all' as WorkerStatusFilter,
  usageScope: 'swarm' as 'swarm' | 'session',
  expandedSeqs: new Set<number>(),
  seenSeqs: new Set<number>(),
  seenWorkerNames: new Set<string>(),
  prevGaugePcts: new Map<string, number>(),
  initialBoardLoaded: false,
  pendingKillAction: null as { name: string; removeWorktree: boolean } | null,
  pendingKillTimer: null as number | null,
  pendingKillAll: false,
  pendingKillAllTimer: null as number | null,
  globalToastTimer: null as number | null,
  replaySeq: null as number | null,
  replayPlaying: false,
  replayTimer: null as number | null,
  hoveredNode: null as string | null,
  activeLogWorker: null as string | null,
  logRawMode: false,
  cachedLogLines: [] as string[],
  activeDiffWorker: null as string | null,
  cachedDiffData: null as WorktreePatchResult | null,
  diffComments: [] as DiffInlineComment[],
  activeDiffCommentTarget: null as DiffCommentTarget | null,
  switchOpenWorker: null as string | null,
  switchDrafts: new Map<string, { provider: string; model: string; prompt: string }>(),
  mergeOpenWorker: null as string | null,
  mergePreviews: new Map<string, { loading: boolean; data?: MergePreviewResult; error?: string }>(),
  mergeDrafts: new Map<string, MergeDraft>(),
  prResults: new Map<string, CreatePrResult>(),
  pendingDeleteSwarm: false,
  activeCommanderPanel: null as 'create' | 'add' | 'arena' | 'templates' | null,
  latestTemplatesConfig: null as TemplatesConfigSnapshot | null,
  arenaSlots: [] as Array<{ provider: string; model: string }>,
  createPoolDraft: null as string[] | null,
  lastKnownPoolBaseline: '',
  addProvidersDraft: new Set<string>(),
  tplRoleOverrides: new Map<string, { provider?: string; model?: string }>(),
  latestProviderConfig: null as ProvidersConfigSnapshot | null,
  settingsExpanded: new Set<string>(),
  settingsDraftModels: new Map<string, string[]>(),
  settingsModelFilters: new Map<string, string>(),
  settingsTestResults: new Map<string, ProviderTestResult>(),
  testingProviders: new Set<string>(),
  discoveringProviders: new Set<string>(),
  pricingExpanded: false,
  activeSettingsSubtab: 'clis' as 'clis' | 'routing',
  routingDraftActive: new Set<string>(),
  routingDraftWriter: new Set<string>(),
  routingDraftReader: new Set<string>(),
  routingDraftDelegation: 'balanced' as OrchestratorDelegationMode,
  routingDraftTasks: new Map<TaskRoutingCategory, TaskModelTarget[]>(),
  routingDraftNotes: '',
  routingDraftTurnTimeout: '',
  routingDraftStallTimeout: '',
  routingDraftSynced: false,
  routingDraftDirty: false,
  routingPoolsAutoInit: false,
  pendingDeleteProvider: null as string | null,
  onboardingForceOpen: false,
  onboardingDismissedThisSession: false,
  onboardingVisible: false,
  onboardingDraftInitialized: false,
  onboardingStep: 1 as 1 | 2 | 3,
  onboardingTestingAll: false,
  onboardingSaving: false,
  onboardingSelectedClis: new Set<string>(),
  onboardingDefaultModels: new Map<string, string>(),
  onboardingModelsRaw: new Map<string, string>(),
  onboardingDefaultCli: '',
  onboardingUsePool: true,
  onboardingFailover: true,
  onboardingWriterPool: new Set<string>(),
  onboardingReaderPool: new Set<string>(),
};
