/**
 * Arena boards and the Workers card list.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 *   bridge -> `bridge.ts`   (callbacks still owned by the entrypoint)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import { clearPendingKillState, isEditingInsideWorkersList, providerBadgeClass, resizeComposerInput, statusLabel, withBusyButton } from './helpers.js';
import { tr } from './context.js';
import { state } from './store.js';
import * as dom from './dom.js';
import {
  calcInputCacheHit,
  escapeHtml,
  formatDurationMs,
  formatNum,
} from './format.js';
import type {
  MemberState,
  WorktreeDiffSummary,
} from './types.js';
import * as bridge from './bridge.js';

export function renderArenaBoards(
  members: MemberState[],
  diffs: Record<string, WorktreeDiffSummary | null>,
): void {
  const groups = new Map<string, MemberState[]>();
  for (const m of members) {
    if (!m.arenaGroup) continue;
    const list = groups.get(m.arenaGroup) || [];
    list.push(m);
    groups.set(m.arenaGroup, list);
  }
  dom.arenaBoards.innerHTML = '';
  for (const [groupName, groupMembers] of groups.entries()) {
    const card = document.createElement('div');
    card.className = 'arena-card';
    const rowsHtml = groupMembers
      .map((m) => {
        const diff = diffs[m.name];
        const totalTok = m.usage?.totalTokens || 0;
        const changesText = m.branch
          ? `${diff?.commitCount ?? 0}c / ${diff?.changedFiles?.length ?? 0}f`
          : m.workspaceMode;
        return `
          <tr>
            <td><strong>${escapeHtml(m.name)}</strong></td>
            <td><span class="provider-badge ${providerBadgeClass(m.provider)}">${escapeHtml(m.provider || 'dsh')}</span><span class="arena-model-text">${escapeHtml(m.model)}</span></td>
            <td>${escapeHtml(statusLabel(m.status))}</td>
            <td>${escapeHtml(changesText)}</td>
            <td>${escapeHtml(formatNum(totalTok))}</td>
            <td>
              <div class="arena-row-actions">
                ${m.workspaceMode === 'worktree' || m.branch ? `<button type="button" class="btn btn-sm" data-arena-diff="${escapeHtml(m.name)}">${escapeHtml(tr('workers.diffBtn'))}</button>` : ''}
                ${m.workspaceMode === 'worktree' && m.branch && m.status !== 'killed' ? `<button type="button" class="btn btn-sm" data-arena-merge="${escapeHtml(m.name)}">${escapeHtml(tr('workers.mergeBtn'))}</button>` : ''}
                ${m.status !== 'killed' ? `<button type="button" class="btn btn-sm" data-arena-review="${escapeHtml(m.name)}">${escapeHtml(tr('workers.reviewBtn'))}</button>` : ''}
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
    card.innerHTML = `
      <div class="arena-card-title">${escapeHtml(tr('arena.sectionTitle', { group: groupName }))}</div>
      <table class="arena-table">
        <thead>
          <tr>
            <th>${escapeHtml(tr('arena.colWorker'))}</th>
            <th>${escapeHtml(tr('arena.colCli'))}</th>
            <th>${escapeHtml(tr('arena.colStatus'))}</th>
            <th>${escapeHtml(tr('arena.colChanges'))}</th>
            <th>${escapeHtml(tr('arena.colTokens'))}</th>
            <th>${escapeHtml(tr('arena.colActions'))}</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
    card.querySelectorAll<HTMLButtonElement>('[data-arena-diff]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wName = btn.dataset.arenaDiff;
        if (wName) void bridge.openWorkerDiff(wName);
      });
    });
    card.querySelectorAll<HTMLButtonElement>('[data-arena-merge]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wName = btn.dataset.arenaMerge;
        if (!wName) return;
        state.mergeOpenWorker = state.mergeOpenWorker === wName ? null : wName;
        if (state.mergeOpenWorker === wName) void bridge.previewMergeFromUi(wName);
        renderWorkers(members, diffs);
      });
    });
    card.querySelectorAll<HTMLButtonElement>('[data-arena-review]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wName = btn.dataset.arenaReview;
        if (wName) void bridge.crossReviewFromUi(wName);
      });
    });
    dom.arenaBoards.appendChild(card);
  }
}

export function renderWorkers(
  members: MemberState[],
  diffs: Record<string, WorktreeDiffSummary | null>,
): void {
  renderArenaBoards(members, diffs);
  if (members.length === 0) {
    state.seenWorkerNames.clear();
    dom.workersList.innerHTML = `<div class="empty-state">${escapeHtml(tr('workers.empty'))}</div>`;
    return;
  }

  dom.workersList.innerHTML = '';
  for (const m of members) {
    const isNewWorker = state.initialBoardLoaded && !state.seenWorkerNames.has(m.name);
    const card = document.createElement('div');
    card.className = `worker-card${m.status === 'working' ? ' is-working' : ''}${isNewWorker ? ' is-new' : ''}`;

    const diff = diffs[m.name];
    const outOfScope = diff?.outOfScopeFiles?.length
      ? diff.outOfScopeFiles
      : m.outOfScopeFiles || [];

    const inputTok = m.usage?.inputTokens || 0;
    const cacheTok = m.usage?.cacheReadTokens || 0;
    const outputTok = m.usage?.outputTokens || 0;
    const totalTok = m.usage?.totalTokens || inputTok + cacheTok + outputTok;
    const hitRate = calcInputCacheHit(inputTok, cacheTok);
    const uncachedPct = inputTok + cacheTok > 0 ? Math.max(0, 100 - hitRate) : 0;

    const pillClass =
      m.status === 'working'
        ? 'pill-working'
        : m.status === 'queued' || m.status === 'blocked'
          ? 'pill-warn'
          : m.status === 'waiting'
            ? 'pill-waiting'
            : m.status === 'failed'
              ? 'pill-failed'
              : 'pill-neutral';

    const depsHtml =
      m.dependsOn && m.dependsOn.length > 0
        ? `<div class="worker-deps-row"><span>${escapeHtml(tr('workers.dependsOn'))}</span>${m.dependsOn
            .map((d) => `<span class="dep-pill">@${escapeHtml(d)}</span>`)
            .join('')}</div>`
        : '';

    const changedFilesHtml = diff?.changedFiles?.length
      ? `<div class="file-pills">${diff.changedFiles
          .slice(0, 12)
          .map((f) => {
            const isBad = outOfScope.includes(f);
            return `<span class="file-pill${isBad ? ' bad' : ''}">${escapeHtml(f)}</span>`;
          })
          .join('')}${diff.changedFiles.length > 12 ? `<span class="file-pill">${escapeHtml(tr('workers.moreFiles', { n: diff.changedFiles.length - 12 }))}</span>` : ''}</div>`
      : '';

    const wtHtml = m.branch
      ? `
        <div class="worktree-box">
          <div class="worktree-branch">${escapeHtml(m.branch)}</div>
          <div class="worker-meta">
            <span>${escapeHtml(tr('workers.commits'))}: ${diff?.commitCount ?? 0}</span>
            <span>${escapeHtml(tr('workers.changed'))}: ${diff?.changedFiles?.length ?? 0}</span>
            <span>${escapeHtml(tr('workers.dirty'))}: ${diff?.dirtyFiles?.length ?? 0}</span>
          </div>
          ${changedFilesHtml}
        </div>
      `
      : `<div class="worker-meta"><span>${escapeHtml(tr('workers.workspace'))}: ${escapeHtml(m.workspaceMode)}</span><span>${escapeHtml(tr('workers.perm'))}: ${escapeHtml(m.permissionMode)}</span></div>`;

    const activityHtml = m.activity
      ? `
        <div class="worker-activity-row">
          <span class="eq-bars" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="worker-activity-text">${escapeHtml(m.activity)}</span>
        </div>
      `
      : '';

    const verifyHtml =
      m.lastVerifyResults && m.lastVerifyResults.length > 0
        ? `<div class="verify-box">${m.lastVerifyResults
            .map(
              (vr) => `
              <div>
                <div class="verify-row">
                  <span class="verify-cmd"><code>${escapeHtml(vr.command)}</code></span>
                  <span class="badge ${vr.passed ? 'badge-done' : 'badge-error'}">${escapeHtml(tr(vr.passed ? 'workers.verifyPass' : 'workers.verifyFail'))} (${vr.durationMs}ms)</span>
                </div>
                ${!vr.passed && vr.outputTail ? `<pre class="verify-tail">${escapeHtml(vr.outputTail)}</pre>` : ''}
              </div>`,
            )
            .join('')}</div>`
        : '';

    const failoverChain =
      m.failedProviders && m.failedProviders.length > 0
        ? [...m.failedProviders.filter((x) => x !== m.provider), m.provider || 'dsh'].join(' → ')
        : '';

    let elapsedHtml = '';
    if (m.lastTurnStartedAt) {
      const startMs = Date.parse(m.lastTurnStartedAt);
      if (Number.isFinite(startMs)) {
        const endMs =
          m.status === 'working'
            ? Date.now()
            : m.lastTurnFinishedAt
              ? Date.parse(m.lastTurnFinishedAt)
              : Number.NaN;
        if (Number.isFinite(endMs) && endMs >= startMs) {
          const dur = formatDurationMs(endMs - startMs);
          const label =
            m.status === 'working'
              ? tr('workers.elapsedRunning', { dur })
              : tr('workers.elapsedDone', { dur });
          const liveAttr =
            m.status === 'working' ? ` data-turn-started="${escapeHtml(m.lastTurnStartedAt)}"` : '';
          elapsedHtml = `<span class="worker-elapsed${m.status === 'working' ? ' is-live' : ''}"${liveAttr}>${escapeHtml(label)}</span>`;
        }
      }
    }

    card.innerHTML = `
      <div class="worker-top">
        <div class="worker-name-wrap">
          <span class="status-dot ${escapeHtml(m.status)}"></span>
          <span class="worker-name">${escapeHtml(m.name)}</span>
          <span class="provider-badge ${providerBadgeClass(m.provider)}">${escapeHtml(m.provider || 'dsh')}</span>
          ${failoverChain ? `<span class="failover-tag" title="${escapeHtml(failoverChain)}">⚡ ${escapeHtml(tr('workers.failoverBadge', { chain: failoverChain }))}</span>` : ''}
          ${m.arenaGroup ? `<span class="arena-tag">${escapeHtml(tr('workers.arenaGroup'))}${escapeHtml(m.arenaGroup)}</span>` : ''}
          <span class="pill ${pillClass}"><span class="pill-dot"></span>${escapeHtml(statusLabel(m.status))}</span>
        </div>
        <span class="pill pill-neutral">${escapeHtml(m.role)}</span>
      </div>

      <div class="worker-meta">
        <span>${escapeHtml(tr('workers.model'))}: <strong>${escapeHtml(m.model)}</strong></span>
        <span>${escapeHtml(tr('workers.turnsSteps', { turns: m.turns, steps: m.steps }))}</span>
        <span>${escapeHtml(tr('workers.perm'))}: ${escapeHtml(m.permissionMode)}</span>
        ${elapsedHtml}
      </div>

      ${depsHtml}
      ${activityHtml}

      <div class="token-meter">
        <div class="token-meter-label">
          <span>${escapeHtml(tr('workers.totalUsage', { total: formatNum(totalTok), input: formatNum(inputTok), output: formatNum(outputTok) }))}</span>
          <span>${escapeHtml(tr('workers.cacheHit', { pct: hitRate }))}</span>
        </div>
        <div class="token-bar-track">
          <div class="token-bar-cache" style="width:${hitRate}%"></div>
          <div class="token-bar-uncached" style="width:${uncachedPct}%"></div>
        </div>
      </div>

      ${wtHtml}
      ${verifyHtml}
      ${m.lastError ? `<div class="worker-error">${escapeHtml(m.lastError)}</div>` : ''}
      ${outOfScope.length > 0 ? `<div class="worker-error">${escapeHtml(tr('workers.whitelistViolation'))}${escapeHtml(outOfScope.join(', '))}</div>` : ''}
    `;

    const actions = document.createElement('div');
    actions.className = 'worker-actions';

    if (m.status !== 'killed') {
      const btnMention = document.createElement('button');
      btnMention.type = 'button';
      btnMention.className = 'btn btn-sm';
      btnMention.textContent = `@${m.name}`;
      btnMention.onclick = () => {
        bridge.switchTab('board');
        dom.composerInput.value = `@${m.name} `;
        resizeComposerInput();
        dom.composerInput.focus();
      };
      actions.appendChild(btnMention);
    }

    const btnEvents = document.createElement('button');
    btnEvents.type = 'button';
    btnEvents.className = 'btn btn-sm btn-ghost';
    btnEvents.textContent = tr('workers.events');
    btnEvents.onclick = () => void bridge.openWorkerLogs(m.name);
    actions.appendChild(btnEvents);

    if (m.workspaceMode === 'worktree' || m.branch) {
      const btnDiff = document.createElement('button');
      btnDiff.type = 'button';
      btnDiff.className = 'btn btn-sm';
      btnDiff.textContent = tr('workers.diffBtn');
      btnDiff.onclick = () => void bridge.openWorkerDiff(m.name);
      actions.appendChild(btnDiff);
    }

    if (
      m.workspaceMode === 'worktree' &&
      m.branch &&
      m.status !== 'working' &&
      m.status !== 'queued' &&
      m.status !== 'killed'
    ) {
      const btnMerge = document.createElement('button');
      btnMerge.type = 'button';
      btnMerge.className = 'btn btn-sm';
      btnMerge.textContent = tr(state.mergeOpenWorker === m.name ? 'workers.mergeCancel' : 'workers.mergeBtn');
      btnMerge.onclick = () => {
        if (state.mergeOpenWorker === m.name) {
          state.mergeOpenWorker = null;
        } else {
          state.mergeOpenWorker = m.name;
          void bridge.previewMergeFromUi(m.name);
        }
        renderWorkers(members, diffs);
      };
      actions.appendChild(btnMerge);
    }

    if (m.status !== 'killed') {
      const btnReview = document.createElement('button');
      btnReview.type = 'button';
      btnReview.className = 'btn btn-sm btn-ghost';
      btnReview.textContent = tr('workers.reviewBtn');
      btnReview.onclick = () => void withBusyButton(btnReview, () => bridge.crossReviewFromUi(m.name));
      actions.appendChild(btnReview);
    }

    if (m.status === 'failed') {
      const btnRetry = document.createElement('button');
      btnRetry.type = 'button';
      btnRetry.className = 'btn btn-sm btn-primary';
      btnRetry.textContent = tr('workers.retryBtn');
      btnRetry.onclick = () =>
        void withBusyButton(btnRetry, () => bridge.retryOrSwitchWorker({ name: m.name }));
      actions.appendChild(btnRetry);
    }

    if (m.status === 'waiting' || m.status === 'failed') {
      const btnSwitch = document.createElement('button');
      btnSwitch.type = 'button';
      btnSwitch.className = 'btn btn-sm btn-ghost';
      btnSwitch.textContent = tr(
        state.switchOpenWorker === m.name ? 'workers.switchCancel' : 'workers.switchBtn',
      );
      btnSwitch.onclick = () => {
        if (state.switchOpenWorker === m.name) {
          state.switchOpenWorker = null;
        } else {
          state.switchOpenWorker = m.name;
          if (!state.switchDrafts.has(m.name)) {
            state.switchDrafts.set(m.name, {
              provider: m.provider || 'dsh',
              model: m.model || '',
              prompt: '',
            });
          }
        }
        renderWorkers(members, diffs);
      };
      actions.appendChild(btnSwitch);
    }

    const triggerKillConfirm = (removeWorktree: boolean) => {
      const isSame =
        state.pendingKillAction?.name === m.name && state.pendingKillAction.removeWorktree === removeWorktree;
      if (!isSame) {
        if (state.pendingKillTimer !== null) window.clearTimeout(state.pendingKillTimer);
        state.pendingKillAction = { name: m.name, removeWorktree };
        state.pendingKillTimer = window.setTimeout(() => {
          state.pendingKillAction = null;
          state.pendingKillTimer = null;
          if (state.activeTab === 'workers' && state.latestSnapshot?.swarm) {
            if (isEditingInsideWorkersList()) {
              state.workersDeferredRender = true;
            } else {
              renderWorkers(Object.values(state.latestSnapshot.swarm.members || {}), state.latestSnapshot.diffs || {});
            }
          }
        }, 3500);
        renderWorkers(members, diffs);
        return;
      }
      clearPendingKillState();
      void bridge.killWorkerFromUi(m.name, removeWorktree);
    };

    const hasWorktree = m.workspaceMode === 'worktree' && Boolean(m.branch);

    if (m.status !== 'killed') {
      const confirmingKill =
        state.pendingKillAction?.name === m.name && !state.pendingKillAction.removeWorktree;
      const btnKill = document.createElement('button');
      btnKill.type = 'button';
      btnKill.className = 'btn btn-sm btn-danger btn-kill-end';
      btnKill.textContent = confirmingKill ? tr('workers.confirmKill') : tr('workers.kill');
      btnKill.onclick = () => triggerKillConfirm(false);
      actions.appendChild(btnKill);

      if (hasWorktree) {
        const confirmingClean =
          state.pendingKillAction?.name === m.name && state.pendingKillAction.removeWorktree;
        const btnKillClean = document.createElement('button');
        btnKillClean.type = 'button';
        btnKillClean.className = 'btn btn-sm btn-ghost btn-ghost-danger';
        btnKillClean.textContent = confirmingClean
          ? tr('workers.confirmKillClean')
          : tr('workers.killCleanBtn');
        btnKillClean.onclick = () => triggerKillConfirm(true);
        actions.appendChild(btnKillClean);
      }
    } else if (hasWorktree) {
      const confirmingClean =
        state.pendingKillAction?.name === m.name && state.pendingKillAction.removeWorktree;
      const btnCleanWt = document.createElement('button');
      btnCleanWt.type = 'button';
      btnCleanWt.className = 'btn btn-sm btn-ghost btn-ghost-danger btn-kill-end';
      btnCleanWt.textContent = confirmingClean
        ? tr('workers.confirmKillClean')
        : tr('workers.cleanWtBtn');
      btnCleanWt.onclick = () => triggerKillConfirm(true);
      actions.appendChild(btnCleanWt);
    }

    card.appendChild(actions);

    if (state.switchOpenWorker === m.name && (m.status === 'waiting' || m.status === 'failed')) {
      const draft = state.switchDrafts.get(m.name) || {
        provider: m.provider || 'dsh',
        model: m.model || '',
        prompt: '',
      };
      const enabledProviders =
        state.latestSnapshot?.providerConfig?.providers?.filter((p) => p.enabled) ||
        state.latestProviderConfig?.providers?.filter((p) => p.enabled) ||
        [];
      const switchBox = document.createElement('div');
      switchBox.className = 'worker-switch-box';
      const provOptions = enabledProviders.length
        ? enabledProviders
            .map(
              (p) =>
                `<option value="${escapeHtml(p.id)}" ${p.id === draft.provider ? 'selected' : ''}>${escapeHtml(p.displayName)} (${escapeHtml(p.id)})</option>`,
            )
            .join('')
        : `<option value="${escapeHtml(draft.provider)}" selected>${escapeHtml(draft.provider)}</option>`;

      switchBox.innerHTML = `
        <div class="settings-form-grid">
          <label class="settings-field">
            <span>${escapeHtml(tr('workers.switchProvider'))}</span>
            <select class="input input-sm" data-sw-provider>${provOptions}</select>
          </label>
          <label class="settings-field">
            <span>${escapeHtml(tr('workers.switchModel'))}</span>
            <input class="input input-sm mono-input" type="text" list="dl-prov-models-${escapeHtml(draft.provider)}" data-sw-model value="${escapeHtml(draft.model)}" />
          </label>
          <label class="settings-field span-2">
            <span>${escapeHtml(tr('workers.switchPrompt'))}</span>
            <input class="input input-sm" type="text" data-sw-prompt value="${escapeHtml(draft.prompt)}" />
          </label>
        </div>
        <div class="settings-add-footer">
          <button type="button" class="btn btn-sm btn-primary" data-sw-apply>${escapeHtml(tr('workers.switchApply'))}</button>
        </div>
      `;
      const provSel = switchBox.querySelector<HTMLSelectElement>('[data-sw-provider]')!;
      const modelInp = switchBox.querySelector<HTMLInputElement>('[data-sw-model]')!;
      const promptInp = switchBox.querySelector<HTMLInputElement>('[data-sw-prompt]')!;
      let prevSwitchProvider = draft.provider;
      const syncDraft = () => {
        state.switchDrafts.set(m.name, {
          provider: provSel.value,
          model: modelInp.value,
          prompt: promptInp.value,
        });
      };
      provSel.addEventListener('change', () => {
        const prevProvDesc = enabledProviders.find((p) => p.id === prevSwitchProvider);
        const chosen = enabledProviders.find((p) => p.id === provSel.value);
        modelInp.setAttribute('list', `dl-prov-models-${provSel.value}`);
        const curModel = modelInp.value.trim();
        if (
          !curModel ||
          curModel === m.model ||
          (prevProvDesc?.defaultModel && curModel === prevProvDesc.defaultModel)
        ) {
          modelInp.value = chosen?.defaultModel || '';
        }
        prevSwitchProvider = provSel.value;
        syncDraft();
      });
      modelInp.addEventListener('input', syncDraft);
      promptInp.addEventListener('input', syncDraft);
      const swApplyBtn = switchBox.querySelector<HTMLButtonElement>('[data-sw-apply]')!;
      swApplyBtn.addEventListener('click', () => {
        void withBusyButton(swApplyBtn, async () => {
          const ok = await bridge.retryOrSwitchWorker({
            name: m.name,
            provider: provSel.value,
            model: modelInp.value.trim() || undefined,
            prompt: promptInp.value.trim() || undefined,
          });
          if (ok) {
            state.switchOpenWorker = null;
            state.switchDrafts.delete(m.name);
            if (state.latestSnapshot?.swarm) {
              renderWorkers(Object.values(state.latestSnapshot.swarm.members || {}), state.latestSnapshot.diffs || {});
            }
          }
        });
      });
      card.appendChild(switchBox);
    }

    if (state.mergeOpenWorker === m.name && m.branch && m.status !== 'killed') {
      const previewState = state.mergePreviews.get(m.name);
      const draft = state.mergeDrafts.get(m.name) || {
        mode: 'squash' as const,
        removeWt: true,
        commitMsg: '',
      };
      const mergeBox = document.createElement('div');
      mergeBox.className = 'worker-merge-box';

      let statusHtml = `<div class="empty-state-compact">${escapeHtml(tr('merge.checking'))}</div>`;
      const p = previewState?.data;
      if (previewState?.error) {
        statusHtml = `<div class="merge-status-conflict">${escapeHtml(previewState.error)}</div>`;
      } else if (p && !previewState?.loading) {
        statusHtml = p.canCleanMerge
          ? `<div class="merge-status-clean">${escapeHtml(tr('merge.clean', { commits: p.aheadCommits, files: p.changedFiles.length }))}</div>`
          : `<div class="merge-status-conflict">${escapeHtml(tr('merge.conflict'))}${escapeHtml(p.conflictFiles.join(', ') || p.conflictDetails[0] || '')}</div>`;
        if (p.dirtyFiles.length > 0) {
          statusHtml += `<div class="worker-meta">${escapeHtml(tr('merge.dirtyNote', { n: p.dirtyFiles.length }))}</div>`;
        }
        if (p.stat?.trim()) {
          statusHtml += `<pre class="merge-stat-pre">${escapeHtml(p.stat.trim())}</pre>`;
        }
      }

      const targetBranchLabel = p?.targetBranch || 'HEAD';
      mergeBox.innerHTML = `
        <div class="merge-box-title">${escapeHtml(tr('merge.title', { branch: m.branch, target: targetBranchLabel }))}</div>
        ${statusHtml}
        <div class="merge-controls-row">
          <label class="settings-field">
            <span>${escapeHtml(tr('merge.modeLabel'))}</span>
            <select class="input input-sm" data-mg-mode>
              <option value="squash" ${draft.mode === 'squash' ? 'selected' : ''}>${escapeHtml(tr('merge.modeSquash'))}</option>
              <option value="cherry-pick" ${draft.mode === 'cherry-pick' ? 'selected' : ''}>${escapeHtml(tr('merge.modeCherryPick'))}</option>
              <option value="merge" ${draft.mode === 'merge' ? 'selected' : ''}>${escapeHtml(tr('merge.modeMerge'))}</option>
            </select>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" data-mg-rm ${draft.removeWt ? 'checked' : ''} />
            <span>${escapeHtml(tr('merge.removeWt'))}</span>
          </label>
        </div>
        <label class="settings-field">
          <span>${escapeHtml(tr('merge.commitMsgLabel'))}</span>
          <input class="input input-sm" type="text" data-mg-msg value="${escapeHtml(draft.commitMsg)}" placeholder="${escapeHtml(tr('merge.commitMsgPlaceholder'))}" />
        </label>
        <div class="settings-add-footer">
          <button type="button" class="btn btn-sm btn-ghost" data-mg-recheck ${previewState?.loading ? 'disabled' : ''}>${escapeHtml(tr('merge.recheckBtn'))}</button>
          <button type="button" class="btn btn-sm btn-primary" data-mg-apply ${!p || !p.canCleanMerge || previewState?.loading ? 'disabled' : ''}>${escapeHtml(tr('merge.confirmBtn'))}</button>
        </div>
      `;

      const modeSel = mergeBox.querySelector<HTMLSelectElement>('[data-mg-mode]')!;
      const rmChk = mergeBox.querySelector<HTMLInputElement>('[data-mg-rm]')!;
      const msgInp = mergeBox.querySelector<HTMLInputElement>('[data-mg-msg]')!;
      const mgRecheckBtn = mergeBox.querySelector<HTMLButtonElement>('[data-mg-recheck]')!;
      const mgApplyBtn = mergeBox.querySelector<HTMLButtonElement>('[data-mg-apply]')!;
      const syncMergeDraft = () => {
        state.mergeDrafts.set(m.name, {
          mode: modeSel.value as 'squash' | 'cherry-pick' | 'merge',
          removeWt: rmChk.checked,
          commitMsg: msgInp.value,
        });
      };
      modeSel.addEventListener('change', syncMergeDraft);
      rmChk.addEventListener('change', syncMergeDraft);
      msgInp.addEventListener('input', syncMergeDraft);
      mgRecheckBtn.addEventListener('click', () => {
        void withBusyButton(mgRecheckBtn, () => bridge.previewMergeFromUi(m.name));
      });
      mgApplyBtn.addEventListener('click', () => {
        syncMergeDraft();
        void withBusyButton(mgApplyBtn, () => bridge.applyMergeFromUi(m.name));
      });
      card.appendChild(mergeBox);
    }

    dom.workersList.appendChild(card);
  }

  state.seenWorkerNames.clear();
  for (const m of members) {
    state.seenWorkerNames.add(m.name);
  }
}
