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
 * Extracts @mentions from board text.
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

  const re = /(?:^|[^a-zA-Z0-9._+-])@([a-zA-Z0-9][a-zA-Z0-9_-]*)(?!\/)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
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
