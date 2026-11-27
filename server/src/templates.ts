import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeReasoningEffort } from '../shared/model-options.js';
import { validateWorkerName } from './mentions.js';
import { atomicWriteJson } from './store.js';
import {
  MAX_TURN_TIMEOUT_SECONDS,
  type PermissionMode,
  type SwarmTemplate,
  type TemplateWorkerSpec,
  type TemplatesConfigSnapshot,
  type WorkspaceMode,
} from './types.js';

const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TEMPLATES_SNAPSHOT_TTL_MS = 10_000;
const templatesSnapshotCache = new Map<
  string,
  { expiresAt: number; mtimeSig: string; snapshot: TemplatesConfigSnapshot }
>();

function templateFileMtimeToken(filePath?: string): string {
  if (!filePath || !existsSync(filePath)) return '0';
  try {
    return String(statSync(filePath).mtimeMs);
  } catch {
    return '0';
  }
}

export const BUILTIN_TEMPLATES: SwarmTemplate[] = [
  {
    id: 'feature-squad',
    name: 'Feature Squad (Implement -> Review & Test)',
    description:
      'One isolated worktree implementer followed automatically by a read-only code reviewer and a parallel test author once implementation finishes.',
    kind: 'builtin',
    defaultTitle: 'Feature Squad',
    workers: [
      {
        name: 'impl',
        role: 'Feature Implementer',
        workspace: 'worktree',
        permission: 'workspace-write',
        brief:
          'Implement the requested feature cleanly in your isolated worktree:\n{{goal}}\n\nFollow repository conventions, keep changes focused, and summarize modified files plus verification steps before finishing.',
      },
      {
        name: 'reviewer',
        role: 'Code Reviewer',
        workspace: 'inherit',
        permission: 'read-only',
        dependsOn: ['impl'],
        brief:
          'Review the implementation completed by @impl for:\n{{goal}}\n\nInspect @impl\'s branch diff via `git diff <base>..<branch>` from the upstream summary (check edge cases, security/error handling, and regressions) and report structured P0/P1/P2 findings with file:line references to @coordinator.',
      },
      {
        name: 'tester',
        role: 'Test Author',
        workspace: 'worktree',
        permission: 'workspace-write',
        dependsOn: ['impl'],
        brief:
          'Write and run unit/integration tests covering the work for:\n{{goal}}\n\nNote: your isolated worktree starts from base HEAD—inspect @impl\'s branch/diff listed in the upstream summary so your tests match @impl\'s exact interfaces and behavior. Report test results and coverage gaps to @coordinator.',
      },
    ],
  },
  {
    id: 'bug-hunt',
    name: 'Bug Hunt (Reproduce -> Fix -> Verify)',
    description:
      'Root-cause investigator reproduces the bug first, hands off findings to a worktree fixer, then a regression verifier confirms the fix.',
    kind: 'builtin',
    defaultTitle: 'Bug Hunt',
    workers: [
      {
        name: 'reproducer',
        role: 'Bug Investigator',
        workspace: 'inherit',
        permission: 'read-only',
        brief:
          'Investigate and locate the root cause and minimal reproduction steps for:\n{{goal}}\n\nSummarize exact files, symbols, and reproduction steps so @fixer can patch it directly.',
      },
      {
        name: 'fixer',
        role: 'Bug Fixer',
        workspace: 'worktree',
        permission: 'workspace-write',
        dependsOn: ['reproducer'],
        brief:
          'Apply a clean, minimal fix in your isolated worktree based on @reproducer findings for:\n{{goal}}\n\nAdd regression assertions if missing and verify locally.',
      },
      {
        name: 'verifier',
        role: 'Regression Verifier',
        workspace: 'inherit',
        permission: 'read-only',
        dependsOn: ['fixer'],
        brief:
          'Verify the fix proposed by @fixer for:\n{{goal}}\n\nInspect @fixer\'s branch diff via `git diff <base>..<branch>` from the upstream summary, check for unintended side effects or missed edge cases, and report go/no-go with file:line evidence to @coordinator.',
      },
    ],
  },
  {
    id: 'doc-and-test',
    name: 'Docs & Tests Parallel',
    description:
      'Two parallel worktree workers updating documentation/examples and adding automated test coverage side by side.',
    kind: 'builtin',
    defaultTitle: 'Docs & Tests',
    workers: [
      {
        name: 'docs',
        role: 'Docs Updater',
        workspace: 'worktree',
        permission: 'workspace-write',
        brief:
          'Update documentation, usage examples, and inline comments relevant to:\n{{goal}}\n\nKeep docs accurate against current source code.',
      },
      {
        name: 'tests',
        role: 'Test Coverage Author',
        workspace: 'worktree',
        permission: 'workspace-write',
        brief:
          'Add or strengthen automated tests covering:\n{{goal}}\n\nRun the test suite cleanly in your worktree and summarize results.',
      },
    ],
  },
  {
    id: 'review-loop',
    name: 'Review Loop (Implement <-> Cross-Review)',
    description:
      'Vendor-neutral closed-loop workflow pairing an isolated worktree implementer with a read-only architecture reviewer using a 4-state verdict protocol (PASS / FIX / ROLLBACK / NEEDS_HUMAN) and automatic task-scene routing.',
    kind: 'builtin',
    defaultTitle: 'Review Loop',
    workers: [
      {
        name: 'impl',
        role: 'Feature Implementer',
        workspace: 'worktree',
        permission: 'workspace-write',
        scopeMode: 'warn',
        autoVerify: true,
        verifyTimeoutSeconds: 300,
        maxVerifyRetries: 2,
        brief:
          'Implement the task in your isolated git worktree branch, run relevant verification checks, and commit your changes before reporting.\n- First completion: report to `@coordinator [done]` with modified files, verification commands/results, and rationale for any out-of-scope changes (`outOfScopeFiles`).\n- When `@reviewer` replies with `VERDICT: FIX`: apply minimal targeted fixes on the same branch, commit, re-run verification, and reply `@reviewer [done]` with updated results. Never relax assertions or bypass checks.\n\nGoal:\n{{goal}}',
      },
      {
        name: 'reviewer',
        role: 'Architecture Reviewer',
        workspace: 'inherit',
        permission: 'read-only',
        dependsOn: ['impl'],
        brief:
          'Perform a strict read-only review of impl\'s work: read `branch`, `baseRef`, `changedFiles`, and `outOfScopeFiles` from the upstream summary, inspect `git diff <base>..<branch>` and the relevant source files directly. Do NOT redirect `git diff` to `/tmp` or any path outside the workspace to read it back; instead run `git diff <base>..<branch> -- <path>` directly by subpath.\nReport findings by `P0` / `P1` / `P2` with `file:line` references, then emit exactly one verdict (on `PASS` / `ROLLBACK` / `NEEDS_HUMAN`, refer to the implementer as "impl" and NEVER write `@impl` anywhere in your message, including inside backticks, so you do not accidentally re-wake it):\n- `VERDICT: PASS` (no `P0`/`P1` findings): reply `@coordinator [done] VERDICT: PASS ...` (do NOT mention `@impl`).\n- `VERDICT: FIX` (fixable `P0`/`P1` findings within the first 2 review rounds): reply `@impl VERDICT: FIX ...` with a concise fix checklist and ask impl to reply `@reviewer [done]` after fixing and re-verifying.\n- `VERDICT: ROLLBACK` (wrong direction or still not converged after 2 rework rounds): reply `@coordinator [blocker] VERDICT: ROLLBACK ...` (do NOT mention `@impl`).\n- `VERDICT: NEEDS_HUMAN` (e.g., `outOfScopeFiles` touches sensitive files with valid justification needing human approval, or requires device/manual confirmation): reply `@coordinator [blocker] VERDICT: NEEDS_HUMAN ...` (do NOT mention `@impl`).\n\nGoal:\n{{goal}}',
      },
    ],
  },
];

function sanitizeWorkerSpec(raw: unknown): TemplateWorkerSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const nameRaw = typeof r.name === 'string' ? r.name : '';
  const nameCheck = validateWorkerName(nameRaw);
  if (!nameCheck.valid) return null;

  const role = typeof r.role === 'string' && r.role.trim() ? r.role.trim() : nameCheck.normalized;
  const brief = typeof r.brief === 'string' ? r.brief.trim() : '';
  if (!brief) return null;

  const workspace: WorkspaceMode | undefined =
    r.workspace === 'inherit' || r.workspace === 'worktree' ? r.workspace : undefined;
  const permission: PermissionMode | undefined =
    r.permission === 'read-only' ||
    r.permission === 'workspace-write' ||
    r.permission === 'danger-full-access'
      ? r.permission
      : undefined;

  const dependsOn = Array.isArray(r.dependsOn)
    ? r.dependsOn
        .map((d) => String(d).trim().toLowerCase())
        .filter((d) => d && d !== nameCheck.normalized)
    : undefined;

  const allowedFiles = Array.isArray(r.allowedFiles)
    ? r.allowedFiles.map((f) => String(f).trim()).filter(Boolean)
    : undefined;

  const verifyCommands = Array.isArray(r.verifyCommands)
    ? r.verifyCommands.map((c) => String(c).trim()).filter(Boolean)
    : undefined;

  const verifyTimeoutSeconds =
    typeof r.verifyTimeoutSeconds === 'number' && Number.isFinite(r.verifyTimeoutSeconds)
      ? Math.min(1800, Math.max(10, Math.floor(r.verifyTimeoutSeconds)))
      : undefined;
  const maxVerifyRetries =
    typeof r.maxVerifyRetries === 'number' && Number.isFinite(r.maxVerifyRetries)
      ? Math.min(5, Math.max(0, Math.floor(r.maxVerifyRetries)))
      : undefined;
  const turnTimeoutSeconds =
    typeof r.turnTimeoutSeconds === 'number' && Number.isFinite(r.turnTimeoutSeconds)
      ? Math.min(MAX_TURN_TIMEOUT_SECONDS, Math.max(0, Math.floor(r.turnTimeoutSeconds)))
      : undefined;
  const scopeMode =
    r.scopeMode === 'warn' ? 'warn' : r.scopeMode === 'enforce' ? 'enforce' : undefined;
  const reasoningEffort = sanitizeReasoningEffort(r.reasoningEffort);
  const fastMode = typeof r.fastMode === 'boolean' ? r.fastMode : undefined;

  return {
    name: nameCheck.normalized,
    role,
    brief,
    ...(typeof r.provider === 'string' && r.provider.trim()
      ? { provider: r.provider.trim().toLowerCase() }
      : {}),
    ...(typeof r.model === 'string' && r.model.trim() ? { model: r.model.trim() } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(workspace ? { workspace } : {}),
    ...(permission ? { permission } : {}),
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn: [...new Set(dependsOn)] } : {}),
    ...(allowedFiles && allowedFiles.length > 0 ? { allowedFiles } : {}),
    ...(scopeMode ? { scopeMode } : {}),
    ...(verifyCommands && verifyCommands.length > 0 ? { verifyCommands } : {}),
    ...(typeof r.autoVerify === 'boolean' ? { autoVerify: r.autoVerify } : {}),
    ...(verifyTimeoutSeconds !== undefined ? { verifyTimeoutSeconds } : {}),
    ...(maxVerifyRetries !== undefined ? { maxVerifyRetries } : {}),
    ...(turnTimeoutSeconds !== undefined ? { turnTimeoutSeconds } : {}),
  };
}

function sanitizeTemplate(raw: unknown, kind: 'builtin' | 'custom'): SwarmTemplate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim().toLowerCase() : '';
  if (!TEMPLATE_ID_RE.test(id)) return null;
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id;
  const description = typeof r.description === 'string' ? r.description.trim() : '';
  const workersRaw = Array.isArray(r.workers) ? r.workers : [];
  const workers: TemplateWorkerSpec[] = [];
  const seenNames = new Set<string>();
  for (const w of workersRaw) {
    const spec = sanitizeWorkerSpec(w);
    if (!spec || seenNames.has(spec.name)) continue;
    seenNames.add(spec.name);
    workers.push(spec);
  }
  if (workers.length === 0) return null;

  // Drop dependsOn targets that do not exist in the template
  for (const w of workers) {
    if (w.dependsOn) {
      w.dependsOn = w.dependsOn.filter((d) => seenNames.has(d) && d !== w.name);
      if (w.dependsOn.length === 0) delete w.dependsOn;
    }
  }

  return {
    id,
    name,
    description,
    kind,
    ...(typeof r.defaultTitle === 'string' && r.defaultTitle.trim()
      ? { defaultTitle: r.defaultTitle.trim() }
      : {}),
    workers,
  };
}

interface TemplatesFileShape {
  templates?: unknown[];
}

function readTemplatesFile(filePath: string): SwarmTemplate[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as TemplatesFileShape | unknown[];
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray(parsed.templates)
        ? parsed.templates
        : [];
    const out: SwarmTemplate[] = [];
    for (const item of list) {
      const tpl = sanitizeTemplate(item, 'custom');
      if (tpl) out.push(tpl);
    }
    return out;
  } catch (err) {
    console.error(`[agy-ext-swarm] Failed to read templates from ${filePath}:`, err);
    return [];
  }
}

export function getTemplatesSnapshot(dataDir: string, repoRoot?: string): TemplatesConfigSnapshot {
  const globalPath = join(dataDir, 'templates.json');
  const repoPath = repoRoot ? join(repoRoot, '.agy-ext-swarm', 'templates.json') : undefined;
  const cacheKey = `${dataDir}|${repoRoot || ''}`;
  const mtimeSig = `${templateFileMtimeToken(globalPath)}:${templateFileMtimeToken(repoPath)}`;
  const now = Date.now();
  const cached = templatesSnapshotCache.get(cacheKey);
  if (cached && now < cached.expiresAt && cached.mtimeSig === mtimeSig) {
    return cached.snapshot;
  }

  const byId = new Map<string, SwarmTemplate>();
  for (const b of BUILTIN_TEMPLATES) {
    byId.set(b.id, { ...b, workers: b.workers.map((w) => ({ ...w })) });
  }
  for (const g of readTemplatesFile(globalPath)) {
    const existing = byId.get(g.id);
    byId.set(g.id, { ...g, kind: existing?.kind === 'builtin' ? 'builtin' : 'custom' });
  }
  if (repoPath) {
    for (const r of readTemplatesFile(repoPath)) {
      if (BUILTIN_TEMPLATES.some((b) => b.id === r.id)) {
        // Untrusted repo config must never override or spoof built-in templates
        continue;
      }
      byId.set(r.id, { ...r, kind: 'custom' });
    }
  }

  const snapshot: TemplatesConfigSnapshot = {
    globalPath,
    repoPath,
    templates: [...byId.values()],
  };
  templatesSnapshotCache.set(cacheKey, {
    expiresAt: now + TEMPLATES_SNAPSHOT_TTL_MS,
    mtimeSig,
    snapshot,
  });
  return snapshot;
}

export function saveTemplatePatch(
  dataDir: string,
  repoRoot: string | undefined,
  patch: {
    upsertTemplate?: Omit<SwarmTemplate, 'kind'> & { kind?: 'builtin' | 'custom' };
    removeTemplateId?: string;
  },
): TemplatesConfigSnapshot {
  const globalPath = join(dataDir, 'templates.json');
  const existingCustom = readTemplatesFile(globalPath);
  const byId = new Map<string, SwarmTemplate>(existingCustom.map((t) => [t.id, t]));

  if (patch.removeTemplateId) {
    const rmId = patch.removeTemplateId.trim().toLowerCase();
    const isBuiltin = BUILTIN_TEMPLATES.some((b) => b.id === rmId);
    if (isBuiltin && !byId.has(rmId)) {
      throw new Error(`Built-in template "${rmId}" cannot be deleted.`);
    }
    byId.delete(rmId);
  }

  if (patch.upsertTemplate) {
    const sanitized = sanitizeTemplate(patch.upsertTemplate, 'custom');
    if (!sanitized) {
      throw new Error(
        `Invalid template: requires lowercase id matching ^[a-z0-9][a-z0-9_-]{0,47}$ and at least 1 valid worker with name + brief.`,
      );
    }
    byId.set(sanitized.id, sanitized);
  }

  atomicWriteJson(globalPath, {
    templates: [...byId.values()].map(({ kind: _k, ...rest }) => rest),
  });
  templatesSnapshotCache.clear();

  return getTemplatesSnapshot(dataDir, repoRoot);
}

export function expandTemplateWorkerBrief(rawBrief: string, goal: string): string {
  const cleanGoal = goal.trim();
  if (!cleanGoal) return rawBrief.replace(/\{\{goal\}\}/g, '').trim();
  if (rawBrief.includes('{{goal}}')) {
    return rawBrief.split('{{goal}}').join(cleanGoal).trim();
  }
  return `${rawBrief.trim()}\n\nGoal:\n${cleanGoal}`;
}
