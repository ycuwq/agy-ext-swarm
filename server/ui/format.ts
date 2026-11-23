import type { Locale } from './i18n.js';
import type { MemberState, ModelPricing, UsageBreakdown } from './types.js';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatMessageHtml(rawText: string): string {
  let nonce = 'AGYPH';
  while (rawText.includes(nonce)) {
    nonce += 'X';
  }
  const blocks: string[] = [];
  const withPlaceholders = rawText.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `${nonce}CB${idx}E`;
  });

  let html = escapeHtml(withPlaceholders);

  const inlines: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlines.length;
    inlines.push(`<code>${code}</code>`);
    return `${nonce}IC${idx}E`;
  });

  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])(@[a-zA-Z0-9_-]+)/g, '$1<span class="mention-tag">$2</span>');
  html = html.replace(
    /(^|[\s(])#(\d+)\b/g,
    '$1<button class="seq-link" type="button" data-jump-seq="$2">#$2</button>',
  );

  html = html.replace(new RegExp(`${nonce}IC(\\d+)E`, 'g'), (_, idx) => inlines[Number(idx)] ?? '');
  html = html.replace(new RegExp(`${nonce}CB(\\d+)E`, 'g'), (_, idx) => blocks[Number(idx)] ?? '');

  return html;
}

export function formatTime(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function calcInputCacheHit(inputTokens: number, cacheReadTokens: number): number {
  const prompt = inputTokens + cacheReadTokens;
  if (prompt <= 0) return 0;
  return Math.round((cacheReadTokens / prompt) * 1000) / 10;
}

export function calcModelCostValue(
  model: string,
  inputTok: number,
  cacheTok: number,
  outputTok: number,
  pricingMap?: Record<string, ModelPricing>,
): { amount: number; currency: 'USD' | 'CNY' } | null {
  const rate = pricingMap?.[model];
  if (!rate) return null;
  const cacheRate = rate.cacheReadPer1M ?? rate.inputPer1M;
  const amount =
    (inputTok * rate.inputPer1M + cacheTok * cacheRate + outputTok * rate.outputPer1M) / 1_000_000;
  return { amount, currency: rate.currency === 'CNY' ? 'CNY' : 'USD' };
}

export function formatMoney(amount: number, currency: 'USD' | 'CNY'): string {
  return `${currency === 'CNY' ? '¥' : '$'}${amount.toFixed(4)}`;
}

export function sumModelMapCost(
  modelsMap: Record<string, UsageBreakdown>,
  pricingMap?: Record<string, ModelPricing>,
): string | null {
  if (!pricingMap) return null;
  let totalUsd = 0;
  let totalCny = 0;
  let hasUsd = false;
  let hasCny = false;
  for (const [mName, st] of Object.entries(modelsMap)) {
    const c = calcModelCostValue(mName, st.inputTokens, st.cacheReadTokens, st.outputTokens, pricingMap);
    if (!c) continue;
    if (c.currency === 'CNY') {
      totalCny += c.amount;
      hasCny = true;
    } else {
      totalUsd += c.amount;
      hasUsd = true;
    }
  }
  const parts: string[] = [];
  if (hasUsd) parts.push(formatMoney(totalUsd, 'USD'));
  if (hasCny) parts.push(formatMoney(totalCny, 'CNY'));
  return parts.length > 0 ? parts.join(' + ') : null;
}

export function sumMembersCost(
  members: MemberState[],
  pricingMap?: Record<string, ModelPricing>,
): string | null {
  if (!pricingMap) return null;
  let totalUsd = 0;
  let totalCny = 0;
  let hasUsd = false;
  let hasCny = false;
  for (const m of members) {
    const u = m.usage || { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0 };
    const c = calcModelCostValue(m.model, u.inputTokens, u.cacheReadTokens, u.outputTokens, pricingMap);
    if (!c) continue;
    if (c.currency === 'CNY') {
      totalCny += c.amount;
      hasCny = true;
    } else {
      totalUsd += c.amount;
      hasUsd = true;
    }
  }
  const parts: string[] = [];
  if (hasUsd) parts.push(formatMoney(totalUsd, 'USD'));
  if (hasCny) parts.push(formatMoney(totalCny, 'CNY'));
  return parts.length > 0 ? parts.join(' + ') : null;
}

export function formatArgsForInput(args?: string[]): string {
  if (!args || args.length === 0) return '';
  if (args.every((a) => !/\s/.test(a))) {
    return args.join(' ');
  }
  return JSON.stringify(args);
}

export function parseArgsFromInput(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v));
      }
    } catch {
      // Fall back to tokenized split
    }
  }
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens.length > 0 ? tokens : undefined;
}

export function splitModelList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]+/)) {
    const item = part.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function formatDurationMs(ms: number): string {
  const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (safeMs < 1000) return '<1s';
  const totalSec = Math.round(safeMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 60) return remSec > 0 ? `${totalMin}m ${remSec}s` : `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

export function parseEnvText(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;
    let val = line.slice(eqIdx + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function formatEnvText(env?: Record<string, string>): string {
  if (!env) return '';
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k] ?? ''}`)
    .join('\n');
}
