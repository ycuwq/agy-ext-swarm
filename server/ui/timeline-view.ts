import * as bridge from './bridge.js';
import { tr } from './context.js';
import { escapeHtml, formatDurationMs, formatNum } from './format.js';
import { formatMemberModelWithOptions, providerBadgeClass, statusLabel } from './helpers.js';
import { state } from './store.js';
import { selectNativeSubagents } from './telemetry-selectors.js';
import type { Snapshot, WorkerStatus } from './types.js';

interface SwimlaneItem {
  kind: 'external' | 'native';
  id: string;
  label: string;
  providerBadge: string;
  providerClass: string;
  status: WorkerStatus;
  model: string;
  startMs: number;
  endMs: number;
  totalTokens: number;
}

export function renderSwimlaneTimeline(container: HTMLElement, snap: Snapshot): void {
  const members = snap.swarm ? Object.values(snap.swarm.members || {}) : [];
  const nativeSubs = state.graphShowNative ? selectNativeSubagents(snap, 'current') : [];
  const nowMs = Date.now();

  const items: SwimlaneItem[] = [];

  for (const m of members) {
    const startMs = Date.parse(m.lastTurnStartedAt || m.createdAt);
    const rawEnd =
      m.status === 'working'
        ? nowMs
        : Date.parse(m.lastTurnFinishedAt || (m.status === 'queued' ? m.createdAt : m.updatedAt) || m.createdAt);
    const safeStart = Number.isFinite(startMs) ? startMs : nowMs;
    const safeEnd = Number.isFinite(rawEnd) && rawEnd >= safeStart ? rawEnd : safeStart;
    items.push({
      kind: 'external',
      id: m.name,
      label: m.name,
      providerBadge: m.provider || 'dsh',
      providerClass: providerBadgeClass(m.provider),
      status: m.status,
      model: formatMemberModelWithOptions(m),
      startMs: safeStart,
      endMs: safeEnd,
      totalTokens: m.usage?.totalTokens || 0,
    });
  }

  for (const sub of nativeSubs) {
    const startMs = Date.parse(sub.createdAt || sub.lastTurnStartedAt || sub.updatedAt);
    const rawEnd =
      sub.status === 'working'
        ? nowMs
        : Date.parse(sub.lastTurnFinishedAt || sub.updatedAt || sub.createdAt);
    const safeStart = Number.isFinite(startMs) ? startMs : nowMs;
    const safeEnd = Number.isFinite(rawEnd) && rawEnd >= safeStart ? rawEnd : safeStart;
    items.push({
      kind: 'native',
      id: sub.id,
      label: sub.role,
      providerBadge: 'native',
      providerClass: 'prov-native',
      status: sub.status,
      model: sub.model,
      startMs: safeStart,
      endMs: safeEnd,
      totalTokens: sub.usageSinceSwarm.totalTokens > 0 ? sub.usageSinceSwarm.totalTokens : sub.usage.totalTokens,
    });
  }

  if (items.length === 0) {
    container.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('graph.timelineEmpty'))}</div>`;
    return;
  }

  items.sort((a, b) => a.startMs - b.startMs);

  let minStart = items[0].startMs;
  let maxEnd = items[0].endMs;
  for (const it of items) {
    if (it.startMs < minStart) minStart = it.startMs;
    if (it.endMs > maxEnd) maxEnd = it.endMs;
  }
  const spanMs = Math.max(1000, maxEnd - minStart);

  const rowsHtml = items
    .map((it) => {
      const leftPct = Math.max(0, Math.min(96, ((it.startMs - minStart) / spanMs) * 100));
      const rawWidthPct = ((it.endMs - it.startMs) / spanMs) * 100;
      const widthPct = Math.max(3, Math.min(100 - leftPct, rawWidthPct));
      const durText = formatDurationMs(Math.max(0, it.endMs - it.startMs));
      const barCls = [
        'swimlane-bar',
        it.kind === 'native' ? 'is-native' : 'is-external',
        it.status === 'working' ? 'is-working' : '',
        it.status === 'failed' ? 'is-failed' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return `
        <button type="button" class="swimlane-row" data-lane-kind="${it.kind}" data-lane-id="${escapeHtml(it.id)}" data-lane-label="${escapeHtml(it.label)}" title="${escapeHtml(`${it.label} · ${it.model} · ${statusLabel(it.status)}`)}">
          <span class="swimlane-label">
            <span class="status-dot ${escapeHtml(it.status)}"></span>
            <span class="swimlane-name">${escapeHtml(it.label)}</span>
            <span class="provider-badge ${it.providerClass}">${escapeHtml(it.providerBadge)}</span>
          </span>
          <span class="swimlane-track">
            <span class="${barCls}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%"></span>
          </span>
          <span class="swimlane-stats">
            <span>${escapeHtml(durText)}</span>
            <span class="swimlane-tok">${escapeHtml(formatNum(it.totalTokens))}</span>
          </span>
        </button>
      `;
    })
    .join('');

  container.innerHTML = `
    <div class="swimlane-axis">
      <span>0s</span>
      <span>${escapeHtml(formatDurationMs(Math.round(spanMs / 2)))}</span>
      <span>${escapeHtml(formatDurationMs(spanMs))}</span>
    </div>
    <div class="swimlane-list">${rowsHtml}</div>
  `;

  container.querySelectorAll<HTMLButtonElement>('.swimlane-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.laneKind;
      const id = btn.dataset.laneId;
      const label = btn.dataset.laneLabel || id || '';
      if (!id) return;
      if (kind === 'native') {
        void bridge.openNativeSubagentLogs(id, label);
      } else {
        void bridge.openWorkerLogs(id);
      }
    });
  });
}
