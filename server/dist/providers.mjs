// src/models.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}
function getProfilePatchPath(profile = "headless") {
  return join(getDshHome(), "profiles", profile, "cordis.patch.yml");
}
function listDshModels(profile = "headless") {
  const safeProfile = profile.trim() || "headless";
  const configPath = getProfilePatchPath(safeProfile);
  let defaultProvider = "";
  let defaultModel = "";
  const models = [];
  if (!existsSync(configPath)) {
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
    const raw = readFileSync(configPath, "utf8");
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
import { delimiter as delimiter2, extname, isAbsolute as isAbsolute2, join as join3 } from "node:path";

// src/worktree.ts
import { execFile } from "node:child_process";
import { delimiter, isAbsolute, join as join2, resolve } from "node:path";
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
    const found = checkExecCandidate(join3(dir, trimmed));
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
import { join as join4 } from "node:path";
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
      const patchPath = join4(ctx.patchesDir, `${ctx.workerName}.yml`);
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
import { existsSync as existsSync3, readFileSync as readFileSync3, statSync } from "node:fs";
import { join as join6 } from "node:path";
import { promisify as promisify2 } from "node:util";

// src/store.ts
import {
  appendFileSync,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readdirSync,
  readFileSync as readFileSync2,
  renameSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync as writeFileSync2
} from "node:fs";
import { join as join5 } from "node:path";
import { randomBytes } from "node:crypto";
function atomicWriteJson(filePath, value) {
  const dir = join5(filePath, "..");
  mkdirSync2(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync2(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmpPath, filePath);
}

// src/providers/config.ts
var execFileAsync2 = promisify2(execFile2);
var BUILTIN_ADAPTERS = {
  dsh: dshAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter
};
function getBuiltinAdapter(id) {
  return BUILTIN_ADAPTERS[id.trim().toLowerCase()];
}
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
  if (!existsSync3(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync3(filePath, "utf8"));
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
  const globalConfigPath = join6(dataDir, "providers.json");
  const repoConfigPath = repoRoot ? join6(repoRoot, ".agy-ext-swarm", "providers.json") : void 0;
  const repoConfigExists = Boolean(repoConfigPath && existsSync3(repoConfigPath));
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
function loadCustomProviders(dataDir, repoRoot) {
  const state = mergeProvidersConfig(dataDir, repoRoot);
  const out = {};
  for (const [id, cfg] of Object.entries(state.providers)) {
    if (BUILTIN_ADAPTERS[id]) continue;
    if (typeof cfg.command === "string" && cfg.command.trim()) {
      out[id] = { ...cfg, command: cfg.command.trim() };
    }
  }
  return out;
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
  const globalPath = join6(dataDir, "providers.json");
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
    `Unknown CLI provider "${providerId}". Available built-ins: ${Object.keys(BUILTIN_ADAPTERS).join(", ")}. Or pass custom_command / configure ${join6(dataDir, "providers.json")}.`
  );
}
var PROVIDER_SNAPSHOT_TTL_MS = 1e4;
var providerSnapshotCache = /* @__PURE__ */ new Map();
function fileMtimeToken(filePath) {
  if (!filePath || !existsSync3(filePath)) return "0";
  try {
    return String(statSync(filePath).mtimeMs);
  } catch {
    return "0";
  }
}
function getProviderConfigSnapshot(dataDir, repoRoot, profileOverride, bypassCache = false) {
  const globalPath = join6(dataDir, "providers.json");
  const repoPath = repoRoot ? join6(repoRoot, ".agy-ext-swarm", "providers.json") : void 0;
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
function listProviders(dataDir, repoRoot, profile = "headless") {
  return getProviderConfigSnapshot(dataDir, repoRoot, profile).providers;
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
export {
  BUILTIN_ADAPTERS,
  applyBuiltinOverride,
  claudeAdapter,
  codexAdapter,
  createCustomAdapter,
  dshAdapter,
  expandTemplateArgs,
  geminiAdapter,
  getBuiltinAdapter,
  getProviderConfigSnapshot,
  getProviderModels,
  listDshModels,
  listProviders,
  loadCustomProviders,
  resolveDefaultProvider,
  resolveExecutable,
  resolveProviderAdapter,
  saveProviderConfigPatch,
  summarizeToolCall,
  testProviderConnection
};
