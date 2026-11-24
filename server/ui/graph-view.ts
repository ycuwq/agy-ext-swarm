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
} from './format.js';
import type {
  BoardMessage,
  SwarmState,
} from './types.js';
import { computeGraphEdgesFromMessages } from '../shared/graph.js';
import * as bridge from './bridge.js';

export function renderGraphAndReplay(swarm: SwarmState, messages: BoardMessage[]): void {
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
  dom.graphCaption.textContent =
    state.replaySeq === null
      ? tr('graph.liveCaption', { n: maxSeq })
      : tr('graph.replayCaption', { n: activeCutoff });

  const visibleMessages =
    state.replaySeq === null ? messages : messages.filter((m) => m.seq <= activeCutoff);
  const currentMsg = visibleMessages[visibleMessages.length - 1];

  const members = Object.values(swarm.members || {});
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

  const count = members.length;
  const extraCount = Math.max(0, count - 5);
  const width = Math.max(600, 600 + extraCount * 28);
  const height = Math.max(360, 360 + extraCount * 26);
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.min(width * 0.37, 205 + extraCount * 15);
  const ry = Math.min(height * 0.37, 122 + extraCount * 14);
  dom.mentionGraph.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const coords = new Map<string, { x: number; y: number }>();
  const coordY = members.length <= 2 ? 78 : cy;
  coords.set('coordinator', { x: cx, y: coordY });

  members.forEach((m, idx) => {
    if (members.length <= 2) {
      const spread = members.length === 1 ? 0 : idx === 0 ? -150 : 150;
      coords.set(m.name, { x: cx + spread, y: 245 });
    } else {
      const angle = (Math.PI * 2 * idx) / members.length - Math.PI / 2;
      coords.set(m.name, {
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
        return `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="var(--warning-text)" stroke-width="1.3" stroke-dasharray="3 4" opacity="0.52" marker-end="url(#arrow-normal)" />`;
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
      const dimmed = state.hoveredNode !== null && e.from !== state.hoveredNode && e.to !== state.hoveredNode;
      const stroke = isCurrent ? 'var(--success-text)' : 'var(--accent)';
      const opacity = dimmed ? 0.14 : isCurrent ? 0.98 : 0.56;
      const pathD = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      const pathId = `edge-path-${idx}`;

      const mx = 0.25 * sx + 0.5 * qx + 0.25 * ex;
      const my = 0.25 * sy + 0.5 * qy + 0.25 * ey;

      return `
        <g opacity="${opacity}">
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

  const allNodes = ['coordinator', ...memberNames];
  const nodesSvg = allNodes
    .map((name) => {
      const p = coords.get(name);
      if (!p) return '';
      const m = members.find((item) => item.name === name);
      const isWorking = m?.status === 'working' || m?.status === 'queued';
      const isActiveActor =
        currentMsg && (currentMsg.agent === name || activeEdgeKeys.has(`${currentMsg.agent}->${name}`));
      const dimmed =
        state.hoveredNode !== null &&
        state.hoveredNode !== name &&
        !edges.some((e) => (e.from === state.hoveredNode && e.to === name) || (e.to === state.hoveredNode && e.from === name));

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
        <g class="graph-node" data-node="${escapeHtml(name)}" opacity="${dimmed ? 0.3 : 1}" style="cursor:pointer">
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

  dom.mentionGraph.innerHTML = `${defs}${depEdgesSvg}${edgesSvg}${nodesSvg}`;

  dom.mentionGraph.querySelectorAll<SVGGElement>('.graph-node').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      state.hoveredNode = g.dataset.node || null;
      renderGraphAndReplay(swarm, messages);
    });
    g.addEventListener('mouseleave', () => {
      state.hoveredNode = null;
      renderGraphAndReplay(swarm, messages);
    });
    g.addEventListener('click', () => {
      const nodeName = g.dataset.node || null;
      if (!nodeName) return;
      state.selectedAgentFilter = nodeName;
      state.dirtyTabs.add('board');
      bridge.switchTab('board');
    });
  });

  if (!currentMsg) {
    dom.replayPreview.innerHTML = `<div class="empty-state-compact">${escapeHtml(tr('graph.noMessages'))}</div>`;
  } else {
    const route = formatRouteText(currentMsg);
    dom.replayPreview.innerHTML = `
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
  renderGraphAndReplay(state.latestSnapshot.swarm, state.latestSnapshot.messages);
}
