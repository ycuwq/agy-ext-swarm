/**
 * Topology SVG graph renderer and replay transport.
 *
 * Extracted verbatim from the former monolithic `ui/app.ts`; identifiers are
 * bound as follows:
 *   state  -> `store.ts`    (shared mutable UI state)
 *   dom    -> `dom.ts`      (typed DOM refs)
 *   bridge -> `bridge.ts`   (callbacks still owned by the entrypoint)
 * This keeps the module graph acyclic: views never import `app.ts`.
 */
import { formatRouteText, formatTime } from './helpers.js';
import { tr } from './context.js';
import { state } from './store.js';
import * as dom from './dom.js';
import {
  escapeHtml,
  formatMessageHtml,
  formatNum,
} from './format.js';
import { selectNativeSubagents } from './telemetry-selectors.js';
import { renderSwimlaneTimeline } from './timeline-view.js';
import type {
  BoardMessage,
  NativeSubagentState,
  Snapshot,
} from './types.js';
import { computeGraphEdgesFromMessages } from '../shared/graph.js';
import * as bridge from './bridge.js';

function nativeNodeKey(id: string): string {
  return `native:${id}`;
}

function truncateGraphLabel(text: string, maxLen = 18): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

let replayPreviewContext: {
  hasSwarm: boolean;
  currentMsg?: BoardMessage;
  nativeSubs: NativeSubagentState[];
} | null = null;
let previousPreviewHtml = '';

function getGraphNode(target: EventTarget | null): SVGGElement | null {
  return target instanceof Element ? target.closest<SVGGElement>('.graph-node') : null;
}

function updateHoveredNode(node: string | null): void {
  state.hoveredNode = node;
  const connected = new Set<string>();
  if (node) connected.add(node);
  dom.mentionGraph.querySelectorAll<SVGElement>('.graph-edge').forEach((edge) => {
    const from = edge.dataset.from;
    const to = edge.dataset.to;
    const touchesNode = node === from || node === to;
    edge.classList.toggle('is-dimmed', Boolean(node) && !touchesNode);
    if (touchesNode && from && to) {
      connected.add(from);
      connected.add(to);
    }
  });
  dom.mentionGraph.querySelectorAll<SVGGElement>('.graph-node').forEach((el) => {
    const key = el.dataset.node || '';
    el.classList.toggle('is-dimmed', Boolean(node) && !connected.has(key));
    el.classList.toggle('is-hovered', key === node);
  });
  renderReplayPreview();
}

function activateGraphNode(node: SVGGElement): void {
  const nativeId = node.dataset.nativeId;
  if (nativeId) {
    void bridge.openNativeSubagentLogs(nativeId, node.dataset.nativeRole || nativeId.slice(0, 8));
  } else if (node.dataset.node) {
    state.selectedAgentFilter = node.dataset.node;
    state.dirtyTabs.add('board');
    bridge.switchTab('board');
  }
}

export function bindGraphEvents(): void {
  const graph = dom.mentionGraph;
  const focusedNode = () => getGraphNode(document.activeElement)?.dataset.node || null;
  graph.addEventListener('mouseover', (event) => {
    const node = getGraphNode(event.target);
    if (node && node !== getGraphNode(event.relatedTarget)) {
      updateHoveredNode(node.dataset.node || null);
    }
  });
  graph.addEventListener('mouseout', (event) => {
    if (getGraphNode(event.target) && !getGraphNode(event.relatedTarget)) {
      updateHoveredNode(focusedNode());
    }
  });
  graph.addEventListener('mouseleave', () => updateHoveredNode(focusedNode()));
  graph.addEventListener('focusin', () => updateHoveredNode(focusedNode()));
  graph.addEventListener('focusout', (event) => {
    if (!getGraphNode(event.relatedTarget)) updateHoveredNode(null);
  });
  graph.addEventListener('click', (event) => {
    const node = getGraphNode(event.target);
    if (node) activateGraphNode(node);
  });
  graph.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const node = getGraphNode(event.target);
    if (!node) return;
    event.preventDefault();
    if (!event.repeat) activateGraphNode(node);
  });
}

export function renderGraphAndReplay(snap: Snapshot): void {
  const swarm = snap.swarm;
  const messages = snap.messages || [];
  const members = swarm ? Object.values(swarm.members || {}) : [];
  const nativeSubs = state.graphShowNative ? selectNativeSubagents(snap, 'current') : [];

  dom.graphModeTopology.classList.toggle('active', state.graphViewMode === 'topology');
  dom.graphModeTimeline.classList.toggle('active', state.graphViewMode === 'timeline');
  dom.graphModeTopology.setAttribute('aria-pressed', String(state.graphViewMode === 'topology'));
  dom.graphModeTimeline.setAttribute('aria-pressed', String(state.graphViewMode === 'timeline'));
  dom.graphToggleNative.checked = state.graphShowNative;

  const isTimeline = state.graphViewMode === 'timeline';
  dom.mentionGraph.classList.toggle('hidden', isTimeline);
  dom.graphLegend.classList.toggle('hidden', isTimeline);
  dom.timelineStage.classList.toggle('hidden', !isTimeline);
  dom.replayBar.classList.toggle('hidden', isTimeline || !swarm);
  dom.replayPreview.classList.toggle('hidden', isTimeline);

  if (isTimeline) {
    dom.graphCaption.textContent = tr('graph.timelineCaption', {
      total: members.length + nativeSubs.length,
      external: members.length,
      native: nativeSubs.length,
    });
    renderSwimlaneTimeline(dom.timelineStage, snap);
    replayPreviewContext = null;
    state.hoveredNode = null;
    return;
  }

  const maxSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0;
  dom.replaySlider.min = '1';
  dom.replaySlider.max = String(Math.max(1, maxSeq));

  if (state.replaySeq !== null && state.replaySeq > maxSeq) {
    state.replaySeq = maxSeq > 0 ? maxSeq : null;
  }

  const activeCutoff = state.replaySeq ?? maxSeq;
  dom.replaySlider.value = String(Math.max(1, activeCutoff));
  dom.replaySlider.disabled = maxSeq === 0;
  dom.replayPlayBtn.disabled = maxSeq <= 1;
  dom.replayPrevBtn.disabled = maxSeq === 0 || activeCutoff <= 1;
  dom.replayNextBtn.disabled = maxSeq === 0 || activeCutoff >= maxSeq;
  dom.replayLiveBtn.classList.toggle('active', state.replaySeq === null);

  dom.replayCounter.textContent = maxSeq === 0 ? '0 / 0' : `#${activeCutoff} / ${maxSeq}`;
  if (state.replaySeq !== null) {
    dom.graphCaption.textContent = tr('graph.replayCaption', { n: activeCutoff });
  } else if (nativeSubs.length > 0) {
    dom.graphCaption.textContent = tr('graph.liveCaptionNative', {
      n: maxSeq,
      native: nativeSubs.length,
    });
  } else {
    dom.graphCaption.textContent = tr('graph.liveCaption', { n: maxSeq });
  }

  const visibleMessages =
    state.replaySeq === null ? messages : messages.filter((m) => m.seq <= activeCutoff);
  const currentMsg = visibleMessages[visibleMessages.length - 1];

  const memberNames = members.map((m) => m.name);
  const { edges, postCounts: counts } = computeGraphEdgesFromMessages(visibleMessages, memberNames);

  const activeEdgeKeys = new Set<string>();
  if (currentMsg) {
    if (currentMsg.all) {
      for (const mName of memberNames) {
        if (mName !== currentMsg.agent) activeEdgeKeys.add(`${currentMsg.agent}->${mName}`);
      }
      if (currentMsg.agent !== 'coordinator') {
        activeEdgeKeys.add(`${currentMsg.agent}->coordinator`);
      }
    } else {
      for (const targetName of currentMsg.mentions) {
        activeEdgeKeys.add(`${currentMsg.agent}->${targetName}`);
      }
      if (currentMsg.mentionsCoordinator && currentMsg.agent !== 'coordinator') {
        activeEdgeKeys.add(`${currentMsg.agent}->coordinator`);
      }
    }
  }

  const totalSatellites = members.length + nativeSubs.length;
  const extraCount = Math.max(0, totalSatellites - 5);
  const width = Math.max(600, 600 + extraCount * 32);
  const height = Math.max(360, 360 + extraCount * 28);
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.min(width * 0.38, 210 + extraCount * 16);
  const ry = Math.min(height * 0.37, 124 + extraCount * 15);
  dom.mentionGraph.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const coords = new Map<string, { x: number; y: number }>();
  const coordY = totalSatellites <= 2 ? 78 : cy;
  coords.set('coordinator', { x: cx, y: coordY });

  const satelliteIds = [
    ...members.map((m) => m.name),
    ...nativeSubs.map((s) => nativeNodeKey(s.id)),
  ];
  satelliteIds.forEach((nodeKey, idx) => {
    if (satelliteIds.length <= 2) {
      const spread = satelliteIds.length === 1 ? 0 : idx === 0 ? -155 : 155;
      coords.set(nodeKey, { x: cx + spread, y: 245 });
    } else {
      const angle = (Math.PI * 2 * idx) / satelliteIds.length - Math.PI / 2;
      coords.set(nodeKey, {
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry,
      });
    }
  });

  const edgeDirSet = new Set(edges.map((e) => `${e.from}->${e.to}`));

  const defs = `
    <defs>
      <pattern id="dot-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <circle cx="10" cy="10" r="1" fill="var(--text-3)" opacity="0.18" />
      </pattern>
      <radialGradient id="hub-aura" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.18" />
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
      </radialGradient>
      <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <marker id="arrow-normal" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--accent)" opacity="0.72" />
      </marker>
      <marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--success-text)" />
      </marker>
      <marker id="arrow-native" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="var(--accent-2)" opacity="0.82" />
      </marker>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#dot-grid)" />
    <circle cx="${cx}" cy="${coordY}" r="120" fill="url(#hub-aura)" />
  `;

  const depEdgesSvg = members
    .flatMap((m) =>
      (m.dependsOn || []).map((depName) => {
        const p1 = coords.get(depName);
        const p2 = coords.get(m.name);
        if (!p1 || !p2) return '';
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const sx = p1.x + (dx / len) * 24;
        const sy = p1.y + (dy / len) * 24;
        const ex = p2.x - (dx / len) * 26;
        const ey = p2.y - (dy / len) * 26;
        return `<line class="graph-edge" data-from="${escapeHtml(depName)}" data-to="${escapeHtml(m.name)}" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="var(--warning-text)" stroke-width="1.3" stroke-dasharray="3 4" opacity="0.52" marker-end="url(#arrow-normal)" />`;
      }),
    )
    .join('');

  const edgesSvg = edges
    .map((e, idx) => {
      const p1 = coords.get(e.from);
      const p2 = coords.get(e.to);
      if (!p1 || !p2) return '';

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;

      const hasReverse = edgeDirSet.has(`${e.to}->${e.from}`);
      const curveOffset = hasReverse ? 30 : 12;
      const qx = (p1.x + p2.x) / 2 + nx * curveOffset;
      const qy = (p1.y + p2.y) / 2 + ny * curveOffset;

      const startPad = 24;
      const endPad = 28;
      const sx = p1.x + (dx / len) * startPad;
      const sy = p1.y + (dy / len) * startPad;
      const ex = p2.x - (dx / len) * endPad;
      const ey = p2.y - (dy / len) * endPad;

      const edgeKey = `${e.from}->${e.to}`;
      const isCurrent = activeEdgeKeys.has(edgeKey);
      const stroke = isCurrent ? 'var(--success-text)' : 'var(--accent)';
      const opacity = isCurrent ? 0.98 : 0.56;
      const pathD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      const pathId = `edge-path-${idx}`;

      const mx = 0.25 * sx + 0.5 * qx + 0.25 * ex;
      const my = 0.25 * sy + 0.5 * qy + 0.25 * ey;

      return `
        <g class="graph-edge" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}" opacity="${opacity}">
          <path id="${pathId}" d="${pathD}" fill="none" stroke="${stroke}"
            class="${isCurrent ? 'edge-stream' : ''}"
            filter="${isCurrent ? 'url(#glow)' : 'none'}"
            stroke-width="${isCurrent ? 2.6 : Math.min(3.4, 1.2 + e.count * 0.45)}"
            stroke-dasharray="${e.viaAll ? '5 3' : isCurrent ? '6 5' : 'none'}"
            marker-end="url(#${isCurrent ? 'arrow-active' : 'arrow-normal'})" />
          ${
            isCurrent
              ? `<circle r="4.5" fill="var(--success-text)" filter="url(#glow)">
                   <animateMotion dur="1.05s" repeatCount="indefinite">
                     <mpath href="#${pathId}" />
                   </animateMotion>
                 </circle>`
              : ''
          }
          <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="9.5" fill="var(--bg-2)" stroke="var(--border-1)" />
          <text x="${mx.toFixed(1)}" y="${(my + 3.5).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="700" fill="var(--text-1)">${e.count}</text>
        </g>
      `;
    })
    .join('');

  const nativeEdgesSvg = nativeSubs
    .map((sub, idx) => {
      const nKey = nativeNodeKey(sub.id);
      const pCoord = coords.get('coordinator');
      const pNative = coords.get(nKey);
      if (!pCoord || !pNative) return '';

      const dx = pNative.x - pCoord.x;
      const dy = pNative.y - pCoord.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;

      const opacity = sub.status === 'working' ? 0.9 : 0.62;

      const sx = pCoord.x + (dx / len) * 24;
      const sy = pCoord.y + (dy / len) * 24;
      const ex = pNative.x - (dx / len) * 28;
      const ey = pNative.y - (dy / len) * 28;
      const hasReply = sub.messagesToParent > 0;
      const qx = (pCoord.x + pNative.x) / 2 + nx * (hasReply ? 22 : 10);
      const qy = (pCoord.y + pNative.y) / 2 + ny * (hasReply ? 22 : 10);
      const dispatchPathD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      const dispatchPathId = `native-dispatch-${idx}`;

      let replySvg = '';
      if (hasReply) {
        const rsx = pNative.x - (dx / len) * 24;
        const rsy = pNative.y - (dy / len) * 24;
        const rex = pCoord.x + (dx / len) * 28;
        const rey = pCoord.y + (dy / len) * 28;
        const rqx = (pCoord.x + pNative.x) / 2 - nx * 22;
        const rqy = (pCoord.y + pNative.y) / 2 - ny * 22;
        const rPathD = `M ${rsx.toFixed(1)} ${rsy.toFixed(1)} Q ${rqx.toFixed(1)} ${rqy.toFixed(1)} ${rex.toFixed(1)} ${rey.toFixed(1)}`;
        const mx = 0.25 * rsx + 0.5 * rqx + 0.25 * rex;
        const my = 0.25 * rsy + 0.5 * rqy + 0.25 * rey;
        replySvg = `
          <path d="${rPathD}" fill="none" stroke="var(--accent-2)" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#arrow-native)" />
          <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="8.5" fill="var(--bg-2)" stroke="var(--accent-2)" stroke-dasharray="2 2" />
          <text x="${mx.toFixed(1)}" y="${(my + 3.2).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent-2)">${sub.messagesToParent}</text>
        `;
      }

      return `
        <g class="graph-edge" data-from="coordinator" data-to="${escapeHtml(nKey)}" opacity="${opacity}">
          <path id="${dispatchPathId}" d="${dispatchPathD}" fill="none" stroke="var(--accent-2)"
            class="${sub.status === 'working' ? 'edge-stream' : ''}"
            stroke-width="${sub.status === 'working' ? 2.1 : 1.4}"
            stroke-dasharray="4 4"
            marker-end="url(#arrow-native)" />
          ${
            sub.status === 'working'
              ? `<circle r="3.8" fill="var(--accent-2)" filter="url(#glow)">
                   <animateMotion dur="1.2s" repeatCount="indefinite">
                     <mpath href="#${dispatchPathId}" />
                   </animateMotion>
                 </circle>`
              : ''
          }
          ${replySvg}
        </g>
      `;
    })
    .join('');

  const allExternalNodes = ['coordinator', ...memberNames];
  const externalNodesSvg = allExternalNodes
    .map((name) => {
      const p = coords.get(name);
      if (!p) return '';
      const m = members.find((item) => item.name === name);
      const isWorking = m?.status === 'working' || m?.status === 'queued';
      const isActiveActor =
        currentMsg && (currentMsg.agent === name || activeEdgeKeys.has(`${currentMsg.agent}->${name}`));
      const dotColor =
        name === 'coordinator'
          ? 'var(--accent)'
          : isWorking
            ? 'var(--info-text)'
            : m?.status === 'blocked'
              ? 'var(--warning-text)'
              : m?.status === 'failed'
                ? 'var(--danger-text)'
                : m?.status === 'killed'
                  ? 'var(--text-3)'
                  : 'var(--success-text)';

      const postCount = counts.get(name) || 0;
      const label = postCount > 0 ? `${name} (${postCount})` : name;
      const boxW = Math.max(90, label.length * 7.2 + 28);

      const workingRings = isWorking
        ? `
          <rect class="sonar-ring" x="${(p.x - boxW / 2 - 4).toFixed(1)}" y="${(p.y - 20).toFixed(1)}"
            width="${(boxW + 8).toFixed(1)}" height="40" rx="20"
            fill="none" stroke="var(--info-text)" stroke-width="1.5" />
          <ellipse class="orbit-ring" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}"
            rx="${(boxW / 2 + 10).toFixed(1)}" ry="24"
            fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55" />
        `
        : '';

      return `
        <g class="graph-node" data-node="${escapeHtml(name)}" tabindex="0" role="button" aria-label="${escapeHtml(tr('graph.filterNode', { name }))}">
          ${workingRings}
          <rect x="${(p.x - boxW / 2).toFixed(1)}" y="${(p.y - 16).toFixed(1)}"
            width="${boxW.toFixed(1)}" height="32" rx="16"
            fill="var(--bg-1)" stroke="${isActiveActor ? 'var(--success-text)' : dotColor}"
            filter="${isWorking || isActiveActor ? 'url(#glow)' : 'none'}"
            stroke-width="${isActiveActor || isWorking ? 2.3 : 1.6}" />
          <circle cx="${(p.x - boxW / 2 + 13).toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="${dotColor}" />
          <text x="${(p.x + 6).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle"
            font-size="11.5" font-weight="600" fill="var(--text-1)">${escapeHtml(label)}</text>
        </g>
      `;
    })
    .join('');

  const nativeNodesSvg = nativeSubs
    .map((sub) => {
      const nKey = nativeNodeKey(sub.id);
      const p = coords.get(nKey);
      if (!p) return '';
      const isWorking = sub.status === 'working';
      const dotColor =
        isWorking
          ? 'var(--accent-2)'
          : sub.status === 'failed'
            ? 'var(--danger-text)'
            : sub.status === 'killed'
              ? 'var(--text-3)'
              : 'var(--success-text)';

      const shortRole = truncateGraphLabel(sub.role, 16);
      const label = sub.messagesToParent > 0 ? `${shortRole} (${sub.messagesToParent})` : shortRole;
      const boxW = Math.max(96, label.length * 7.0 + 30);

      const workingRings = isWorking
        ? `
          <rect class="sonar-ring" x="${(p.x - boxW / 2 - 4).toFixed(1)}" y="${(p.y - 20).toFixed(1)}"
            width="${(boxW + 8).toFixed(1)}" height="40" rx="12"
            fill="none" stroke="var(--accent-2)" stroke-width="1.4" />
        `
        : '';

      return `
        <g class="graph-node is-native-node" data-node="${escapeHtml(nKey)}" data-native-id="${escapeHtml(sub.id)}" data-native-role="${escapeHtml(sub.role)}" tabindex="0" role="button" aria-label="${escapeHtml(tr('graph.openNativeTrace', { name: sub.role }))}">
          ${workingRings}
          <rect x="${(p.x - boxW / 2).toFixed(1)}" y="${(p.y - 16).toFixed(1)}"
            width="${boxW.toFixed(1)}" height="32" rx="10"
            fill="var(--bg-2)" stroke="${isWorking ? 'var(--accent-2)' : dotColor}"
            stroke-dasharray="4 3"
            filter="${isWorking ? 'url(#glow)' : 'none'}"
            stroke-width="${isWorking ? 2.1 : 1.5}" />
          <circle cx="${(p.x - boxW / 2 + 13).toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.2" fill="${dotColor}" />
          <text x="${(p.x + 6).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle"
            font-size="11" font-weight="600" fill="var(--text-1)">${escapeHtml(label)}</text>
        </g>
      `;
    })
    .join('');

  const focusedKey = getGraphNode(document.activeElement)?.dataset.node;
  const hoveredKey = state.hoveredNode;
  dom.mentionGraph.innerHTML = `${defs}${depEdgesSvg}${nativeEdgesSvg}${edgesSvg}${externalNodesSvg}${nativeNodesSvg}`;
  replayPreviewContext = { hasSwarm: Boolean(swarm), currentMsg, nativeSubs };
  const nodes = [...dom.mentionGraph.querySelectorAll<SVGGElement>('.graph-node')];
  const focused = focusedKey && nodes.find((node) => node.dataset.node === focusedKey);
  if (focused) focused.focus({ preventScroll: true });
  updateHoveredNode(nodes.some((node) => node.dataset.node === hoveredKey) ? hoveredKey : null);
}

function renderReplayPreview(): void {
  if (!replayPreviewContext) return;
  const { nativeSubs, currentMsg, hasSwarm } = replayPreviewContext;
  let html: string;
  const hoveredNative: NativeSubagentState | undefined = state.hoveredNode?.startsWith('native:')
    ? nativeSubs.find((s) => nativeNodeKey(s.id) === state.hoveredNode)
    : undefined;

  if (hoveredNative) {
    html = `
      <div class="msg-header">
        <div class="msg-author-wrap">
          <span class="msg-author">${escapeHtml(hoveredNative.role)}</span>
          <span class="provider-badge prov-native">${escapeHtml(tr('workers.nativeBadge'))}</span>
          <span class="msg-seq">${escapeHtml(hoveredNative.shortId)}</span>
        </div>
        <span class="msg-time">${escapeHtml(formatNum(hoveredNative.usage.totalTokens))} tok</span>
      </div>
      <div class="msg-body">${escapeHtml(
        tr('graph.nativePreviewMeta', {
          type: hoveredNative.typeName,
          model: hoveredNative.model,
          steps: hoveredNative.steps,
        }),
      )}${hoveredNative.lastReplyPreview ? `\n${escapeHtml(hoveredNative.lastReplyPreview)}` : ''}</div>
    `;
  } else if (!currentMsg) {
    html = `<div class="empty-state-compact">${escapeHtml(
      hasSwarm ? tr('graph.noMessages') : tr('graph.noTraffic'),
    )}</div>`;
  } else {
    const route = formatRouteText(currentMsg);
    html = `
      <div class="msg-header">
        <div class="msg-author-wrap">
          <span class="msg-author${currentMsg.agent === 'coordinator' ? ' is-coord' : ''}">${escapeHtml(currentMsg.agent)}</span>
          ${route ? `<span class="msg-route">${escapeHtml(route)}</span>` : ''}
          <span class="msg-seq">#${currentMsg.seq}</span>
        </div>
        <span class="msg-time">${escapeHtml(formatTime(currentMsg.time))}</span>
      </div>
      <div class="msg-body">${formatMessageHtml(currentMsg.text.slice(0, 600))}${currentMsg.text.length > 600 ? '...' : ''}</div>
    `;
  }
  if (html !== previousPreviewHtml) {
    previousPreviewHtml = html;
    dom.replayPreview.innerHTML = html;
  }
}

export function stopReplayPlayback(): void {
  state.replayPlaying = false;
  dom.replayPlayBtn.textContent = tr('graph.play');
  if (state.replayTimer !== null) {
    window.clearInterval(state.replayTimer);
    state.replayTimer = null;
  }
}

export function stepReplay(nextSeq: number): void {
  if (!state.latestSnapshot?.swarm) return;
  const maxSeq = state.latestSnapshot.messages.length
    ? state.latestSnapshot.messages[state.latestSnapshot.messages.length - 1].seq
    : 0;
  if (maxSeq === 0) return;
  const clamped = Math.max(1, Math.min(maxSeq, nextSeq));
  state.replaySeq = clamped >= maxSeq && !state.replayPlaying ? null : clamped;
  renderGraphAndReplay(state.latestSnapshot);
}
