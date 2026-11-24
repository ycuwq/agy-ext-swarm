/**
 * Commander bar: create/add/arena/templates panels, merge preview/apply,
 * cross-review actions and their event bindings.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 *   bridge -> `bridge.ts`   (callbacks still owned by the entrypoint)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import { clearPendingKillState, extractToolErrorMessage, parseOptionalTimeoutInput, renderCliCheckboxGrid, serializeTaskRoutingMap, showCommanderToast, showGlobalToast, withBusyButton } from './helpers.js';
import { tr } from './context.js';
import { state } from './store.js';
import * as dom from './dom.js';
import { escapeHtml, splitModelList } from './format.js';
import {
  DEFAULT_STALL_TIMEOUT_SECONDS,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  MAX_STALL_TIMEOUT_SECONDS,
  MAX_TURN_TIMEOUT_SECONDS,
  type MemberState,
  type MergeApplyResult,
  type MergePreviewResult,
  type SwarmState,
  type SwarmTemplate,
  type TemplatesConfigSnapshot,
} from './types.js';
import { app } from './mcp-app.js';
import { getEnabledProvidersForUi, syncAddWorkerModelDatalist, syncProviderModelDatalists } from './settings-view.js';
import { renderWorkers } from './workers-view.js';
import * as bridge from './bridge.js';
import type { CommanderPanel } from './bridge.js';

export function toggleCommanderPanel(next: CommanderPanel): void {
  state.activeCommanderPanel = state.activeCommanderPanel === next ? null : next;
  dom.cmdPanelCreate.classList.toggle('hidden', state.activeCommanderPanel !== 'create');
  dom.cmdPanelAdd.classList.toggle('hidden', state.activeCommanderPanel !== 'add');
  dom.cmdPanelArena.classList.toggle('hidden', state.activeCommanderPanel !== 'arena');
  dom.cmdPanelTemplates.classList.toggle('hidden', state.activeCommanderPanel !== 'templates');

  const fallbackRepo =
    state.latestSnapshot?.swarm?.repoRoot || state.latestSnapshot?.swarms?.at(-1)?.repoRoot || '';
  if (state.activeCommanderPanel === 'create' && !dom.createSwarmRepo.value.trim() && fallbackRepo) {
    dom.createSwarmRepo.value = fallbackRepo;
  }
  if (state.activeCommanderPanel === 'arena' && state.arenaSlots.length < 2) {
    const enabled = (
      state.latestSnapshot?.providerConfig?.providers ||
      state.latestProviderConfig?.providers ||
      []
    ).filter((p) => p.enabled);
    const preferred = enabled.filter((p) => p.available);
    const seed = preferred.length >= 2 ? preferred : enabled;
    state.arenaSlots = [
      { provider: seed[0]?.id || 'dsh', model: seed[0]?.defaultModel || '' },
      { provider: seed[1]?.id || seed[0]?.id || 'claude', model: seed[1]?.defaultModel || '' },
    ];
    renderArenaContestantRows();
  }
  if (state.activeCommanderPanel === 'templates') {
    if (!dom.tplRepo.value.trim() && fallbackRepo) {
      dom.tplRepo.value = fallbackRepo;
    }
    if (!state.latestTemplatesConfig) {
      void fetchTemplatesFromServer();
    } else {
      renderTemplatePreview();
    }
  }
}

export function renderArenaQuickPicks(): void {
  const enabled = getEnabledProvidersForUi();
  const checkedSet = new Set(state.arenaSlots.map((s) => s.provider));
  renderCliCheckboxGrid(dom.arenaQuickPicks, enabled, checkedSet, (id, on) => {
    const prov = enabled.find((p) => p.id === id);
    if (on) {
      if (!state.arenaSlots.some((s) => s.provider === id)) {
        state.arenaSlots.push({ provider: id, model: prov?.defaultModel || '' });
      }
    } else {
      state.arenaSlots = state.arenaSlots.filter((s) => s.provider !== id);
    }
    renderArenaContestantRows();
  });
}

export function renderArenaContestantRows(): void {
  const providers = getEnabledProvidersForUi();
  renderArenaQuickPicks();
  dom.arenaContestants.innerHTML = '';
  state.arenaSlots.forEach((slot, idx) => {
    const row = document.createElement('div');
    row.className = 'arena-contestant-row';
    const options = providers.length
      ? providers
          .map(
            (p) =>
              `<option value="${escapeHtml(p.id)}" ${p.id === slot.provider ? 'selected' : ''}>${escapeHtml(p.displayName)} (${escapeHtml(p.id)})</option>`,
          )
          .join('')
      : `<option value="${escapeHtml(slot.provider)}" selected>${escapeHtml(slot.provider)}</option>`;
    row.innerHTML = `
      <select class="input input-sm" data-arena-prov>${options}</select>
      <input class="input input-sm mono-input" type="text" list="dl-prov-models-${escapeHtml(slot.provider)}" data-arena-model value="${escapeHtml(slot.model)}" placeholder="default" />
      <button type="button" class="btn btn-sm btn-ghost" data-arena-rm>×</button>
    `;
    const provSel = row.querySelector<HTMLSelectElement>('[data-arena-prov]')!;
    const modInp = row.querySelector<HTMLInputElement>('[data-arena-model]')!;
    provSel.addEventListener('change', () => {
      const chosen = providers.find((p) => p.id === provSel.value);
      state.arenaSlots[idx].provider = provSel.value;
      state.arenaSlots[idx].model = chosen?.defaultModel || '';
      modInp.value = state.arenaSlots[idx].model;
      modInp.setAttribute('list', `dl-prov-models-${provSel.value}`);
      renderArenaQuickPicks();
    });
    modInp.addEventListener('input', () => {
      state.arenaSlots[idx].model = modInp.value;
    });
    row.querySelector<HTMLButtonElement>('[data-arena-rm]')!.addEventListener('click', () => {
      state.arenaSlots.splice(idx, 1);
      renderArenaContestantRows();
    });
    dom.arenaContestants.appendChild(row);
  });
}

export function renderTemplatePreview(): void {
  const templates = state.latestTemplatesConfig?.templates || [];
  const selectedId = dom.tplSelect.value || templates[0]?.id || '';
  const tpl = templates.find((t) => t.id === selectedId) || templates[0];
  if (!tpl) {
    dom.tplDesc.textContent = '';
    dom.tplRoleGrid.innerHTML = '';
    dom.tplDeleteBtn.classList.add('hidden');
    return;
  }
  dom.tplDesc.textContent = tpl.description || tpl.name;

  const enabled = getEnabledProvidersForUi();
  dom.tplRoleGrid.innerHTML = '';
  for (const w of tpl.workers) {
    const key = `${tpl.id}:${w.name}`;
    const saved = state.tplRoleOverrides.get(key) || {
      provider: w.provider || '',
      model: w.model || '',
    };
    const row = document.createElement('div');
    row.className = 'tpl-role-row';
    const provOpts = [
      `<option value="">${escapeHtml(tr('cmd.tplRoleAuto'))}</option>`,
      ...enabled.map(
        (p) =>
          `<option value="${escapeHtml(p.id)}" ${p.id === saved.provider ? 'selected' : ''}>${escapeHtml(p.displayName)} (${escapeHtml(p.id)})</option>`,
      ),
    ].join('');

    const effectiveRoleProv =
      saved.provider ||
      state.latestSnapshot?.swarm?.defaultProvider ||
      state.latestSnapshot?.providerConfig?.effectiveDefaultProvider ||
      '';
    row.innerHTML = `
      <div class="tpl-role-label-wrap" title="${escapeHtml(w.role)}">
        <span class="tpl-role-label">${escapeHtml(w.name)}</span>
        ${w.dependsOn && w.dependsOn.length > 0 ? `<span class="tpl-role-dep">← ${escapeHtml(w.dependsOn.join(','))}</span>` : ''}
      </div>
      <select class="input input-sm" data-tpl-role-prov>${provOpts}</select>
      <input class="input input-sm mono-input" type="text" list="dl-prov-models-${escapeHtml(effectiveRoleProv)}" data-tpl-role-model value="${escapeHtml(saved.model || '')}" placeholder="model (auto)" />
    `;
    const provSel = row.querySelector<HTMLSelectElement>('[data-tpl-role-prov]')!;
    const modInp = row.querySelector<HTMLInputElement>('[data-tpl-role-model]')!;
    const syncRole = () => {
      const chosenProv =
        provSel.value.trim() ||
        state.latestSnapshot?.swarm?.defaultProvider ||
        state.latestSnapshot?.providerConfig?.effectiveDefaultProvider ||
        '';
      modInp.setAttribute('list', `dl-prov-models-${chosenProv}`);
      state.tplRoleOverrides.set(key, {
        provider: provSel.value.trim() || undefined,
        model: modInp.value.trim() || undefined,
      });
    };
    provSel.addEventListener('change', syncRole);
    modInp.addEventListener('input', syncRole);
    dom.tplRoleGrid.appendChild(row);
  }

  dom.tplDeleteBtn.classList.toggle('hidden', tpl.kind !== 'custom');
}

export function isEditingInsideCommanderPanels(): boolean {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae) return false;
  const inPanel =
    dom.cmdPanelCreate.contains(ae) ||
    dom.cmdPanelAdd.contains(ae) ||
    dom.cmdPanelArena.contains(ae) ||
    dom.cmdPanelTemplates.contains(ae);
  if (!inPanel) return false;
  return ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT';
}

export function computeCommanderConfigSignature(): string {
  const providers =
    state.latestSnapshot?.providerConfig?.providers || state.latestProviderConfig?.providers || [];
  const provSig = providers
    .map(
      (p) =>
        `${p.id}:${p.enabled ? 1 : 0}:${p.available ? 1 : 0}:${p.defaultModel || ''}:${p.detectedModelProvider || ''}:${(p.detectedModelProviders || []).join('|')}:${(p.models || []).join('|')}:${(p.detectedModels || []).join('|')}:${(p.warnings || []).join('|')}`,
    )
    .join(';');
  const tplSig = (state.latestTemplatesConfig?.templates || [])
    .map((t) => `${t.id}:${t.name}:${t.kind}:${t.workers.length}`)
    .join(',');
  const repoRootsSig = (state.latestSnapshot?.swarms || [])
    .map((s) => s.repoRoot || '')
    .join(',');
  const activePoolSig = (state.latestSnapshot?.providerConfig?.activePool || []).join(',');
  const autoFailoverSig = state.latestSnapshot?.providerConfig?.routingPolicy?.autoFailover ? 1 : 0;
  const timeoutDefaultsSig = `${state.latestSnapshot?.providerConfig?.defaultTurnTimeoutSeconds ?? ''}:${state.latestSnapshot?.providerConfig?.defaultStallTimeoutSeconds ?? ''}`;
  return `${state.currentLocale}:${state.latestSnapshot?.swarm?.id || ''}:${state.latestSnapshot?.swarm?.repoRoot || ''}:${state.latestSnapshot?.swarm?.defaultProvider || ''}:${state.latestSnapshot?.providerConfig?.effectiveDefaultProvider || ''}:${repoRootsSig}:${activePoolSig}:${autoFailoverSig}:${timeoutDefaultsSig}:${provSig}:${tplSig}`;
}

export function syncCommanderControls(force = false): void {
  const hasSwarm = Boolean(state.latestSnapshot?.swarm);
  const swarmMembers = Object.values(state.latestSnapshot?.swarm?.members || {});
  const hasAliveMembers = swarmMembers.some((m) => m.status !== 'killed');
  dom.cmdToggleAdd.disabled = !hasSwarm;
  dom.cmdToggleArena.disabled = !hasSwarm;
  dom.cmdToggleCreate.classList.toggle('btn-primary', !hasSwarm);
  dom.cmdToggleCreate.classList.toggle('btn-ghost', hasSwarm);
  dom.cmdToggleAdd.classList.toggle('btn-primary', hasSwarm);
  dom.cmdToggleAdd.classList.toggle('btn-ghost', !hasSwarm);
  dom.cmdKillAll.classList.toggle('hidden', !hasAliveMembers);
  dom.cmdKillAll.textContent = tr(state.pendingKillAll ? 'workers.confirmKillAll' : 'workers.killAllBtn');
  dom.tplFromSwarmBtn.classList.toggle('hidden', swarmMembers.length === 0);

  if (!hasSwarm && (state.activeCommanderPanel === 'add' || state.activeCommanderPanel === 'arena')) {
    toggleCommanderPanel(null);
  }

  const cfgSig = computeCommanderConfigSignature();
  if (!force && cfgSig === state.lastCommanderConfigSignature) {
    return;
  }
  if (!force && isEditingInsideCommanderPanels()) {
    state.commanderDeferredSync = true;
    return;
  }
  state.commanderDeferredSync = false;
  state.lastCommanderConfigSignature = cfgSig;

  syncProviderModelDatalists();
  dom.createSwarmTurnTimeout.placeholder = String(
    state.latestSnapshot?.providerConfig?.defaultTurnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS,
  );
  dom.createSwarmStallTimeout.placeholder = String(
    state.latestSnapshot?.providerConfig?.defaultStallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS,
  );

  const repoSet = new Set<string>();
  if (state.latestSnapshot?.swarm?.repoRoot) repoSet.add(state.latestSnapshot.swarm.repoRoot);
  for (const sItem of [...(state.latestSnapshot?.swarms || [])].reverse()) {
    if (sItem.repoRoot) repoSet.add(sItem.repoRoot);
  }
  dom.dlRepoHistory.innerHTML = '';
  for (const rPath of repoSet) {
    const opt = document.createElement('option');
    opt.value = rPath;
    dom.dlRepoHistory.appendChild(opt);
  }

  const enabled = getEnabledProvidersForUi();
  const prevPrimary = dom.createSwarmProvider.value;
  dom.createSwarmProvider.innerHTML = '';
  for (const p of enabled) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.displayName} (${p.id})${p.available ? '' : ' [!]'}`;
    dom.createSwarmProvider.appendChild(opt);
  }
  if (prevPrimary && enabled.some((p) => p.id === prevPrimary)) {
    dom.createSwarmProvider.value = prevPrimary;
  } else if (state.latestSnapshot?.swarm?.defaultProvider) {
    dom.createSwarmProvider.value = state.latestSnapshot.swarm.defaultProvider;
  } else if (state.latestSnapshot?.providerConfig?.effectiveDefaultProvider) {
    dom.createSwarmProvider.value = state.latestSnapshot.providerConfig.effectiveDefaultProvider;
  }

  if (state.createPoolDraft === null) {
    const globalPool = state.latestSnapshot?.providerConfig?.activePool;
    state.createPoolDraft =
      globalPool && globalPool.length > 0
        ? [...globalPool]
        : enabled.filter((p) => p.available).map((p) => p.id);
    dom.createSwarmFailover.checked = Boolean(
      state.latestSnapshot?.providerConfig?.routingPolicy?.autoFailover,
    );
  }
  const createPoolSet = new Set(state.createPoolDraft);
  renderCliCheckboxGrid(dom.createSwarmPool, enabled, createPoolSet, (id, on) => {
    const cur = new Set(state.createPoolDraft || []);
    if (on) cur.add(id);
    else cur.delete(id);
    state.createPoolDraft = [...cur];
  });

  renderCliCheckboxGrid(dom.addWorkerProviders, enabled, state.addProvidersDraft, (id, on) => {
    if (on) state.addProvidersDraft.add(id);
    else state.addProvidersDraft.delete(id);
    syncAddWorkerModelDatalist();
  });
  syncAddWorkerModelDatalist();

  const templates = state.latestTemplatesConfig?.templates || [];
  const prevTpl = dom.tplSelect.value;
  dom.tplSelect.innerHTML = '';
  for (const tItem of templates) {
    const opt = document.createElement('option');
    opt.value = tItem.id;
    opt.textContent = `${tItem.name} [${tItem.kind}]`;
    dom.tplSelect.appendChild(opt);
  }
  if (prevTpl && templates.some((tItem) => tItem.id === prevTpl)) {
    dom.tplSelect.value = prevTpl;
  }
  renderTemplatePreview();
  if (state.activeCommanderPanel === 'arena') {
    renderArenaContestantRows();
  }
}

export async function fetchTemplatesFromServer(): Promise<void> {
  try {
    const res = await app.callServerTool({
      name: 'app_get_templates',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showCommanderToast(errMsg, true);
      return;
    }
    const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
    if (sc?.templatesConfig) {
      state.latestTemplatesConfig = sc.templatesConfig;
      syncCommanderControls(true);
    }
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

export async function previewMergeFromUi(name: string): Promise<void> {
  state.mergePreviews.set(name, { loading: true });
  if (state.latestSnapshot?.swarm) {
    renderWorkers(Object.values(state.latestSnapshot.swarm.members || {}), state.latestSnapshot.diffs || {});
  }
  try {
    const res = await app.callServerTool({
      name: 'app_preview_merge',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      state.mergePreviews.set(name, { loading: false, error: errMsg });
    } else {
      const sc = res.structuredContent as { preview?: MergePreviewResult } | undefined;
      state.mergePreviews.set(name, { loading: false, data: sc?.preview });
    }
  } catch (err) {
    state.mergePreviews.set(name, {
      loading: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (state.latestSnapshot?.swarm) {
    renderWorkers(Object.values(state.latestSnapshot.swarm.members || {}), state.latestSnapshot.diffs || {});
  }
}

export async function applyMergeFromUi(name: string): Promise<void> {
  const draft = state.mergeDrafts.get(name) || {
    mode: 'squash' as const,
    removeWt: true,
    commitMsg: '',
  };
  try {
    const res = await app.callServerTool({
      name: 'app_merge_worker',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        name,
        mode: draft.mode,
        remove_worktree: draft.removeWt,
        ...(draft.commitMsg.trim() ? { commit_message: draft.commitMsg.trim() } : {}),
      },
    });
    const sc = res.structuredContent as MergeApplyResult | undefined;
    if (res.isError || sc?.merged === false) {
      showCommanderToast(extractToolErrorMessage(res) || sc?.message || 'Merge blocked', true);
      void previewMergeFromUi(name);
    } else {
      state.mergeOpenWorker = null;
      state.mergePreviews.delete(name);
      state.mergeDrafts.delete(name);
      showCommanderToast(tr('merge.applied', { msg: sc?.message || name }));
    }
    await bridge.refreshSnapshot(true);
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

export async function crossReviewFromUi(targetWorker: string): Promise<void> {
  try {
    const res = await app.callServerTool({
      name: 'app_cross_review',
      arguments: {
        ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
        target_worker: targetWorker,
      },
    });
    const errMsg = extractToolErrorMessage(res);
    if (errMsg) {
      showCommanderToast(errMsg, true);
      return;
    }
    const sc = res.structuredContent as { reviewer?: MemberState } | undefined;
    showCommanderToast(
      tr('cmd.toastReviewStarted', {
        reviewer: sc?.reviewer?.name || 'reviewer',
        target: targetWorker,
      }),
    );
    await bridge.refreshSnapshot(true);
  } catch (err) {
    showCommanderToast(err instanceof Error ? err.message : String(err), true);
  }
}

/** Wire commander listener bindings. Called once from the entrypoint. */
export function bindCommanderEvents(): void {
  dom.cmdToggleCreate.addEventListener('click', () => toggleCommanderPanel('create'));
  dom.cmdToggleAdd.addEventListener('click', () => toggleCommanderPanel('add'));
  dom.cmdToggleArena.addEventListener('click', () => toggleCommanderPanel('arena'));
  dom.cmdToggleTemplates.addEventListener('click', () => toggleCommanderPanel('templates'));
  dom.cmdKillAll.addEventListener('click', () => {
    if (!state.latestSnapshot?.swarm) return;
    if (!state.pendingKillAll) {
      state.pendingKillAll = true;
      dom.cmdKillAll.textContent = tr('workers.confirmKillAll');
      if (state.pendingKillAllTimer !== null) window.clearTimeout(state.pendingKillAllTimer);
      state.pendingKillAllTimer = window.setTimeout(() => {
        state.pendingKillAll = false;
        state.pendingKillAllTimer = null;
        dom.cmdKillAll.textContent = tr('workers.killAllBtn');
      }, 3500);
      return;
    }
    clearPendingKillState();
    dom.cmdKillAll.textContent = tr('workers.killAllBtn');
    void bridge.killWorkerFromUi('all', false);
  });
  dom.cmdCreateCancel.addEventListener('click', () => toggleCommanderPanel(null));
  dom.cmdAddCancel.addEventListener('click', () => toggleCommanderPanel(null));
  dom.cmdArenaCancel.addEventListener('click', () => toggleCommanderPanel(null));
  dom.cmdTemplatesCancel.addEventListener('click', () => toggleCommanderPanel(null));

  dom.arenaAddRow.addEventListener('click', () => {
    const providers = getEnabledProvidersForUi();
    const next = providers[state.arenaSlots.length % Math.max(1, providers.length)];
    state.arenaSlots.push({ provider: next?.id || 'dsh', model: next?.defaultModel || '' });
    renderArenaContestantRows();
  });

  dom.tplSelect.addEventListener('change', () => renderTemplatePreview());

  dom.tplToggleSave.addEventListener('click', () => {
    const hidden = dom.tplSaveForm.classList.toggle('hidden');
    if (!hidden && !dom.tplSaveWorkers.value.trim()) {
      dom.tplSaveWorkers.value = JSON.stringify(
        [
          {
            name: 'impl',
            role: 'Implementer',
            workspace: 'worktree',
            permission: 'workspace-write',
            brief: 'Implement: {{goal}}',
          },
          {
            name: 'review',
            role: 'Reviewer',
            workspace: 'inherit',
            permission: 'read-only',
            dependsOn: ['impl'],
            brief: 'Review @impl for: {{goal}}',
          },
        ],
        null,
        2,
      );
    }
  });

  dom.tplSaveCancel.addEventListener('click', () => {
    dom.tplSaveForm.classList.add('hidden');
  });

  dom.tplFromSwarmBtn.addEventListener('click', () => {
    const swarm = state.latestSnapshot?.swarm;
    if (!swarm) return;
    const allMembers = Object.values(swarm.members || {});
    const chosen = allMembers.filter((m) => m.status !== 'killed');
    const sourceMembers = chosen.length > 0 ? chosen : allMembers;
    if (sourceMembers.length === 0) return;

    const specs = sourceMembers.map((m) => ({
      name: m.name,
      role: m.role,
      workspace: m.workspaceMode,
      permission: m.permissionMode,
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.model && m.model !== 'default' ? { model: m.model } : {}),
      ...(m.dependsOn?.length ? { dependsOn: m.dependsOn } : {}),
      ...(m.allowedFiles?.length ? { allowedFiles: m.allowedFiles } : {}),
      ...(m.verifyCommands?.length ? { verifyCommands: m.verifyCommands } : {}),
      ...(m.autoVerify ? { autoVerify: true } : {}),
      brief: `Execute ${m.role} tasks for:\n{{goal}}`,
    }));
    dom.tplSaveWorkers.value = JSON.stringify(specs, null, 2);
    if (!dom.tplSaveId.value.trim()) {
      const slug = swarm.title
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
      dom.tplSaveId.value = slug || 'custom-squad';
    }
    if (!dom.tplSaveName.value.trim()) {
      dom.tplSaveName.value = swarm.title;
    }
    showGlobalToast(tr('cmd.tplFromSwarmToast', { n: specs.length }));
  });

  dom.tplDeleteBtn.addEventListener('click', async () => {
    const id = dom.tplSelect.value;
    if (!id) return;
    await withBusyButton(dom.tplDeleteBtn, async () => {
      try {
        const res = await app.callServerTool({
          name: 'app_save_template',
          arguments: {
            ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
            remove_template_id: id,
          },
        });
        const errMsg = extractToolErrorMessage(res);
        if (errMsg) {
          showCommanderToast(errMsg, true);
          return;
        }
        const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
        if (sc?.templatesConfig) state.latestTemplatesConfig = sc.templatesConfig;
        syncCommanderControls(true);
        showCommanderToast(tr('cmd.toastTemplateDeleted', { id }));
      } catch (err) {
        showCommanderToast(err instanceof Error ? err.message : String(err), true);
      }
    });
  });

  dom.cmdPanelCreate.addEventListener('submit', async (e) => {
    e.preventDefault();
    const repoRoot = dom.createSwarmRepo.value.trim();
    if (!repoRoot) return;
    const rawConc = dom.createSwarmConcurrency.value.trim();
    let maxConcurrency: number | undefined;
    if (rawConc) {
      if (!/^\d+$/.test(rawConc)) {
        showCommanderToast(tr('cmd.invalidCreateParams'), true);
        return;
      }
      const n = Number(rawConc);
      if (!Number.isSafeInteger(n) || n < 1 || n > 16) {
        showCommanderToast(tr('cmd.invalidCreateParams'), true);
        return;
      }
      maxConcurrency = n;
    }
    const parsedTurnTo = parseOptionalTimeoutInput(
      dom.createSwarmTurnTimeout.value,
      MAX_TURN_TIMEOUT_SECONDS,
    );
    const parsedStallTo = parseOptionalTimeoutInput(
      dom.createSwarmStallTimeout.value,
      MAX_STALL_TIMEOUT_SECONDS,
    );
    if (parsedTurnTo === 'invalid' || parsedStallTo === 'invalid') {
      showCommanderToast(tr('routing.invalidTimeout'), true);
      return;
    }

    const submitBtn = dom.cmdPanelCreate.querySelector<HTMLButtonElement>('button[type="submit"]');
    await withBusyButton(submitBtn, async () => {
      const activeProviders = (state.createPoolDraft || []).filter(Boolean);
      const autoFailover = dom.createSwarmFailover.checked;
      const globalPolicy = state.latestSnapshot?.providerConfig?.routingPolicy;
      const taskRoutingPayload = serializeTaskRoutingMap(globalPolicy?.taskRouting);
      const routingPolicy =
        globalPolicy || autoFailover
          ? {
              ...(globalPolicy?.writerProviders?.length
                ? { writer_providers: globalPolicy.writerProviders }
                : {}),
              ...(globalPolicy?.readerProviders?.length
                ? { reader_providers: globalPolicy.readerProviders }
                : {}),
              ...(globalPolicy?.delegationMode
                ? { delegation_mode: globalPolicy.delegationMode }
                : {}),
              ...(taskRoutingPayload ? { task_routing: taskRoutingPayload } : {}),
              ...(globalPolicy?.routingNotes
                ? { routing_notes: globalPolicy.routingNotes }
                : {}),
              auto_failover: autoFailover,
            }
          : undefined;
      try {
        const res = await app.callServerTool({
          name: 'app_create_swarm',
          arguments: {
            repo_root: repoRoot,
            title: dom.createSwarmTitle.value.trim() || undefined,
            default_provider: dom.createSwarmProvider.value || undefined,
            ...(activeProviders.length > 0 ? { active_providers: activeProviders } : {}),
            ...(routingPolicy ? { routing_policy: routingPolicy } : {}),
            ...(maxConcurrency !== undefined ? { max_concurrency: maxConcurrency } : {}),
            ...(parsedTurnTo !== null ? { turn_timeout_seconds: parsedTurnTo } : {}),
            ...(parsedStallTo !== null ? { stall_timeout_seconds: parsedStallTo } : {}),
          },
        });
        const errMsg = extractToolErrorMessage(res);
        if (errMsg) {
          showCommanderToast(errMsg, true);
          return;
        }
        const sc = res.structuredContent as { swarm?: SwarmState } | undefined;
        if (sc?.swarm?.id && sc.swarm.id !== state.currentSwarmId) {
          state.currentSwarmId = sc.swarm.id;
          bridge.resetSwarmScopedUiState(false);
        }
        state.createPoolDraft = null;
        toggleCommanderPanel(null);
        dom.cmdPanelCreate.reset();
        showCommanderToast(tr('cmd.toastCreated', { title: sc?.swarm?.title || repoRoot }));
        await bridge.refreshSnapshot(true);
      } catch (err) {
        showCommanderToast(err instanceof Error ? err.message : String(err), true);
      }
    });
  });

  dom.cmdPanelAdd.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = dom.addWorkerName.value.trim();
    const brief = dom.addWorkerBrief.value.trim();
    if (!name || !brief) return;
    const submitBtn = dom.cmdPanelAdd.querySelector<HTMLButtonElement>('button[type="submit"]');
    await withBusyButton(submitBtn, async () => {
      const deps = dom.addWorkerDeps.value
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const tasks = dom.addWorkerTasks.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const allowedFiles = splitModelList(dom.addWorkerAllowed.value);
      const verifyCommands = dom.addWorkerVerify.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const autoVerify = dom.addWorkerAutoVerify.checked;
      const chosenProviders = [...state.addProvidersDraft];
      try {
        const res = await app.callServerTool({
          name: 'app_add_worker',
          arguments: {
            ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
            name,
            brief,
            role: dom.addWorkerRole.value.trim() || undefined,
            ...(chosenProviders.length === 1
              ? { provider: chosenProviders[0] }
              : chosenProviders.length >= 2
                ? { providers: chosenProviders }
                : {}),
            model: dom.addWorkerModel.value.trim() || undefined,
            permission_mode: dom.addWorkerPerm.value,
            workspace: dom.addWorkerWs.value,
            ...(tasks.length > 0 ? { tasks } : {}),
            ...(allowedFiles.length > 0 ? { allowed_files: allowedFiles } : {}),
            ...(verifyCommands.length > 0 ? { verify_commands: verifyCommands } : {}),
            ...(autoVerify ? { auto_verify: true } : {}),
            ...(deps.length > 0 ? { depends_on: deps } : {}),
          },
        });
        const errMsg = extractToolErrorMessage(res);
        if (errMsg) {
          showCommanderToast(errMsg, true);
          return;
        }
        state.addProvidersDraft.clear();
        syncCommanderControls(true);
        toggleCommanderPanel(null);
        dom.cmdPanelAdd.reset();
        showCommanderToast(tr('cmd.toastAdded', { name }));
        await bridge.refreshSnapshot(true);
      } catch (err) {
        showCommanderToast(err instanceof Error ? err.message : String(err), true);
      }
    });
  });

  dom.cmdPanelArena.addEventListener('submit', async (e) => {
    e.preventDefault();
    const task = dom.arenaTask.value.trim();
    if (!task || state.arenaSlots.length < 2) {
      showCommanderToast(tr('cmd.arenaNeedTwo'), true);
      return;
    }
    const submitBtn = dom.cmdPanelArena.querySelector<HTMLButtonElement>('button[type="submit"]');
    await withBusyButton(submitBtn, async () => {
      try {
        const res = await app.callServerTool({
          name: 'app_start_arena',
          arguments: {
            ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
            task,
            base_name: dom.arenaBaseName.value.trim() || undefined,
            permission: dom.arenaPerm.value,
            contestants: state.arenaSlots.map((s) => ({
              provider: s.provider,
              ...(s.model.trim() ? { model: s.model.trim() } : {}),
            })),
          },
        });
        const errMsg = extractToolErrorMessage(res);
        if (errMsg) {
          showCommanderToast(errMsg, true);
          return;
        }
        const sc = res.structuredContent as { arenaGroup?: string } | undefined;
        toggleCommanderPanel(null);
        dom.arenaTask.value = '';
        showCommanderToast(tr('cmd.toastArena', { group: sc?.arenaGroup || 'arena' }));
        await bridge.refreshSnapshot(true);
      } catch (err) {
        showCommanderToast(err instanceof Error ? err.message : String(err), true);
      }
    });
  });

  dom.tplApplyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const templateId = dom.tplSelect.value;
    const goal = dom.tplGoal.value.trim();
    if (!templateId || !goal) return;
    const submitBtn = dom.tplApplyForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    await withBusyButton(submitBtn, async () => {
      const tpl = state.latestTemplatesConfig?.templates?.find((t) => t.id === templateId);
      const providerOverrides: Record<string, string> = {};
      const modelOverrides: Record<string, string> = {};
      for (const w of tpl?.workers || []) {
        const ov = state.tplRoleOverrides.get(`${templateId}:${w.name}`);
        if (ov?.provider) providerOverrides[w.name] = ov.provider;
        if (ov?.model) modelOverrides[w.name] = ov.model;
      }
      try {
        const res = await app.callServerTool({
          name: 'app_apply_template',
          arguments: {
            ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
            template_id: templateId,
            goal,
            repo_root: dom.tplRepo.value.trim() || undefined,
            title: dom.tplTitle.value.trim() || undefined,
            ...(Object.keys(providerOverrides).length > 0
              ? { provider_overrides: providerOverrides }
              : {}),
            ...(Object.keys(modelOverrides).length > 0 ? { model_overrides: modelOverrides } : {}),
          },
        });
        const errMsg = extractToolErrorMessage(res);
        if (errMsg) {
          showCommanderToast(errMsg, true);
          return;
        }
        const sc = res.structuredContent as { swarmId?: string; added?: MemberState[]; template?: SwarmTemplate } | undefined;
        if (sc?.swarmId && sc.swarmId !== state.currentSwarmId) {
          state.currentSwarmId = sc.swarmId;
          bridge.resetSwarmScopedUiState(false);
        }
        toggleCommanderPanel(null);
        dom.tplGoal.value = '';
        showCommanderToast(
          tr('cmd.toastTemplateApplied', {
            name: sc?.template?.name || templateId,
            n: sc?.added?.length || 0,
          }),
        );
        await bridge.refreshSnapshot(true);
      } catch (err) {
        showCommanderToast(err instanceof Error ? err.message : String(err), true);
      }
    });
  });

  dom.tplSaveForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = dom.tplSaveId.value.trim().toLowerCase();
    const name = dom.tplSaveName.value.trim();
    if (!id || !name) return;
    const submitBtn = dom.tplSaveForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    await withBusyButton(submitBtn, async () => {
      try {
        const workers = JSON.parse(dom.tplSaveWorkers.value);
        const res = await app.callServerTool({
          name: 'app_save_template',
          arguments: {
            ...(state.currentSwarmId ? { swarm_id: state.currentSwarmId } : {}),
            upsert_template: {
              id,
              name,
              description: dom.tplSaveDesc.value.trim() || undefined,
              workers,
            },
          },
        });
        const errMsg = extractToolErrorMessage(res);
        if (errMsg) {
          showCommanderToast(errMsg, true);
          return;
        }
        const sc = res.structuredContent as { templatesConfig?: TemplatesConfigSnapshot } | undefined;
        if (sc?.templatesConfig) state.latestTemplatesConfig = sc.templatesConfig;
        dom.tplSaveForm.classList.add('hidden');
        syncCommanderControls(true);
        dom.tplSelect.value = id;
        renderTemplatePreview();
        showCommanderToast(tr('cmd.toastTemplateSaved', { id }));
      } catch (err) {
        showCommanderToast(err instanceof Error ? err.message : String(err), true);
      }
    });
  });
}
