import type { BoardMessage, GraphEdge } from './types.js';

export function computeGraphEdgesFromMessages(
  messages: ReadonlyArray<Pick<BoardMessage, 'agent' | 'mentions' | 'all' | 'mentionsCoordinator'>>,
  memberNames: ReadonlyArray<string>,
): { edges: GraphEdge[]; postCounts: Map<string, number> } {
  const edgeMap = new Map<string, GraphEdge>();
  const postCounts = new Map<string, number>();

  for (const m of messages) {
    postCounts.set(m.agent, (postCounts.get(m.agent) || 0) + 1);
    const targets = new Set<string>(m.mentions);
    if (m.mentionsCoordinator && m.agent !== 'coordinator') {
      targets.add('coordinator');
    }
    if (m.all) {
      for (const name of memberNames) {
        if (name !== m.agent) targets.add(name);
      }
      if (m.agent !== 'coordinator') targets.add('coordinator');
    }
    for (const target of targets) {
      if (target === m.agent) continue;
      const key = `${m.agent}->${target}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count += 1;
        existing.viaAll = existing.viaAll || m.all;
      } else {
        edgeMap.set(key, { from: m.agent, to: target, count: 1, viaAll: m.all });
      }
    }
  }

  return { edges: Array.from(edgeMap.values()), postCounts };
}
