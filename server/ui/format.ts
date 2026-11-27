import {
  calcMemberCost,
  calcModelCost,
  collectUnpricedModels,
  convertCurrency,
  convertRateForDisplay,
  formatMoney,
  resolveModelPricing,
  sumMembersCost,
  sumModelMapCost,
  type CostCalculation,
  type CostDisplayOptions,
  type CostSource,
} from '../shared/pricing.js';
import type { Locale } from './i18n.js';
import type { MemberState, ModelPricing } from './types.js';

export {
  collectUnpricedModels,
  convertCurrency,
  convertRateForDisplay,
  formatMoney,
  resolveModelPricing,
  sumMembersCost,
  sumModelMapCost,
};
export type { CostCalculation, CostDisplayOptions, CostSource };

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
  while (rawText.includes(nonce)) nonce += 'X';
  const inlineCodes: string[] = [];
  const formatText = (value: string): string => {
    const formatLinks = (text: string) => text
      .replace(/(^|[\s(])(@[a-zA-Z0-9_-]+)/g, '$1<span class="mention-tag">$2</span>')
      .replace(/(^|[\s(])#(\d+)\b/g, '$1<button class="seq-link" type="button" data-jump-seq="$2">#$2</button>');
    return value.split(/(\*\*[^*\n]+\*\*)/g).map((part, idx) =>
      idx % 2 ? '<strong>' + formatLinks(part.slice(2, -2)) + '</strong>' : formatLinks(part),
    ).join('').replace(new RegExp(nonce + '(\\d+)E', 'g'), (_, idx) => inlineCodes[Number(idx)]);
  };

  const runs = [...rawText.matchAll(/`+/g)];
  const output: string[] = [];
  let pendingText = '';
  let cursor = 0;
  const isFenceLine = (offset: number) =>
    /^ {0,3}$/.test(rawText.slice(offset === 0 ? 0 : rawText.lastIndexOf('\n', offset - 1) + 1, offset));

  for (let i = 0; i < runs.length; i++) {
    const start = runs[i].index;
    const len = runs[i][0].length;
    const bodyStart = start + len;
    const eol = rawText.indexOf('\n', bodyStart);
    const isFence = len >= 3 && isFenceLine(start) &&
      !rawText.slice(bodyStart, eol < 0 ? undefined : eol).includes('`');

    if (isFence) {
      pendingText += escapeHtml(rawText.slice(cursor, start));
      output.push(formatText(pendingText));
      pendingText = '';
      let close = i + 1;
      for (; close < runs.length; close++) {
        const mark = runs[close];
        if (mark[0].length < len || !isFenceLine(mark.index)) continue;
        const end = mark.index + mark[0].length;
        const lineEnd = rawText.indexOf('\n', end);
        if (/^[ \t\r]*$/.test(rawText.slice(end, lineEnd < 0 ? undefined : lineEnd))) break;
      }
      const closingFence = runs[close];
      const code = rawText.slice(eol < 0 ? rawText.length : eol + 1, closingFence?.index)
        .replace(/\r?\n[ ]{0,3}$/, '');
      output.push('<pre><code>' + escapeHtml(code) + '</code></pre>');
      cursor = closingFence ? closingFence.index + closingFence[0].length : rawText.length;
      i = close;
    } else {
      let close = i + 1;
      while (close < runs.length && (eol < 0 || runs[close].index < eol) && runs[close][0].length !== len) close++;
      if (close >= runs.length || (eol >= 0 && runs[close].index >= eol)) continue;
      pendingText += escapeHtml(rawText.slice(cursor, start));
      const code = rawText.slice(bodyStart, runs[close].index);
      const idx = inlineCodes.push('<code>' + escapeHtml(code) + '</code>') - 1;
      pendingText += nonce + idx + 'E';
      cursor = runs[close].index + len;
      i = close;
    }
  }

  output.push(formatText(pendingText + escapeHtml(rawText.slice(cursor))));
  return output.join('');
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
  catalogPricing?: Record<string, ModelPricing>,
  displayOpts?: CostDisplayOptions,
): CostCalculation | null {
  return calcModelCost(model, inputTok, cacheTok, outputTok, pricingMap, catalogPricing, displayOpts);
}

export function calcMemberCostValue(
  member: MemberState,
  pricingMap?: Record<string, ModelPricing>,
  catalogPricing?: Record<string, ModelPricing>,
  displayOpts?: CostDisplayOptions,
): CostCalculation | null {
  return calcMemberCost(member, pricingMap, catalogPricing, displayOpts);
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
