export interface ParsedMentions {
  mentions: string[];
  all: boolean;
  mentionsCoordinator: boolean;
}

const RESERVED_NAMES = new Set(['all', 'coordinator', 'system']);
export const MAX_WORKER_NAME_LEN = 40;
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function validateWorkerName(name: string): { valid: true; normalized: string } | { valid: false; error: string } {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return { valid: false, error: 'Worker name cannot be empty.' };
  }
  if (RESERVED_NAMES.has(normalized) || normalized.startsWith('coordinator-')) {
    return { valid: false, error: `Worker name "${normalized}" is reserved.` };
  }
  if (!WORKER_NAME_RE.test(normalized)) {
    return {
      valid: false,
      error: `Worker name "${name}" must match ^[a-z0-9][a-z0-9_-]{0,39}$ (lowercase letters, digits, '-' or '_').`,
    };
  }
  return { valid: true, normalized };
}

/**
 * Replaces Markdown fenced code blocks (``` / ~~~) and inline backtick code spans with spaces,
 * preserving line structure and leaving unmatched stray backticks intact as literal prose.
 */
function stripMarkdownCode(text: string): string {
  const lines = text.split('\n');
  const segments: Array<{ fenced: boolean; content: string }> = [];
  let currentLines: string[] = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (const line of lines) {
    if (!inFence) {
      const openBacktick = /^[ ]{0,3}(`{3,})([^`]*)$/.exec(line);
      const openTilde = openBacktick ? null : /^[ ]{0,3}(~{3,})(.*)$/.exec(line);
      const openMatch = openBacktick || openTilde;
      if (openMatch) {
        if (currentLines.length > 0) {
          segments.push({ fenced: false, content: currentLines.join('\n') });
          currentLines = [];
        }
        inFence = true;
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
        segments.push({ fenced: true, content: line.replace(/[^\r]/g, ' ') });
        continue;
      }
      currentLines.push(line);
    } else {
      segments.push({ fenced: true, content: line.replace(/[^\r]/g, ' ') });
      const closeRe = fenceChar === '`' ? /^[ ]{0,3}(`{3,})[ \t\r]*$/ : /^[ ]{0,3}(~{3,})[ \t\r]*$/;
      const closeMatch = closeRe.exec(line);
      if (closeMatch && closeMatch[1].length >= fenceLen) {
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
      }
    }
  }
  if (currentLines.length > 0) {
    segments.push({ fenced: false, content: currentLines.join('\n') });
  }

  return segments
    .map((seg) => {
      if (seg.fenced) return seg.content;
      const src = seg.content;
      let out = '';
      let i = 0;
      while (i < src.length) {
        if (src[i] !== '`') {
          out += src[i];
          i += 1;
          continue;
        }
        let runLen = 0;
        while (i + runLen < src.length && src[i + runLen] === '`') {
          runLen += 1;
        }
        let searchIdx = i + runLen;
        let closeIdx = -1;
        while (searchIdx < src.length) {
          // Inline code spans in CommonMark do not cross blank lines
          if (src[searchIdx] === '\n') {
            let k = searchIdx + 1;
            while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\r')) {
              k += 1;
            }
            if (k < src.length && src[k] === '\n') {
              break;
            }
          }
          if (src[searchIdx] !== '`') {
            searchIdx += 1;
            continue;
          }
          let closeRunLen = 0;
          while (searchIdx + closeRunLen < src.length && src[searchIdx + closeRunLen] === '`') {
            closeRunLen += 1;
          }
          if (closeRunLen === runLen) {
            closeIdx = searchIdx;
            break;
          }
          searchIdx += closeRunLen;
        }
        if (closeIdx !== -1) {
          const spanEnd = closeIdx + runLen;
          out += src.slice(i, spanEnd).replace(/[^\r\n]/g, ' ');
          i = spanEnd;
        } else {
          out += src.slice(i, i + runLen);
          i += runLen;
        }
      }
      return out;
    })
    .join('\n');
}

/**
 * Extracts @mentions from board text, ignoring Markdown fenced code blocks and inline code spans.
 * Matches `@name` preceded by start-of-string or a non-word character (not email addresses),
 * supporting `@all`, `@coordinator`, exact worker names, and sharded group prefixes (e.g. `@worker` -> `worker-1`, `worker-2`).
 */
export function extractMentions(text: string, knownWorkerNames: string[]): ParsedMentions {
  const normalizedKnown = new Map<string, string>();
  for (const name of knownWorkerNames) {
    normalizedKnown.set(name.toLowerCase(), name);
  }

  const matchedTargets = new Set<string>();
  let all = false;
  let mentionsCoordinator = false;

  const scannableText = stripMarkdownCode(text);
  const re = /(?:^|[^a-zA-Z0-9._+-])@([a-zA-Z0-9][a-zA-Z0-9_-]*)(?!\/)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(scannableText)) !== null) {
    const token = match[1].toLowerCase();
    if (token === 'all') {
      all = true;
      continue;
    }
    if (token === 'coordinator') {
      mentionsCoordinator = true;
      continue;
    }
    const exact = normalizedKnown.get(token);
    if (exact) {
      matchedTargets.add(exact);
      continue;
    }
    // Check sharded group prefix: e.g. @worker matches worker-1, worker-2, ...
    const shardPrefix = `${token}-`;
    for (const [lower, original] of normalizedKnown.entries()) {
      if (lower.startsWith(shardPrefix) && /^\d+$/.test(lower.slice(shardPrefix.length))) {
        matchedTargets.add(original);
      }
    }
  }

  return {
    mentions: Array.from(matchedTargets),
    all,
    mentionsCoordinator,
  };
}
