import { join } from 'node:path';
import { sanitizeReasoningEffort } from '../../shared/model-options.js';
import {
  buildDshSiblingCatalogOverlay,
  listDshModels,
  parseDshQualifiedModel,
  writeModelPatch,
} from '../models.js';
import {
  isValidObservedModelId,
  safeParseJsonLine,
  summarizeToolCall,
  toNonNegFinite,
  type CliProviderAdapter,
  type ParsedProviderEvent,
} from './shared.js';

// DeepSeek Harness (dsh) built-in adapter
export const dshAdapter: CliProviderAdapter = {
  id: 'dsh',
  displayName: 'DeepSeek Harness (dsh)',
  kind: 'builtin',
  command: process.env.DSH_BIN || 'dsh',
  supportsSessionResume: true,
  supportsStreamEvents: true,
  notes: 'Native headless profile with --session-id resume, --patch model selection, and worktree sandbox.',
  buildInvocation(ctx) {
    // Launcher flags (--profile, --patch) must precede all booted-app flags (--json, --permission-mode, ...)
    const args: string[] = ['--profile', ctx.profile];
    const catalog = listDshModels(ctx.profile);
    const rawModel = ctx.model?.trim() || 'default';
    const knownProviders = [
      ...(catalog.providers || []),
      catalog.defaultProvider,
      ctx.modelProvider || '',
    ].filter(Boolean);
    const fallbackProvider = ctx.modelProvider?.trim() || catalog.defaultProvider || undefined;
    const parsedModel = parseDshQualifiedModel(rawModel, knownProviders, fallbackProvider);
    const requestedModel = parsedModel.model;
    const overrideProvider = parsedModel.modelProvider || fallbackProvider;
    const providerChanged = Boolean(overrideProvider && overrideProvider !== catalog.defaultProvider);
    const fromSiblingCatalog = Boolean(catalog.catalogSourceProfile);
    const requestedEffort = sanitizeReasoningEffort(ctx.reasoningEffort);
    const modelForPatch =
      requestedModel && requestedModel !== 'default'
        ? requestedModel
        : catalog.defaultModel || requestedModel;
    const catalogOverlay =
      modelForPatch && modelForPatch !== 'default'
        ? buildDshSiblingCatalogOverlay(ctx.profile, overrideProvider, modelForPatch)
        : undefined;
    if (
      requestedEffort ||
      catalogOverlay ||
      (requestedModel &&
        requestedModel !== 'default' &&
        (fromSiblingCatalog || requestedModel !== catalog.defaultModel || providerChanged))
    ) {
      const patchPath = join(ctx.patchesDir, `${ctx.workerName}.yml`);
      writeModelPatch(
        patchPath,
        overrideProvider,
        modelForPatch,
        catalogOverlay ? [catalogOverlay] : undefined,
        requestedEffort,
      );
      args.push('--patch', patchPath);
    }
    args.push('--json', '--permission-mode', ctx.permissionMode, '--approval-policy', 'never');
    if (ctx.sessionId) {
      args.push('--session-id', ctx.sessionId);
    }
    if (ctx.permissionMode === 'workspace-write') {
      if (ctx.gitCommonDir) {
        args.push('--add-dir', ctx.gitCommonDir);
      }
      args.push('--add-dir', ctx.swarmDir);
    }
    args.push('-');
    return {
      command: this.command,
      args,
      stdinText: ctx.prompt,
    };
  },
  parseStdoutLine(line) {
    const ev = safeParseJsonLine(line);
    if (!ev) return [];
    const out: ParsedProviderEvent[] = [];
    const evType = ev.type;
    if (evType === 'session' && typeof ev.sessionId === 'string' && ev.sessionId.trim()) {
      out.push({ type: 'session', sessionId: ev.sessionId.trim() });
      if (typeof ev.model === 'string' && isValidObservedModelId(ev.model)) {
        out.push({ type: 'meta', model: ev.model.trim() });
      }
    } else if (evType === 'status') {
      if (typeof ev.model === 'string' && isValidObservedModelId(ev.model)) {
        out.push({ type: 'meta', model: ev.model.trim() });
      }
      const phase = ev.phase;
      if (phase === 'turn_start') {
        out.push({ type: 'turn_start' });
      } else if (phase === 'step_start') {
        out.push({ type: 'step_start' });
      } else if (phase === 'step_end' && ev.usage && typeof ev.usage === 'object') {
        const u = ev.usage as Record<string, unknown>;
        const inputTokens = toNonNegFinite(u.inputTokens);
        const outputTokens = toNonNegFinite(u.outputTokens);
        const cacheReadTokens = toNonNegFinite(u.cacheReadTokens);
        const parsedTotal = toNonNegFinite(u.totalTokens);
        out.push({
          type: 'usage',
          inputTokens,
          outputTokens,
          cacheReadTokens,
          totalTokens: parsedTotal > 0 ? parsedTotal : inputTokens + cacheReadTokens + outputTokens,
        });
      } else if (phase === 'turn_end' && ev.reason && typeof ev.reason === 'object') {
        const reason = ev.reason as Record<string, unknown>;
        out.push({
          type: 'final',
          reasonKind: typeof reason.kind === 'string' ? reason.kind : undefined,
          errorText: typeof reason.message === 'string' ? reason.message : undefined,
        });
      }
    } else if (evType === 'tool_call') {
      out.push({ type: 'tool_call', summary: summarizeToolCall(ev.tool, ev.input) });
    } else if (evType === 'text' && typeof ev.text === 'string') {
      out.push({ type: 'text', text: ev.text });
    } else if (evType === 'final') {
      const reason =
        ev.reason && typeof ev.reason === 'object' ? (ev.reason as Record<string, unknown>) : undefined;
      out.push({
        type: 'final',
        sessionId: typeof ev.sessionId === 'string' && ev.sessionId.trim() ? ev.sessionId.trim() : undefined,
        text: typeof ev.text === 'string' ? ev.text : undefined,
        reasonKind: typeof reason?.kind === 'string' ? reason.kind : undefined,
        errorText: typeof reason?.message === 'string' ? reason.message : undefined,
      });
    } else if (evType === 'error') {
      const msg =
        typeof ev.message === 'string'
          ? ev.message
          : typeof ev.error === 'string'
            ? ev.error
            : JSON.stringify(ev);
      out.push({ type: 'error', message: msg });
      out.push({ type: 'final', reasonKind: 'error', errorText: msg });
    }
    return out;
  },
};
