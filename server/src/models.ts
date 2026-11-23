export {
  formatDshQualifiedModel,
  getDshHome,
  getProfilePatchPath,
  isValidDshProfileName,
  listDshModels,
  parseDshQualifiedModel,
  writeModelPatch,
  type DshPatchOverlayEntry,
} from './models/dsh-catalog.js';
export {
  buildDshSiblingCatalogOverlay,
  checkDshModelCatalogReadiness,
  checkDshProfileCatalogPlugins,
  checkDshProfileProviderPlugin,
  getDshNoAdapterHint,
  getDshUnknownModelHint,
  type DshModelCatalogReadiness,
} from './models/dsh-diagnostics.js';
export {
  detectClaudeModels,
  detectCodexModels,
  detectCustomLocalModels,
  detectGeminiModels,
  parseClaudeHelpModelAliases,
  parseModelsFromCliOutput,
  type LocalModelsDetection,
} from './models/local-discovery.js';
