export {
  detectClaudeModels,
  detectCodexModels,
  detectCustomLocalModels,
  detectGeminiModels,
  listDshModels,
  parseClaudeHelpModelAliases,
  parseModelsFromCliOutput,
  type LocalModelsDetection,
} from '../models.js';
export {
  expandTemplateArgs,
  resolveExecutable,
  summarizeToolCall,
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
  type ProviderModelsResult,
  type SaveProviderConfigPatch,
} from './config.js';
