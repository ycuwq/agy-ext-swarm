import { formatModelWithOptions } from '../shared/model-options.js';
import {
  calcMemberCost,
  calcModelCost,
  formatMoney,
  type CostDisplayOptions,
} from '../shared/pricing.js';
import type {
  BoardMessage,
  HostTelemetrySnapshot,
  ModelPricing,
  SwarmState,
  WorktreeDiffSummary,
} from './types.js';

export function buildSwarmMarkdownReport(
  swarm: SwarmState,
  diffs: Record<string, WorktreeDiffSummary | null>,
  messages: BoardMessage[],
  hostTelemetry?: HostTelemetrySnapshot,
  pricing?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
  displayOpts?: CostDisplayOptions,
): { filename: string; markdown: string } {
  const members = Object.values(swarm.members);

  const calcModelCostText = (
    model: string,
    inputTok: number,
    cacheTok: number,
    outputTok: number,
  ): string => {
    const c = calcModelCost(model, inputTok, cacheTok, outputTok, pricing, catalogPricing, displayOpts);
    return c ? formatMoney(c.amount, c.currency) : '-';
  };

  const fmtTo = (s: number) => (s === 0 ? 'off' : `${s}s`);
  const lines: string[] = [
    `# AGY Ext Swarm Report: ${swarm.title}`,
    '',
    `- **Swarm ID**: \`${swarm.id}\``,
    `- **Workspace**: \`${swarm.repoRoot}\``,
    `- **Default Provider**: \`${swarm.defaultProvider}\` (profile: \`${swarm.profile}\`)`,
    `- **Created / Updated**: ${swarm.createdAt} → ${swarm.updatedAt}`,
    `- **Messages / Hops**: ${swarm.headSeq} posts · ${swarm.hopCount}/${swarm.maxHops} hops`,
    `- **Timeouts**: turn=${fmtTo(swarm.turnTimeoutSeconds)} · stall=${fmtTo(swarm.stallTimeoutSeconds)}`,
    '',
    '## Workers',
    '',
    '| Worker | Status | Provider | Model | Turns/Steps | Tokens (In / Cache / Out) | Est. Cost | Branch / Changed |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  let totalWorkerTokens = 0;
  let totalWorkerIn = 0;
  let totalWorkerCache = 0;
  for (const m of members) {
    const u = m.usage || { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 };
    totalWorkerTokens += u.totalTokens;
    totalWorkerIn += u.inputTokens;
    totalWorkerCache += u.cacheReadTokens;
    const diff = diffs[m.name];
    const branchSummary = m.branch
      ? `\`${m.branch}\` (${diff?.commitCount ?? 0} commits, ${diff?.changedFiles?.length ?? 0} files)`
      : m.workspaceMode;
    const memberCost = calcMemberCost(m, pricing, catalogPricing, displayOpts);
    const costTxt = memberCost ? formatMoney(memberCost.amount, memberCost.currency) : '-';
    const effectiveModel = m.model === 'default' && m.resolvedModel ? m.resolvedModel : m.model;
    const modelLabel = formatModelWithOptions(
      effectiveModel,
      m.reasoningEffort || m.resolvedReasoningEffort,
      m.fastMode ?? m.resolvedFastMode,
    );
    lines.push(
      `| ${m.name} | ${m.status} | ${m.provider} | ${modelLabel} | ${m.turns}/${m.steps} | ${u.totalTokens} (${u.inputTokens}/${u.cacheReadTokens}/${u.outputTokens}) | ${costTxt} | ${branchSummary} |`,
    );
  }

  const nativeSubs = (hostTelemetry?.subagents || []).filter((s) => s.inCurrentSwarm);
  if (nativeSubs.length > 0) {
    lines.push(
      '',
      '## Native Subagents (AGY)',
      '',
      '| Role | Type | Status | Model | Turns/Steps | Tokens (In / Cache / Out) | Est. Cost | Messages |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const sub of nativeSubs) {
      const u = sub.usageSinceSwarm.totalTokens > 0 ? sub.usageSinceSwarm : sub.usage;
      const costTxt = calcModelCostText(sub.model, u.inputTokens, u.cacheReadTokens, u.outputTokens);
      lines.push(
        `| ${sub.role} (\`${sub.shortId}\`) | ${sub.typeName} | ${sub.status} | ${sub.model} | ${sub.turns}/${sub.steps} | ${u.totalTokens} (${u.inputTokens}/${u.cacheReadTokens}/${u.outputTokens}) | ${costTxt} | ↑${sub.messagesToParent} / ↓${sub.messagesFromParent} |`,
      );
    }
  }

  const workerPrompt = totalWorkerIn + totalWorkerCache;
  const workerHit =
    workerPrompt > 0 ? Math.round((totalWorkerCache / workerPrompt) * 1000) / 10 : 0;

  lines.push('', '## Token & Cache Telemetry', '');
  lines.push(`- **External CLI Cluster**: ${totalWorkerTokens} tokens (cache hit ${workerHit}%)`);
  if (hostTelemetry) {
    const subAgg = hostTelemetry.subagentUsage.sinceSwarmStart;
    const subModels = Object.entries(hostTelemetry.subagentUsage.byModelSinceSwarm || {}).sort(
      (a, b) => b[1].totalTokens - a[1].totalTokens,
    );
    if (hostTelemetry.subagentUsage.currentSwarmCount > 0 || subAgg.totalTokens > 0) {
      lines.push(
        `- **AGY Native Subagents (${hostTelemetry.subagentUsage.currentSwarmCount} active wave / ${hostTelemetry.subagentUsage.totalCount} total)**: ${subAgg.totalTokens} tokens (cache hit ${subAgg.cacheHitRate}%)`,
      );
      for (const [modelName, st] of subModels) {
        const costTxt = calcModelCostText(modelName, st.inputTokens, st.cacheReadTokens, st.outputTokens);
        lines.push(
          `  - \`${modelName}\`: ${st.totalTokens} tokens (in ${st.inputTokens} / cache ${st.cacheReadTokens} / out ${st.outputTokens}, hit ${st.cacheHitRate}%, ${st.calls} steps${costTxt !== '-' ? `, est. ${costTxt}` : ''})`,
        );
      }
    }

    const agy = hostTelemetry.coordinator.sinceSwarmStart;
    const agyModels = Object.entries(hostTelemetry.coordinator.byModelSinceSwarm || {}).sort(
      (a, b) => b[1].totalTokens - a[1].totalTokens,
    );
    const scopeLabel =
      agyModels.length > 1
        ? `Since Swarm Start, Orchestrator / ${agyModels.length} models`
        : 'Since Swarm Start';
    lines.push(
      `- **AGY Main Model (${scopeLabel})**: ${agy.totalTokens} tokens (cache hit ${agy.cacheHitRate}%)`,
    );
    for (const [modelName, st] of agyModels) {
      const costTxt = calcModelCostText(modelName, st.inputTokens, st.cacheReadTokens, st.outputTokens);
      lines.push(
        `  - \`${modelName}\`: ${st.totalTokens} tokens (in ${st.inputTokens} / cache ${st.cacheReadTokens} / out ${st.outputTokens}, hit ${st.cacheHitRate}%, ${st.calls} steps${costTxt !== '-' ? `, est. ${costTxt}` : ''})`,
      );
    }
  }

  if (messages.length > 0) {
    lines.push('', '## Message Board Transcript', '');
    for (const msg of messages) {
      lines.push(`### #${msg.seq} · ${msg.agent} (${msg.kind}) · ${msg.time}`, '', msg.text, '');
    }
  }

  const safeSlug = swarm.title.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || swarm.id;
  return {
    filename: `${safeSlug}-${swarm.id}.md`,
    markdown: lines.join('\n'),
  };
}
