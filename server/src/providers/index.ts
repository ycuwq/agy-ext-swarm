export {
  buildDshSiblingCatalogOverlay,
  checkDshModelCatalogReadiness,
  checkDshProfileCatalogPlugins,
  checkDshProfileProviderPlugin,
  detectClaudeModels,
  detectCodexModels,
  detectCustomLocalModels,
  detectGeminiModels,
  formatDshQualifiedModel,
  getDshHome,
  getDshNoAdapterHint,
  getDshUnknownModelHint,
  isValidDshProfileName,
  listDshModels,
  parseClaudeHelpModelAliases,
  parseDshQualifiedModel,
  parseModelsFromCliOutput,
  type DshModelCatalogReadiness,
  type DshPatchOverlayEntry,
  type LocalModelsDetection,
} from '../models.js';
export type { DshProfileProviderCheck } from '../types.js';
export {
  expandTemplateArgs,
  quoteWinCmdArg,
  resolveExecutable,
  summarizeToolCall,
  toNonNegFinite,
  type CliProviderAdapter,
  type ParsedProviderEvent,
  type ProviderRunContext,
} from './shared.js';
export { dshAdapter } from './dsh.js';
export { claudeAdapter } from './claude.js';
export { codexAdapter } from './codex.js';
export { geminiAdapter } from './gemini.js';
export { createCustomAdapter } from './custom.js';
export {
  BUILTIN_ADAPTERS,
  applyBuiltinOverride,
  discoverProviderModels,
  getBuiltinAdapter,
  getProviderConfigSnapshot,
  getProviderModels,
  listProviders,
  loadCustomProviders,
  resolveDefaultProvider,
  resolveProviderAdapter,
  saveProviderConfigPatch,
  testProviderConnection,
  type ProviderConfigSnapshotOptions,
  type ProviderModelsResult,
  type SaveProviderConfigPatch,
} from './config.js';
export {
  BUILTIN_MODEL_PRICING,
  calcMemberCost,
  calcModelCost,
  collectUnpricedModels,
  convertCurrency,
  convertRateForDisplay,
  normalizeModelPricingCandidates,
  resolveModelPricing,
  type CostCalculation,
  type CostDisplayOptions,
  type CostSource,
  type ResolvedModelPricing,
} from '../../shared/pricing.js';
export {
  loadPricingCatalog,
  parseLiteLlmPricingCatalog,
  parseOpenRouterPricingCatalog,
  pickRelevantCatalogPricing,
  syncPricingCatalog,
  type LoadedPricingCatalog,
} from '../pricing-catalog.js';
