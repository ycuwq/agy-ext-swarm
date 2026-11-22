// src/index.ts
import { existsSync as existsSync8, readFileSync as readFileSync7, realpathSync as realpathSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname2, join as join10, resolve as resolve4 } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// src/coordinator-usage.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
var SAFE_CONVERSATION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
var MAX_TRANSCRIPT_CACHE_SIZE = 32;
var CONVERSATIONS_TTL_MS = 1e4;
function isSafeConversationId(id) {
  return SAFE_CONVERSATION_ID_RE.test(id.trim());
}
var transcriptCache = /* @__PURE__ */ new Map();
var conversationsCache = null;
function emptyBreakdown() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0,
    calls: 0
  };
}
function finalizeBreakdown(acc) {
  const promptTokens = acc.inputTokens + acc.cacheReadTokens;
  const totalTokens = promptTokens + acc.outputTokens;
  const cacheHitRate = promptTokens > 0 ? Math.round(acc.cacheReadTokens / promptTokens * 1e3) / 10 : 0;
  return {
    inputTokens: acc.inputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    promptTokens,
    outputTokens: acc.outputTokens,
    totalTokens,
    cacheHitRate,
    calls: acc.calls
  };
}
function addStepToBreakdown(acc, step) {
  acc.inputTokens += step.inputTokens;
  acc.cacheReadTokens += step.cacheReadTokens;
  acc.outputTokens += step.outputTokens;
  acc.calls += 1;
}
function extractTitleFromUserContent(content) {
  if (typeof content !== "string") return "";
  let text = content.trim();
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  if (reqMatch) {
    text = reqMatch[1].trim();
  }
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  return singleLine.length > 42 ? `${singleLine.slice(0, 40)}...` : singleLine;
}
function parseTranscriptFile(transcriptPath) {
  if (!existsSync(transcriptPath)) return null;
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return null;
  }
  const cached = transcriptCache.get(transcriptPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }
  let raw = "";
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  let title = "";
  const steps = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!title && obj.type === "USER_INPUT" && obj.source === "USER_EXPLICIT") {
      title = extractTitleFromUserContent(obj.content);
    }
    if (obj.type === "PLANNER_RESPONSE") {
      const inputTokens = Number(obj.input_tokens || 0);
      const cacheReadTokens = Number(obj.cache_read_tokens || 0);
      const outputTokens = Number(obj.output_tokens || 0);
      if (inputTokens > 0 || cacheReadTokens > 0 || outputTokens > 0) {
        const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : "unknown";
        const ts = typeof obj.created_at === "string" ? Date.parse(obj.created_at) : Number.NaN;
        steps.push({
          model,
          inputTokens,
          cacheReadTokens,
          outputTokens,
          timestampMs: Number.isFinite(ts) ? ts : 0
        });
      }
    }
  }
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    title,
    steps
  };
  if (transcriptCache.has(transcriptPath)) {
    transcriptCache.delete(transcriptPath);
  } else if (transcriptCache.size >= MAX_TRANSCRIPT_CACHE_SIZE) {
    const oldestKey = transcriptCache.keys().next().value;
    if (oldestKey) transcriptCache.delete(oldestKey);
  }
  transcriptCache.set(transcriptPath, entry);
  return entry;
}
function resolveBrainDir(dataDir) {
  const candidates = [];
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    candidates.push(join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, "brain"));
  }
  candidates.push(resolve(dataDir, "..", "..", "brain"));
  candidates.push(join(homedir(), ".gemini", "antigravity", "brain"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
function listRecentConversations(brainDir, limit = 12) {
  if (!brainDir || !existsSync(brainDir)) return [];
  const cacheKey = `${brainDir}:${limit}`;
  const now = Date.now();
  if (conversationsCache && conversationsCache.key === cacheKey && now < conversationsCache.expiresAt) {
    return conversationsCache.entries;
  }
  let dirs;
  try {
    dirs = readdirSync(brainDir);
  } catch {
    return [];
  }
  const found = [];
  for (const id of dirs) {
    if (id.startsWith(".") || !isSafeConversationId(id)) continue;
    const transcriptPath = join(brainDir, id, ".system_generated", "logs", "transcript.jsonl");
    if (!existsSync(transcriptPath)) continue;
    try {
      const st = statSync(transcriptPath);
      found.push({ id, mtimeMs: st.mtimeMs, transcriptPath });
    } catch {
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const entries = found.slice(0, limit).map((item) => {
    const parsed = parseTranscriptFile(item.transcriptPath);
    const shortId = item.id.slice(0, 8);
    return {
      id: item.id,
      title: parsed?.title ? `${parsed.title} (${shortId})` : shortId,
      updatedAt: new Date(item.mtimeMs).toISOString()
    };
  });
  conversationsCache = {
    key: cacheKey,
    expiresAt: now + CONVERSATIONS_TTL_MS,
    entries
  };
  return entries;
}
function aggregateSteps(steps) {
  const totalAcc = emptyBreakdown();
  const modelAccs = /* @__PURE__ */ new Map();
  for (const step of steps) {
    addStepToBreakdown(totalAcc, step);
    let mAcc = modelAccs.get(step.model);
    if (!mAcc) {
      mAcc = emptyBreakdown();
      modelAccs.set(step.model, mAcc);
    }
    addStepToBreakdown(mAcc, step);
  }
  const byModel = {};
  for (const [model, acc] of modelAccs.entries()) {
    byModel[model] = finalizeBreakdown(acc);
  }
  return {
    total: finalizeBreakdown(totalAcc),
    byModel
  };
}
function readCoordinatorUsage(brainDir, swarm) {
  const conversations = listRecentConversations(brainDir, 12);
  const emptySummary = {
    conversationId: null,
    sessionTotal: emptyBreakdown(),
    sinceSwarmStart: emptyBreakdown(),
    byModelSession: {},
    byModelSinceSwarm: {}
  };
  if (!brainDir || !existsSync(brainDir)) {
    return { usage: emptySummary, conversations };
  }
  const candidateIds = [
    swarm?.coordinatorConversationId,
    process.env.ANTIGRAVITY_CONVERSATION_ID,
    conversations[0]?.id
  ].filter((v) => typeof v === "string" && v.trim().length > 0);
  const resolvedBrainRoot = resolve(brainDir);
  const brainPrefix = resolvedBrainRoot.endsWith(sep) ? resolvedBrainRoot : `${resolvedBrainRoot}${sep}`;
  let selectedId = null;
  let selectedPath;
  for (const rawId of candidateIds) {
    const id = rawId.trim();
    if (!isSafeConversationId(id)) continue;
    const p = resolve(brainDir, id, ".system_generated", "logs", "transcript.jsonl");
    if (!p.startsWith(brainPrefix)) continue;
    if (existsSync(p)) {
      selectedId = id;
      selectedPath = p;
      break;
    }
  }
  if (!selectedId || !selectedPath) {
    return { usage: emptySummary, conversations };
  }
  const parsed = parseTranscriptFile(selectedPath);
  if (!parsed) {
    return { usage: emptySummary, conversations };
  }
  const sessionAgg = aggregateSteps(parsed.steps);
  const swarmStartMs = swarm?.createdAt ? Date.parse(swarm.createdAt) : Number.NaN;
  const sinceSteps = Number.isFinite(swarmStartMs) ? parsed.steps.filter((s) => s.timestampMs === 0 || s.timestampMs >= swarmStartMs) : [];
  const sinceAgg = aggregateSteps(sinceSteps);
  const convEntry = conversations.find((c) => c.id === selectedId);
  return {
    usage: {
      conversationId: selectedId,
      conversationTitle: convEntry?.title || parsed.title || selectedId.slice(0, 8),
      transcriptPath: selectedPath,
      sessionTotal: sessionAgg.total,
      sinceSwarmStart: sinceAgg.total,
      byModelSession: sessionAgg.byModel,
      byModelSinceSwarm: sinceAgg.byModel
    },
    conversations
  };
}

// src/models.ts
import { existsSync as existsSync2, mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";
import YAML from "yaml";
var CUSTOM_TAG_SAFE_OPTIONS = {
  // Ignore !!js or other custom tags gracefully when reading cordis.patch.yml
  customTags: [
    {
      tag: "tag:yaml.org,2002:js",
      resolve: (str) => str
    },
    {
      tag: "!!js",
      resolve: (str) => str
    }
  ]
};
function findCatalogRecursive(obj, out) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findCatalogRecursive(item, out);
    }
    return;
  }
  const rec = obj;
  if (Array.isArray(rec.lastCatalog)) {
    for (const entry of rec.lastCatalog) {
      if (entry && typeof entry === "object") {
        out.push(entry);
      }
    }
  }
  for (const val of Object.values(rec)) {
    if (val && typeof val === "object") {
      findCatalogRecursive(val, out);
    }
  }
}
function getDshHome() {
  return process.env.DSH_HOME || join2(homedir2(), ".dsh");
}
function getProfilePatchPath(profile = "headless") {
  return join2(getDshHome(), "profiles", profile, "cordis.patch.yml");
}
function listDshModels(profile = "headless") {
  const safeProfile = profile.trim() || "headless";
  const configPath = getProfilePatchPath(safeProfile);
  let defaultProvider = "";
  let defaultModel = "";
  const models = [];
  if (!existsSync2(configPath)) {
    return {
      profile: safeProfile,
      configPath,
      exists: false,
      defaultProvider,
      defaultModel,
      models,
      note: `Profile patch file not found at ${configPath}. Configure models in Settings or providers.json if needed.`
    };
  }
  try {
    const raw = readFileSync2(configPath, "utf8");
    const parsed = YAML.parse(raw, CUSTOM_TAG_SAFE_OPTIONS);
    if (Array.isArray(parsed)) {
      const seenIds = /* @__PURE__ */ new Set();
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        if (entry.id === "agent-default-model" && entry.config) {
          if (typeof entry.config.provider === "string" && entry.config.provider.trim()) {
            defaultProvider = entry.config.provider.trim();
          }
          if (typeof entry.config.model === "string" && entry.config.model.trim()) {
            defaultModel = entry.config.model.trim();
          }
        }
        const rawCatalog = [];
        if (entry.config) {
          findCatalogRecursive(entry.config, rawCatalog);
        }
        for (const item of rawCatalog) {
          const id = typeof item.id === "string" ? item.id.trim() : "";
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          models.push({
            id,
            name: typeof item.name === "string" ? item.name : id,
            contextWindow: typeof item.contextWindow === "number" ? item.contextWindow : void 0,
            maxTokens: typeof item.maxTokens === "number" ? item.maxTokens : void 0,
            creditMultiplier: typeof item.creditMultiplier === "number" ? item.creditMultiplier : void 0,
            description: typeof item.descriptionEn === "string" ? item.descriptionEn : typeof item.descriptionZh === "string" ? item.descriptionZh : void 0,
            supportsToolCall: typeof item.supportsToolCall === "boolean" ? item.supportsToolCall : void 0,
            supportsImages: typeof item.supportsImages === "boolean" ? item.supportsImages : void 0
          });
        }
      }
    }
    return {
      profile: safeProfile,
      configPath,
      exists: true,
      defaultProvider,
      defaultModel,
      models,
      note: models.length === 0 ? "No lastCatalog entries found in cordis.patch.yml; configure supported models in AGY Ext Swarm Settings or providers.json if needed." : void 0
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      profile: safeProfile,
      configPath,
      exists: true,
      defaultProvider,
      defaultModel,
      models,
      note: `Failed to parse ${configPath}: ${msg}`
    };
  }
}
function writeModelPatch(patchPath, provider, model) {
  mkdirSync(dirname(patchPath), { recursive: true });
  const trimmedProvider = provider?.trim();
  const config = trimmedProvider ? { provider: trimmedProvider, model } : { model };
  const doc = [
    {
      id: "agent-default-model",
      name: "@deepseek-ai/dsh-agent-default-model",
      config
    }
  ];
  writeFileSync(patchPath, YAML.stringify(doc), "utf8");
}

// src/providers/shared.ts
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter as delimiter2, extname, isAbsolute as isAbsolute2, join as join4 } from "node:path";

// src/worktree.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, realpathSync, rmSync, statSync as statSync2 } from "node:fs";
import { delimiter, isAbsolute, join as join3, resolve as resolve2 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
function buildAugmentedEnv(extra) {
  const pathKey = process.platform === "win32" ? Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH" : "PATH";
  const existingPath = process.env[pathKey] || "";
  const parts = existingPath.split(delimiter).filter(Boolean);
  if (process.platform !== "win32") {
    const extraPaths = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
    for (const p of extraPaths) {
      if (!parts.includes(p)) {
        parts.push(p);
      }
    }
  }
  const joinedPath = parts.join(delimiter);
  const env = {
    ...process.env,
    ...extra,
    PATH: joinedPath
  };
  if (pathKey !== "PATH") {
    env[pathKey] = joinedPath;
  }
  return env;
}
async function runGit(cwd, args) {
  const res = await execFileAsync("git", args, {
    cwd,
    env: buildAugmentedEnv(),
    maxBuffer: 4 * 1024 * 1024
  });
  return { stdout: res.stdout.trimEnd(), stderr: res.stderr.trimEnd() };
}
async function detectGitRepo(dir) {
  if (!existsSync3(dir)) return null;
  try {
    const { stdout: topOut } = await runGit(dir, ["rev-parse", "--show-toplevel"]);
    const rawRoot = topOut.trim();
    if (!rawRoot) return null;
    const repoRoot = existsSync3(rawRoot) ? realpathSync(rawRoot) : rawRoot;
    const { stdout: commonOut } = await runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
    const rawCommon = commonOut.trim();
    const resolvedCommon = isAbsolute(rawCommon) ? rawCommon : resolve2(repoRoot, rawCommon);
    const gitCommonDir = existsSync3(resolvedCommon) ? realpathSync(resolvedCommon) : resolvedCommon;
    let headRef = "HEAD";
    try {
      const { stdout: headOut } = await runGit(repoRoot, ["rev-parse", "HEAD"]);
      if (headOut.trim()) {
        headRef = headOut.trim();
      }
    } catch {
      return null;
    }
    return { repoRoot, gitCommonDir, headRef };
  } catch {
    return null;
  }
}
async function createWorktree(repoRoot, swarmId, workerName, worktreeBaseDir) {
  mkdirSync2(worktreeBaseDir, { recursive: true });
  const realBaseDir = realpathSync(worktreeBaseDir);
  const worktreePath = join3(realBaseDir, workerName);
  const safeSwarm = swarmId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeWorker = workerName.replace(/[^a-zA-Z0-9_-]/g, "-");
  const branch = `ext-swarm/${safeSwarm}/${safeWorker}`;
  const { stdout: headOut } = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  const baseRef = headOut.trim();
  if (existsSync3(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  try {
    await runGit(repoRoot, ["branch", "-D", branch]);
  } catch {
  }
  await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
  return { worktreePath, branch, baseRef };
}
function normalizeRelPath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "__DOUBLE_STAR__").replace(/\*/g, "[^/]*").replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}
function isPathAllowed(filePath, allowedFiles) {
  if (!allowedFiles || allowedFiles.length === 0) return true;
  const rel = normalizeRelPath(filePath);
  for (const rawPattern of allowedFiles) {
    const pattern = normalizeRelPath(rawPattern.trim());
    if (!pattern) continue;
    if (pattern === "." || pattern === "*" || pattern === "**") return true;
    if (rel === pattern) return true;
    if (rel.startsWith(`${pattern}/`)) return true;
    if (pattern.includes("*") && globToRegex(pattern).test(rel)) return true;
  }
  return false;
}
async function getWorktreeDiff(cwd, baseRef, allowedFiles) {
  if (!existsSync3(cwd)) return null;
  try {
    const { stdout: branchOut } = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchOut.trim() || "HEAD";
    const ref = baseRef || "HEAD";
    let commitCount = 0;
    try {
      const { stdout: cntOut } = await runGit(cwd, ["rev-list", "--count", `${ref}..HEAD`]);
      commitCount = Number.parseInt(cntOut.trim(), 10) || 0;
    } catch {
      commitCount = 0;
    }
    const committedFiles = [];
    if (commitCount > 0) {
      const { stdout: diffNames } = await runGit(cwd, ["diff", "--name-only", `${ref}..HEAD`]);
      for (const line of diffNames.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) committedFiles.push(trimmed);
      }
    }
    const dirtyFiles = [];
    const { stdout: statusOut } = await runGit(cwd, ["status", "--porcelain"]);
    for (const line of statusOut.split("\n")) {
      if (!line.trim()) continue;
      let filePart = line.slice(3).trim();
      const arrowIdx = filePart.lastIndexOf(" -> ");
      if (arrowIdx !== -1) {
        filePart = filePart.slice(arrowIdx + 4).trim();
      }
      if (filePart.startsWith('"') && filePart.endsWith('"')) {
        filePart = filePart.slice(1, -1);
      }
      if (filePart) dirtyFiles.push(filePart);
    }
    const changedSet = /* @__PURE__ */ new Set([...committedFiles, ...dirtyFiles]);
    const changedFiles = Array.from(changedSet).sort();
    let stat = "";
    try {
      const { stdout: statOut } = await runGit(cwd, ["diff", "--stat", ref]);
      stat = statOut.trim();
    } catch {
      stat = "";
    }
    const outOfScopeFiles = allowedFiles && allowedFiles.length > 0 ? changedFiles.filter((f) => !isPathAllowed(f, allowedFiles)) : [];
    return {
      branch,
      baseRef: ref,
      changedFiles,
      dirtyFiles: Array.from(new Set(dirtyFiles)).sort(),
      commitCount,
      stat,
      outOfScopeFiles
    };
  } catch {
    return null;
  }
}
async function getWorktreeFullDiff(cwd, baseRef, maxBytes = 12e4) {
  if (!existsSync3(cwd)) return null;
  try {
    const { stdout: branchOut } = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchOut.trim() || "HEAD";
    const ref = baseRef || "HEAD";
    let stat = "";
    try {
      const { stdout: statOut } = await runGit(cwd, ["diff", "--stat", ref]);
      stat = statOut.trim();
    } catch {
      stat = "";
    }
    let patch = "";
    try {
      const { stdout: diffOut } = await runGit(cwd, ["diff", "--no-color", ref]);
      patch = diffOut;
    } catch {
      patch = "";
    }
    const untrackedFiles = [];
    try {
      const { stdout: lsOut } = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
      for (const line of lsOut.split("\n")) {
        const f = line.trim();
        if (f) untrackedFiles.push(f);
      }
    } catch {
    }
    const extraPatches = [];
    for (const relPath of untrackedFiles) {
      if (patch.length + extraPatches.join("\n").length > maxBytes) break;
      const absFile = join3(cwd, relPath);
      try {
        const st = statSync2(absFile);
        if (!st.isFile()) continue;
        const normRel = normalizeRelPath(relPath);
        if (st.size > 16 * 1024) {
          extraPatches.push(
            `diff --git a/${normRel} b/${normRel}
new file mode 100644
--- /dev/null
+++ b/${normRel}
@@ -0,0 +1,1 @@
+[file > 16KB omitted: ${st.size} bytes]`
          );
          continue;
        }
        const buf = readFileSync3(absFile);
        if (buf.includes(0)) {
          extraPatches.push(
            `diff --git a/${normRel} b/${normRel}
new file mode 100644
Binary file b/${normRel} (${st.size} bytes)`
          );
          continue;
        }
        const text = buf.toString("utf8");
        const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
        const hunkBody = lines.map((l) => `+${l}`).join("\n");
        extraPatches.push(
          `diff --git a/${normRel} b/${normRel}
new file mode 100644
--- /dev/null
+++ b/${normRel}
@@ -0,0 +1,${lines.length} @@
${hunkBody}`
        );
      } catch {
      }
    }
    if (extraPatches.length > 0) {
      patch = patch ? `${patch}
${extraPatches.join("\n")}` : extraPatches.join("\n");
    }
    let truncated = false;
    if (patch.length > maxBytes) {
      patch = `${patch.slice(0, maxBytes)}
... [diff truncated at ${maxBytes} chars]`;
      truncated = true;
    }
    return {
      branch,
      baseRef: ref,
      stat,
      patch,
      truncated,
      untrackedFiles
    };
  } catch {
    return null;
  }
}
async function runGitVerbose(cwd, args) {
  try {
    const res = await execFileAsync("git", args, {
      cwd,
      env: buildAugmentedEnv(),
      maxBuffer: 4 * 1024 * 1024
    });
    return {
      code: 0,
      stdout: (res.stdout || "").trimEnd(),
      stderr: (res.stderr || "").trimEnd()
    };
  } catch (err) {
    const rec = err;
    return {
      code: typeof rec.code === "number" ? rec.code : 1,
      stdout: String(rec.stdout || "").trimEnd(),
      stderr: String(rec.stderr || rec.message || "").trimEnd()
    };
  }
}
async function getDirtyFiles(worktreePath) {
  if (!worktreePath || !existsSync3(worktreePath)) return [];
  const res = await runGitVerbose(worktreePath, ["status", "--porcelain"]);
  if (res.code !== 0 || !res.stdout) return [];
  const files = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const rawPath = line.slice(3).trim();
    const arrowIdx = rawPath.indexOf(" -> ");
    files.push(arrowIdx >= 0 ? rawPath.slice(arrowIdx + 4).trim() : rawPath);
  }
  return [...new Set(files)];
}
function parseConflictOutput(combined) {
  const files = /* @__PURE__ */ new Set();
  const details = [];
  for (const rawLine of combined.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const stageMatch = line.match(/^[0-9]{6}\s+[0-9a-f]+\s+[123]\t(.+)$/i);
    if (stageMatch?.[1]) {
      files.add(stageMatch[1].trim());
      continue;
    }
    if (line.startsWith("CONFLICT")) {
      details.push(line);
      const mergeConflictMatch = line.match(/Merge conflict in (.+)$/);
      if (mergeConflictMatch?.[1]) {
        files.add(mergeConflictMatch[1].trim());
      } else {
        const modDelMatch = line.match(/^CONFLICT\s*\([^)]+\):\s*(.+?)\s+(?:deleted|modified|renamed)\b/);
        if (modDelMatch?.[1]) {
          files.add(modDelMatch[1].trim());
        }
      }
    } else if (line.startsWith("error:") || line.startsWith("fatal:")) {
      details.push(line);
    }
  }
  return { conflictFiles: [...files], conflictDetails: details };
}
async function commitWithAuthorFallback(cwd, extraArgs) {
  const first = await runGitVerbose(cwd, ["commit", ...extraArgs]);
  if (first.code === 0) return first;
  if (/Author identity unknown|unable to auto-detect email|user\.name|user\.email/i.test(first.stderr + first.stdout)) {
    return runGitVerbose(cwd, [
      "-c",
      "user.name=agy-ext-swarm",
      "-c",
      "user.email=swarm@local",
      "commit",
      ...extraArgs
    ]);
  }
  return first;
}
async function previewWorktreeMerge(opts) {
  const headRes = await runGitVerbose(opts.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : "HEAD";
  const targetBranch = opts.targetBranch?.trim() || currentBranch;
  const baseRes = await runGitVerbose(opts.repoRoot, ["merge-base", targetBranch, opts.branch]);
  const mergeBase = baseRes.code === 0 ? baseRes.stdout.trim() : "";
  const aheadRes = await runGitVerbose(opts.repoRoot, [
    "rev-list",
    "--count",
    `${targetBranch}..${opts.branch}`
  ]);
  const aheadCommits = aheadRes.code === 0 ? Number(aheadRes.stdout.trim()) || 0 : 0;
  const diffBase = mergeBase || targetBranch;
  const committedFilesRes = await runGitVerbose(opts.repoRoot, [
    "diff",
    "--name-only",
    diffBase,
    opts.branch
  ]);
  const committedFiles = committedFilesRes.code === 0 ? committedFilesRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const dirtyFiles = await getDirtyFiles(opts.workerCwd);
  const changedFiles = [.../* @__PURE__ */ new Set([...committedFiles, ...dirtyFiles])];
  const statRes = await runGitVerbose(opts.repoRoot, ["diff", "--stat", `${diffBase}..${opts.branch}`]);
  const stat = statRes.code === 0 ? statRes.stdout : "";
  if (aheadCommits === 0 && dirtyFiles.length === 0) {
    return {
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      mergeBase,
      aheadCommits: 0,
      changedFiles: [],
      dirtyFiles: [],
      canCleanMerge: true,
      conflictFiles: [],
      conflictDetails: [],
      stat
    };
  }
  let canCleanMerge = true;
  const conflictFileSet = /* @__PURE__ */ new Set();
  const conflictDetails = [];
  if (aheadCommits > 0) {
    const mt = await runGitVerbose(opts.repoRoot, ["merge-tree", "--write-tree", targetBranch, opts.branch]);
    if (mt.code !== 0) {
      const combined = `${mt.stdout}
${mt.stderr}`;
      if (/unknown option|usage: git merge-tree/i.test(combined) && mergeBase) {
        const legacy = await runGitVerbose(opts.repoRoot, [
          "merge-tree",
          mergeBase,
          targetBranch,
          opts.branch
        ]);
        const legacyOut = `${legacy.stdout}
${legacy.stderr}`;
        if (legacyOut.includes("<<<<<<<") || legacyOut.includes("changed in both")) {
          canCleanMerge = false;
          for (const l of legacyOut.split("\n")) {
            if (l.includes("changed in both") || l.includes("result in")) {
              conflictDetails.push(l.trim());
            }
          }
        }
      } else {
        canCleanMerge = false;
        const parsed = parseConflictOutput(combined);
        for (const f of parsed.conflictFiles) conflictFileSet.add(f);
        conflictDetails.push(...parsed.conflictDetails);
        if (conflictDetails.length === 0 && mt.stderr) {
          conflictDetails.push(mt.stderr);
        }
      }
    }
  }
  if (dirtyFiles.length > 0 && mergeBase) {
    const targetChangedRes = await runGitVerbose(opts.repoRoot, [
      "diff",
      "--name-only",
      mergeBase,
      targetBranch
    ]);
    const targetChanged = new Set(
      targetChangedRes.code === 0 ? targetChangedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : []
    );
    for (const dirty of dirtyFiles) {
      if (targetChanged.has(dirty)) {
        canCleanMerge = false;
        conflictFileSet.add(dirty);
        conflictDetails.push(
          `Uncommitted worktree edit "${dirty}" overlaps with changes on ${targetBranch}.`
        );
      }
    }
  }
  return {
    workerName: opts.workerName,
    branch: opts.branch,
    targetBranch,
    mergeBase,
    aheadCommits,
    changedFiles,
    dirtyFiles,
    canCleanMerge,
    conflictFiles: [...conflictFileSet],
    conflictDetails,
    stat
  };
}
async function mergeWorktreeBranch(opts) {
  const mode = opts.mode || "squash";
  const headRes = await runGitVerbose(opts.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : "HEAD";
  const targetBranch = opts.targetBranch?.trim() || currentBranch;
  if (opts.targetBranch?.trim() && opts.targetBranch.trim() !== currentBranch && opts.targetBranch.trim() !== "HEAD") {
    return {
      merged: false,
      mode,
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      message: `Target branch "${targetBranch}" is not checked out in ${opts.repoRoot} (current HEAD is "${currentBranch}"). Switch branches first.`
    };
  }
  const wtCleanRes = await runGitVerbose(opts.repoRoot, ["diff", "--quiet"]);
  const idxCleanRes = await runGitVerbose(opts.repoRoot, ["diff", "--cached", "--quiet"]);
  if (wtCleanRes.code !== 0 || idxCleanRes.code !== 0) {
    return {
      merged: false,
      mode,
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      message: `Target repository (${opts.repoRoot}) has uncommitted tracked changes; commit or stash them before merging.`
    };
  }
  if (opts.workerCwd && existsSync3(opts.workerCwd)) {
    const dirtyBefore = await getDirtyFiles(opts.workerCwd);
    if (dirtyBefore.length > 0) {
      const addRes = await runGitVerbose(opts.workerCwd, ["add", "-A"]);
      if (addRes.code !== 0) {
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: opts.branch,
          targetBranch,
          message: `Failed to stage uncommitted worktree files in ${opts.workerCwd}: ${addRes.stderr}`
        };
      }
      const commitSnap = await commitWithAuthorFallback(opts.workerCwd, [
        "-m",
        `chore(swarm): snapshot ${opts.workerName} worktree changes`
      ]);
      if (commitSnap.code !== 0) {
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: opts.branch,
          targetBranch,
          message: `Failed to commit worktree snapshot: ${commitSnap.stderr || commitSnap.stdout}`
        };
      }
    }
  }
  const preview = await previewWorktreeMerge({
    repoRoot: opts.repoRoot,
    workerName: opts.workerName,
    branch: opts.branch,
    workerCwd: opts.workerCwd,
    targetBranch
  });
  if (preview.aheadCommits === 0) {
    let worktreeRemoved2 = false;
    if (opts.removeWorktreeAfter && opts.workerCwd) {
      const rm = await removeWorktree(opts.repoRoot, opts.workerCwd, opts.branch);
      worktreeRemoved2 = rm.removedWorktree;
    }
    return {
      merged: true,
      mode,
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      message: "Already up to date (no commits ahead of target branch).",
      worktreeRemoved: worktreeRemoved2
    };
  }
  if (!preview.canCleanMerge) {
    return {
      merged: false,
      mode,
      workerName: opts.workerName,
      branch: opts.branch,
      targetBranch,
      conflictFiles: preview.conflictFiles,
      message: preview.conflictDetails[0] || `Merge conflicts detected in ${preview.conflictFiles.join(", ") || "worktree"}; working tree left untouched.`
    };
  }
  const commitMsg = opts.commitMessage?.trim() || `feat(swarm): merge ${opts.workerName} (${opts.branch})`;
  if (mode === "squash") {
    const mergeRes = await runGitVerbose(opts.repoRoot, ["merge", "--squash", opts.branch]);
    if (mergeRes.code !== 0) {
      const parsed = parseConflictOutput(`${mergeRes.stdout}
${mergeRes.stderr}`);
      await runGitVerbose(opts.repoRoot, ["reset", "--merge"]);
      return {
        merged: false,
        mode,
        workerName: opts.workerName,
        branch: opts.branch,
        targetBranch,
        conflictFiles: parsed.conflictFiles,
        message: parsed.conflictDetails[0] || mergeRes.stderr || "Squash merge failed cleanly."
      };
    }
    const stagedRes = await runGitVerbose(opts.repoRoot, ["diff", "--cached", "--name-only"]);
    if (stagedRes.code === 0 && stagedRes.stdout.trim()) {
      const commitRes = await commitWithAuthorFallback(opts.repoRoot, ["-m", commitMsg]);
      if (commitRes.code !== 0) {
        await runGitVerbose(opts.repoRoot, ["reset", "--merge"]);
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: opts.branch,
          targetBranch,
          message: `Squash commit failed: ${commitRes.stderr || commitRes.stdout}`
        };
      }
    }
  } else if (mode === "merge") {
    let mergeRes = await runGitVerbose(opts.repoRoot, ["merge", "--no-ff", "-m", commitMsg, opts.branch]);
    if (mergeRes.code !== 0 && /Author identity unknown|unable to auto-detect email|user\.name|user\.email/i.test(
      mergeRes.stderr + mergeRes.stdout
    )) {
      await runGitVerbose(opts.repoRoot, ["merge", "--abort"]);
      mergeRes = await runGitVerbose(opts.repoRoot, [
        "-c",
        "user.name=agy-ext-swarm",
        "-c",
        "user.email=swarm@local",
        "merge",
        "--no-ff",
        "-m",
        commitMsg,
        opts.branch
      ]);
    }
    if (mergeRes.code !== 0) {
      const parsed = parseConflictOutput(`${mergeRes.stdout}
${mergeRes.stderr}`);
      await runGitVerbose(opts.repoRoot, ["merge", "--abort"]);
      return {
        merged: false,
        mode,
        workerName: opts.workerName,
        branch: opts.branch,
        targetBranch,
        conflictFiles: parsed.conflictFiles,
        message: parsed.conflictDetails[0] || mergeRes.stderr || "Merge failed cleanly."
      };
    }
  } else {
    const revRes = await runGitVerbose(opts.repoRoot, [
      "rev-list",
      "--reverse",
      `${targetBranch}..${opts.branch}`
    ]);
    const commits = revRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (commits.length > 0) {
      let cpRes = await runGitVerbose(opts.repoRoot, ["cherry-pick", ...commits]);
      if (cpRes.code !== 0 && /Author identity unknown|unable to auto-detect email|user\.name|user\.email/i.test(
        cpRes.stderr + cpRes.stdout
      )) {
        await runGitVerbose(opts.repoRoot, ["cherry-pick", "--abort"]);
        cpRes = await runGitVerbose(opts.repoRoot, [
          "-c",
          "user.name=agy-ext-swarm",
          "-c",
          "user.email=swarm@local",
          "cherry-pick",
          ...commits
        ]);
      }
      if (cpRes.code !== 0) {
        const parsed = parseConflictOutput(`${cpRes.stdout}
${cpRes.stderr}`);
        await runGitVerbose(opts.repoRoot, ["cherry-pick", "--abort"]);
        return {
          merged: false,
          mode,
          workerName: opts.workerName,
          branch: opts.branch,
          targetBranch,
          conflictFiles: parsed.conflictFiles,
          message: parsed.conflictDetails[0] || cpRes.stderr || "Cherry-pick failed cleanly."
        };
      }
    }
  }
  const shaRes = await runGitVerbose(opts.repoRoot, ["rev-parse", "HEAD"]);
  const commitSha = shaRes.code === 0 ? shaRes.stdout.trim() : void 0;
  let worktreeRemoved = false;
  if (opts.removeWorktreeAfter && opts.workerCwd) {
    const rm = await removeWorktree(opts.repoRoot, opts.workerCwd, opts.branch);
    worktreeRemoved = rm.removedWorktree;
  }
  return {
    merged: true,
    mode,
    workerName: opts.workerName,
    branch: opts.branch,
    targetBranch,
    commitSha,
    message: `Merged ${opts.branch} into ${targetBranch} using ${mode}${commitSha ? ` (${commitSha.slice(0, 7)})` : ""}.`,
    worktreeRemoved
  };
}
async function removeWorktree(repoRoot, worktreePath, branch) {
  let removedWorktree = false;
  let removedBranch = false;
  if (repoRoot && existsSync3(repoRoot)) {
    try {
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
      removedWorktree = true;
    } catch {
      try {
        if (existsSync3(worktreePath)) {
          rmSync(worktreePath, { recursive: true, force: true });
          removedWorktree = true;
        }
        await runGit(repoRoot, ["worktree", "prune"]);
      } catch {
      }
    }
    if (branch) {
      try {
        await runGit(repoRoot, ["branch", "-D", branch]);
        removedBranch = true;
      } catch {
      }
    }
  } else if (existsSync3(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
    removedWorktree = true;
  }
  return { removedWorktree, removedBranch };
}

// src/providers/shared.ts
function summarizeToolCall(tool, input) {
  const name = typeof tool === "string" ? tool : "tool";
  if (input && typeof input === "object") {
    const rec = input;
    if (typeof rec.command === "string") {
      const cmd = rec.command.replace(/\s+/g, " ").trim();
      return `${name}: ${cmd.slice(0, 60)}${cmd.length > 60 ? "..." : ""}`;
    }
    if (typeof rec.path === "string") {
      return `${name}: ${rec.path}`;
    }
    if (typeof rec.file_path === "string") {
      return `${name}: ${rec.file_path}`;
    }
    if (typeof rec.pattern === "string") {
      return `${name}: ${rec.pattern}`;
    }
    if (typeof rec.description === "string") {
      return `${name}: ${rec.description.slice(0, 60)}`;
    }
  }
  return name;
}
function checkExecCandidate(filePath) {
  const mode = process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  const candidates = [filePath];
  if (process.platform === "win32" && !extname(filePath)) {
    const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((s) => s.trim()).filter(Boolean);
    for (const ext of pathext) {
      candidates.push(`${filePath}${ext}`);
      candidates.push(`${filePath}${ext.toLowerCase()}`);
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, mode);
      return candidate;
    } catch {
    }
  }
  return null;
}
function resolveExecutable(command) {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (isAbsolute2(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return checkExecCandidate(trimmed);
  }
  const env = buildAugmentedEnv();
  const envPath = env.PATH || "";
  for (const dir of envPath.split(delimiter2).filter(Boolean)) {
    const found = checkExecCandidate(join4(dir, trimmed));
    if (found) return found;
  }
  return null;
}
function expandTemplateArgs(templateArgs, ctx) {
  let usedPromptVar = false;
  const vars = {
    "{{prompt}}": ctx.prompt,
    "{{model}}": ctx.model,
    "{{cwd}}": ctx.cwd,
    "{{sessionId}}": ctx.sessionId || "",
    "{{permissionMode}}": ctx.permissionMode,
    "{{workerName}}": ctx.workerName,
    "{{swarmDir}}": ctx.swarmDir,
    "{{gitCommonDir}}": ctx.gitCommonDir || "",
    "{{boardCli}}": ctx.boardCli
  };
  const out = [];
  for (const raw of templateArgs) {
    if (raw.includes("{{prompt}}")) usedPromptVar = true;
    let expanded = raw;
    for (const [k, v] of Object.entries(vars)) {
      if (expanded.includes(k)) {
        expanded = expanded.split(k).join(v);
      }
    }
    out.push(expanded);
  }
  return { args: out, usedPromptVar };
}

// src/providers/dsh.ts
import { join as join5 } from "node:path";
var dshAdapter = {
  id: "dsh",
  displayName: "DeepSeek Harness (dsh)",
  kind: "builtin",
  command: process.env.DSH_BIN || "dsh",
  supportsSessionResume: true,
  supportsStreamEvents: true,
  notes: "Native headless profile with --session-id resume, --patch model selection, and worktree sandbox.",
  buildInvocation(ctx) {
    const args = [
      "--profile",
      ctx.profile,
      "--json",
      "--permission-mode",
      ctx.permissionMode,
      "--approval-policy",
      "never"
    ];
    if (ctx.sessionId) {
      args.push("--session-id", ctx.sessionId);
    }
    const catalog = listDshModels(ctx.profile);
    const requestedModel = ctx.model?.trim();
    const overrideProvider = ctx.modelProvider?.trim();
    const providerChanged = Boolean(overrideProvider && overrideProvider !== catalog.defaultProvider);
    if (requestedModel && requestedModel !== "default" && (requestedModel !== catalog.defaultModel || providerChanged)) {
      const patchPath = join5(ctx.patchesDir, `${ctx.workerName}.yml`);
      const patchProvider = overrideProvider || catalog.defaultProvider || void 0;
      writeModelPatch(patchPath, patchProvider, requestedModel);
      args.push("--patch", patchPath);
    }
    if (ctx.permissionMode === "workspace-write") {
      if (ctx.gitCommonDir) {
        args.push("--add-dir", ctx.gitCommonDir);
      }
      args.push("--add-dir", ctx.swarmDir);
    }
    args.push("-");
    return {
      command: this.command,
      args,
      stdinText: ctx.prompt
    };
  },
  parseStdoutLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return [];
    }
    const out = [];
    const evType = ev.type;
    if (evType === "session" && typeof ev.sessionId === "string") {
      out.push({ type: "session", sessionId: ev.sessionId });
    } else if (evType === "status") {
      const phase = ev.phase;
      if (phase === "turn_start") {
        out.push({ type: "turn_start" });
      } else if (phase === "step_start") {
        out.push({ type: "step_start" });
      } else if (phase === "step_end" && ev.usage && typeof ev.usage === "object") {
        const u = ev.usage;
        out.push({
          type: "usage",
          inputTokens: Number(u.inputTokens || 0),
          outputTokens: Number(u.outputTokens || 0),
          cacheReadTokens: Number(u.cacheReadTokens || 0),
          totalTokens: Number(u.totalTokens || 0)
        });
      } else if (phase === "turn_end" && ev.reason && typeof ev.reason === "object") {
        const reason = ev.reason;
        out.push({
          type: "final",
          reasonKind: typeof reason.kind === "string" ? reason.kind : void 0,
          errorText: typeof reason.message === "string" ? reason.message : void 0
        });
      }
    } else if (evType === "tool_call") {
      out.push({ type: "tool_call", summary: summarizeToolCall(ev.tool, ev.input) });
    } else if (evType === "text" && typeof ev.text === "string") {
      out.push({ type: "text", text: ev.text });
    } else if (evType === "final") {
      const reason = ev.reason && typeof ev.reason === "object" ? ev.reason : void 0;
      out.push({
        type: "final",
        sessionId: typeof ev.sessionId === "string" ? ev.sessionId : void 0,
        text: typeof ev.text === "string" ? ev.text : void 0,
        reasonKind: typeof reason?.kind === "string" ? reason.kind : void 0,
        errorText: typeof reason?.message === "string" ? reason.message : void 0
      });
    } else if (evType === "error") {
      out.push({
        type: "error",
        message: typeof ev.message === "string" ? ev.message : typeof ev.error === "string" ? ev.error : JSON.stringify(ev)
      });
    }
    return out;
  }
};

// src/providers/claude.ts
var claudeAdapter = {
  id: "claude",
  displayName: "Claude Code CLI",
  kind: "builtin",
  command: process.env.CLAUDE_BIN || "claude",
  supportsSessionResume: true,
  supportsStreamEvents: true,
  defaultModel: "default",
  notes: "Uses `claude -p --output-format stream-json --verbose` and `--resume <sessionId>`.",
  buildInvocation(ctx) {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (ctx.model && ctx.model !== "default") {
      args.push("--model", ctx.model);
    }
    if (ctx.sessionId) {
      args.push("--resume", ctx.sessionId);
    }
    if (ctx.permissionMode === "read-only") {
      args.push("--permission-mode", "plan");
    } else if (ctx.permissionMode === "workspace-write") {
      args.push("--permission-mode", "acceptEdits");
      if (ctx.gitCommonDir) args.push("--add-dir", ctx.gitCommonDir);
      args.push("--add-dir", ctx.swarmDir);
    } else {
      args.push("--dangerously-skip-permissions");
    }
    return {
      command: this.command,
      args,
      stdinText: ctx.prompt
    };
  },
  parseStdoutLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return [];
    }
    const out = [];
    if (typeof ev.session_id === "string") {
      out.push({ type: "session", sessionId: ev.session_id });
    }
    if (ev.type === "system" && ev.subtype === "init") {
      out.push({ type: "turn_start" });
    } else if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
      out.push({ type: "step_start" });
      const msg = ev.message;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== "object") continue;
          const b = block;
          if (b.type === "tool_use") {
            out.push({ type: "tool_call", summary: summarizeToolCall(b.name, b.input) });
          } else if (b.type === "text" && typeof b.text === "string") {
            out.push({ type: "text", text: b.text });
          }
        }
      }
    } else if (ev.type === "result") {
      if (ev.usage && typeof ev.usage === "object") {
        const u = ev.usage;
        const inputTokens = Number(u.input_tokens || 0);
        const cacheReadTokens = Number(u.cache_read_input_tokens || 0);
        const outputTokens = Number(u.output_tokens || 0);
        out.push({
          type: "usage",
          inputTokens,
          cacheReadTokens,
          outputTokens,
          totalTokens: inputTokens + cacheReadTokens + outputTokens
        });
      }
      out.push({
        type: "final",
        text: typeof ev.result === "string" ? ev.result : void 0,
        reasonKind: ev.is_error ? "error" : "completed",
        errorText: ev.is_error && typeof ev.result === "string" ? ev.result : void 0
      });
    }
    return out;
  }
};

// src/providers/codex.ts
var codexAdapter = {
  id: "codex",
  displayName: "OpenAI Codex CLI",
  kind: "builtin",
  command: process.env.CODEX_BIN || "codex",
  supportsSessionResume: true,
  supportsStreamEvents: true,
  defaultModel: "default",
  notes: "Uses `codex exec --json` and `codex exec resume <threadId> --json`.",
  buildInvocation(ctx) {
    const args = ctx.sessionId ? ["exec", "resume", ctx.sessionId, "--json"] : ["exec", "--json", "--sandbox", ctx.permissionMode];
    if (!ctx.sessionId && ctx.permissionMode === "workspace-write") {
      if (ctx.gitCommonDir) args.push("--add-dir", ctx.gitCommonDir);
      args.push("--add-dir", ctx.swarmDir);
    }
    if (ctx.model && ctx.model !== "default") {
      args.push("-m", ctx.model);
    }
    args.push("-");
    return {
      command: this.command,
      args,
      stdinText: ctx.prompt
    };
  },
  parseStdoutLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return [];
    }
    const out = [];
    if (ev.type === "thread.started" && typeof ev.thread_id === "string") {
      out.push({ type: "session", sessionId: ev.thread_id });
    } else if (ev.type === "turn.started") {
      out.push({ type: "turn_start" });
    } else if (ev.type === "item.started" && ev.item && typeof ev.item === "object") {
      const item = ev.item;
      if (item.type === "command_execution") {
        out.push({ type: "step_start" });
        out.push({
          type: "tool_call",
          summary: summarizeToolCall("shell", { command: item.command })
        });
      }
    } else if (ev.type === "item.completed" && ev.item && typeof ev.item === "object") {
      const item = ev.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        out.push({ type: "text", text: item.text });
      }
    } else if (ev.type === "turn.completed") {
      if (ev.usage && typeof ev.usage === "object") {
        const u = ev.usage;
        const inputTokens = Number(u.input_tokens || 0);
        const cacheReadTokens = Number(u.cached_input_tokens || 0);
        const outputTokens = Number(u.output_tokens || 0);
        out.push({
          type: "usage",
          inputTokens,
          cacheReadTokens,
          outputTokens,
          totalTokens: inputTokens + cacheReadTokens + outputTokens
        });
      }
      out.push({ type: "final", reasonKind: "completed" });
    } else if (ev.type === "error" || ev.type === "turn.failed") {
      out.push({
        type: "error",
        message: typeof ev.message === "string" ? ev.message : JSON.stringify(ev)
      });
    }
    return out;
  }
};

// src/providers/gemini.ts
var geminiAdapter = {
  id: "gemini",
  displayName: "Gemini CLI",
  kind: "builtin",
  command: process.env.GEMINI_BIN || "gemini",
  supportsSessionResume: true,
  supportsStreamEvents: true,
  defaultModel: "default",
  notes: "Uses `gemini -p --output-format stream-json` with optional `--resume <sessionId>`.",
  buildInvocation(ctx) {
    const args = ["-p", "--output-format", "stream-json"];
    if (ctx.model && ctx.model !== "default") {
      args.push("-m", ctx.model);
    }
    if (ctx.sessionId) {
      args.push("--resume", ctx.sessionId);
    }
    if (ctx.permissionMode !== "read-only") {
      args.push("--yolo");
    }
    return {
      command: this.command,
      args,
      stdinText: ctx.prompt
    };
  },
  parseStdoutLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return [];
    }
    const out = [];
    const sid = typeof ev.session_id === "string" ? ev.session_id : typeof ev.sessionId === "string" ? ev.sessionId : void 0;
    if (sid) {
      out.push({ type: "session", sessionId: sid });
    }
    if (ev.type === "init") {
      out.push({ type: "turn_start" });
    } else if (ev.type === "tool_use") {
      out.push({ type: "step_start" });
      out.push({
        type: "tool_call",
        summary: summarizeToolCall(ev.tool_name || ev.tool, ev.parameters || ev.input)
      });
    } else if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
      out.push({ type: "text", text: ev.content });
    } else if (ev.type === "text" && typeof ev.text === "string") {
      out.push({ type: "text", text: ev.text });
    } else if (ev.type === "result") {
      const stats = ev.stats || ev.usage;
      if (stats && typeof stats === "object") {
        const inputTokens = Number(stats.input_tokens || stats.inputTokens || 0);
        const cacheReadTokens = Number(stats.cached || stats.cacheReadTokens || 0);
        const outputTokens = Number(stats.output_tokens || stats.outputTokens || 0);
        const totalTokens = Number(
          stats.total_tokens || stats.totalTokens || inputTokens + cacheReadTokens + outputTokens
        );
        out.push({ type: "usage", inputTokens, cacheReadTokens, outputTokens, totalTokens });
      }
      out.push({
        type: "final",
        text: typeof ev.response === "string" ? ev.response : typeof ev.text === "string" ? ev.text : void 0,
        reasonKind: ev.status === "error" ? "error" : "completed"
      });
    }
    return out;
  }
};

// src/providers/custom.ts
function createCustomAdapter(id, config) {
  const promptMode = config.promptMode || "stdin";
  const outputFormat = config.outputFormat || "text";
  return {
    id,
    displayName: config.displayName || id,
    kind: "custom",
    command: config.command,
    supportsSessionResume: Boolean(config.resumeArgs && config.resumeArgs.length > 0),
    supportsStreamEvents: outputFormat === "ndjson",
    defaultModel: config.defaultModel || "custom",
    notes: `Custom CLI (${outputFormat}, prompt via ${promptMode})`,
    buildInvocation(ctx) {
      const template = ctx.sessionId && config.resumeArgs && config.resumeArgs.length > 0 ? config.resumeArgs : config.args || [];
      const { args, usedPromptVar } = expandTemplateArgs(template, ctx);
      let stdinText;
      if (promptMode === "stdin") {
        stdinText = ctx.prompt;
      } else if (!usedPromptVar) {
        args.push(ctx.prompt);
      }
      return {
        command: config.command,
        args,
        stdinText,
        env: config.env
      };
    },
    parseStdoutLine(line) {
      if (outputFormat !== "ndjson") return [];
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return [];
      }
      const out = [];
      const sid = ev.sessionId ?? ev.session_id ?? ev.thread_id;
      if (typeof sid === "string" && sid) {
        out.push({ type: "session", sessionId: sid });
      }
      if (ev.type === "turn_start" || ev.phase === "turn_start") {
        out.push({ type: "turn_start" });
      }
      if (ev.type === "tool_call" || ev.type === "tool_use") {
        out.push({
          type: "tool_call",
          summary: summarizeToolCall(ev.tool || ev.tool_name || ev.name, ev.input)
        });
      }
      if (typeof ev.text === "string" && ev.type !== "final") {
        out.push({ type: "text", text: ev.text });
      }
      const usageObj = ev.usage || ev.stats;
      if (usageObj && typeof usageObj === "object") {
        const inputTokens = Number(usageObj.inputTokens ?? usageObj.input_tokens ?? 0);
        const cacheReadTokens = Number(
          usageObj.cacheReadTokens ?? usageObj.cache_read_input_tokens ?? usageObj.cached_input_tokens ?? 0
        );
        const outputTokens = Number(usageObj.outputTokens ?? usageObj.output_tokens ?? 0);
        const totalTokens = Number(
          usageObj.totalTokens ?? usageObj.total_tokens ?? inputTokens + cacheReadTokens + outputTokens
        );
        if (totalTokens > 0) {
          out.push({ type: "usage", inputTokens, cacheReadTokens, outputTokens, totalTokens });
        }
      }
      if (ev.type === "final" || ev.type === "result") {
        const finalTxt = typeof ev.text === "string" ? ev.text : typeof ev.result === "string" ? ev.result : typeof ev.message === "string" ? ev.message : void 0;
        out.push({ type: "final", text: finalTxt, reasonKind: "completed" });
      }
      return out;
    },
    finalizeOutput(stdoutAll, accumulatedText) {
      if (outputFormat === "ndjson") {
        return { finalText: accumulatedText.trim() };
      }
      return { finalText: stdoutAll.trim() };
    }
  };
}

// src/providers/config.ts
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync5, readFileSync as readFileSync5, statSync as statSync3 } from "node:fs";
import { join as join7 } from "node:path";
import { promisify as promisify2 } from "node:util";

// src/store.ts
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync as existsSync4,
  mkdirSync as mkdirSync3,
  readdirSync as readdirSync2,
  readFileSync as readFileSync4,
  renameSync,
  rmSync as rmSync2,
  unlinkSync,
  watch,
  writeFileSync as writeFileSync2
} from "node:fs";
import { join as join6 } from "node:path";
import { randomBytes } from "node:crypto";

// src/mentions.ts
var RESERVED_NAMES = /* @__PURE__ */ new Set(["all", "coordinator"]);
var WORKER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
function validateWorkerName(name) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return { valid: false, error: "Worker name cannot be empty." };
  }
  if (RESERVED_NAMES.has(normalized) || normalized.startsWith("coordinator-")) {
    return { valid: false, error: `Worker name "${normalized}" is reserved.` };
  }
  if (!WORKER_NAME_RE.test(normalized)) {
    return {
      valid: false,
      error: `Worker name "${name}" must match ^[a-z0-9][a-z0-9_-]{0,23}$ (lowercase letters, digits, '-' or '_').`
    };
  }
  return { valid: true, normalized };
}
function extractMentions(text, knownWorkerNames) {
  const normalizedKnown = /* @__PURE__ */ new Map();
  for (const name of knownWorkerNames) {
    normalizedKnown.set(name.toLowerCase(), name);
  }
  const matchedTargets = /* @__PURE__ */ new Set();
  let all = false;
  let mentionsCoordinator = false;
  const re = /(?:^|[^a-zA-Z0-9._+-])@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const token = match[1].toLowerCase();
    if (token === "all") {
      all = true;
      continue;
    }
    if (token === "coordinator") {
      mentionsCoordinator = true;
      continue;
    }
    const exact = normalizedKnown.get(token);
    if (exact) {
      matchedTargets.add(exact);
      continue;
    }
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
    mentionsCoordinator
  };
}

// src/store.ts
function atomicWriteJson(filePath, value) {
  const dir = join6(filePath, "..");
  mkdirSync3(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync2(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmpPath, filePath);
}
var SwarmStore = class extends EventEmitter {
  dataDir;
  indexPath;
  swarmsDir;
  states = /* @__PURE__ */ new Map();
  watchers = /* @__PURE__ */ new Map();
  processingInboxFiles = /* @__PURE__ */ new Set();
  index;
  constructor(dataDir) {
    super();
    this.setMaxListeners(100);
    this.dataDir = dataDir;
    this.indexPath = join6(dataDir, "index.json");
    this.swarmsDir = join6(dataDir, "swarms");
    mkdirSync3(this.swarmsDir, { recursive: true });
    this.index = this.loadIndexFromDisk();
    this.loadExistingSwarms();
  }
  loadIndexFromDisk() {
    if (!existsSync4(this.indexPath)) {
      return { swarms: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync4(this.indexPath, "utf8"));
      if (parsed && Array.isArray(parsed.swarms)) {
        return parsed;
      }
    } catch (err) {
      console.error(`[agy-ext-swarm] Failed to read index.json:`, err);
    }
    return { swarms: [] };
  }
  saveIndex() {
    atomicWriteJson(this.indexPath, this.index);
  }
  loadExistingSwarms() {
    for (const entry of this.index.swarms) {
      const statePath = join6(this.getSwarmDir(entry.id), "state.json");
      if (!existsSync4(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync4(statePath, "utf8"));
        if (!state.defaultProvider) {
          state.defaultProvider = "dsh";
        }
        if (typeof state.turnTimeoutSeconds !== "number") {
          state.turnTimeoutSeconds = 300;
        }
        if (typeof state.stallTimeoutSeconds !== "number") {
          state.stallTimeoutSeconds = 120;
        }
        let mutated = false;
        for (const member of Object.values(state.members)) {
          if (member.status === "working" || member.status === "queued") {
            member.status = "waiting";
            member.activity = void 0;
            mutated = true;
          }
        }
        this.states.set(state.id, state);
        if (mutated) {
          this.saveState(state);
        }
      } catch (err) {
        console.error(`[agy-ext-swarm] Failed to load swarm ${entry.id}:`, err);
      }
    }
  }
  getSwarmDir(swarmId) {
    return join6(this.swarmsDir, swarmId);
  }
  getInboxDir(swarmId) {
    return join6(this.getSwarmDir(swarmId), "inbox");
  }
  getLogsDir(swarmId) {
    return join6(this.getSwarmDir(swarmId), "logs");
  }
  getPatchesDir(swarmId) {
    return join6(this.getSwarmDir(swarmId), "patches");
  }
  getWorktreesDir(swarmId) {
    return join6(this.getSwarmDir(swarmId), "worktrees");
  }
  getBoardPath(swarmId) {
    return join6(this.getSwarmDir(swarmId), "board.jsonl");
  }
  listSwarms() {
    return [...this.index.swarms];
  }
  getLatestSwarmId() {
    return this.index.latestSwarmId;
  }
  resolveSwarmId(swarmId) {
    if (swarmId && this.states.has(swarmId)) {
      return swarmId;
    }
    if (swarmId) {
      throw new Error(`Swarm "${swarmId}" not found.`);
    }
    if (this.index.latestSwarmId && this.states.has(this.index.latestSwarmId)) {
      return this.index.latestSwarmId;
    }
    const last = this.index.swarms[this.index.swarms.length - 1];
    if (last && this.states.has(last.id)) {
      return last.id;
    }
    throw new Error("No swarm exists yet. Call ext_swarm_create first.");
  }
  getSwarm(swarmId) {
    const id = this.resolveSwarmId(swarmId);
    const state = this.states.get(id);
    if (!state) {
      throw new Error(`Swarm "${id}" not found.`);
    }
    return state;
  }
  tryGetSwarm(swarmId) {
    try {
      return this.getSwarm(swarmId);
    } catch {
      return void 0;
    }
  }
  createSwarm(params) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const dir = this.getSwarmDir(params.id);
    mkdirSync3(dir, { recursive: true });
    mkdirSync3(this.getInboxDir(params.id), { recursive: true });
    mkdirSync3(this.getLogsDir(params.id), { recursive: true });
    mkdirSync3(this.getPatchesDir(params.id), { recursive: true });
    mkdirSync3(this.getWorktreesDir(params.id), { recursive: true });
    const state = {
      id: params.id,
      title: params.title,
      repoRoot: params.repoRoot,
      gitRepoRoot: params.gitRepoRoot,
      gitCommonDir: params.gitCommonDir,
      coordinatorConversationId: params.coordinatorConversationId,
      defaultProvider: params.defaultProvider?.trim() || "dsh",
      ...params.activeProviders && params.activeProviders.length > 0 ? { activeProviders: params.activeProviders } : {},
      ...params.routingPolicy ? { routingPolicy: params.routingPolicy } : {},
      rrCursor: 0,
      profile: params.profile,
      maxConcurrency: params.maxConcurrency,
      maxHops: params.maxHops,
      turnTimeoutSeconds: params.turnTimeoutSeconds ?? 300,
      stallTimeoutSeconds: params.stallTimeoutSeconds ?? 120,
      hopCount: 0,
      headSeq: 0,
      createdAt: now,
      updatedAt: now,
      members: {}
    };
    this.states.set(state.id, state);
    this.saveState(state);
    this.index.latestSwarmId = state.id;
    this.index.swarms.push({
      id: state.id,
      title: state.title,
      repoRoot: state.repoRoot,
      createdAt: now,
      updatedAt: now
    });
    this.saveIndex();
    this.emit("state", state.id, state);
    return state;
  }
  setCoordinatorConversation(swarmId, conversationId) {
    const trimmed = conversationId.trim();
    if (trimmed && !isSafeConversationId(trimmed)) {
      throw new Error(
        `Invalid coordinator conversation ID "${conversationId}". Must match ^[a-zA-Z0-9_-]{1,128}$.`
      );
    }
    const state = this.getSwarm(swarmId);
    state.coordinatorConversationId = trimmed || void 0;
    this.saveState(state);
    return state;
  }
  saveState(state) {
    state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    atomicWriteJson(join6(this.getSwarmDir(state.id), "state.json"), state);
    const idxEntry = this.index.swarms.find((s) => s.id === state.id);
    if (idxEntry) {
      idxEntry.updatedAt = state.updatedAt;
      idxEntry.title = state.title;
      this.saveIndex();
    }
    this.emit("state", state.id, state);
  }
  upsertMember(swarmId, member) {
    const state = this.getSwarm(swarmId);
    member.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    state.members[member.name] = member;
    this.saveState(state);
  }
  readBoard(swarmId, since = 0, limit = 200) {
    const boardPath = this.getBoardPath(swarmId);
    if (!existsSync4(boardPath)) return [];
    const lines = readFileSync4(boardPath, "utf8").split("\n");
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.seq > since) {
          out.push(msg);
        }
      } catch {
      }
    }
    if (limit > 0 && out.length > limit) {
      return out.slice(-limit);
    }
    return out;
  }
  appendBoardMessage(swarmId, input) {
    const state = this.getSwarm(swarmId);
    const knownWorkers = Object.keys(state.members);
    const parsed = extractMentions(input.text, knownWorkers);
    state.headSeq += 1;
    const msg = {
      seq: state.headSeq,
      agent: input.agent,
      text: input.text,
      kind: input.kind || "message",
      time: input.time || (/* @__PURE__ */ new Date()).toISOString(),
      mentions: parsed.mentions,
      all: parsed.all,
      mentionsCoordinator: parsed.mentionsCoordinator
    };
    appendFileSync(this.getBoardPath(swarmId), JSON.stringify(msg) + "\n", "utf8");
    this.saveState(state);
    this.emit("message", swarmId, msg);
    return msg;
  }
  computeGraphEdges(swarmId) {
    const state = this.getSwarm(swarmId);
    const messages = this.readBoard(swarmId, 0, 5e3);
    const memberNames = Object.keys(state.members);
    const edgeMap = /* @__PURE__ */ new Map();
    for (const msg of messages) {
      const targets = new Set(msg.mentions);
      if (msg.mentionsCoordinator && msg.agent !== "coordinator") {
        targets.add("coordinator");
      }
      if (msg.all) {
        for (const m of memberNames) {
          if (m !== msg.agent) targets.add(m);
        }
        if (msg.agent !== "coordinator") targets.add("coordinator");
      }
      for (const target of targets) {
        if (target === msg.agent) continue;
        const key = `${msg.agent}->${target}`;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.count += 1;
          existing.viaAll = existing.viaAll || msg.all;
        } else {
          edgeMap.set(key, { from: msg.agent, to: target, count: 1, viaAll: msg.all });
        }
      }
    }
    return Array.from(edgeMap.values());
  }
  startInboxWatcher(swarmId) {
    if (this.watchers.has(swarmId)) return;
    const inboxDir = this.getInboxDir(swarmId);
    mkdirSync3(inboxDir, { recursive: true });
    const drain = () => {
      this.drainInbox(swarmId);
    };
    let fsWatcher;
    try {
      fsWatcher = watch(inboxDir, () => drain());
    } catch {
    }
    const interval = setInterval(drain, 1e3);
    interval.unref?.();
    this.watchers.set(swarmId, { fsWatcher, interval });
    drain();
  }
  drainInbox(swarmId) {
    const inboxDir = this.getInboxDir(swarmId);
    if (!existsSync4(inboxDir)) return;
    let files;
    try {
      files = readdirSync2(inboxDir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
    } catch {
      return;
    }
    for (const file of files) {
      const fullPath = join6(inboxDir, file);
      if (this.processingInboxFiles.has(fullPath)) continue;
      this.processingInboxFiles.add(fullPath);
      try {
        const raw = readFileSync4(fullPath, "utf8");
        const payload = JSON.parse(raw);
        if (payload.agent && payload.text) {
          this.appendBoardMessage(swarmId, {
            agent: String(payload.agent),
            text: String(payload.text),
            kind: payload.kind || "message",
            time: payload.time
          });
        }
        unlinkSync(fullPath);
      } catch (err) {
        console.error(`[agy-ext-swarm] Failed to ingest inbox file ${fullPath}:`, err);
        try {
          unlinkSync(fullPath);
        } catch {
        }
      } finally {
        this.processingInboxFiles.delete(fullPath);
      }
    }
  }
  getUiPrefs() {
    const prefsPath = join6(this.dataDir, "ui-prefs.json");
    if (!existsSync4(prefsPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync4(prefsPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  setUiPrefs(patch) {
    const current = this.getUiPrefs();
    const next = { ...current };
    if (patch.locale === "zh" || patch.locale === "en") {
      next.locale = patch.locale;
    }
    atomicWriteJson(join6(this.dataDir, "ui-prefs.json"), next);
    return next;
  }
  deleteSwarm(swarmId) {
    const watcher = this.watchers.get(swarmId);
    if (watcher) {
      clearInterval(watcher.interval);
      watcher.fsWatcher?.close();
      this.watchers.delete(swarmId);
    }
    this.states.delete(swarmId);
    this.index.swarms = this.index.swarms.filter((s) => s.id !== swarmId);
    if (this.index.latestSwarmId === swarmId) {
      this.index.latestSwarmId = this.index.swarms[this.index.swarms.length - 1]?.id;
    }
    this.saveIndex();
    const dir = this.getSwarmDir(swarmId);
    if (existsSync4(dir)) {
      rmSync2(dir, { recursive: true, force: true });
    }
    this.emit("state", swarmId, void 0);
  }
  closeAllWatchers() {
    for (const { fsWatcher, interval } of this.watchers.values()) {
      clearInterval(interval);
      fsWatcher?.close();
    }
    this.watchers.clear();
  }
};

// src/providers/config.ts
var execFileAsync2 = promisify2(execFile2);
var BUILTIN_ADAPTERS = {
  dsh: dshAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter
};
var PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function dedupeStrings(items) {
  if (!Array.isArray(items)) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
function sanitizeEnvMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (!key || v === void 0 || v === null) continue;
    out[key] = String(v);
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function sanitizeEntryConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const rec = raw;
  const cfg = {};
  if (typeof rec.enabled === "boolean") cfg.enabled = rec.enabled;
  if (typeof rec.displayName === "string" && rec.displayName.trim()) {
    cfg.displayName = rec.displayName.trim();
  }
  if (typeof rec.command === "string" && rec.command.trim()) {
    cfg.command = rec.command.trim();
  }
  if (typeof rec.defaultModel === "string" && rec.defaultModel.trim()) {
    cfg.defaultModel = rec.defaultModel.trim();
  }
  if (Array.isArray(rec.models)) {
    const models = dedupeStrings(rec.models);
    if (models.length > 0) cfg.models = models;
  }
  if (typeof rec.profile === "string" && rec.profile.trim()) {
    cfg.profile = rec.profile.trim();
  }
  if (typeof rec.modelProvider === "string" && rec.modelProvider.trim()) {
    cfg.modelProvider = rec.modelProvider.trim();
  }
  if (Array.isArray(rec.args)) {
    cfg.args = rec.args.map((s) => String(s));
  }
  if (Array.isArray(rec.resumeArgs)) {
    cfg.resumeArgs = rec.resumeArgs.map((s) => String(s));
  }
  if (rec.promptMode === "stdin" || rec.promptMode === "arg") {
    cfg.promptMode = rec.promptMode;
  }
  if (rec.outputFormat === "text" || rec.outputFormat === "ndjson") {
    cfg.outputFormat = rec.outputFormat;
  }
  const env = sanitizeEnvMap(rec.env);
  if (env) cfg.env = env;
  return cfg;
}
function hasMeaningfulEntryConfig(cfg) {
  if (!cfg) return false;
  return Boolean(
    cfg.enabled === false || cfg.displayName || cfg.command || cfg.defaultModel || cfg.models && cfg.models.length > 0 || cfg.profile || cfg.modelProvider || cfg.args && cfg.args.length > 0 || cfg.resumeArgs && cfg.resumeArgs.length > 0 || cfg.promptMode || cfg.outputFormat || cfg.env && Object.keys(cfg.env).length > 0
  );
}
function sanitizePricingMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const out = {};
  for (const [modelKey, val] of Object.entries(raw)) {
    const model = modelKey.trim();
    if (!model || !val || typeof val !== "object" || Array.isArray(val)) continue;
    const rec = val;
    const inputPer1M = Number(rec.inputPer1M);
    const outputPer1M = Number(rec.outputPer1M);
    if (!Number.isFinite(inputPer1M) || inputPer1M < 0 || !Number.isFinite(outputPer1M) || outputPer1M < 0) {
      continue;
    }
    const cacheReadPer1M = rec.cacheReadPer1M !== void 0 && Number.isFinite(Number(rec.cacheReadPer1M)) && Number(rec.cacheReadPer1M) >= 0 ? Number(rec.cacheReadPer1M) : void 0;
    const currency = rec.currency === "CNY" ? "CNY" : rec.currency === "USD" ? "USD" : void 0;
    out[model] = {
      inputPer1M,
      outputPer1M,
      ...cacheReadPer1M !== void 0 ? { cacheReadPer1M } : {},
      ...currency ? { currency } : {}
    };
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function sanitizeProviderIdList(raw) {
  if (!Array.isArray(raw)) return void 0;
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const norm = item.trim().toLowerCase();
    if (!norm || !PROVIDER_ID_RE.test(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.length > 0 ? out : void 0;
}
function sanitizeRoutingPolicy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const rec = raw;
  const writerProviders = sanitizeProviderIdList(rec.writerProviders);
  const readerProviders = sanitizeProviderIdList(rec.readerProviders);
  const autoFailover = typeof rec.autoFailover === "boolean" ? rec.autoFailover : void 0;
  if (!writerProviders && !readerProviders && autoFailover === void 0) return void 0;
  return {
    ...writerProviders ? { writerProviders } : {},
    ...readerProviders ? { readerProviders } : {},
    ...autoFailover !== void 0 ? { autoFailover } : {}
  };
}
function readProvidersFile(filePath) {
  if (!existsSync5(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync5(filePath, "utf8"));
    if (parsed && typeof parsed === "object") {
      const providers = {};
      if (parsed.providers && typeof parsed.providers === "object") {
        for (const [rawId, rawCfg] of Object.entries(parsed.providers)) {
          const id = rawId.trim().toLowerCase();
          if (!id) continue;
          const sanitized = sanitizeEntryConfig(rawCfg);
          if (sanitized) providers[id] = sanitized;
        }
      }
      const pricing = sanitizePricingMap(parsed.pricing);
      const activePool = sanitizeProviderIdList(parsed.activePool);
      const routingPolicy = sanitizeRoutingPolicy(parsed.routingPolicy);
      return {
        defaultProvider: typeof parsed.defaultProvider === "string" && parsed.defaultProvider.trim() ? parsed.defaultProvider.trim().toLowerCase() : void 0,
        ...activePool ? { activePool } : {},
        ...routingPolicy ? { routingPolicy } : {},
        providers: Object.keys(providers).length > 0 ? providers : void 0,
        ...pricing ? { pricing } : {}
      };
    }
  } catch (err) {
    console.error(`[agy-ext-swarm] Failed to read ${filePath}:`, err);
  }
  return {};
}
function mergeProvidersConfig(dataDir, repoRoot) {
  const globalConfigPath = join7(dataDir, "providers.json");
  const repoConfigPath = repoRoot ? join7(repoRoot, ".agy-ext-swarm", "providers.json") : void 0;
  const repoConfigExists = Boolean(repoConfigPath && existsSync5(repoConfigPath));
  const globalCfg = readProvidersFile(globalConfigPath);
  const repoCfg = repoConfigPath ? readProvidersFile(repoConfigPath) : {};
  const merged = {};
  for (const [id, cfg] of Object.entries(globalCfg.providers || {})) {
    merged[id] = { ...cfg };
  }
  for (const [id, cfg] of Object.entries(repoCfg.providers || {})) {
    const prev = merged[id];
    merged[id] = prev ? {
      ...prev,
      ...cfg,
      env: prev.env || cfg.env ? { ...prev.env || {}, ...cfg.env || {} } : void 0
    } : { ...cfg };
  }
  const pricing = {
    ...globalCfg.pricing || {},
    ...repoCfg.pricing || {}
  };
  const activePool = repoCfg.activePool || globalCfg.activePool;
  const mergedRouting = globalCfg.routingPolicy || repoCfg.routingPolicy ? {
    ...globalCfg.routingPolicy || {},
    ...repoCfg.routingPolicy || {}
  } : void 0;
  return {
    globalConfigPath,
    repoConfigPath,
    repoConfigExists,
    globalCfg,
    repoCfg,
    configuredDefaultProvider: repoCfg.defaultProvider || globalCfg.defaultProvider,
    activePool,
    routingPolicy: mergedRouting,
    providers: merged,
    pricing
  };
}
function applyBuiltinOverride(base, override) {
  if (!override) return base;
  const mergedEnv = override.env ? { ...override.env } : void 0;
  const overridden = {
    ...base,
    displayName: override.displayName?.trim() || base.displayName,
    command: override.command?.trim() || base.command,
    defaultModel: override.defaultModel?.trim() || base.defaultModel,
    buildInvocation(ctx) {
      const inv = base.buildInvocation.call(overridden, ctx);
      if (mergedEnv) {
        inv.env = { ...mergedEnv, ...inv.env || {} };
      }
      return inv;
    }
  };
  return overridden;
}
function saveProviderConfigPatch(dataDir, patch) {
  const globalPath = join7(dataDir, "providers.json");
  const current = readProvidersFile(globalPath);
  const nextProviders = { ...current.providers || {} };
  const nextPricing = { ...current.pricing || {} };
  let nextDefault = current.defaultProvider;
  let nextActivePool = current.activePool ? [...current.activePool] : void 0;
  let nextRouting = current.routingPolicy ? { ...current.routingPolicy } : void 0;
  if (patch.defaultProvider !== void 0) {
    if (patch.defaultProvider === null || !patch.defaultProvider.trim()) {
      nextDefault = void 0;
    } else {
      const norm = patch.defaultProvider.trim().toLowerCase();
      if (!PROVIDER_ID_RE.test(norm)) {
        throw new Error(
          `Invalid defaultProvider "${patch.defaultProvider}". Must match ^[a-z0-9][a-z0-9_-]{0,31}$.`
        );
      }
      nextDefault = norm;
    }
  }
  if (patch.activePool !== void 0) {
    if (patch.activePool === null || patch.activePool.length === 0) {
      nextActivePool = void 0;
    } else {
      nextActivePool = sanitizeProviderIdList(patch.activePool);
    }
  }
  if (patch.routingPolicy !== void 0) {
    if (patch.routingPolicy === null) {
      nextRouting = void 0;
    } else {
      nextRouting = sanitizeRoutingPolicy(patch.routingPolicy);
    }
  }
  if (patch.removeProvider) {
    const rmId = patch.removeProvider.trim().toLowerCase();
    delete nextProviders[rmId];
    if (nextDefault === rmId) {
      nextDefault = void 0;
    }
    if (nextActivePool) {
      nextActivePool = nextActivePool.filter((id) => id !== rmId);
      if (nextActivePool.length === 0) nextActivePool = void 0;
    }
    if (nextRouting) {
      if (nextRouting.writerProviders) {
        nextRouting.writerProviders = nextRouting.writerProviders.filter((id) => id !== rmId);
        if (nextRouting.writerProviders.length === 0) delete nextRouting.writerProviders;
      }
      if (nextRouting.readerProviders) {
        nextRouting.readerProviders = nextRouting.readerProviders.filter((id) => id !== rmId);
        if (nextRouting.readerProviders.length === 0) delete nextRouting.readerProviders;
      }
      nextRouting = sanitizeRoutingPolicy(nextRouting);
    }
  }
  if (patch.upsertProvider) {
    const id = patch.upsertProvider.id.trim().toLowerCase();
    if (!PROVIDER_ID_RE.test(id)) {
      throw new Error(
        `Invalid provider ID "${patch.upsertProvider.id}". Must match ^[a-z0-9][a-z0-9_-]{0,31}$ (lowercase letters, numbers, - or _).`
      );
    }
    if (patch.upsertProvider.config === null) {
      delete nextProviders[id];
      if (!BUILTIN_ADAPTERS[id] && nextDefault === id) {
        nextDefault = void 0;
      }
    } else {
      const sanitized = sanitizeEntryConfig(patch.upsertProvider.config) || {};
      const builtinBase = BUILTIN_ADAPTERS[id];
      const isBuiltin = Boolean(builtinBase);
      if (!isBuiltin && (!sanitized.command || !sanitized.command.trim())) {
        throw new Error(`Custom CLI provider "${id}" requires a non-empty command.`);
      }
      if (isBuiltin && builtinBase) {
        if (sanitized.displayName === builtinBase.displayName) {
          delete sanitized.displayName;
        }
        if (sanitized.command === builtinBase.command) {
          delete sanitized.command;
        }
        if (id === "dsh" && sanitized.profile === "headless") {
          delete sanitized.profile;
        }
        if (id !== "dsh" && builtinBase.defaultModel && sanitized.defaultModel === builtinBase.defaultModel) {
          delete sanitized.defaultModel;
        }
      }
      if (sanitized.enabled === true) {
        delete sanitized.enabled;
      }
      if (isBuiltin && !hasMeaningfulEntryConfig(sanitized)) {
        delete nextProviders[id];
      } else {
        nextProviders[id] = sanitized;
      }
      if (sanitized.enabled === false && nextDefault === id) {
        nextDefault = void 0;
      }
    }
  }
  if (patch.upsertPricing) {
    const modelKey = patch.upsertPricing.model.trim();
    if (!modelKey) {
      throw new Error("Model name for pricing cannot be empty.");
    }
    if (patch.upsertPricing.pricing === null) {
      delete nextPricing[modelKey];
    } else {
      const sanitizedOne = sanitizePricingMap({ [modelKey]: patch.upsertPricing.pricing });
      if (!sanitizedOne || !sanitizedOne[modelKey]) {
        throw new Error(`Invalid pricing values for "${modelKey}".`);
      }
      nextPricing[modelKey] = sanitizedOne[modelKey];
    }
  }
  const out = {};
  if (nextDefault) {
    out.defaultProvider = nextDefault;
  }
  if (nextActivePool && nextActivePool.length > 0) {
    out.activePool = nextActivePool;
  }
  if (nextRouting) {
    out.routingPolicy = nextRouting;
  }
  if (Object.keys(nextProviders).length > 0) {
    out.providers = nextProviders;
  }
  if (Object.keys(nextPricing).length > 0) {
    out.pricing = nextPricing;
  }
  atomicWriteJson(globalPath, out);
  providerSnapshotCache.clear();
  return out;
}
function resolveDefaultProvider(dataDir, repoRoot) {
  const state = mergeProvidersConfig(dataDir, repoRoot);
  const configured = state.configuredDefaultProvider;
  if (configured) {
    const entry = state.providers[configured];
    const isKnown = Boolean(
      BUILTIN_ADAPTERS[configured] || entry && typeof entry.command === "string" && entry.command.trim()
    );
    if (isKnown && entry?.enabled !== false) {
      return configured;
    }
  }
  const priority = ["dsh", "claude", "codex", "gemini"];
  for (const id of priority) {
    const adapter = BUILTIN_ADAPTERS[id];
    const override = state.providers[id];
    if (!adapter || override?.enabled === false) continue;
    const cmd = override?.command?.trim() || adapter.command;
    if (resolveExecutable(cmd)) {
      return id;
    }
  }
  for (const [id, cfg] of Object.entries(state.providers)) {
    if (BUILTIN_ADAPTERS[id] || cfg.enabled === false) continue;
    if (cfg.command && resolveExecutable(cfg.command)) {
      return id;
    }
  }
  for (const id of priority) {
    if (state.providers[id]?.enabled !== false) {
      return id;
    }
  }
  return "dsh";
}
function resolveProviderAdapter(providerId, inlineCustomConfig, dataDir, repoRoot) {
  const id = providerId.trim().toLowerCase() || "dsh";
  if (inlineCustomConfig) {
    return createCustomAdapter(id, inlineCustomConfig);
  }
  const state = mergeProvidersConfig(dataDir, repoRoot);
  const entry = state.providers[id];
  if (entry?.enabled === false) {
    throw new Error(
      `CLI provider "${id}" is disabled in AGY Ext Swarm settings. Enable it in the Settings tab or providers.json.`
    );
  }
  const builtin = BUILTIN_ADAPTERS[id];
  if (builtin) {
    return applyBuiltinOverride(builtin, entry);
  }
  if (entry && typeof entry.command === "string" && entry.command.trim()) {
    return createCustomAdapter(id, entry);
  }
  throw new Error(
    `Unknown CLI provider "${providerId}". Available built-ins: ${Object.keys(BUILTIN_ADAPTERS).join(", ")}. Or pass custom_command / configure ${join7(dataDir, "providers.json")}.`
  );
}
var PROVIDER_SNAPSHOT_TTL_MS = 1e4;
var providerSnapshotCache = /* @__PURE__ */ new Map();
function fileMtimeToken(filePath) {
  if (!filePath || !existsSync5(filePath)) return "0";
  try {
    return String(statSync3(filePath).mtimeMs);
  } catch {
    return "0";
  }
}
function getProviderConfigSnapshot(dataDir, repoRoot, profileOverride, bypassCache = false) {
  const globalPath = join7(dataDir, "providers.json");
  const repoPath = repoRoot ? join7(repoRoot, ".agy-ext-swarm", "providers.json") : void 0;
  const cacheKey = `${dataDir}|${repoRoot || ""}|${profileOverride || ""}`;
  const mtimeSig = `${fileMtimeToken(globalPath)}:${fileMtimeToken(repoPath)}`;
  const now = Date.now();
  if (!bypassCache) {
    const cached = providerSnapshotCache.get(cacheKey);
    if (cached && now < cached.expiresAt && cached.mtimeSig === mtimeSig) {
      return cached.snapshot;
    }
  }
  const state = mergeProvidersConfig(dataDir, repoRoot);
  const descriptors = [];
  for (const base of Object.values(BUILTIN_ADAPTERS)) {
    const entry = state.providers[base.id];
    const enabled = entry?.enabled !== false;
    const displayName = entry?.displayName?.trim() || base.displayName;
    const command = entry?.command?.trim() || base.command;
    const resolvedPath = resolveExecutable(command);
    const configuredModels = dedupeStrings(entry?.models);
    const configuredDefaultModel = entry?.defaultModel?.trim() || void 0;
    if (base.id === "dsh") {
      const effectiveProfile = profileOverride?.trim() || entry?.profile?.trim() || "headless";
      const catalog = listDshModels(effectiveProfile);
      const detectedModels = catalog.models.map((m) => m.id);
      const detectedDefaultModel = catalog.defaultModel || void 0;
      const detectedModelProvider = catalog.defaultProvider || void 0;
      const models = dedupeStrings([...configuredModels, ...detectedModels]);
      const defaultModel = configuredDefaultModel || detectedDefaultModel || "default";
      descriptors.push({
        id: base.id,
        displayName,
        kind: "builtin",
        enabled,
        command,
        available: resolvedPath !== null,
        resolvedPath: resolvedPath || void 0,
        supportsSessionResume: base.supportsSessionResume,
        supportsStreamEvents: base.supportsStreamEvents,
        defaultModel,
        configuredDefaultModel,
        detectedDefaultModel,
        detectedModelProvider,
        models,
        configuredModels,
        detectedModels,
        profile: effectiveProfile,
        modelProvider: entry?.modelProvider?.trim() || void 0,
        hasOverride: hasMeaningfulEntryConfig(entry),
        env: entry?.env,
        notes: base.notes
      });
    } else {
      const defaultModel = configuredDefaultModel || base.defaultModel || "default";
      const models = configuredModels.length > 0 ? configuredModels : defaultModel ? [defaultModel] : [];
      descriptors.push({
        id: base.id,
        displayName,
        kind: "builtin",
        enabled,
        command,
        available: resolvedPath !== null,
        resolvedPath: resolvedPath || void 0,
        supportsSessionResume: base.supportsSessionResume,
        supportsStreamEvents: base.supportsStreamEvents,
        defaultModel,
        configuredDefaultModel,
        models,
        configuredModels,
        hasOverride: hasMeaningfulEntryConfig(entry),
        env: entry?.env,
        notes: base.notes
      });
    }
  }
  for (const [id, entry] of Object.entries(state.providers)) {
    if (BUILTIN_ADAPTERS[id]) continue;
    if (typeof entry.command !== "string" || !entry.command.trim()) continue;
    const adapter = createCustomAdapter(id, entry);
    const resolvedPath = resolveExecutable(adapter.command);
    const configuredModels = dedupeStrings(entry.models);
    const configuredDefaultModel = entry.defaultModel?.trim() || void 0;
    const defaultModel = configuredDefaultModel || adapter.defaultModel || "default";
    const models = configuredModels.length > 0 ? configuredModels : defaultModel ? [defaultModel] : [];
    descriptors.push({
      id,
      displayName: adapter.displayName,
      kind: "custom",
      enabled: entry.enabled !== false,
      command: adapter.command,
      available: resolvedPath !== null,
      resolvedPath: resolvedPath || void 0,
      supportsSessionResume: adapter.supportsSessionResume,
      supportsStreamEvents: adapter.supportsStreamEvents,
      defaultModel,
      configuredDefaultModel,
      models,
      configuredModels,
      hasOverride: true,
      args: entry.args,
      resumeArgs: entry.resumeArgs,
      promptMode: entry.promptMode,
      outputFormat: entry.outputFormat,
      env: entry.env,
      notes: adapter.notes
    });
  }
  const snapshot = {
    globalConfigPath: state.globalConfigPath,
    repoConfigPath: state.repoConfigPath,
    repoConfigExists: state.repoConfigExists,
    configuredDefaultProvider: state.configuredDefaultProvider,
    effectiveDefaultProvider: resolveDefaultProvider(dataDir, repoRoot),
    ...state.activePool && state.activePool.length > 0 ? { activePool: state.activePool } : {},
    ...state.routingPolicy ? { routingPolicy: state.routingPolicy } : {},
    providers: descriptors,
    ...Object.keys(state.pricing).length > 0 ? { pricing: state.pricing } : {}
  };
  if (providerSnapshotCache.size >= 32) {
    const oldest = providerSnapshotCache.keys().next().value;
    if (oldest) providerSnapshotCache.delete(oldest);
  }
  providerSnapshotCache.set(cacheKey, {
    expiresAt: Date.now() + PROVIDER_SNAPSHOT_TTL_MS,
    mtimeSig,
    snapshot
  });
  return snapshot;
}
async function testProviderConnection(providerId, dataDir, repoRoot, profileOverride) {
  const id = providerId.trim().toLowerCase();
  const snap = getProviderConfigSnapshot(dataDir, repoRoot, profileOverride, true);
  const descriptor = snap.providers.find((p) => p.id === id);
  const warnings = [];
  if (!descriptor) {
    return {
      providerId: id,
      command: id,
      ok: false,
      latencyMs: 0,
      details: `Unknown CLI provider "${providerId}".`
    };
  }
  if (!descriptor.enabled) {
    warnings.push("Provider is currently disabled in Settings.");
  }
  if (!descriptor.resolvedPath) {
    return {
      providerId: id,
      command: descriptor.command,
      ok: false,
      latencyMs: 0,
      details: `Command "${descriptor.command}" not found in PATH or at specified path.`,
      ...warnings.length > 0 ? { warnings } : {}
    };
  }
  const start = Date.now();
  const env = buildAugmentedEnv(descriptor.env);
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(descriptor.resolvedPath);
  let versionText = "";
  let probeOk = false;
  let probeError = "";
  for (const flag of ["--version", "-v"]) {
    try {
      const res = await execFileAsync2(descriptor.resolvedPath, [flag], {
        env,
        timeout: 5e3,
        maxBuffer: 256 * 1024,
        shell: useShell
      });
      const combined = `${res.stdout || ""}
${res.stderr || ""}`.trim();
      if (combined) {
        versionText = combined.split("\n")[0].trim().slice(0, 120);
      }
      probeOk = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      probeError = msg;
    }
  }
  const latencyMs = Date.now() - start;
  if (!probeOk) {
    return {
      providerId: id,
      command: descriptor.command,
      resolvedPath: descriptor.resolvedPath,
      ok: false,
      latencyMs,
      details: `Executable found at ${descriptor.resolvedPath}, but version probe failed: ${probeError.slice(0, 240)}`,
      ...warnings.length > 0 ? { warnings } : {}
    };
  }
  const extraDetails = [];
  if (versionText) {
    extraDetails.push(`version: ${versionText}`);
  } else {
    extraDetails.push(`executable responded (${latencyMs}ms)`);
  }
  if (id === "dsh") {
    const profile = profileOverride?.trim() || descriptor.profile || "headless";
    const catalog = listDshModels(profile);
    if (!catalog.exists) {
      warnings.push(`dsh profile patch file not found: ${catalog.configPath}`);
    } else {
      extraDetails.push(
        `profile="${profile}", defaultModel="${catalog.defaultModel || "default"}", catalog=${catalog.models.length} models`
      );
    }
  }
  return {
    providerId: id,
    command: descriptor.command,
    resolvedPath: descriptor.resolvedPath,
    ok: true,
    ...versionText ? { version: versionText } : {},
    latencyMs,
    details: extraDetails.join(" | "),
    ...warnings.length > 0 ? { warnings } : {}
  };
}
function getProviderModels(providerId, dataDir, repoRoot, profileOverride) {
  const resolvedId = (providerId?.trim() || resolveDefaultProvider(dataDir, repoRoot)).toLowerCase();
  const snap = getProviderConfigSnapshot(dataDir, repoRoot, profileOverride, true);
  const descriptor = snap.providers.find((p) => p.id === resolvedId);
  if (resolvedId === "dsh") {
    const effectiveProfile = profileOverride?.trim() || descriptor?.profile || "headless";
    const catalog = listDshModels(effectiveProfile);
    const effectiveModelProvider = descriptor?.modelProvider || catalog.defaultProvider || void 0;
    return {
      provider: "dsh",
      displayName: descriptor?.displayName || "DeepSeek Harness (dsh)",
      enabled: descriptor?.enabled ?? true,
      available: descriptor?.available ?? false,
      defaultModel: descriptor?.defaultModel || "default",
      models: descriptor?.models || [],
      configuredModels: descriptor?.configuredModels || [],
      detectedModels: descriptor?.detectedModels,
      modelDetails: catalog.models,
      profile: effectiveProfile,
      configPath: catalog.configPath,
      exists: catalog.exists,
      modelProvider: effectiveModelProvider,
      note: catalog.note
    };
  }
  return {
    provider: resolvedId,
    displayName: descriptor?.displayName || resolvedId,
    enabled: descriptor?.enabled ?? true,
    available: descriptor?.available ?? false,
    defaultModel: descriptor?.defaultModel || "default",
    models: descriptor?.models || ["default"],
    configuredModels: descriptor?.configuredModels || [],
    note: descriptor?.notes || `Pass any model identifier supported by "${resolvedId}" CLI directly to ext_swarm_add.`
  };
}

// src/runner.ts
import {
  exec,
  execFile as execFile3,
  spawn
} from "node:child_process";
import { appendFileSync as appendFileSync2, existsSync as existsSync7, mkdirSync as mkdirSync4, realpathSync as realpathSync2 } from "node:fs";
import { join as join9, resolve as resolve3 } from "node:path";
import { randomBytes as randomBytes2 } from "node:crypto";
import { promisify as promisify3 } from "node:util";

// src/templates.ts
import { existsSync as existsSync6, readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";
var TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
var BUILTIN_TEMPLATES = [
  {
    id: "feature-squad",
    name: "Feature Squad (Implement -> Review & Test)",
    description: "One isolated worktree implementer followed automatically by a read-only code reviewer and a parallel test author once implementation finishes.",
    kind: "builtin",
    defaultTitle: "Feature Squad",
    workers: [
      {
        name: "impl",
        role: "Feature Implementer",
        workspace: "worktree",
        permission: "workspace-write",
        brief: "Implement the requested feature cleanly in your isolated worktree:\n{{goal}}\n\nFollow repository conventions, keep changes focused, and summarize modified files plus verification steps before finishing."
      },
      {
        name: "reviewer",
        role: "Code Reviewer",
        workspace: "inherit",
        permission: "read-only",
        dependsOn: ["impl"],
        brief: "Review the implementation completed by @impl for:\n{{goal}}\n\nInspect edge cases, security/error handling, regressions, and report actionable findings to @coordinator."
      },
      {
        name: "tester",
        role: "Test Author",
        workspace: "worktree",
        permission: "workspace-write",
        dependsOn: ["impl"],
        brief: "Write and run unit/integration tests covering the work for:\n{{goal}}\n\nReport test results and coverage gaps to @coordinator."
      }
    ]
  },
  {
    id: "bug-hunt",
    name: "Bug Hunt (Reproduce -> Fix -> Verify)",
    description: "Root-cause investigator reproduces the bug first, hands off findings to a worktree fixer, then a regression verifier confirms the fix.",
    kind: "builtin",
    defaultTitle: "Bug Hunt",
    workers: [
      {
        name: "reproducer",
        role: "Bug Investigator",
        workspace: "inherit",
        permission: "read-only",
        brief: "Investigate and locate the root cause and minimal reproduction steps for:\n{{goal}}\n\nSummarize exact files, symbols, and reproduction steps so @fixer can patch it directly."
      },
      {
        name: "fixer",
        role: "Bug Fixer",
        workspace: "worktree",
        permission: "workspace-write",
        dependsOn: ["reproducer"],
        brief: "Apply a clean, minimal fix in your isolated worktree based on @reproducer findings for:\n{{goal}}\n\nAdd regression assertions if missing and verify locally."
      },
      {
        name: "verifier",
        role: "Regression Verifier",
        workspace: "inherit",
        permission: "read-only",
        dependsOn: ["fixer"],
        brief: "Verify the fix proposed by @fixer for:\n{{goal}}\n\nCheck for unintended side effects, missed edge cases, and report go/no-go to @coordinator."
      }
    ]
  },
  {
    id: "doc-and-test",
    name: "Docs & Tests Parallel",
    description: "Two parallel worktree workers updating documentation/examples and adding automated test coverage side by side.",
    kind: "builtin",
    defaultTitle: "Docs & Tests",
    workers: [
      {
        name: "docs",
        role: "Docs Updater",
        workspace: "worktree",
        permission: "workspace-write",
        brief: "Update documentation, usage examples, and inline comments relevant to:\n{{goal}}\n\nKeep docs accurate against current source code."
      },
      {
        name: "tests",
        role: "Test Coverage Author",
        workspace: "worktree",
        permission: "workspace-write",
        brief: "Add or strengthen automated tests covering:\n{{goal}}\n\nRun the test suite cleanly in your worktree and summarize results."
      }
    ]
  }
];
function sanitizeWorkerSpec(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw;
  const nameRaw = typeof r.name === "string" ? r.name : "";
  const nameCheck = validateWorkerName(nameRaw);
  if (!nameCheck.valid) return null;
  const role = typeof r.role === "string" && r.role.trim() ? r.role.trim() : nameCheck.normalized;
  const brief = typeof r.brief === "string" ? r.brief.trim() : "";
  if (!brief) return null;
  const workspace = r.workspace === "inherit" || r.workspace === "worktree" ? r.workspace : void 0;
  const permission = r.permission === "read-only" || r.permission === "workspace-write" || r.permission === "danger-full-access" ? r.permission : void 0;
  const dependsOn = Array.isArray(r.dependsOn) ? r.dependsOn.map((d) => String(d).trim().toLowerCase()).filter((d) => d && d !== nameCheck.normalized) : void 0;
  const allowedFiles = Array.isArray(r.allowedFiles) ? r.allowedFiles.map((f) => String(f).trim()).filter(Boolean) : void 0;
  const verifyCommands = Array.isArray(r.verifyCommands) ? r.verifyCommands.map((c) => String(c).trim()).filter(Boolean) : void 0;
  return {
    name: nameCheck.normalized,
    role,
    brief,
    ...typeof r.provider === "string" && r.provider.trim() ? { provider: r.provider.trim().toLowerCase() } : {},
    ...typeof r.model === "string" && r.model.trim() ? { model: r.model.trim() } : {},
    ...workspace ? { workspace } : {},
    ...permission ? { permission } : {},
    ...dependsOn && dependsOn.length > 0 ? { dependsOn: [...new Set(dependsOn)] } : {},
    ...allowedFiles && allowedFiles.length > 0 ? { allowedFiles } : {},
    ...verifyCommands && verifyCommands.length > 0 ? { verifyCommands } : {},
    ...typeof r.autoVerify === "boolean" ? { autoVerify: r.autoVerify } : {}
  };
}
function sanitizeTemplate(raw, kind) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw;
  const id = typeof r.id === "string" ? r.id.trim().toLowerCase() : "";
  if (!TEMPLATE_ID_RE.test(id)) return null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : id;
  const description = typeof r.description === "string" ? r.description.trim() : "";
  const workersRaw = Array.isArray(r.workers) ? r.workers : [];
  const workers = [];
  const seenNames = /* @__PURE__ */ new Set();
  for (const w of workersRaw) {
    const spec = sanitizeWorkerSpec(w);
    if (!spec || seenNames.has(spec.name)) continue;
    seenNames.add(spec.name);
    workers.push(spec);
  }
  if (workers.length === 0) return null;
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
    ...typeof r.defaultTitle === "string" && r.defaultTitle.trim() ? { defaultTitle: r.defaultTitle.trim() } : {},
    workers
  };
}
function readTemplatesFile(filePath) {
  if (!existsSync6(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync6(filePath, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.templates) ? parsed.templates : [];
    const out = [];
    for (const item of list) {
      const tpl = sanitizeTemplate(item, "custom");
      if (tpl) out.push(tpl);
    }
    return out;
  } catch (err) {
    console.error(`[agy-ext-swarm] Failed to read templates from ${filePath}:`, err);
    return [];
  }
}
function getTemplatesSnapshot(dataDir, repoRoot) {
  const globalPath = join8(dataDir, "templates.json");
  const repoPath = repoRoot ? join8(repoRoot, ".agy-ext-swarm", "templates.json") : void 0;
  const byId = /* @__PURE__ */ new Map();
  for (const b of BUILTIN_TEMPLATES) {
    byId.set(b.id, { ...b, workers: b.workers.map((w) => ({ ...w })) });
  }
  for (const g of readTemplatesFile(globalPath)) {
    const existing = byId.get(g.id);
    byId.set(g.id, { ...g, kind: existing?.kind === "builtin" ? "builtin" : "custom" });
  }
  if (repoPath) {
    for (const r of readTemplatesFile(repoPath)) {
      const existing = byId.get(r.id);
      byId.set(r.id, { ...r, kind: existing?.kind === "builtin" ? "builtin" : "custom" });
    }
  }
  return {
    globalPath,
    repoPath,
    templates: [...byId.values()]
  };
}
function saveTemplatePatch(dataDir, repoRoot, patch) {
  const globalPath = join8(dataDir, "templates.json");
  const existingCustom = readTemplatesFile(globalPath);
  const byId = new Map(existingCustom.map((t) => [t.id, t]));
  if (patch.removeTemplateId) {
    const rmId = patch.removeTemplateId.trim().toLowerCase();
    const isBuiltin = BUILTIN_TEMPLATES.some((b) => b.id === rmId);
    if (isBuiltin && !byId.has(rmId)) {
      throw new Error(`Built-in template "${rmId}" cannot be deleted.`);
    }
    byId.delete(rmId);
  }
  if (patch.upsertTemplate) {
    const sanitized = sanitizeTemplate(patch.upsertTemplate, "custom");
    if (!sanitized) {
      throw new Error(
        `Invalid template: requires lowercase id matching ^[a-z0-9][a-z0-9_-]{0,47}$ and at least 1 valid worker with name + brief.`
      );
    }
    byId.set(sanitized.id, sanitized);
  }
  atomicWriteJson(globalPath, {
    templates: [...byId.values()].map(({ kind: _k, ...rest }) => rest)
  });
  return getTemplatesSnapshot(dataDir, repoRoot);
}
function expandTemplateWorkerBrief(rawBrief, goal) {
  const cleanGoal = goal.trim();
  if (!cleanGoal) return rawBrief.replace(/\{\{goal\}\}/g, "").trim();
  if (rawBrief.includes("{{goal}}")) {
    return rawBrief.split("{{goal}}").join(cleanGoal).trim();
  }
  return `${rawBrief.trim()}

Goal:
${cleanGoal}`;
}

// src/runner.ts
var execAsync = promisify3(exec);
function inferMessageKind(text) {
  if (/\[blocker\]/i.test(text)) return "blocker";
  if (/\[done\]/i.test(text)) return "done";
  return "message";
}
function killProcessTree(proc, signal = "SIGTERM") {
  if (process.platform === "win32") {
    if (proc.pid) {
      try {
        execFile3("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => {
        });
        return;
      } catch {
      }
    }
    try {
      proc.kill(signal);
    } catch {
    }
    return;
  }
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
    }
  }
  try {
    proc.kill(signal);
  } catch {
  }
}
var SwarmRuntime = class {
  store;
  pluginRoot;
  boardCli;
  runningProcs = /* @__PURE__ */ new Map();
  queues = /* @__PURE__ */ new Map();
  initialPrompts = /* @__PURE__ */ new Map();
  shuttingDown = false;
  constructor(store, pluginRoot) {
    this.store = store;
    this.pluginRoot = pluginRoot;
    this.boardCli = join9(this.pluginRoot, "bin", "ext-board.mjs");
    for (const s of this.store.listSwarms()) {
      this.store.startInboxWatcher(s.id);
    }
    this.store.on("message", (swarmId, msg) => {
      this.handleBoardMessage(swarmId, msg);
    });
  }
  procKey(swarmId, memberName) {
    return `${swarmId}:${memberName}`;
  }
  async createSwarm(params) {
    const resolvedRoot = resolve3(params.repoRoot);
    if (!existsSync7(resolvedRoot)) {
      throw new Error(`repo_root does not exist: ${resolvedRoot}`);
    }
    const absRoot = realpathSync2(resolvedRoot);
    const trimmedConvId = params.coordinatorConversationId?.trim();
    if (trimmedConvId && !isSafeConversationId(trimmedConvId)) {
      throw new Error(
        `Invalid coordinator_conversation_id "${params.coordinatorConversationId}". Must match ^[a-zA-Z0-9_-]{1,128}$.`
      );
    }
    const gitInfo = await detectGitRepo(absRoot);
    const id = `sw-${Date.now().toString(36)}-${randomBytes2(3).toString("hex")}`;
    const providerSnap = getProviderConfigSnapshot(this.store.dataDir, absRoot, params.profile);
    const dshProfile = providerSnap.providers.find((p) => p.id === "dsh")?.profile || "headless";
    const cleanActiveProviders = params.activeProviders ? [...new Set(params.activeProviders.map((p) => p.trim().toLowerCase()).filter(Boolean))] : providerSnap.activePool && providerSnap.activePool.length > 0 ? [...providerSnap.activePool] : void 0;
    const mergedRoutingPolicy = params.routingPolicy ? {
      ...params.routingPolicy.writerProviders?.length ? {
        writerProviders: [
          ...new Set(
            params.routingPolicy.writerProviders.map((p) => p.trim().toLowerCase()).filter(Boolean)
          )
        ]
      } : {},
      ...params.routingPolicy.readerProviders?.length ? {
        readerProviders: [
          ...new Set(
            params.routingPolicy.readerProviders.map((p) => p.trim().toLowerCase()).filter(Boolean)
          )
        ]
      } : {},
      ...params.routingPolicy.autoFailover !== void 0 ? { autoFailover: params.routingPolicy.autoFailover } : {}
    } : providerSnap.routingPolicy ? { ...providerSnap.routingPolicy } : void 0;
    const defaultProvider = params.defaultProvider?.trim().toLowerCase() || cleanActiveProviders && cleanActiveProviders[0] || providerSnap.effectiveDefaultProvider || resolveDefaultProvider(this.store.dataDir, absRoot);
    const turnTimeoutSeconds = typeof params.turnTimeoutSeconds === "number" ? Math.max(0, Math.floor(params.turnTimeoutSeconds)) : 300;
    const stallTimeoutSeconds = typeof params.stallTimeoutSeconds === "number" ? Math.max(0, Math.floor(params.stallTimeoutSeconds)) : 120;
    const state = this.store.createSwarm({
      id,
      title: params.title.trim() || "AGY Ext Swarm",
      repoRoot: absRoot,
      gitRepoRoot: gitInfo?.repoRoot,
      gitCommonDir: gitInfo?.gitCommonDir,
      coordinatorConversationId: trimmedConvId || void 0,
      defaultProvider,
      activeProviders: cleanActiveProviders,
      routingPolicy: mergedRoutingPolicy,
      profile: (params.profile || dshProfile).trim() || "headless",
      maxConcurrency: Math.max(1, Math.min(16, params.maxConcurrency ?? 4)),
      maxHops: Math.max(1, Math.min(50, params.maxHops ?? 12)),
      turnTimeoutSeconds,
      stallTimeoutSeconds
    });
    this.store.startInboxWatcher(state.id);
    return state;
  }
  pickRoutedProvider(swarm, permissionMode, providerSnap) {
    const policy = swarm.routingPolicy;
    const rawPool = permissionMode === "read-only" && policy?.readerProviders && policy.readerProviders.length > 0 ? policy.readerProviders : permissionMode !== "read-only" && policy?.writerProviders && policy.writerProviders.length > 0 ? policy.writerProviders : swarm.activeProviders && swarm.activeProviders.length > 0 ? swarm.activeProviders : [swarm.defaultProvider || "dsh"];
    const enabledPool = rawPool.filter((id) => {
      const desc = providerSnap.providers.find((p) => p.id === id);
      return desc ? desc.enabled : true;
    });
    const effectivePool = enabledPool.length > 0 ? enabledPool : [swarm.defaultProvider || "dsh"];
    const cursor = swarm.rrCursor || 0;
    const chosen = effectivePool[cursor % effectivePool.length];
    swarm.rrCursor = cursor + 1;
    this.store.saveState(swarm);
    return chosen;
  }
  async addWorker(input) {
    const swarm = this.store.getSwarm(input.swarmId);
    const warnings = [];
    const providerSnap = getProviderConfigSnapshot(
      this.store.dataDir,
      swarm.repoRoot,
      swarm.profile
    );
    const permissionMode = input.permissionMode || "workspace-write";
    const requestedWorkspace = input.workspace || "worktree";
    const role = (input.role || "worker").trim() || "worker";
    const allowedFiles = input.allowedFiles?.map((s) => s.trim()).filter(Boolean);
    const verifyCommands = input.verifyCommands?.map((s) => s.trim()).filter(Boolean);
    const explicitProviders = (input.providers || []).map((p) => p.trim().toLowerCase()).filter(Boolean);
    const explicitSingle = input.provider?.trim().toLowerCase();
    const targets = [];
    if (input.tasks && input.tasks.length > 0) {
      const baseCheck = validateWorkerName(input.name);
      if (!baseCheck.valid) {
        throw new Error(baseCheck.error);
      }
      for (let i = 0; i < input.tasks.length; i++) {
        const shardName = `${baseCheck.normalized}-${i + 1}`;
        const shardCheck = validateWorkerName(shardName);
        if (!shardCheck.valid) {
          throw new Error(shardCheck.error);
        }
        const providerId = explicitProviders.length > 0 ? explicitProviders[i % explicitProviders.length] : explicitSingle || (input.customCommand ? "custom" : this.pickRoutedProvider(swarm, permissionMode, providerSnap));
        targets.push({
          name: shardCheck.normalized,
          taskText: `${input.brief}

Assigned Slice (${i + 1}/${input.tasks.length}):
${input.tasks[i]}`,
          providerId
        });
      }
    } else if (explicitProviders.length >= 2) {
      const baseCheck = validateWorkerName(input.name);
      if (!baseCheck.valid) {
        throw new Error(baseCheck.error);
      }
      const usedInCall = new Set(Object.keys(swarm.members));
      for (const provId of explicitProviders) {
        const slug = provId.replace(/[^a-z0-9_-]+/g, "") || "cli";
        const maxBase = Math.max(1, 24 - 1 - slug.length);
        let fanName = `${baseCheck.normalized.slice(0, maxBase)}-${slug}`;
        if (usedInCall.has(fanName)) {
          let idx = 2;
          while (usedInCall.has(`${fanName.slice(0, Math.max(1, 24 - 2 - String(idx).length))}-${idx}`)) {
            idx++;
          }
          fanName = `${fanName.slice(0, Math.max(1, 24 - 2 - String(idx).length))}-${idx}`;
        }
        const check = validateWorkerName(fanName);
        if (!check.valid) {
          throw new Error(check.error);
        }
        usedInCall.add(check.normalized);
        targets.push({
          name: check.normalized,
          taskText: input.brief,
          providerId: provId
        });
      }
    } else {
      const check = validateWorkerName(input.name);
      if (!check.valid) {
        throw new Error(check.error);
      }
      const providerId = explicitProviders[0] || explicitSingle || (input.customCommand ? "custom" : this.pickRoutedProvider(swarm, permissionMode, providerSnap));
      targets.push({ name: check.normalized, taskText: input.brief, providerId });
    }
    for (const t of targets) {
      if (swarm.members[t.name]) {
        throw new Error(
          `Worker "${t.name}" already exists in swarm "${swarm.id}" (status: ${swarm.members[t.name].status}). Killed names cannot be reused.`
        );
      }
      if (t.providerId === "custom" && !input.customCommand) {
        throw new Error('custom_command is required when provider="custom".');
      }
      resolveProviderAdapter(t.providerId, input.customCommand, this.store.dataDir, swarm.repoRoot);
    }
    const dependsOn = input.dependsOn ? [...new Set(input.dependsOn.map((d) => d.trim().toLowerCase()).filter(Boolean))] : [];
    const fanBaseCheck = validateWorkerName(input.name);
    const arenaGroup = input.arenaGroup?.trim() || (explicitProviders.length >= 2 && (!input.tasks || input.tasks.length === 0) && fanBaseCheck.valid ? `multi-${fanBaseCheck.normalized}` : void 0);
    if (dependsOn.length > 0) {
      const targetNameSet = new Set(targets.map((t) => t.name));
      for (const depName of dependsOn) {
        if (targetNameSet.has(depName)) {
          throw new Error(`Worker cannot depend on itself ("${depName}").`);
        }
        const depMember = swarm.members[depName];
        if (!depMember) {
          throw new Error(
            `Dependency worker "${depName}" does not exist in swarm "${swarm.id}".`
          );
        }
        if (depMember.status === "failed" || depMember.status === "killed") {
          throw new Error(
            `Cannot depend on worker "${depName}" because its status is already "${depMember.status}".`
          );
        }
      }
    }
    const allDepsReady = dependsOn.length === 0 || dependsOn.every((depName) => {
      const dep = swarm.members[depName];
      return Boolean(dep && dep.status === "waiting" && dep.turns > 0);
    });
    const added = [];
    const briefSeqs = [];
    for (const target of targets) {
      const providerId = target.providerId;
      const adapter = resolveProviderAdapter(
        providerId,
        input.customCommand,
        this.store.dataDir,
        swarm.repoRoot
      );
      const descriptor = !input.customCommand ? providerSnap.providers.find((p) => p.id === providerId) : void 0;
      const requestedModel = input.modelsByProvider?.[providerId]?.trim() || input.model?.trim() || descriptor?.defaultModel || adapter.defaultModel || "default";
      let modelProvider;
      if (providerId === "dsh") {
        modelProvider = descriptor?.modelProvider || descriptor?.detectedModelProvider || void 0;
        if (input.model?.trim() && requestedModel !== "default" && descriptor && descriptor.models.length > 0) {
          const known = descriptor.models.includes(requestedModel);
          if (!known) {
            warnings.push(
              `Model "${requestedModel}" is not listed in configured models or dsh lastCatalog; dsh may reject it unless supported by profile "${descriptor.profile || swarm.profile}".`
            );
          }
        }
      }
      let effectiveWorkspace = requestedWorkspace;
      let workerCwd = swarm.repoRoot;
      let branch;
      let baseRef;
      if (requestedWorkspace === "worktree") {
        if (!swarm.gitRepoRoot) {
          effectiveWorkspace = "inherit";
          warnings.push(
            `Worker "${target.name}" requested workspace="worktree", but "${swarm.repoRoot}" is not a git repository with commits; falling back to workspace="inherit".`
          );
        } else {
          const wt = await createWorktree(
            swarm.gitRepoRoot,
            swarm.id,
            target.name,
            this.store.getWorktreesDir(swarm.id)
          );
          workerCwd = wt.worktreePath;
          branch = wt.branch;
          baseRef = wt.baseRef;
        }
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const shouldBlock = dependsOn.length > 0 && !allDepsReady;
      const member = {
        name: target.name,
        role,
        status: shouldBlock ? "blocked" : "queued",
        model: requestedModel,
        provider: providerId,
        modelProvider,
        customConfig: input.customCommand,
        permissionMode,
        workspaceMode: effectiveWorkspace,
        cwd: workerCwd,
        branch,
        baseRef,
        turns: 0,
        steps: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0
        },
        lastReadSeq: swarm.headSeq,
        pendingWake: false,
        allowedFiles: allowedFiles && allowedFiles.length > 0 ? allowedFiles : void 0,
        verifyCommands: verifyCommands && verifyCommands.length > 0 ? verifyCommands : void 0,
        autoVerify: input.autoVerify ? true : void 0,
        dependsOn: dependsOn.length > 0 ? dependsOn : void 0,
        pendingBrief: shouldBlock ? target.taskText : void 0,
        arenaGroup,
        retryTurns: 0,
        createdAt: now,
        updatedAt: now
      };
      this.store.upsertMember(swarm.id, member);
      if (shouldBlock) {
        const blockMsg = this.store.appendBoardMessage(swarm.id, {
          agent: "system",
          text: `Worker "${member.name}" added as blocked (waiting on: ${dependsOn.join(", ")}).`,
          kind: "system"
        });
        briefSeqs.push(blockMsg.seq);
        member.lastReadSeq = blockMsg.seq;
        this.store.upsertMember(swarm.id, member);
      } else {
        let promptTaskText = target.taskText;
        if (dependsOn.length > 0) {
          const upstreamSummary = await this.collectUpstreamContext(swarm.id, dependsOn);
          if (upstreamSummary) {
            promptTaskText = `${target.taskText}

${upstreamSummary}`;
          }
        }
        const briefMsg = this.store.appendBoardMessage(swarm.id, {
          agent: "coordinator",
          text: `@${member.name} ${target.taskText}`,
          kind: "brief"
        });
        briefSeqs.push(briefMsg.seq);
        member.lastReadSeq = briefMsg.seq;
        this.store.upsertMember(swarm.id, member);
        const initialPrompt = this.buildInitialPrompt(swarm, member, promptTaskText, briefMsg.seq);
        this.initialPrompts.set(this.procKey(swarm.id, member.name), initialPrompt);
        this.enqueueTask({
          swarmId: swarm.id,
          memberName: member.name,
          overridePrompt: initialPrompt,
          maxDeliveredSeq: briefMsg.seq
        });
      }
      added.push(member);
    }
    if (dependsOn.length > 0 && !allDepsReady) {
      await this.checkAndReleaseBlockedDependents(swarm.id);
    }
    return { swarmId: swarm.id, added, warnings, briefSeqs };
  }
  buildInitialPrompt(swarm, member, brief, briefSeq) {
    const swarmDir = this.store.getSwarmDir(swarm.id);
    const lines = [
      `You are worker "${member.name}" (role: ${member.role}) in AGY Ext Swarm "${swarm.title}" (${swarm.id}).`,
      `Working directory: ${member.cwd}`,
      `Permission mode: ${member.permissionMode}`,
      `Your assignment is board post #${briefSeq}.`
    ];
    if (member.branch) {
      lines.push(
        `Git isolation: You are on dedicated branch "${member.branch}" (base commit ${member.baseRef || "HEAD"}). Commit your work on this branch when done; do NOT switch branches or touch other worktrees.`
      );
    }
    if (member.allowedFiles && member.allowedFiles.length > 0) {
      lines.push(
        "",
        "STRICT FILE WHITELIST (you MUST ONLY modify or create paths matching these):",
        ...member.allowedFiles.map((f) => `- ${f}`),
        "Do NOT modify files outside this whitelist. Do NOT relax existing test assertions or use `as any` to bypass type errors."
      );
    }
    if (member.verifyCommands && member.verifyCommands.length > 0) {
      lines.push(
        "",
        "MANDATORY VERIFICATION COMMANDS (run before reporting [done]):",
        ...member.verifyCommands.map((c) => `- ${c}`)
      );
    }
    lines.push("", "COLLABORATION PROTOCOL:");
    lines.push(
      "- Address the next peer by @name (e.g. `@verifier ...`) or `@coordinator` in your message."
    );
    lines.push("- Start your completion report with `[done]` after the @mention (e.g. `@coordinator [done] ...`), or `[blocker]` if blocked.");
    lines.push("- Reference prior board posts by sequence number (e.g. `#4`) rather than copying long reports.");
    if (member.permissionMode !== "read-only") {
      lines.push(
        `- Mid-turn board CLI (for interim updates, handoffs, or reading recent posts):`,
        `  node "${this.boardCli}" post --swarm-dir "${swarmDir}" --as "${member.name}" "@coordinator [done] ..."`,
        `  node "${this.boardCli}" read --swarm-dir "${swarmDir}" --since ${member.lastReadSeq}`,
        `- Your final response text is also automatically posted to the board if you did not post via ext-board during this turn.`
      );
    } else {
      lines.push(
        "- You are in read-only mode: do not attempt file edits. Your final response text will automatically be posted to the shared board."
      );
    }
    lines.push("", "ASSIGNMENT:", brief);
    return lines.join("\n");
  }
  buildWakePrompt(swarm, member, unread) {
    const swarmDir = this.store.getSwarmDir(swarm.id);
    const lines = [
      `New board messages for worker "${member.name}" in "${swarm.title}":`
    ];
    if (!member.sessionId) {
      lines.push(
        `Worker context (fresh CLI session): role=${member.role}, cwd=${member.cwd}${member.branch ? `, branch=${member.branch}` : ""}, permission=${member.permissionMode}.`
      );
      const allMsgs = this.store.readBoard(swarm.id, 0, 200);
      const briefMsg = allMsgs.find(
        (m) => m.kind === "brief" && m.mentions.includes(member.name)
      );
      if (briefMsg && !unread.some((u) => u.seq === briefMsg.seq)) {
        lines.push(`Original assignment [#${briefMsg.seq}]: ${briefMsg.text}`);
      }
    }
    lines.push(
      "",
      ...unread.map((m) => `[#${m.seq}] (${m.kind}) ${m.agent}: ${m.text}`),
      "",
      "Respond to the @mention above and execute only what is requested."
    );
    if (member.allowedFiles && member.allowedFiles.length > 0) {
      lines.push(`Reminder - strict file whitelist: ${member.allowedFiles.join(", ")}`);
    }
    if (member.verifyCommands && member.verifyCommands.length > 0) {
      lines.push(`Verification commands: ${member.verifyCommands.join(" ; ")}`);
    }
    if (member.permissionMode !== "read-only") {
      lines.push(
        `You may post mid-turn via: node "${this.boardCli}" post --swarm-dir "${swarmDir}" --as "${member.name}" "..."`
      );
    }
    lines.push("Include `@target` (such as `@coordinator`) and `[done]` when finished.");
    return lines.join("\n");
  }
  handleBoardMessage(swarmId, msg) {
    if (this.shuttingDown) return;
    if (msg.kind === "brief" || msg.kind === "system" || msg.kind === "warning" || msg.kind === "error") {
      return;
    }
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;
    if (msg.agent === "coordinator") {
      if (swarm.hopCount !== 0) {
        swarm.hopCount = 0;
        this.store.saveState(swarm);
      }
    }
    const activeMembers = Object.values(swarm.members).filter(
      (m) => m.status !== "killed" && m.status !== "blocked"
    );
    const targets = /* @__PURE__ */ new Set();
    if (msg.all) {
      for (const m of activeMembers) {
        if (m.name !== msg.agent) targets.add(m.name);
      }
    } else {
      for (const mention of msg.mentions) {
        const st = swarm.members[mention]?.status;
        if (mention !== msg.agent && st !== "killed" && st !== "blocked") {
          targets.add(mention);
        }
      }
    }
    if (targets.size === 0) return;
    if (msg.agent !== "coordinator") {
      if (swarm.hopCount >= swarm.maxHops) {
        this.store.appendBoardMessage(swarmId, {
          agent: "system",
          text: `@coordinator [circuit-breaker] Autonomous hop limit (${swarm.maxHops}) reached; pausing automatic worker-to-worker wakes until coordinator posts.`,
          kind: "system"
        });
        return;
      }
      swarm.hopCount += 1;
      this.store.saveState(swarm);
    }
    for (const targetName of targets) {
      const target = swarm.members[targetName];
      if (!target || target.status === "killed") continue;
      if (target.status === "working" || target.status === "queued") {
        target.pendingWake = true;
        this.store.upsertMember(swarmId, target);
      } else {
        target.status = "queued";
        target.pendingWake = false;
        this.store.upsertMember(swarmId, target);
        this.enqueueTask({
          swarmId,
          memberName: targetName,
          maxDeliveredSeq: msg.seq
        });
      }
    }
  }
  enqueueTask(task) {
    const queue = this.queues.get(task.swarmId) || [];
    const alreadyQueued = queue.some((t) => t.memberName === task.memberName);
    if (!alreadyQueued) {
      queue.push(task);
      this.queues.set(task.swarmId, queue);
    }
    this.pumpQueue(task.swarmId);
  }
  countRunningInSwarm(swarmId) {
    const prefix = `${swarmId}:`;
    let count = 0;
    for (const key of this.runningProcs.keys()) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  }
  pumpQueue(swarmId) {
    if (this.shuttingDown) return;
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;
    const queue = this.queues.get(swarmId);
    if (!queue || queue.length === 0) return;
    while (queue.length > 0 && this.countRunningInSwarm(swarmId) < swarm.maxConcurrency) {
      const next = queue.shift();
      const member = swarm.members[next.memberName];
      if (!member || member.status === "killed") {
        continue;
      }
      if (this.runningProcs.has(this.procKey(swarmId, next.memberName))) {
        continue;
      }
      void this.runWorkerTurn(swarmId, next).catch((err) => {
        console.error(`[agy-ext-swarm] runWorkerTurn error for ${swarmId}/${next.memberName}:`, err);
      });
    }
  }
  tryFailoverWorker(swarmId, member, reasonDetail) {
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm || !swarm.routingPolicy?.autoFailover) return false;
    if (member.status === "killed" || member.customConfig) return false;
    const providerSnap = getProviderConfigSnapshot(
      this.store.dataDir,
      swarm.repoRoot,
      swarm.profile
    );
    const rolePool = member.permissionMode === "read-only" ? swarm.routingPolicy.readerProviders || [] : swarm.routingPolicy.writerProviders || [];
    const combinedPool = [...rolePool, ...swarm.activeProviders || []];
    const exhausted = /* @__PURE__ */ new Set([...member.failedProviders || [], member.provider]);
    const seen = /* @__PURE__ */ new Set();
    const candidates = [];
    for (const id of combinedPool) {
      const norm = id.trim().toLowerCase();
      if (!norm || seen.has(norm) || exhausted.has(norm)) continue;
      seen.add(norm);
      const desc = providerSnap.providers.find((p) => p.id === norm);
      if (desc && desc.enabled && desc.available) {
        candidates.push(norm);
      }
    }
    if (candidates.length === 0) return false;
    const nextId = candidates[0];
    const prevProvider = member.provider;
    let nextAdapter;
    try {
      nextAdapter = resolveProviderAdapter(nextId, void 0, this.store.dataDir, swarm.repoRoot);
    } catch {
      return false;
    }
    const nextDesc = providerSnap.providers.find((p) => p.id === nextId);
    member.failedProviders = [.../* @__PURE__ */ new Set([...member.failedProviders || [], prevProvider])];
    member.provider = nextId;
    member.model = nextDesc?.defaultModel || nextAdapter.defaultModel || "default";
    member.modelProvider = nextId === "dsh" ? nextDesc?.modelProvider || nextDesc?.detectedModelProvider || void 0 : void 0;
    member.sessionId = void 0;
    member.lastError = void 0;
    member.activity = `failover -> ${nextId}`;
    member.retryTurns += 1;
    member.status = "queued";
    member.pendingWake = false;
    this.store.upsertMember(swarmId, member);
    const notice = this.store.appendBoardMessage(swarmId, {
      agent: "system",
      text: `@coordinator [warning] [failover] Worker "${member.name}" switched from ${prevProvider} to ${nextId} after error: ${reasonDetail.slice(0, 240)}`,
      kind: "warning"
    });
    const pKey = this.procKey(swarmId, member.name);
    const savedInitial = this.initialPrompts.get(pKey);
    const fallbackBrief = savedInitial || this.store.readBoard(swarmId, 0, 500).find((m) => m.kind === "brief" && m.mentions.includes(member.name))?.text || member.role;
    const failoverPrompt = `[Failover Recovery Notice: previous CLI "${prevProvider}" failed (${reasonDetail.slice(0, 220)}). You are now continuing seamlessly in existing workspace "${member.cwd}"${member.branch ? ` (branch=${member.branch})` : ""}. Inspect current workspace files first, avoid redoing finished edits, and complete the task cleanly.]

${fallbackBrief}`;
    this.initialPrompts.set(pKey, failoverPrompt);
    this.enqueueTask({
      swarmId,
      memberName: member.name,
      overridePrompt: failoverPrompt,
      maxDeliveredSeq: Math.max(member.lastReadSeq, notice.seq)
    });
    return true;
  }
  failWorkerSafely(swarmId, memberName, reasonText) {
    try {
      const currentSwarm = this.store.tryGetSwarm(swarmId);
      const currentMember = currentSwarm?.members[memberName];
      if (!currentSwarm || !currentMember || currentMember.status === "killed") {
        this.pumpQueue(swarmId);
        return;
      }
      if (this.tryFailoverWorker(swarmId, currentMember, reasonText)) {
        return;
      }
      currentMember.status = "failed";
      currentMember.pendingWake = false;
      currentMember.activity = void 0;
      currentMember.lastError = reasonText;
      currentMember.lastTurnFinishedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.store.upsertMember(swarmId, currentMember);
      this.store.appendBoardMessage(swarmId, {
        agent: memberName,
        text: `@coordinator [error] Worker failed: ${reasonText.slice(0, 600)}`,
        kind: "error"
      });
      this.propagateBlockedDependencyFailures(swarmId);
    } catch (err) {
      console.error(`[agy-ext-swarm] failWorkerSafely error for ${swarmId}/${memberName}:`, err);
    } finally {
      this.pumpQueue(swarmId);
    }
  }
  async runWorkerTurn(swarmId, task) {
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;
    const member = swarm.members[task.memberName];
    if (!member || member.status === "killed") return;
    let prompt = task.overridePrompt;
    let maxDeliveredSeq = task.maxDeliveredSeq;
    if (!prompt) {
      const unread = this.store.readBoard(swarmId, member.lastReadSeq, 200);
      if (unread.length === 0) {
        member.status = "waiting";
        member.pendingWake = false;
        this.store.upsertMember(swarmId, member);
        this.pumpQueue(swarmId);
        return;
      }
      maxDeliveredSeq = Math.max(maxDeliveredSeq, unread[unread.length - 1].seq);
      prompt = this.buildWakePrompt(swarm, member, unread);
    }
    const key = this.procKey(swarmId, member.name);
    let adapter;
    let invocation;
    let logPath = "";
    let proc;
    try {
      adapter = resolveProviderAdapter(
        member.provider || "dsh",
        member.customConfig,
        this.store.dataDir,
        swarm.repoRoot
      );
      member.status = "working";
      member.pendingWake = false;
      member.lastError = void 0;
      member.activity = `starting ${adapter.id}...`;
      member.lastTurnStartedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.store.upsertMember(swarmId, member);
      const cfgSnap = getProviderConfigSnapshot(this.store.dataDir, swarm.repoRoot, swarm.profile);
      const providerDesc = !member.customConfig ? cfgSnap.providers.find((p) => p.id === (member.provider || "dsh")) : void 0;
      const effectiveProfile = providerDesc?.profile || swarm.profile || "headless";
      const effectiveModelProvider = member.modelProvider || providerDesc?.modelProvider || providerDesc?.detectedModelProvider;
      invocation = adapter.buildInvocation({
        prompt,
        workerName: member.name,
        cwd: member.cwd,
        model: member.model,
        modelProvider: effectiveModelProvider,
        permissionMode: member.permissionMode,
        sessionId: member.sessionId,
        profile: effectiveProfile,
        swarmDir: this.store.getSwarmDir(swarmId),
        patchesDir: this.store.getPatchesDir(swarmId),
        gitCommonDir: swarm.gitCommonDir,
        boardCli: this.boardCli
      });
      logPath = join9(this.store.getLogsDir(swarmId), `${member.name}.ndjson`);
      mkdirSync4(this.store.getLogsDir(swarmId), { recursive: true });
      const swarmDir = this.store.getSwarmDir(swarmId);
      const env = buildAugmentedEnv({
        ...invocation.env,
        EXT_SWARM_DIR: swarmDir,
        EXT_SWARM_AGENT: member.name,
        DSH_SWARM_DIR: swarmDir,
        DSH_SWARM_AGENT: member.name
      });
      const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(invocation.command);
      proc = spawn(invocation.command, invocation.args, {
        cwd: member.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: useShell
      });
      this.runningProcs.set(key, proc);
    } catch (err) {
      this.runningProcs.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      this.failWorkerSafely(swarmId, member.name, msg);
      return;
    }
    const turnStartedHeadSeq = swarm.headSeq;
    const turnTimeoutSec = Math.max(0, swarm.turnTimeoutSeconds ?? 300);
    const stallTimeoutSec = Math.max(0, swarm.stallTimeoutSeconds ?? 120);
    let lastActivityAt = Date.now();
    let timedOutReason = "";
    let turnTimer;
    let stallInterval;
    let killEscalationTimer;
    const terminateTimedOut = (reasonText) => {
      if (timedOutReason) return;
      timedOutReason = reasonText;
      killProcessTree(proc, "SIGTERM");
      killEscalationTimer = setTimeout(() => {
        if (!proc.killed) {
          killProcessTree(proc, "SIGKILL");
        }
      }, 3e3);
      killEscalationTimer.unref?.();
    };
    if (turnTimeoutSec > 0) {
      turnTimer = setTimeout(() => {
        terminateTimedOut(`Turn exceeded hard timeout (${turnTimeoutSec}s)`);
      }, turnTimeoutSec * 1e3);
      turnTimer.unref?.();
    }
    if (stallTimeoutSec > 0) {
      const checkIntervalMs = Math.min(
        1e4,
        Math.max(500, Math.floor(stallTimeoutSec * 1e3 / 3))
      );
      stallInterval = setInterval(() => {
        if (Date.now() - lastActivityAt >= stallTimeoutSec * 1e3) {
          terminateTimedOut(`Worker stalled (no output for ${stallTimeoutSec}s)`);
        }
      }, checkIntervalMs);
      stallInterval.unref?.();
    }
    proc.stdin?.on("error", () => {
    });
    try {
      if (invocation.stdinText !== void 0) {
        proc.stdin.write(invocation.stdinText);
      }
      proc.stdin.end();
    } catch {
    }
    let stdoutBuffer = "";
    let stdoutAll = "";
    let stderrBuffer = "";
    const textChunks = [];
    let finalText = "";
    let finalReasonKind = "";
    let turnErrorText = "";
    let sawTurnStart = false;
    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      if (adapter.supportsStreamEvents) {
        try {
          appendFileSync2(logPath, line + "\n", "utf8");
        } catch {
        }
      }
      const events = adapter.parseStdoutLine(line);
      if (events.length === 0) return;
      const currentSwarm = this.store.tryGetSwarm(swarmId);
      const currentMember = currentSwarm?.members[member.name];
      if (!currentMember || currentMember.status === "killed") return;
      for (const ev of events) {
        if (ev.type === "session") {
          currentMember.sessionId = ev.sessionId;
          this.store.upsertMember(swarmId, currentMember);
        } else if (ev.type === "turn_start") {
          sawTurnStart = true;
          currentMember.turns += 1;
          currentMember.activity = "thinking...";
          this.store.upsertMember(swarmId, currentMember);
        } else if (ev.type === "step_start") {
          currentMember.steps += 1;
          currentMember.activity = `step ${currentMember.steps}...`;
          this.store.upsertMember(swarmId, currentMember);
        } else if (ev.type === "usage") {
          currentMember.usage.inputTokens += ev.inputTokens;
          currentMember.usage.outputTokens += ev.outputTokens;
          currentMember.usage.totalTokens += ev.totalTokens;
          currentMember.usage.cacheReadTokens += ev.cacheReadTokens;
          this.store.upsertMember(swarmId, currentMember);
        } else if (ev.type === "tool_call") {
          currentMember.activity = ev.summary;
          this.store.upsertMember(swarmId, currentMember);
        } else if (ev.type === "text") {
          textChunks.push(ev.text);
        } else if (ev.type === "final") {
          if (ev.sessionId) {
            currentMember.sessionId = ev.sessionId;
            this.store.upsertMember(swarmId, currentMember);
          }
          if (ev.text !== void 0) {
            finalText = ev.text;
          }
          if (ev.reasonKind) {
            finalReasonKind = ev.reasonKind;
          }
          if (ev.errorText) {
            turnErrorText = ev.errorText;
          }
        } else if (ev.type === "error") {
          turnErrorText = ev.message;
        }
      }
    };
    proc.stdout.on("data", (chunk) => {
      lastActivityAt = Date.now();
      const str = chunk.toString("utf8");
      stdoutAll += str;
      if (stdoutAll.length > 262144) {
        stdoutAll = stdoutAll.slice(-262144);
      }
      stdoutBuffer += str;
      let nlIdx = stdoutBuffer.indexOf("\n");
      while (nlIdx !== -1) {
        const line = stdoutBuffer.slice(0, nlIdx);
        stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
        handleLine(line);
        nlIdx = stdoutBuffer.indexOf("\n");
      }
    });
    proc.stderr.on("data", (chunk) => {
      lastActivityAt = Date.now();
      stderrBuffer += chunk.toString("utf8");
      if (stderrBuffer.length > 8e3) {
        stderrBuffer = stderrBuffer.slice(-8e3);
      }
    });
    proc.on("error", (err) => {
      stderrBuffer += `
Spawn error: ${err.message}`;
    });
    proc.on("close", async (code, signal) => {
      if (turnTimer) clearTimeout(turnTimer);
      if (stallInterval) clearInterval(stallInterval);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      this.runningProcs.delete(key);
      try {
        if (stdoutBuffer.trim()) {
          handleLine(stdoutBuffer);
          stdoutBuffer = "";
        }
        if (!this.store.tryGetSwarm(swarmId)) {
          this.queues.delete(swarmId);
          return;
        }
        this.store.drainInbox(swarmId);
        const latestSwarm = this.store.tryGetSwarm(swarmId);
        const latestMember = latestSwarm?.members[member.name];
        if (!latestSwarm || !latestMember) {
          return;
        }
        if (!sawTurnStart) {
          latestMember.turns += 1;
        }
        if (!finalText && adapter.finalizeOutput) {
          const finalized = adapter.finalizeOutput(stdoutAll, textChunks.join(""));
          finalText = finalized.finalText;
          if (finalized.sessionId) latestMember.sessionId = finalized.sessionId;
          if (finalized.reasonKind) finalReasonKind = finalized.reasonKind;
          if (finalized.errorText) turnErrorText = finalized.errorText;
          if (!adapter.supportsStreamEvents && finalText) {
            try {
              appendFileSync2(
                logPath,
                JSON.stringify({ type: "final", reason: { kind: "completed" }, text: finalText }) + "\n",
                "utf8"
              );
            } catch {
            }
          }
        }
        if (latestMember.status === "killed") {
          latestMember.activity = void 0;
          this.store.upsertMember(swarmId, latestMember);
          return;
        }
        const failed = Boolean(timedOutReason) || code !== 0 || Boolean(signal) || finalReasonKind && finalReasonKind !== "completed";
        if (failed) {
          const reasonDetail = timedOutReason || turnErrorText || stderrBuffer.trim().split("\n").slice(-6).join(" | ") || `exit code=${code ?? "null"} signal=${signal ?? "none"} reason=${finalReasonKind || "unknown"}`;
          if (this.tryFailoverWorker(swarmId, latestMember, reasonDetail)) {
            this.pumpQueue(swarmId);
            return;
          }
          latestMember.status = "failed";
          latestMember.activity = void 0;
          latestMember.lastError = reasonDetail;
          latestMember.lastTurnFinishedAt = (/* @__PURE__ */ new Date()).toISOString();
          latestMember.lastReadSeq = Math.max(latestMember.lastReadSeq, maxDeliveredSeq);
          this.store.upsertMember(swarmId, latestMember);
          this.store.appendBoardMessage(swarmId, {
            agent: latestMember.name,
            text: `@coordinator [error] Worker failed: ${reasonDetail.slice(0, 600)}`,
            kind: "error"
          });
          this.propagateBlockedDependencyFailures(swarmId);
          this.pumpQueue(swarmId);
          return;
        }
        latestMember.activity = void 0;
        latestMember.lastTurnFinishedAt = (/* @__PURE__ */ new Date()).toISOString();
        latestMember.lastReadSeq = Math.max(latestMember.lastReadSeq, maxDeliveredSeq);
        if (latestMember.allowedFiles && latestMember.allowedFiles.length > 0 && latestSwarm.gitRepoRoot) {
          const diff = await getWorktreeDiff(
            latestMember.cwd,
            latestMember.baseRef,
            latestMember.allowedFiles
          );
          if (diff) {
            latestMember.outOfScopeFiles = diff.outOfScopeFiles;
            if (diff.outOfScopeFiles.length > 0) {
              this.store.appendBoardMessage(swarmId, {
                agent: "system",
                text: `@coordinator [warning] Worker "${latestMember.name}" modified files outside allowed_files: ${diff.outOfScopeFiles.join(", ")}`,
                kind: "warning"
              });
            }
          }
        }
        if (latestMember.autoVerify && latestMember.verifyCommands && latestMember.verifyCommands.length > 0) {
          latestMember.activity = "running verify_commands...";
          this.store.upsertMember(swarmId, latestMember);
          const verifyResults = await this.runVerifyCommands(
            latestMember.cwd,
            latestMember.verifyCommands
          );
          latestMember.lastVerifyResults = verifyResults;
          latestMember.activity = void 0;
          const allPassed = verifyResults.every((r) => r.passed);
          const summaryLines = verifyResults.map(
            (r) => `- ${r.passed ? "PASS" : "FAIL"} (exit=${r.exitCode ?? "?"}, ${r.durationMs}ms): \`${r.command}\`${!r.passed && r.outputTail ? `
  ${r.outputTail.slice(-300)}` : ""}`
          );
          this.store.appendBoardMessage(swarmId, {
            agent: "system",
            text: allPassed ? `[auto-verify] ${latestMember.name} passed ${verifyResults.length}/${verifyResults.length} verify command(s):
${summaryLines.join("\n")}` : `@coordinator [warning] [auto-verify] ${latestMember.name} failed verification:
${summaryLines.join("\n")}`,
            kind: allPassed ? "system" : "warning"
          });
        }
        const recentMsgs = this.store.readBoard(swarmId, turnStartedHeadSeq, 200);
        const postedSelfThisTurn = recentMsgs.some((m) => m.agent === latestMember.name);
        const rawOutput = (finalText || textChunks.join("")).trim();
        if (!postedSelfThisTurn && rawOutput) {
          const parsed = extractMentions(rawOutput, Object.keys(latestSwarm.members));
          const hasMention = parsed.mentions.length > 0 || parsed.all || parsed.mentionsCoordinator;
          const postText = hasMention ? rawOutput : `@coordinator ${rawOutput}`;
          this.store.appendBoardMessage(swarmId, {
            agent: latestMember.name,
            text: postText,
            kind: inferMessageKind(postText)
          });
        }
        const afterPostSwarm = this.store.tryGetSwarm(swarmId);
        const afterPostMember = afterPostSwarm?.members[member.name] || latestMember;
        afterPostMember.activity = void 0;
        afterPostMember.lastTurnFinishedAt = latestMember.lastTurnFinishedAt;
        afterPostMember.lastReadSeq = latestMember.lastReadSeq;
        afterPostMember.outOfScopeFiles = latestMember.outOfScopeFiles;
        afterPostMember.lastVerifyResults = latestMember.lastVerifyResults;
        if (afterPostSwarm && afterPostMember.pendingWake) {
          const remainingUnread = this.store.readBoard(swarmId, afterPostMember.lastReadSeq, 50);
          if (remainingUnread.length > 0 && afterPostSwarm.hopCount < afterPostSwarm.maxHops) {
            afterPostMember.status = "queued";
            afterPostMember.pendingWake = false;
            this.store.upsertMember(swarmId, afterPostMember);
            this.enqueueTask({
              swarmId,
              memberName: afterPostMember.name,
              maxDeliveredSeq: remainingUnread[remainingUnread.length - 1].seq
            });
          } else {
            afterPostMember.status = "waiting";
            afterPostMember.pendingWake = false;
            this.store.upsertMember(swarmId, afterPostMember);
          }
        } else {
          afterPostMember.status = "waiting";
          this.store.upsertMember(swarmId, afterPostMember);
        }
        await this.checkAndReleaseBlockedDependents(swarmId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.failWorkerSafely(swarmId, member.name, `Post-turn handling error: ${msg}`);
        return;
      }
      this.pumpQueue(swarmId);
    });
  }
  postAsCoordinator(swarmId, text) {
    const swarm = this.store.getSwarm(swarmId);
    return this.store.appendBoardMessage(swarm.id, {
      agent: "coordinator",
      text,
      kind: inferMessageKind(text)
    });
  }
  async getStatus(swarmId, includeDiff = false) {
    const swarm = this.store.getSwarm(swarmId);
    this.store.drainInbox(swarm.id);
    const diffs = {};
    if (includeDiff) {
      await Promise.all(
        Object.values(swarm.members).map(async (m) => {
          if (m.workspaceMode === "worktree" && m.status !== "killed") {
            diffs[m.name] = await getWorktreeDiff(m.cwd, m.baseRef, m.allowedFiles);
          } else {
            diffs[m.name] = null;
          }
        })
      );
    }
    return { swarm, diffs };
  }
  async waitForCondition(opts) {
    const swarm = this.store.getSwarm(opts.swarmId);
    const since = opts.since ?? swarm.headSeq;
    const timeoutMs = Math.max(1, Math.min(90, opts.timeoutSeconds ?? 45)) * 1e3;
    const until = opts.until || "any_post";
    this.store.drainInbox(swarm.id);
    const checkMatch = () => {
      const current = this.store.getSwarm(swarm.id);
      const newMsgs = this.store.readBoard(swarm.id, since, 200);
      const members = Object.values(current.members);
      const nonKilled = members.filter((m) => m.status !== "killed");
      const allIdle = nonKilled.length > 0 && nonKilled.every((m) => m.status === "waiting" || m.status === "failed");
      const hasReleasableBlocked = nonKilled.some(
        (m) => m.status === "blocked" && (m.dependsOn || []).length > 0 && (m.dependsOn || []).every((d) => {
          const dm = current.members[d];
          return Boolean(dm && dm.status === "waiting" && dm.turns > 0);
        })
      );
      const blockedDeadlock = !hasReleasableBlocked && nonKilled.length > 0 && nonKilled.every((m) => m.status !== "working" && m.status !== "queued") && nonKilled.some((m) => m.status === "blocked");
      if (until === "any_post") {
        if (newMsgs.length > 0) return { matched: true, reason: "new_board_post" };
        if (allIdle && members.some((m) => m.turns > 0)) {
          return { matched: true, reason: "all_workers_idle" };
        }
        if (blockedDeadlock) {
          return { matched: true, reason: "blocked_deadlock" };
        }
      } else if (until === "mentions_coordinator") {
        if (newMsgs.some(
          (m) => m.agent !== "coordinator" && (m.mentionsCoordinator || m.all || m.kind === "error" || m.kind === "warning")
        )) {
          return { matched: true, reason: "mentions_coordinator" };
        }
        if (allIdle && members.some((m) => m.turns > 0)) {
          return { matched: true, reason: "all_workers_idle" };
        }
        if (blockedDeadlock) {
          return { matched: true, reason: "blocked_deadlock" };
        }
      } else if (until === "all_idle") {
        if (allIdle) return { matched: true, reason: "all_workers_idle" };
        if (blockedDeadlock) return { matched: true, reason: "blocked_deadlock" };
      } else if (until === "worker_done") {
        const target = opts.workerName ? current.members[opts.workerName] : void 0;
        if (!target) return { matched: true, reason: "worker_not_found" };
        if (target.status === "waiting" || target.status === "failed" || target.status === "killed") {
          return { matched: true, reason: `worker_${target.status}` };
        }
        if (target.status === "blocked" && blockedDeadlock) {
          return { matched: true, reason: "blocked_deadlock" };
        }
      }
      return { matched: false, reason: "waiting" };
    };
    const immediate = checkMatch();
    if (immediate.matched) {
      return {
        timedOut: false,
        reason: immediate.reason,
        swarm: this.store.getSwarm(swarm.id),
        messages: this.store.readBoard(swarm.id, since, 200)
      };
    }
    return new Promise((resolveWait) => {
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.store.off("message", onEvent);
        this.store.off("state", onEvent);
      };
      const onEvent = (evSwarmId) => {
        if (evSwarmId !== swarm.id || finished) return;
        const status = checkMatch();
        if (status.matched) {
          cleanup();
          resolveWait({
            timedOut: false,
            reason: status.reason,
            swarm: this.store.getSwarm(swarm.id),
            messages: this.store.readBoard(swarm.id, since, 200)
          });
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolveWait({
          timedOut: true,
          reason: "timeout",
          swarm: this.store.getSwarm(swarm.id),
          messages: this.store.readBoard(swarm.id, since, 200)
        });
      }, timeoutMs);
      this.store.on("message", onEvent);
      this.store.on("state", onEvent);
    });
  }
  async killWorker(swarmId, name, removeWorktreeFlag = false) {
    const swarm = this.store.getSwarm(swarmId);
    const normalized = name.trim().toLowerCase();
    const targetNames = [];
    if (normalized === "all") {
      targetNames.push(...Object.keys(swarm.members));
    } else if (swarm.members[normalized]) {
      targetNames.push(normalized);
    } else {
      const prefix = `${normalized}-`;
      for (const mName of Object.keys(swarm.members)) {
        if (mName.startsWith(prefix) && /^\d+$/.test(mName.slice(prefix.length))) {
          targetNames.push(mName);
        }
      }
    }
    if (targetNames.length === 0) {
      throw new Error(`No matching worker "${name}" in swarm "${swarm.id}".`);
    }
    const queue = this.queues.get(swarm.id);
    if (queue) {
      this.queues.set(
        swarm.id,
        queue.filter((t) => !targetNames.includes(t.memberName))
      );
    }
    const killed = [];
    const removedWorktrees = [];
    for (const tName of targetNames) {
      const member = swarm.members[tName];
      if (!member) continue;
      const wasKilled = member.status === "killed";
      member.status = "killed";
      member.pendingWake = false;
      member.activity = void 0;
      this.store.upsertMember(swarm.id, member);
      const proc = this.runningProcs.get(this.procKey(swarm.id, tName));
      if (proc && !proc.killed) {
        killProcessTree(proc, "SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            killProcessTree(proc, "SIGKILL");
          }
        }, 3e3).unref?.();
      }
      if (!wasKilled) {
        killed.push(tName);
      }
      if (removeWorktreeFlag && member.workspaceMode === "worktree") {
        const res = await removeWorktree(swarm.gitRepoRoot, member.cwd, member.branch);
        if (res.removedWorktree) {
          removedWorktrees.push(tName);
        }
      }
    }
    if (killed.length > 0) {
      this.store.appendBoardMessage(swarm.id, {
        agent: "system",
        text: `Killed worker(s): ${killed.join(", ")}${removedWorktrees.length > 0 ? ` (removed worktrees: ${removedWorktrees.join(", ")})` : ""}`,
        kind: "system"
      });
      this.propagateBlockedDependencyFailures(swarm.id);
    }
    return { killed, removedWorktrees };
  }
  async runVerifyCommands(cwd, commands, timeoutMs = 6e4) {
    const results = [];
    const env = buildAugmentedEnv();
    for (const command of commands) {
      const start = Date.now();
      const ranAt = (/* @__PURE__ */ new Date()).toISOString();
      try {
        const res = await execAsync(command, {
          cwd,
          env,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024
        });
        const combined = `${res.stdout || ""}
${res.stderr || ""}`.trim();
        results.push({
          command,
          exitCode: 0,
          passed: true,
          durationMs: Date.now() - start,
          outputTail: combined.slice(-1200),
          ranAt
        });
      } catch (err) {
        const rec = err && typeof err === "object" ? err : {};
        const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
        const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
        const msg = err instanceof Error ? err.message : String(err);
        const combined = `${stdout}
${stderr}`.trim() || msg;
        const exitCode = typeof rec.code === "number" ? rec.code : 1;
        results.push({
          command,
          exitCode,
          passed: false,
          durationMs: Date.now() - start,
          outputTail: combined.slice(-1200),
          ranAt
        });
      }
    }
    return results;
  }
  async getWorkerFullDiff(swarmId, name) {
    const swarm = this.store.getSwarm(swarmId);
    const normName = name.trim().toLowerCase();
    const member = swarm.members[normName];
    if (!member) {
      throw new Error(`Worker "${name}" not found in swarm "${swarm.id}".`);
    }
    if (!existsSync7(member.cwd)) {
      throw new Error(`Worker workspace does not exist: ${member.cwd}`);
    }
    if (member.workspaceMode !== "worktree" && !swarm.gitRepoRoot) {
      return {
        branch: "(no git repo)",
        baseRef: "HEAD",
        stat: "",
        patch: "",
        truncated: false,
        untrackedFiles: []
      };
    }
    const patch = await getWorktreeFullDiff(member.cwd, member.baseRef);
    return patch || {
      branch: member.branch || "HEAD",
      baseRef: member.baseRef || "HEAD",
      stat: "",
      patch: "",
      truncated: false,
      untrackedFiles: []
    };
  }
  async updateAndRetryWorker(opts) {
    const swarm = this.store.getSwarm(opts.swarmId);
    const normName = opts.name.trim().toLowerCase();
    const member = swarm.members[normName];
    if (!member) {
      throw new Error(`Worker "${opts.name}" not found in swarm "${swarm.id}".`);
    }
    if (member.status !== "waiting" && member.status !== "failed") {
      throw new Error(
        `Worker "${member.name}" cannot be updated/retried while status is "${member.status}". Only waiting or failed workers can switch provider/model or retry.`
      );
    }
    const warnings = [];
    const nextProvider = (opts.provider?.trim() || (opts.customCommand ? "custom" : member.provider || swarm.defaultProvider || "dsh")).toLowerCase();
    if (nextProvider === "custom" && !opts.customCommand && member.provider !== "custom") {
      throw new Error('custom_command is required when switching to provider="custom".');
    }
    const effectiveCustomCmd = opts.customCommand ?? (nextProvider === member.provider ? member.customConfig : void 0);
    const adapter = resolveProviderAdapter(
      nextProvider,
      effectiveCustomCmd,
      this.store.dataDir,
      swarm.repoRoot
    );
    const providerSnap = getProviderConfigSnapshot(
      this.store.dataDir,
      swarm.repoRoot,
      swarm.profile
    );
    const descriptor = !effectiveCustomCmd ? providerSnap.providers.find((p) => p.id === nextProvider) : void 0;
    const providerChanged = nextProvider !== member.provider || Boolean(opts.customCommand);
    const nextModel = opts.model?.trim() || (providerChanged ? effectiveCustomCmd?.defaultModel || descriptor?.defaultModel || adapter.defaultModel || "default" : member.model);
    if (providerChanged) {
      member.sessionId = void 0;
      member.customConfig = effectiveCustomCmd;
    }
    if (nextProvider === "dsh") {
      member.modelProvider = descriptor?.modelProvider || descriptor?.detectedModelProvider || void 0;
      if (opts.model?.trim() && nextModel !== "default" && descriptor && descriptor.models.length > 0 && !descriptor.models.includes(nextModel)) {
        warnings.push(
          `Model "${nextModel}" is not listed in configured models or dsh lastCatalog; dsh may reject it unless supported by profile "${descriptor.profile || swarm.profile}".`
        );
      }
    } else {
      member.modelProvider = void 0;
    }
    member.provider = nextProvider;
    member.model = nextModel;
    const shouldRun = Boolean(opts.retry || opts.prompt?.trim());
    if (shouldRun) {
      member.lastError = void 0;
      member.activity = void 0;
      member.retryTurns += 1;
      member.status = "waiting";
      this.store.upsertMember(swarm.id, member);
      const postText = opts.prompt?.trim() ? `@${member.name} ${opts.prompt.trim()}` : `@${member.name} [retry #${member.retryTurns}] Resuming in workspace (provider=${nextProvider}, model=${nextModel}). Please inspect current workspace state and complete your assigned task.`;
      this.store.appendBoardMessage(swarm.id, {
        agent: "coordinator",
        text: postText,
        kind: "message"
      });
    } else {
      this.store.upsertMember(swarm.id, member);
    }
    return {
      swarmId: swarm.id,
      member: this.store.getSwarm(swarm.id).members[normName],
      queued: shouldRun,
      warnings
    };
  }
  async deleteSwarm(swarmId, removeWorktrees = true) {
    const swarm = this.store.getSwarm(swarmId);
    const memberKeys = Object.keys(swarm.members);
    let removedWorktrees = [];
    if (memberKeys.length > 0) {
      const killRes = await this.killWorker(swarm.id, "all", removeWorktrees);
      removedWorktrees = killRes.removedWorktrees;
    }
    this.queues.delete(swarm.id);
    this.store.deleteSwarm(swarm.id);
    return { deletedSwarmId: swarm.id, removedWorktrees };
  }
  async exportSwarmMarkdown(swarmId, coordinatorUsage, pricing) {
    const { swarm, diffs } = await this.getStatus(swarmId, true);
    const messages = this.store.readBoard(swarm.id, 0, 5e3);
    const members = Object.values(swarm.members);
    const calcCostText = (model, inputTok, cacheTok, outputTok) => {
      const p = pricing?.[model];
      if (!p) return "-";
      const cacheRate = p.cacheReadPer1M ?? p.inputPer1M;
      const cost = (inputTok * p.inputPer1M + cacheTok * cacheRate + outputTok * p.outputPer1M) / 1e6;
      const sym = p.currency === "CNY" ? "\xA5" : "$";
      return `${sym}${cost.toFixed(4)}`;
    };
    const lines = [
      `# AGY Ext Swarm Report: ${swarm.title}`,
      "",
      `- **Swarm ID**: \`${swarm.id}\``,
      `- **Workspace**: \`${swarm.repoRoot}\``,
      `- **Default Provider**: \`${swarm.defaultProvider}\` (profile: \`${swarm.profile}\`)`,
      `- **Created / Updated**: ${swarm.createdAt} \u2192 ${swarm.updatedAt}`,
      `- **Messages / Hops**: ${swarm.headSeq} posts \xB7 ${swarm.hopCount}/${swarm.maxHops} hops`,
      `- **Timeouts**: turn=${swarm.turnTimeoutSeconds}s \xB7 stall=${swarm.stallTimeoutSeconds}s`,
      "",
      "## Workers",
      "",
      "| Worker | Status | Provider | Model | Turns/Steps | Tokens (In / Cache / Out) | Est. Cost | Branch / Changed |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |"
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
      const branchSummary = m.branch ? `\`${m.branch}\` (${diff?.commitCount ?? 0} commits, ${diff?.changedFiles?.length ?? 0} files)` : m.workspaceMode;
      const costTxt = calcCostText(m.model, u.inputTokens, u.cacheReadTokens, u.outputTokens);
      lines.push(
        `| ${m.name} | ${m.status} | ${m.provider} | ${m.model} | ${m.turns}/${m.steps} | ${u.totalTokens} (${u.inputTokens}/${u.cacheReadTokens}/${u.outputTokens}) | ${costTxt} | ${branchSummary} |`
      );
    }
    const workerPrompt = totalWorkerIn + totalWorkerCache;
    const workerHit = workerPrompt > 0 ? Math.round(totalWorkerCache / workerPrompt * 1e3) / 10 : 0;
    lines.push("", "## Token & Cache Telemetry", "");
    lines.push(
      `- **External CLI Cluster**: ${totalWorkerTokens} tokens (cache hit ${workerHit}%)`
    );
    if (coordinatorUsage) {
      const agy = coordinatorUsage.sinceSwarmStart;
      lines.push(
        `- **AGY Main Model (Since Swarm Start)**: ${agy.totalTokens} tokens (cache hit ${agy.cacheHitRate}%)`
      );
    }
    if (messages.length > 0) {
      lines.push("", "## Message Board Transcript", "");
      for (const msg of messages) {
        lines.push(`### #${msg.seq} \xB7 ${msg.agent} (${msg.kind}) \xB7 ${msg.time}`, "", msg.text, "");
      }
    }
    const safeSlug = swarm.title.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || swarm.id;
    return {
      filename: `${safeSlug}-${swarm.id}.md`,
      markdown: lines.join("\n")
    };
  }
  propagateBlockedDependencyFailures(swarmId) {
    let changed = true;
    while (changed) {
      changed = false;
      const swarm = this.store.tryGetSwarm(swarmId);
      if (!swarm) return;
      for (const m of Object.values(swarm.members)) {
        if (m.status !== "blocked") continue;
        const deps = m.dependsOn || [];
        const brokenDepName = deps.find((d) => {
          const dep = swarm.members[d];
          return !dep || dep.status === "failed" || dep.status === "killed";
        });
        if (!brokenDepName) continue;
        const depStatus = swarm.members[brokenDepName]?.status || "missing";
        m.status = "failed";
        m.pendingBrief = void 0;
        m.activity = void 0;
        m.lastError = `Upstream dependency "${brokenDepName}" is ${depStatus}.`;
        this.store.upsertMember(swarmId, m);
        this.store.appendBoardMessage(swarmId, {
          agent: "system",
          text: `@coordinator [error] Blocked worker "${m.name}" aborted because upstream dependency "${brokenDepName}" is ${depStatus}.`,
          kind: "error"
        });
        changed = true;
      }
    }
  }
  async collectUpstreamContext(swarmId, deps) {
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm || deps.length === 0) return "";
    const boardMsgs = this.store.readBoard(swarmId, 0, 500);
    const sections = [];
    for (const depName of deps) {
      const m = swarm.members[depName];
      if (!m) continue;
      const lastPost = [...boardMsgs].reverse().find((msg) => msg.agent === depName && msg.kind !== "system");
      const diff = m.workspaceMode === "worktree" ? await getWorktreeDiff(m.cwd, m.baseRef, m.allowedFiles) : null;
      const parts = [`- Upstream @${depName} (status: ${m.status}, turns: ${m.turns}):`];
      if (m.branch) parts.push(`  branch: ${m.branch}, cwd: ${m.cwd}`);
      if (diff && (diff.changedFiles.length > 0 || diff.stat)) {
        parts.push(`  changedFiles: ${diff.changedFiles.join(", ") || "(none)"}`);
        if (diff.stat) parts.push(`  stat: ${diff.stat.replace(/\s+/g, " ").slice(0, 260)}`);
      }
      if (lastPost) {
        parts.push(`  lastPost (#${lastPost.seq}): ${lastPost.text.slice(0, 500)}`);
      }
      sections.push(parts.join("\n"));
    }
    if (sections.length === 0) return "";
    return `[Upstream Dependencies Completed: ${deps.join(", ")}]
${sections.join("\n")}`;
  }
  async checkAndReleaseBlockedDependents(swarmId) {
    this.propagateBlockedDependencyFailures(swarmId);
    const swarm = this.store.tryGetSwarm(swarmId);
    if (!swarm) return;
    const blockedMembers = Object.values(swarm.members).filter((m) => m.status === "blocked");
    if (blockedMembers.length === 0) return;
    for (const candidate of blockedMembers) {
      const latestSwarm = this.store.tryGetSwarm(swarmId);
      if (!latestSwarm) return;
      const current = latestSwarm.members[candidate.name];
      if (!current || current.status !== "blocked") continue;
      const deps = current.dependsOn || [];
      const allReady = deps.length > 0 && deps.every((d) => {
        const dm = latestSwarm.members[d];
        return Boolean(dm && dm.status === "waiting" && dm.turns > 0);
      });
      if (!allReady) continue;
      const upstreamSummary = await this.collectUpstreamContext(swarmId, deps);
      const releaseSwarm = this.store.tryGetSwarm(swarmId);
      const releaseMember = releaseSwarm?.members[candidate.name];
      if (!releaseSwarm || !releaseMember || releaseMember.status !== "blocked") continue;
      const rawBrief = releaseMember.pendingBrief || releaseMember.role || "Execute assigned task.";
      const combinedBrief = upstreamSummary ? `${rawBrief}

${upstreamSummary}` : rawBrief;
      releaseMember.status = "queued";
      releaseMember.pendingBrief = void 0;
      releaseMember.activity = void 0;
      this.store.upsertMember(swarmId, releaseMember);
      const briefMsg = this.store.appendBoardMessage(swarmId, {
        agent: "coordinator",
        text: `@${releaseMember.name} [unblocked after ${deps.join(", ")}] ${rawBrief}`,
        kind: "brief"
      });
      releaseMember.lastReadSeq = briefMsg.seq;
      this.store.upsertMember(swarmId, releaseMember);
      const initialPrompt = this.buildInitialPrompt(
        releaseSwarm,
        releaseMember,
        combinedBrief,
        briefMsg.seq
      );
      this.initialPrompts.set(this.procKey(swarmId, releaseMember.name), initialPrompt);
      this.enqueueTask({
        swarmId,
        memberName: releaseMember.name,
        overridePrompt: initialPrompt,
        maxDeliveredSeq: briefMsg.seq
      });
    }
  }
  async previewWorkerMerge(opts) {
    const swarm = this.store.getSwarm(opts.swarmId);
    const normalized = opts.workerName.trim().toLowerCase();
    const member = swarm.members[normalized];
    if (!member) {
      throw new Error(`Worker "${opts.workerName}" not found in swarm "${swarm.id}".`);
    }
    if (!swarm.gitRepoRoot) {
      throw new Error(`Swarm "${swarm.id}" has no git repository root.`);
    }
    if (member.workspaceMode !== "worktree" || !member.branch) {
      throw new Error(
        `Worker "${member.name}" is not using an isolated git worktree branch (workspace=${member.workspaceMode}).`
      );
    }
    return previewWorktreeMerge({
      repoRoot: swarm.gitRepoRoot,
      workerName: member.name,
      branch: member.branch,
      workerCwd: member.cwd,
      targetBranch: opts.targetBranch
    });
  }
  async mergeWorker(opts) {
    const swarm = this.store.getSwarm(opts.swarmId);
    const normalized = opts.workerName.trim().toLowerCase();
    const member = swarm.members[normalized];
    if (!member) {
      throw new Error(`Worker "${opts.workerName}" not found in swarm "${swarm.id}".`);
    }
    if (member.status === "working" || member.status === "queued") {
      throw new Error(
        `Cannot merge while worker "${member.name}" is still ${member.status}. Wait until it finishes or fails.`
      );
    }
    if (!swarm.gitRepoRoot) {
      throw new Error(`Swarm "${swarm.id}" has no git repository root.`);
    }
    if (member.workspaceMode !== "worktree" || !member.branch) {
      throw new Error(
        `Worker "${member.name}" is not using an isolated git worktree branch (workspace=${member.workspaceMode}).`
      );
    }
    const result = await mergeWorktreeBranch({
      repoRoot: swarm.gitRepoRoot,
      workerName: member.name,
      branch: member.branch,
      workerCwd: member.cwd,
      targetBranch: opts.targetBranch,
      mode: opts.mode || "squash",
      commitMessage: opts.commitMessage,
      removeWorktreeAfter: opts.removeWorktreeAfter
    });
    if (result.merged) {
      if (result.worktreeRemoved) {
        const latestSwarm = this.store.tryGetSwarm(swarm.id);
        const latestMember = latestSwarm?.members[member.name];
        if (latestMember) {
          latestMember.branch = void 0;
          latestMember.workspaceMode = "inherit";
          latestMember.cwd = swarm.repoRoot;
          this.store.upsertMember(swarm.id, latestMember);
        }
      }
      this.store.appendBoardMessage(swarm.id, {
        agent: "system",
        text: `Merged @${member.name} (${result.branch} -> ${result.targetBranch}, mode=${result.mode}${result.commitSha ? `, ${result.commitSha.slice(0, 7)}` : ""})${result.worktreeRemoved ? " [worktree removed]" : ""}.`,
        kind: "system"
      });
    } else {
      this.store.appendBoardMessage(swarm.id, {
        agent: "system",
        text: `@coordinator [warning] Merge blocked for @${member.name}: ${result.message}`,
        kind: "warning"
      });
    }
    return result;
  }
  async startArena(opts) {
    if (!opts.contestants || opts.contestants.length < 2) {
      throw new Error("Arena mode requires at least 2 contestants.");
    }
    const swarm = this.store.getSwarm(opts.swarmId);
    const rawGroup = opts.baseName?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || `arena-${randomBytes2(2).toString("hex")}`;
    const arenaGroup = rawGroup.replace(/^-+|-+$/g, "") || "arena";
    const contestants = [];
    const briefSeqs = [];
    const warnings = [];
    const usedNames = new Set(Object.keys(swarm.members));
    for (let i = 0; i < opts.contestants.length; i++) {
      const c = opts.contestants[i];
      const provSlug = c.provider.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "") || `cli${i + 1}`;
      let candidate;
      if (c.name?.trim()) {
        candidate = c.name.trim().toLowerCase();
      } else {
        const maxBase = Math.max(1, 24 - 1 - provSlug.length);
        candidate = `${arenaGroup.slice(0, maxBase)}-${provSlug}`;
      }
      if (usedNames.has(candidate)) {
        let idx = 2;
        while (true) {
          const suffix = `-${idx}`;
          const next = `${candidate.slice(0, Math.max(1, 24 - suffix.length))}${suffix}`;
          if (!usedNames.has(next)) {
            candidate = next;
            break;
          }
          idx++;
        }
      }
      const check = validateWorkerName(candidate);
      if (!check.valid) {
        throw new Error(`Invalid arena worker name "${candidate}": ${check.error}`);
      }
      usedNames.add(check.normalized);
      const res = await this.addWorker({
        swarmId: swarm.id,
        name: check.normalized,
        brief: `[Arena: ${arenaGroup}] Implement your best solution independently in your isolated worktree.

Task:
${opts.task}`,
        provider: c.provider,
        model: c.model,
        permissionMode: c.permissionMode || opts.permissionMode || "workspace-write",
        workspace: "worktree",
        role: c.role || `arena (${c.provider})`,
        arenaGroup
      });
      contestants.push(...res.added);
      briefSeqs.push(...res.briefSeqs);
      warnings.push(...res.warnings);
    }
    return { swarmId: swarm.id, arenaGroup, contestants, briefSeqs, warnings };
  }
  async startCrossReview(opts) {
    const swarm = this.store.getSwarm(opts.swarmId);
    const targetName = opts.targetWorker.trim().toLowerCase();
    const target = swarm.members[targetName];
    if (!target) {
      throw new Error(`Target worker "${opts.targetWorker}" not found in swarm "${swarm.id}".`);
    }
    if (target.status === "killed") {
      throw new Error(`Cannot cross-review killed worker "${target.name}".`);
    }
    const warnings = [];
    let reviewerProvider = opts.reviewerProvider?.trim().toLowerCase();
    if (!reviewerProvider) {
      const snap = getProviderConfigSnapshot(this.store.dataDir, swarm.repoRoot, swarm.profile);
      const priorityIds = [
        ...swarm.routingPolicy?.readerProviders || [],
        ...swarm.activeProviders || [],
        ...snap.providers.map((p) => p.id)
      ];
      const alternateId = priorityIds.find((id) => {
        if (id === target.provider) return false;
        const p = snap.providers.find((item) => item.id === id);
        return Boolean(p && p.enabled && p.available);
      });
      if (alternateId) {
        reviewerProvider = alternateId;
      } else {
        reviewerProvider = target.provider;
        warnings.push(
          `No alternate enabled & available CLI provider found besides "${target.provider}"; reviewing with "${target.provider}".`
        );
      }
    }
    const baseRevName = opts.reviewerName?.trim().toLowerCase() || `rev-${target.name}-${reviewerProvider}`.slice(0, 22).replace(/-+$/, "");
    let candidateName = baseRevName;
    if (swarm.members[candidateName]) {
      let idx = 2;
      while (swarm.members[`${candidateName.slice(0, 19)}-${idx}`]) idx++;
      candidateName = `${candidateName.slice(0, 19)}-${idx}`;
    }
    const briefLines = [
      `Cross-Vendor Code Review of @${target.name} (implemented with provider=${target.provider}, model=${target.model}).`,
      `Your job is strictly READ-ONLY verification: inspect correctness, edge cases, regressions, tests, and adherence to requirements.`
    ];
    if (opts.rubric?.trim()) {
      briefLines.push("", `Review Rubric:
${opts.rubric.trim()}`);
    }
    const targetIsStillRunning = target.status === "working" || target.status === "queued" || target.status === "blocked";
    if (!targetIsStillRunning) {
      if (target.workspaceMode === "worktree") {
        const fullDiff = await getWorktreeFullDiff(target.cwd, target.baseRef, 6e3);
        if (fullDiff) {
          briefLines.push(
            "",
            `Target Worktree: cwd=${target.cwd}, branch=${target.branch || ""}`,
            `Diff Stat:
${fullDiff.stat || "(no stat)"}`,
            `Diff Patch (up to 6000 chars):
\`\`\`diff
${fullDiff.patch}
\`\`\``
          );
        }
      }
      const msgs = this.store.readBoard(swarm.id, 0, 500);
      const lastTargetPost = [...msgs].reverse().find((m) => m.agent === target.name && m.kind !== "system");
      if (lastTargetPost) {
        briefLines.push("", `Latest report from @${target.name}:`, lastTargetPost.text.slice(0, 1200));
      }
    }
    briefLines.push("", "Post a structured review summary to @coordinator.");
    const addRes = await this.addWorker({
      swarmId: swarm.id,
      name: candidateName,
      brief: briefLines.join("\n"),
      provider: reviewerProvider,
      model: opts.reviewerModel,
      permissionMode: "read-only",
      workspace: "inherit",
      role: `cross-reviewer (${reviewerProvider})`,
      dependsOn: targetIsStillRunning ? [target.name] : void 0,
      arenaGroup: target.arenaGroup
    });
    return {
      swarmId: swarm.id,
      reviewer: addRes.added[0],
      targetWorker: target.name,
      reviewerProvider,
      warnings: [...warnings, ...addRes.warnings],
      briefSeqs: addRes.briefSeqs
    };
  }
  async applyTemplate(opts) {
    let swarm = opts.swarmId ? this.store.getSwarm(opts.swarmId) : !opts.repoRoot?.trim() ? this.store.tryGetSwarm(void 0) : void 0;
    const repoForTpl = opts.repoRoot?.trim() || swarm?.repoRoot;
    const snap = getTemplatesSnapshot(this.store.dataDir, repoForTpl);
    const template = snap.templates.find((t) => t.id === opts.templateId.trim().toLowerCase());
    if (!template) {
      throw new Error(
        `Unknown template "${opts.templateId}". Available: ${snap.templates.map((t) => t.id).join(", ")}.`
      );
    }
    const byName = new Map(template.workers.map((w) => [w.name, w]));
    const ordered = [];
    const stateMap = /* @__PURE__ */ new Map();
    const visit = (name) => {
      const st = stateMap.get(name);
      if (st === "done") return;
      if (st === "visiting") {
        throw new Error(`Template "${template.id}" contains a dependency cycle involving "${name}".`);
      }
      const spec = byName.get(name);
      if (!spec) return;
      stateMap.set(name, "visiting");
      for (const dep of spec.dependsOn || []) {
        if (byName.has(dep)) visit(dep);
      }
      stateMap.set(name, "done");
      ordered.push(spec);
    };
    for (const w of template.workers) {
      visit(w.name);
    }
    if (!swarm) {
      if (!opts.repoRoot?.trim()) {
        throw new Error("repo_root is required when applying a template without an existing swarm.");
      }
      swarm = await this.createSwarm({
        repoRoot: opts.repoRoot.trim(),
        title: opts.title?.trim() || template.defaultTitle || template.name
      });
    }
    const added = [];
    const briefSeqs = [];
    const warnings = [];
    for (const spec of ordered) {
      const providerOverride = opts.providerOverrides?.[spec.name];
      const modelOverride = opts.modelOverrides?.[spec.name];
      const res = await this.addWorker({
        swarmId: swarm.id,
        name: spec.name,
        role: spec.role,
        brief: expandTemplateWorkerBrief(spec.brief, opts.goal),
        provider: providerOverride || spec.provider,
        model: modelOverride || spec.model,
        workspace: spec.workspace || "worktree",
        permissionMode: spec.permission || "workspace-write",
        dependsOn: spec.dependsOn,
        allowedFiles: spec.allowedFiles,
        verifyCommands: spec.verifyCommands,
        autoVerify: spec.autoVerify
      });
      added.push(...res.added);
      briefSeqs.push(...res.briefSeqs);
      warnings.push(...res.warnings);
    }
    return { swarmId: swarm.id, template, added, briefSeqs, warnings };
  }
  shutdown() {
    this.shuttingDown = true;
    this.store.closeAllWatchers();
    for (const proc of this.runningProcs.values()) {
      killProcessTree(proc, "SIGTERM");
    }
    this.runningProcs.clear();
  }
};

// src/index.ts
var APP_RESOURCE_URI = "ui://agy-ext-swarm/board.html";
var APP_MIME_TYPE = "text/html;profile=mcp-app";
var CustomCommandSchema = z.object({
  displayName: z.string().optional(),
  command: z.string().min(1).describe("Executable binary name or path."),
  args: z.array(z.string()).optional().describe(
    "CLI args; supports {{prompt}}, {{model}}, {{cwd}}, {{sessionId}}, {{permissionMode}}, {{workerName}}, {{swarmDir}}, {{gitCommonDir}}, {{boardCli}}."
  ),
  resume_args: z.array(z.string()).optional(),
  prompt_mode: z.enum(["stdin", "arg"]).optional(),
  output_format: z.enum(["text", "ndjson"]).optional(),
  env: z.record(z.string()).optional(),
  defaultModel: z.string().optional(),
  models: z.array(z.string()).optional()
}).optional();
function toCustomProviderConfig(raw) {
  if (!raw) return void 0;
  return {
    displayName: raw.displayName,
    command: raw.command,
    args: raw.args,
    resumeArgs: raw.resume_args,
    promptMode: raw.prompt_mode,
    outputFormat: raw.output_format,
    env: raw.env,
    defaultModel: raw.defaultModel,
    models: raw.models
  };
}
var RoutingPolicySchema = z.object({
  writer_providers: z.array(z.string().min(1)).optional(),
  reader_providers: z.array(z.string().min(1)).optional(),
  auto_failover: z.boolean().optional()
});
function toRoutingPolicy(raw) {
  if (!raw) return void 0;
  return {
    ...raw.writer_providers ? { writerProviders: raw.writer_providers } : {},
    ...raw.reader_providers ? { readerProviders: raw.reader_providers } : {},
    ...raw.auto_failover !== void 0 ? { autoFailover: raw.auto_failover } : {}
  };
}
function canonicalPath(p) {
  const abs = resolve4(p);
  return existsSync8(abs) ? realpathSync3(abs) : abs;
}
function parseCliArgs(argv) {
  const selfDir = dirname2(fileURLToPath(import.meta.url));
  let dataDir = join10(homedir3(), ".gemini", "config", "plugins", "agy-ext-swarm", ".data");
  let pluginRoot = resolve4(selfDir, "..", "..");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else if (arg === "--data-dir" && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (arg.startsWith("--plugin-root=")) {
      pluginRoot = arg.slice("--plugin-root=".length);
    } else if (arg === "--plugin-root" && argv[i + 1]) {
      pluginRoot = argv[++i];
    }
  }
  return {
    dataDir: canonicalPath(dataDir),
    pluginRoot: resolve4(pluginRoot)
  };
}
function loadBoardHtml(pluginRoot) {
  const overridePath = process.env.EXT_SWARM_APP_HTML;
  const htmlPath = overridePath ? resolve4(overridePath) : join10(pluginRoot, "server", "dist", "board.html");
  if (!existsSync8(htmlPath)) {
    return `<!doctype html><html><body><p>AGY Ext Swarm UI bundle not found at ${htmlPath}. Run pnpm build in server/.</p></body></html>`;
  }
  return readFileSync7(htmlPath, "utf8");
}
function jsonText(value) {
  return JSON.stringify(value, null, 2);
}
function formatSwarmSummary(snapshot) {
  const s = snapshot.swarm;
  const members = Object.values(s.members);
  const working = members.filter((m) => m.status === "working" || m.status === "queued").length;
  const waiting = members.filter((m) => m.status === "waiting").length;
  const failed = members.filter((m) => m.status === "failed").length;
  return `AGY Ext Swarm "${s.title}" (${s.id}) | head=#${s.headSeq} | members=${members.length} (working=${working}, waiting=${waiting}, failed=${failed})`;
}
async function main() {
  const { dataDir, pluginRoot } = parseCliArgs(process.argv.slice(2));
  const brainDir = resolveBrainDir(dataDir);
  const store = new SwarmStore(dataDir);
  const runtime = new SwarmRuntime(store, pluginRoot);
  const server = new McpServer({
    name: "agy-ext-swarm",
    version: "0.2.0"
  });
  server.registerResource(
    "AGY Ext Swarm Board UI",
    APP_RESOURCE_URI,
    {
      description: "Live side-pane dashboard for AGY Ext Swarm board, topology replay, workers, and usage.",
      mimeType: APP_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false
        }
      }
    },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: APP_MIME_TYPE,
          text: loadBoardHtml(pluginRoot),
          _meta: {
            ui: {
              prefersBorder: false
            }
          }
        }
      ]
    })
  );
  server.registerTool(
    "ext_swarm_create",
    {
      title: "Create External Swarm",
      description: "Create a new AGY Ext Swarm anchored to a workspace directory (auto-detects git repository for worktree isolation and auto-selects an available CLI provider if default_provider is omitted).",
      inputSchema: {
        title: z.string().min(1).describe("Short descriptive title for the swarm."),
        repo_root: z.string().min(1).describe("Absolute path to the workspace/repository root."),
        max_concurrency: z.number().int().min(1).max(16).optional().describe("Maximum concurrent running CLI worker processes (default 4)."),
        max_hops: z.number().int().min(1).max(50).optional().describe("Circuit breaker for autonomous worker-to-worker @mention hops (default 12)."),
        turn_timeout_seconds: z.number().int().min(0).max(7200).optional().describe("Hard timeout per worker turn in seconds (0 disables, default 300)."),
        stall_timeout_seconds: z.number().int().min(0).max(3600).optional().describe("Kill stalled worker when silent on stdout/stderr for N seconds (0 disables, default 120)."),
        profile: z.string().optional().describe('dsh profile name when using dsh workers (default "headless"; never pass "desktop").'),
        default_provider: z.string().optional().describe('Default CLI provider ID ("dsh", "claude", "codex", "gemini", or custom ID). Auto-detected if omitted.'),
        active_providers: z.array(z.string().min(1)).optional().describe('Optional multi-select CLI working pool for this swarm (e.g. ["dsh", "claude", "codex"]); workers rotate across this pool when provider is omitted.'),
        routing_policy: RoutingPolicySchema.optional().describe(
          "Optional role routing (writer_providers, reader_providers) and auto_failover policy."
        ),
        coordinator_conversation_id: z.string().optional().describe("Optional Antigravity conversation ID for main-model Token/Cache telemetry (auto-detected if omitted).")
      }
    },
    async ({
      title,
      repo_root,
      max_concurrency,
      max_hops,
      turn_timeout_seconds,
      stall_timeout_seconds,
      profile,
      default_provider,
      active_providers,
      routing_policy,
      coordinator_conversation_id
    }) => {
      try {
        const state = await runtime.createSwarm({
          title,
          repoRoot: repo_root,
          maxConcurrency: max_concurrency,
          maxHops: max_hops,
          turnTimeoutSeconds: turn_timeout_seconds,
          stallTimeoutSeconds: stall_timeout_seconds,
          profile,
          defaultProvider: default_provider,
          activeProviders: active_providers,
          routingPolicy: toRoutingPolicy(routing_policy),
          coordinatorConversationId: coordinator_conversation_id
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, swarm: state }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_providers",
    {
      title: "List CLI Providers",
      description: "List built-in (dsh, claude, codex, gemini) and custom CLI providers with enabled status, binary availability, configured models, active multi-CLI pool, routing policy, and effective defaultProvider.",
      inputSchema: {
        repo_root: z.string().optional().describe("Optional workspace root to also inspect <repo>/.agy-ext-swarm/providers.json."),
        profile: z.string().optional().describe("Optional dsh profile override.")
      }
    },
    async ({ repo_root, profile }) => {
      const resolvedRepo = repo_root ? resolve4(repo_root) : void 0;
      const snap = getProviderConfigSnapshot(dataDir, resolvedRepo, profile || void 0, true);
      return {
        content: [
          {
            type: "text",
            text: jsonText({
              defaultProvider: snap.effectiveDefaultProvider,
              configuredDefaultProvider: snap.configuredDefaultProvider,
              activePool: snap.activePool,
              routingPolicy: snap.routingPolicy,
              globalConfigPath: snap.globalConfigPath,
              repoConfigPath: snap.repoConfigPath,
              repoConfigExists: snap.repoConfigExists,
              providers: snap.providers
            })
          }
        ]
      };
    }
  );
  server.registerTool(
    "ext_swarm_models",
    {
      title: "List Provider Models",
      description: "List available models for a CLI provider (merges configured models in Settings/providers.json with auto-discovered cordis.patch.yml lastCatalog for dsh).",
      inputSchema: {
        provider: z.string().optional().describe("CLI provider ID (defaults to auto-detected provider)."),
        profile: z.string().optional().describe("Optional dsh profile override."),
        repo_root: z.string().optional().describe("Optional workspace root for repo providers.json.")
      }
    },
    async ({ provider, profile, repo_root }) => {
      const resolvedRepo = repo_root ? resolve4(repo_root) : void 0;
      const result = getProviderModels(provider, dataDir, resolvedRepo, profile || void 0);
      return {
        content: [
          {
            type: "text",
            text: jsonText(result)
          }
        ]
      };
    }
  );
  server.registerTool(
    "ext_swarm_add",
    {
      title: "Add Swarm Worker(s)",
      description: "Spawn one headless CLI worker (or a sharded pool <name>-1..<name>-k via tasks) using dsh, claude, codex, gemini, or custom_command with git worktree isolation and allowed_files whitelist.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        name: z.string().min(1).describe('Lowercase worker name (e.g. "parser", "verifier"). Reserved: all, coordinator.'),
        brief: z.string().min(1).describe("Self-contained task brief posted publicly to the board."),
        tasks: z.array(z.string().min(1)).optional().describe("Optional per-worker slice targets; spawns <name>-1 through <name>-N."),
        provider: z.string().optional().describe('Single CLI provider ID: "dsh", "claude", "codex", "gemini", "custom", or a custom ID from providers.json.'),
        providers: z.array(z.string().min(1)).optional().describe("Optional multi-select CLI providers: when passed with `tasks`, shards distribute round-robin across CLIs; when passed without `tasks`, launches one worker per selected CLI."),
        models_by_provider: z.record(z.string()).optional().describe("Optional per-provider model map (providerId -> modelId) used with multi-select `providers` or pool routing."),
        custom_command: CustomCommandSchema.describe(
          "Inline custom CLI configuration when spawning any third-party CLI command."
        ),
        model: z.string().optional().describe("Model ID for this worker (omit to use provider default)."),
        permission_mode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe('Sandbox permission preset (default "workspace-write").'),
        workspace: z.enum(["worktree", "inherit"]).optional().describe('Workspace isolation mode (default "worktree" for writers in git repos).'),
        role: z.string().optional().describe('Role label such as "worker", "verifier", or "researcher".'),
        allowed_files: z.array(z.string().min(1)).optional().describe("Optional relative file/directory whitelist mechanically checked after each turn."),
        verify_commands: z.array(z.string().min(1)).optional().describe("Optional verification commands the worker must run before reporting [done]."),
        auto_verify: z.boolean().optional().describe("Deterministically run verify_commands in worker cwd after each completed turn and post results to the board (default false)."),
        depends_on: z.array(z.string().min(1)).optional().describe("Optional upstream worker names that must finish (status=waiting, turns>=1) before this worker unlocks and starts."),
        arena_group: z.string().optional().describe("Optional arena comparison group label.")
      }
    },
    async (args) => {
      try {
        const res = await runtime.addWorker({
          swarmId: args.swarm_id,
          name: args.name,
          brief: args.brief,
          tasks: args.tasks,
          provider: args.provider,
          providers: args.providers,
          modelsByProvider: args.models_by_provider,
          customCommand: toCustomProviderConfig(args.custom_command),
          model: args.model,
          permissionMode: args.permission_mode,
          workspace: args.workspace,
          role: args.role,
          allowedFiles: args.allowed_files,
          verifyCommands: args.verify_commands,
          autoVerify: args.auto_verify,
          dependsOn: args.depends_on,
          arenaGroup: args.arena_group
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_post",
    {
      title: "Post to Swarm Board",
      description: "Post a message as coordinator to the shared board. Mentioning @worker wakes waiting/failed workers.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        text: z.string().min(1).describe("Message text; include @name or @all to wake workers.")
      }
    },
    async ({ swarm_id, text }) => {
      try {
        const message = runtime.postAsCoordinator(swarm_id, text);
        return {
          content: [{ type: "text", text: jsonText({ ok: true, message }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_read",
    {
      title: "Read Swarm Board",
      description: "Read board messages after sequence number `since`.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        since: z.number().int().min(0).optional().describe("Return messages with seq > since (default 0)."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum messages to return (default 100).")
      }
    },
    async ({ swarm_id, since, limit }) => {
      try {
        const swarm = store.getSwarm(swarm_id);
        store.drainInbox(swarm.id);
        const messages = store.readBoard(swarm.id, since ?? 0, limit ?? 100);
        return {
          content: [
            {
              type: "text",
              text: jsonText({
                swarmId: swarm.id,
                headSeq: swarm.headSeq,
                messages
              })
            }
          ]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_status",
    {
      title: "Swarm Status",
      description: "Inspect all workers (provider, status, model, activity, sessionId, token usage, worktree branch, coordinatorUsage, and optional diff/out-of-scope check).",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        include_diff: z.boolean().optional().describe("Include git diff stats and allowed_files violation check for worktrees.")
      }
    },
    async ({ swarm_id, include_diff }) => {
      try {
        const res = await runtime.getStatus(swarm_id, include_diff ?? false);
        const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, res.swarm);
        return {
          content: [{ type: "text", text: jsonText({ ...res, coordinatorUsage }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_wait",
    {
      title: "Wait on Swarm",
      description: "Wait up to 90s for a board post, @coordinator mention, worker completion, or all workers becoming idle.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        since: z.number().int().min(0).optional().describe("Board sequence cursor to watch after."),
        timeout_seconds: z.number().min(1).max(90).optional().describe("Maximum seconds to wait (1-90, default 45)."),
        until: z.enum(["any_post", "mentions_coordinator", "all_idle", "worker_done"]).optional().describe('Wake condition (default "any_post").'),
        worker_name: z.string().optional().describe('Worker name when until="worker_done".')
      }
    },
    async ({ swarm_id, since, timeout_seconds, until, worker_name }) => {
      try {
        const res = await runtime.waitForCondition({
          swarmId: swarm_id,
          since,
          timeoutSeconds: timeout_seconds,
          until,
          workerName: worker_name
        });
        return {
          content: [{ type: "text", text: jsonText(res) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_kill",
    {
      title: "Kill Swarm Worker(s)",
      description: 'Terminate one worker, a sharded group, or "all", optionally deleting temporary git worktrees and branches.',
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        name: z.string().min(1).describe('Worker name, group prefix, or "all".'),
        remove_worktree: z.boolean().optional().describe("Also remove worker git worktree directory and branch (default false).")
      }
    },
    async ({ swarm_id, name, remove_worktree }) => {
      try {
        const res = await runtime.killWorker(swarm_id, name, remove_worktree ?? false);
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_update_worker",
    {
      title: "Switch Worker Provider / Model or Retry",
      description: "Update provider/model or retry a waiting/failed worker in place while keeping its existing git worktree and branch intact.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        name: z.string().min(1).describe("Existing waiting/failed worker name."),
        provider: z.string().optional().describe("New CLI provider ID (clears old CLI sessionId when switching CLIs)."),
        custom_command: CustomCommandSchema.describe('Inline custom CLI config if switching to provider="custom".'),
        model: z.string().optional().describe("New model ID to use on this worker."),
        prompt: z.string().optional().describe("Optional follow-up instruction posted to wake the worker."),
        retry: z.boolean().optional().describe("Immediately enqueue/wake worker to resume work (default true if prompt omitted? Specify true to run immediately).")
      }
    },
    async (args) => {
      try {
        const res = await runtime.updateAndRetryWorker({
          swarmId: args.swarm_id,
          name: args.name,
          provider: args.provider,
          customCommand: toCustomProviderConfig(args.custom_command),
          model: args.model,
          prompt: args.prompt,
          retry: args.retry
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_delete",
    {
      title: "Delete Swarm",
      description: "Terminate any remaining processes, clean up worktrees/branches, and delete a historical swarm record.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        remove_worktrees: z.boolean().optional().describe("Remove worker git worktrees and branches (default true).")
      }
    },
    async ({ swarm_id, remove_worktrees }) => {
      try {
        const res = await runtime.deleteSwarm(swarm_id, remove_worktrees ?? true);
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_export",
    {
      title: "Export Swarm Markdown Report",
      description: "Generate a Markdown post-mortem / battle report covering workers, token/cache telemetry, optional cost estimates, diffs, and the full board transcript.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm).")
      }
    },
    async ({ swarm_id }) => {
      try {
        const swarm = store.getSwarm(swarm_id);
        const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
        const cfg = getProviderConfigSnapshot(dataDir, swarm.repoRoot, swarm.profile);
        const res = await runtime.exportSwarmMarkdown(swarm.id, coordinatorUsage, cfg.pricing);
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_merge",
    {
      title: "Preview or Merge Worker Worktree",
      description: 'Run zero-side-effect conflict detection (action="preview") using git merge-tree, or safely apply a worker worktree branch into target branch (action="apply", modes: squash/cherry-pick/merge).',
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        worker: z.string().min(1).describe("Name of the worktree worker to preview or merge."),
        action: z.enum(["preview", "apply"]).optional().describe("preview checks conflicts without modifying working tree (default); apply performs the merge."),
        mode: z.enum(["squash", "cherry-pick", "merge"]).optional().describe('Merge strategy when action="apply" (default "squash").'),
        target_branch: z.string().optional().describe("Target branch name (defaults to currently checked out branch)."),
        commit_message: z.string().optional().describe("Optional custom commit message for squash/merge."),
        remove_worktree: z.boolean().optional().describe("Whether to remove worker worktree and branch after a successful merge (default false).")
      }
    },
    async ({ swarm_id, worker, action, mode, target_branch, commit_message, remove_worktree }) => {
      try {
        if ((action || "preview") === "preview") {
          const preview = await runtime.previewWorkerMerge({
            swarmId: swarm_id,
            workerName: worker,
            targetBranch: target_branch
          });
          return {
            content: [{ type: "text", text: jsonText({ ok: true, preview }) }]
          };
        }
        const result = await runtime.mergeWorker({
          swarmId: swarm_id,
          workerName: worker,
          targetBranch: target_branch,
          mode,
          commitMessage: commit_message,
          removeWorktreeAfter: remove_worktree
        });
        return {
          isError: !result.merged,
          content: [{ type: "text", text: jsonText({ ok: result.merged, ...result }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_arena",
    {
      title: "Launch Multi-CLI Arena Competition",
      description: "Spawn 2+ CLI providers/models side by side in isolated git worktrees to tackle the exact same task cleanly for comparison.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        task: z.string().min(1).describe("Shared task specification assigned to every arena contestant."),
        contestants: z.array(
          z.object({
            name: z.string().optional(),
            provider: z.string().min(1),
            model: z.string().optional(),
            permission: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
            role: z.string().optional()
          })
        ).min(2).describe("List of 2 or more provider/model configurations to race in parallel worktrees."),
        base_name: z.string().optional().describe('Optional arena group prefix (e.g. "arena-auth").'),
        permission: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().describe('Default permission mode for contestants (default "workspace-write").')
      }
    },
    async ({ swarm_id, task, contestants, base_name, permission }) => {
      try {
        const res = await runtime.startArena({
          swarmId: swarm_id,
          task,
          contestants: contestants.map((c) => ({
            name: c.name,
            provider: c.provider,
            model: c.model,
            permissionMode: c.permission,
            role: c.role
          })),
          baseName: base_name,
          permissionMode: permission
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_cross_review",
    {
      title: "Cross-Vendor Code Review",
      description: "Spawn a read-only reviewer using a different CLI provider (or specified reviewer_provider) to audit target_worker changes.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Target swarm ID (defaults to latest swarm)."),
        target_worker: z.string().min(1).describe("Worker whose output and worktree diff should be reviewed."),
        reviewer_provider: z.string().optional().describe("Reviewer CLI provider ID (auto-selects another available provider if omitted)."),
        reviewer_model: z.string().optional().describe("Optional model ID for reviewer."),
        reviewer_name: z.string().optional().describe("Optional worker name for the reviewer."),
        rubric: z.string().optional().describe("Optional custom review checklist or focus areas.")
      }
    },
    async ({
      swarm_id,
      target_worker,
      reviewer_provider,
      reviewer_model,
      reviewer_name,
      rubric
    }) => {
      try {
        const res = await runtime.startCrossReview({
          swarmId: swarm_id,
          targetWorker: target_worker,
          reviewerProvider: reviewer_provider,
          reviewerModel: reviewer_model,
          reviewerName: reviewer_name,
          rubric
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_templates",
    {
      title: "List Swarm Team Templates",
      description: "List built-in and custom reusable swarm playbooks/templates (merged from global dataDir and repo .agy-ext-swarm/templates.json).",
      inputSchema: {
        swarm_id: z.string().optional().describe("Optional swarm ID to resolve repo_root."),
        repo_root: z.string().optional().describe("Optional workspace root to inspect repo templates.")
      }
    },
    async ({ swarm_id, repo_root }) => {
      try {
        const swarm = swarm_id ? store.tryGetSwarm(swarm_id) : store.tryGetSwarm(void 0);
        const snap = getTemplatesSnapshot(dataDir, repo_root?.trim() || swarm?.repoRoot);
        return {
          content: [{ type: "text", text: jsonText(snap) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_apply_template",
    {
      title: "Apply Swarm Team Template",
      description: "Instantiate a multi-worker DAG team playbook (optionally creating a new swarm if swarm_id is omitted) with {{goal}} injection.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Existing swarm ID (omit + provide repo_root to create one)."),
        template_id: z.string().min(1).describe('Template ID (e.g. "feature-squad", "bug-hunt", "doc-and-test").'),
        goal: z.string().min(1).describe("Shared task goal injected into template worker briefs."),
        repo_root: z.string().optional().describe("Workspace root when creating a new swarm."),
        title: z.string().optional().describe("Optional swarm title when creating a new swarm."),
        provider_overrides: z.record(z.string()).optional().describe("Optional per-worker provider overrides (workerName -> providerId)."),
        model_overrides: z.record(z.string()).optional().describe("Optional per-worker model overrides (workerName -> modelId).")
      }
    },
    async ({ swarm_id, template_id, goal, repo_root, title, provider_overrides, model_overrides }) => {
      try {
        const res = await runtime.applyTemplate({
          swarmId: swarm_id,
          templateId: template_id,
          goal,
          repoRoot: repo_root,
          title,
          providerOverrides: provider_overrides,
          modelOverrides: model_overrides
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }]
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "ext_swarm_open_board",
    {
      title: "AGY Ext Swarm Board",
      description: "Open the live AGY Ext Swarm board, topology replay, workers, and token usage cockpit in the interactive MCP App view.",
      inputSchema: {
        swarm_id: z.string().optional().describe("Optional swarm ID to focus (defaults to latest swarm).")
      },
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI
        },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "AGY Ext Swarm" },
            { type: "global", title: "AGY Ext Swarm" }
          ]
        }
      }
    },
    async ({ swarm_id }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      const { usage: coordinatorUsage, conversations: availableConversations } = readCoordinatorUsage(brainDir, swarm ?? null);
      const providerConfig = getProviderConfigSnapshot(dataDir, swarm?.repoRoot, swarm?.profile);
      const templatesConfig = getTemplatesSnapshot(dataDir, swarm?.repoRoot);
      const uiPrefs = store.getUiPrefs();
      if (!swarm) {
        const emptySnapshot = {
          swarm: null,
          messages: [],
          edges: [],
          swarms: store.listSwarms(),
          coordinatorUsage,
          availableConversations,
          providers: providerConfig.providers,
          providerConfig,
          templatesConfig,
          uiPrefs
        };
        return {
          content: [
            {
              type: "text",
              text: "No AGY Ext Swarm has been created yet. Use ext_swarm_create to start one."
            }
          ],
          structuredContent: emptySnapshot
        };
      }
      store.drainInbox(swarm.id);
      const snapshot = {
        swarm,
        messages: store.readBoard(swarm.id, 0, 200),
        edges: store.computeGraphEdges(swarm.id),
        swarms: store.listSwarms(),
        coordinatorUsage,
        availableConversations,
        providers: providerConfig.providers,
        providerConfig,
        templatesConfig,
        uiPrefs
      };
      return {
        content: [{ type: "text", text: formatSwarmSummary(snapshot) }],
        structuredContent: snapshot
      };
    }
  );
  server.registerTool(
    "app_get_snapshot",
    {
      title: "Get Swarm Snapshot",
      description: "Internal UI polling endpoint returning full swarm snapshot and worktree diffs.",
      inputSchema: {
        swarm_id: z.string().optional(),
        include_diff: z.boolean().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, include_diff }) => {
      const swarms = store.listSwarms();
      const swarm = store.tryGetSwarm(swarm_id);
      const { usage: coordinatorUsage, conversations: availableConversations } = readCoordinatorUsage(brainDir, swarm ?? null);
      const providerConfig = getProviderConfigSnapshot(dataDir, swarm?.repoRoot, swarm?.profile);
      const templatesConfig = getTemplatesSnapshot(dataDir, swarm?.repoRoot);
      const uiPrefs = store.getUiPrefs();
      if (!swarm) {
        return {
          content: [{ type: "text", text: "No swarm found" }],
          structuredContent: {
            swarm: null,
            messages: [],
            edges: [],
            swarms,
            diffs: {},
            coordinatorUsage,
            availableConversations,
            providers: providerConfig.providers,
            providerConfig,
            templatesConfig,
            uiPrefs
          }
        };
      }
      store.drainInbox(swarm.id);
      const { diffs } = await runtime.getStatus(swarm.id, include_diff ?? true);
      const snapshot = {
        swarm,
        messages: store.readBoard(swarm.id, 0, 300),
        edges: store.computeGraphEdges(swarm.id),
        swarms,
        diffs,
        coordinatorUsage,
        availableConversations,
        providers: providerConfig.providers,
        providerConfig,
        templatesConfig,
        uiPrefs
      };
      return {
        content: [{ type: "text", text: formatSwarmSummary(snapshot) }],
        structuredContent: snapshot
      };
    }
  );
  server.registerTool(
    "app_set_ui_prefs",
    {
      title: "Set UI Preferences",
      description: "Persist UI preferences (such as locale) in plugin data directory.",
      inputSchema: {
        locale: z.enum(["zh", "en"]).optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ locale }) => {
      const uiPrefs = store.setUiPrefs({ locale });
      return {
        content: [{ type: "text", text: jsonText({ ok: true, uiPrefs }) }],
        structuredContent: { ok: true, uiPrefs }
      };
    }
  );
  server.registerTool(
    "app_get_provider_config",
    {
      title: "Get CLI & Model Config",
      description: "Read configured and auto-detected CLI providers and supported models for the Settings UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        repo_root: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, repo_root }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      const effectiveRepo = repo_root ? resolve4(repo_root) : swarm?.repoRoot;
      const providerConfig = getProviderConfigSnapshot(dataDir, effectiveRepo, swarm?.profile, true);
      return {
        content: [{ type: "text", text: jsonText({ ok: true, providerConfig }) }],
        structuredContent: { ok: true, providerConfig }
      };
    }
  );
  server.registerTool(
    "app_save_provider_config",
    {
      title: "Save CLI & Model Config",
      description: "Persist CLI provider enablement, default provider, model lists, optional pricing, and custom CLI definitions to global providers.json.",
      inputSchema: {
        default_provider: z.string().nullable().optional(),
        active_pool: z.array(z.string()).nullable().optional(),
        routing_policy: RoutingPolicySchema.nullable().optional(),
        upsert_provider: z.object({
          id: z.string().min(1),
          config: z.object({
            enabled: z.boolean().optional(),
            displayName: z.string().optional(),
            command: z.string().optional(),
            defaultModel: z.string().optional(),
            models: z.array(z.string()).optional(),
            profile: z.string().optional(),
            modelProvider: z.string().optional(),
            args: z.array(z.string()).optional(),
            resumeArgs: z.array(z.string()).optional(),
            promptMode: z.enum(["stdin", "arg"]).optional(),
            outputFormat: z.enum(["text", "ndjson"]).optional(),
            env: z.record(z.string()).optional()
          }).nullable()
        }).optional(),
        remove_provider: z.string().optional(),
        upsert_pricing: z.object({
          model: z.string().min(1),
          pricing: z.object({
            inputPer1M: z.number().min(0),
            cacheReadPer1M: z.number().min(0).optional(),
            outputPer1M: z.number().min(0),
            currency: z.enum(["USD", "CNY"]).optional()
          }).nullable()
        }).optional(),
        swarm_id: z.string().optional(),
        repo_root: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({
      default_provider,
      active_pool,
      routing_policy,
      upsert_provider,
      remove_provider,
      upsert_pricing,
      swarm_id,
      repo_root
    }) => {
      try {
        saveProviderConfigPatch(dataDir, {
          defaultProvider: default_provider,
          activePool: active_pool,
          routingPolicy: routing_policy === null ? null : routing_policy !== void 0 ? toRoutingPolicy(routing_policy) : void 0,
          upsertProvider: upsert_provider,
          removeProvider: remove_provider,
          upsertPricing: upsert_pricing
        });
        const swarm = store.tryGetSwarm(swarm_id);
        const effectiveRepo = repo_root ? resolve4(repo_root) : swarm?.repoRoot;
        const providerConfig = getProviderConfigSnapshot(dataDir, effectiveRepo, swarm?.profile, true);
        return {
          content: [{ type: "text", text: jsonText({ ok: true, providerConfig }) }],
          structuredContent: { ok: true, providerConfig }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_get_worker_diff",
    {
      title: "Get Worker Git Diff",
      description: "Read full git diff patch (including untracked files) for a worker worktree.",
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1)
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, name }) => {
      try {
        const diff = await runtime.getWorkerFullDiff(swarm_id, name);
        return {
          content: [{ type: "text", text: jsonText({ ok: true, diff }) }],
          structuredContent: { ok: true, diff }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_retry_worker",
    {
      title: "Retry or Switch Worker from UI",
      description: "Switch provider/model and/or retry a waiting or failed worker from the MCP App UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        provider: z.string().optional(),
        model: z.string().optional(),
        prompt: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, name, provider, model, prompt }) => {
      try {
        const res = await runtime.updateAndRetryWorker({
          swarmId: swarm_id,
          name,
          provider,
          model,
          prompt,
          retry: true
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_test_provider",
    {
      title: "Test CLI Provider Connection",
      description: "Probe a configured CLI provider binary (--version, latency, and dsh profile status).",
      inputSchema: {
        provider_id: z.string().min(1),
        swarm_id: z.string().optional(),
        repo_root: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ provider_id, swarm_id, repo_root }) => {
      const swarm = store.tryGetSwarm(swarm_id);
      const effectiveRepo = repo_root ? resolve4(repo_root) : swarm?.repoRoot;
      const result = await testProviderConnection(
        provider_id,
        dataDir,
        effectiveRepo,
        swarm?.profile
      );
      return {
        content: [{ type: "text", text: jsonText({ ok: true, result }) }],
        structuredContent: { ok: true, result }
      };
    }
  );
  server.registerTool(
    "app_delete_swarm",
    {
      title: "Delete Swarm from UI",
      description: "Delete a historical swarm and optionally remove its temporary worktrees.",
      inputSchema: {
        swarm_id: z.string().optional(),
        remove_worktrees: z.boolean().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, remove_worktrees }) => {
      try {
        const res = await runtime.deleteSwarm(swarm_id, remove_worktrees ?? true);
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res, swarms: store.listSwarms() }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_export_swarm",
    {
      title: "Export Swarm Report from UI",
      description: "Generate downloadable Markdown post-mortem report for a swarm.",
      inputSchema: {
        swarm_id: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id }) => {
      try {
        const swarm = store.getSwarm(swarm_id);
        const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
        const cfg = getProviderConfigSnapshot(dataDir, swarm.repoRoot, swarm.profile);
        const res = await runtime.exportSwarmMarkdown(swarm.id, coordinatorUsage, cfg.pricing);
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_bind_conversation",
    {
      title: "Bind Coordinator Conversation",
      description: "Bind an Antigravity conversation ID to a swarm for main-model token telemetry.",
      inputSchema: {
        swarm_id: z.string().optional(),
        conversation_id: z.string().min(1)
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, conversation_id }) => {
      try {
        const swarm = store.setCoordinatorConversation(swarm_id, conversation_id);
        const { usage: coordinatorUsage } = readCoordinatorUsage(brainDir, swarm);
        return {
          content: [{ type: "text", text: `Bound ${conversation_id}` }],
          structuredContent: { ok: true, swarm, coordinatorUsage }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_post_message",
    {
      title: "App Post Message",
      description: "Post a coordinator message from the MCP App UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        text: z.string().min(1)
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, text }) => {
      try {
        const message = runtime.postAsCoordinator(swarm_id, text);
        return {
          content: [{ type: "text", text: `Posted #${message.seq}` }],
          structuredContent: { ok: true, message }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_kill_worker",
    {
      title: "App Kill Worker",
      description: "Kill a worker from the MCP App UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        remove_worktree: z.boolean().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, name, remove_worktree }) => {
      try {
        const res = await runtime.killWorker(swarm_id, name, remove_worktree ?? false);
        return {
          content: [{ type: "text", text: jsonText(res) }],
          structuredContent: { ok: true, ...res }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_get_worker_log",
    {
      title: "App Get Worker Log",
      description: "Read tail lines of a worker NDJSON log for inspection in the UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        tail_lines: z.number().int().min(1).max(300).optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, name, tail_lines }) => {
      try {
        const swarm = store.getSwarm(swarm_id);
        const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "");
        const logPath = join10(store.getLogsDir(swarm.id), `${safeName}.ndjson`);
        if (!existsSync8(logPath)) {
          return {
            content: [{ type: "text", text: "No logs yet." }],
            structuredContent: { name: safeName, lines: [] }
          };
        }
        const rawLines = readFileSync7(logPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
        const sliced = rawLines.slice(-(tail_lines ?? 80));
        return {
          content: [{ type: "text", text: `Loaded ${sliced.length} log lines` }],
          structuredContent: { name: safeName, lines: sliced }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_preview_merge",
    {
      title: "App Preview Worker Merge",
      description: "Run zero-side-effect git merge-tree conflict check for a worker branch from UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        target_branch: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, name, target_branch }) => {
      try {
        const preview = await runtime.previewWorkerMerge({
          swarmId: swarm_id,
          workerName: name,
          targetBranch: target_branch
        });
        return {
          content: [{ type: "text", text: jsonText(preview) }],
          structuredContent: { ok: true, preview }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_merge_worker",
    {
      title: "App Merge Worker Branch",
      description: "Safely merge a worker worktree branch into target branch from UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        mode: z.enum(["squash", "cherry-pick", "merge"]).optional(),
        target_branch: z.string().optional(),
        commit_message: z.string().optional(),
        remove_worktree: z.boolean().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, name, mode, target_branch, commit_message, remove_worktree }) => {
      try {
        const result = await runtime.mergeWorker({
          swarmId: swarm_id,
          workerName: name,
          mode,
          targetBranch: target_branch,
          commitMessage: commit_message,
          removeWorktreeAfter: remove_worktree
        });
        return {
          isError: !result.merged,
          content: [{ type: "text", text: jsonText(result) }],
          structuredContent: { ok: result.merged, ...result }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_create_swarm",
    {
      title: "App Create Swarm",
      description: "Create a new swarm directly from the MCP App UI.",
      inputSchema: {
        repo_root: z.string().min(1),
        title: z.string().optional(),
        default_provider: z.string().optional(),
        active_providers: z.array(z.string().min(1)).optional(),
        routing_policy: RoutingPolicySchema.optional(),
        max_concurrency: z.number().int().min(1).max(16).optional(),
        max_hops: z.number().int().min(1).max(50).optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({
      repo_root,
      title,
      default_provider,
      active_providers,
      routing_policy,
      max_concurrency,
      max_hops
    }) => {
      try {
        const swarm = await runtime.createSwarm({
          repoRoot: repo_root,
          title: title?.trim() || "Swarm",
          defaultProvider: default_provider,
          activeProviders: active_providers,
          routingPolicy: toRoutingPolicy(routing_policy),
          maxConcurrency: max_concurrency,
          maxHops: max_hops
        });
        return {
          content: [{ type: "text", text: `Created swarm ${swarm.id}` }],
          structuredContent: { ok: true, swarm }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_add_worker",
    {
      title: "App Add Worker",
      description: "Add and start (or queue/block) a worker directly from the MCP App UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        name: z.string().min(1),
        brief: z.string().min(1),
        tasks: z.array(z.string().min(1)).optional(),
        provider: z.string().optional(),
        providers: z.array(z.string().min(1)).optional(),
        models_by_provider: z.record(z.string()).optional(),
        model: z.string().optional(),
        permission_mode: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
        workspace: z.enum(["worktree", "inherit"]).optional(),
        role: z.string().optional(),
        depends_on: z.array(z.string().min(1)).optional(),
        arena_group: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async (args) => {
      try {
        const res = await runtime.addWorker({
          swarmId: args.swarm_id,
          name: args.name,
          brief: args.brief,
          tasks: args.tasks,
          provider: args.provider,
          providers: args.providers,
          modelsByProvider: args.models_by_provider,
          model: args.model,
          permissionMode: args.permission_mode,
          workspace: args.workspace,
          role: args.role,
          dependsOn: args.depends_on,
          arenaGroup: args.arena_group
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_start_arena",
    {
      title: "App Start Arena",
      description: "Launch an isolated multi-CLI arena competition directly from UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        task: z.string().min(1),
        contestants: z.array(
          z.object({
            name: z.string().optional(),
            provider: z.string().min(1),
            model: z.string().optional(),
            permission: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
            role: z.string().optional()
          })
        ).min(2),
        base_name: z.string().optional(),
        permission: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, task, contestants, base_name, permission }) => {
      try {
        const res = await runtime.startArena({
          swarmId: swarm_id,
          task,
          contestants: contestants.map((c) => ({
            name: c.name,
            provider: c.provider,
            model: c.model,
            permissionMode: c.permission,
            role: c.role
          })),
          baseName: base_name,
          permissionMode: permission
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_cross_review",
    {
      title: "App Cross Review",
      description: "Trigger cross-vendor read-only review of a worker directly from UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        target_worker: z.string().min(1),
        reviewer_provider: z.string().optional(),
        reviewer_model: z.string().optional(),
        rubric: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, target_worker, reviewer_provider, reviewer_model, rubric }) => {
      try {
        const res = await runtime.startCrossReview({
          swarmId: swarm_id,
          targetWorker: target_worker,
          reviewerProvider: reviewer_provider,
          reviewerModel: reviewer_model,
          rubric
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_get_templates",
    {
      title: "App Get Templates",
      description: "Fetch built-in and custom team templates for the MCP App UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        repo_root: z.string().optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, repo_root }) => {
      const swarm = swarm_id ? store.tryGetSwarm(swarm_id) : store.tryGetSwarm(void 0);
      const templatesConfig = getTemplatesSnapshot(dataDir, repo_root?.trim() || swarm?.repoRoot);
      return {
        content: [{ type: "text", text: jsonText(templatesConfig) }],
        structuredContent: { ok: true, templatesConfig }
      };
    }
  );
  server.registerTool(
    "app_save_template",
    {
      title: "App Save Template",
      description: "Create, update, or remove a custom swarm team template in global templates.json.",
      inputSchema: {
        swarm_id: z.string().optional(),
        remove_template_id: z.string().optional(),
        upsert_template: z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          description: z.string().optional(),
          defaultTitle: z.string().optional(),
          workers: z.array(
            z.object({
              name: z.string().min(1),
              role: z.string().optional(),
              brief: z.string().min(1),
              provider: z.string().optional(),
              model: z.string().optional(),
              workspace: z.enum(["worktree", "inherit"]).optional(),
              permission: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
              dependsOn: z.array(z.string()).optional(),
              allowedFiles: z.array(z.string()).optional(),
              verifyCommands: z.array(z.string()).optional(),
              autoVerify: z.boolean().optional()
            })
          ).min(1)
        }).optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, remove_template_id, upsert_template }) => {
      try {
        const swarm = swarm_id ? store.tryGetSwarm(swarm_id) : store.tryGetSwarm(void 0);
        const templatesConfig = saveTemplatePatch(dataDir, swarm?.repoRoot, {
          removeTemplateId: remove_template_id,
          upsertTemplate: upsert_template ? {
            ...upsert_template,
            description: upsert_template.description || "",
            workers: upsert_template.workers.map((w) => ({
              ...w,
              role: w.role || w.name
            }))
          } : void 0
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, templatesConfig }) }],
          structuredContent: { ok: true, templatesConfig }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  server.registerTool(
    "app_apply_template",
    {
      title: "App Apply Template",
      description: "Instantiate a swarm team template directly from the MCP App UI.",
      inputSchema: {
        swarm_id: z.string().optional(),
        template_id: z.string().min(1),
        goal: z.string().min(1),
        repo_root: z.string().optional(),
        title: z.string().optional(),
        provider_overrides: z.record(z.string()).optional(),
        model_overrides: z.record(z.string()).optional()
      },
      _meta: {
        ui: {
          visibility: ["app"]
        }
      }
    },
    async ({ swarm_id, template_id, goal, repo_root, title, provider_overrides, model_overrides }) => {
      try {
        const res = await runtime.applyTemplate({
          swarmId: swarm_id,
          templateId: template_id,
          goal,
          repoRoot: repo_root,
          title,
          providerOverrides: provider_overrides,
          modelOverrides: model_overrides
        });
        return {
          content: [{ type: "text", text: jsonText({ ok: true, ...res }) }],
          structuredContent: { ok: true, ...res }
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }]
        };
      }
    }
  );
  const onShutdown = () => {
    runtime.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[agy-ext-swarm] MCP server listening on stdio (dataDir=${dataDir})`);
}
main().catch((err) => {
  console.error("[agy-ext-swarm] Fatal error:", err);
  process.exit(1);
});
//# sourceMappingURL=index.mjs.map
