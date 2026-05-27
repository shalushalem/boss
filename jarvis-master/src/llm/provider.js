const { config } = require("../config");

const ALLOWED_TOOLS = [
  "system_status",
  "open_url",
  "open_app",
  "vision_status",
  "vision_last_observation",
  "agentic_plan",
  "agentic_execute_plan",
  "skills_list",
  "skills_active",
  "skills_activate",
];

const ACTION_WORDS =
  /\b(build|create|implement|analyze|optimize|fix|generate|design|plan|audit|setup|set up)\b/i;

async function callLocalHttpModel(prompt, extraPayload = {}) {
  const payload = {
    model: config.localLlmModel,
    prompt,
    stream: false,
    ...extraPayload,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.localLlmTimeoutMs);
  let res;
  try {
    res = await fetch(config.localLlmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Local model error ${res.status}: ${body}`);
  }

  const json = await res.json();
  return json.response || "";
}

async function reason(userText, context = {}) {
  const deterministic = ruleBasedToolReasoning(userText, context);
  if (deterministic) return deterministic;

  if (config.mode === "mock") {
    return mockReasoning(userText, context);
  }

  const topSkills = (context?.skillRouting?.suggestions || [])
    .slice(0, 5)
    .map((s) => `${s.name} (${s.category}, score ${s.score})`)
    .join("; ");
  const activeSkills = (context?.activeSkills || []).map((s) => s.name).join(", ");
  const selectedSkill = context?.selectedSkill
    ? `${context.selectedSkill.name} (${context.selectedSkill.category})`
    : "none";
  const skillGuide = context?.skillContext?.guideSnippet
    ? context.skillContext.guideSnippet.slice(0, 1400)
    : "none";
  const pendingTask = context?.pendingTask
    ? JSON.stringify({
        id: context.pendingTask.id,
        goal: context.pendingTask.goal,
        status: context.pendingTask.status,
      }).slice(0, 260)
    : "none";
  const recentConversation = formatRecentConversation(context?.recentMessages || []);
  const visionSnapshot = context?.visionContext
    ? JSON.stringify({
        changed: context.visionContext.changed,
        sceneHint: context.visionContext.sceneHint,
        app: context.visionContext.activeWindow?.processName || null,
        title: context.visionContext.activeWindow?.windowTitle || null,
        ocrText: context.visionContext.ocrText || "",
      }).slice(0, 600)
    : "none";

  const prompt = [
    "You are a local Jarvis runtime. Return ONLY compact JSON.",
    'Allowed format: {"type":"text","content":"..."} or {"type":"tool","toolName":"system_status|open_url|open_app|vision_status|vision_last_observation|agentic_plan|agentic_execute_plan|skills_list|skills_active|skills_activate","args":{...}}',
    `Top matched skills: ${topSkills || "none"}`,
    `Active skills: ${activeSkills || "none"}`,
    `Selected skill: ${selectedSkill}`,
    `Selected skill guide snippet: ${skillGuide}`,
    `Pending task context: ${pendingTask}`,
    `Recent conversation: ${recentConversation}`,
    `Vision context snapshot: ${visionSnapshot}`,
    `User: ${userText}`,
  ].join("\n");

  for (let attempt = 1; attempt <= config.localLlmRetries + 1; attempt += 1) {
    try {
      const raw = await callLocalHttpModel(prompt, {
        format: "json",
        options: { temperature: 0 },
      });
      return normalizePlan(extractJsonObject(raw));
    } catch (error) {
      if (attempt > config.localLlmRetries) {
        return {
          type: "text",
          content: buildLlmErrorMessage(error),
        };
      }
    }
  }

  return {
    type: "text",
    content: "Connection error: local LLM did not return a valid response.",
  };
}

function ruleBasedToolReasoning(userText, context = {}) {
  const text = String(userText || "").toLowerCase();
  if (text.includes("battery") || text.includes("system status")) {
    return { type: "tool", toolName: "system_status", args: {} };
  }
  if (text.includes("vision status") || text.includes("eyes status")) {
    return { type: "tool", toolName: "vision_status", args: {} };
  }
  if (text.includes("what do you see") || text.includes("last observation")) {
    return { type: "tool", toolName: "vision_last_observation", args: {} };
  }
  if (text.startsWith("plan ") || text.includes("agentic plan")) {
    const goal = userText.replace(/^plan\s+/i, "").replace(/agentic plan/i, "").trim() || userText;
    return { type: "tool", toolName: "agentic_plan", args: { goal } };
  }
  if (text.startsWith("execute ") || text.includes("run full plan")) {
    const goal = userText.replace(/^execute\s+/i, "").replace(/run full plan/i, "").trim() || userText;
    return { type: "tool", toolName: "agentic_execute_plan", args: { goal } };
  }
  if (text.includes("list skills") || text.includes("show skills")) {
    return { type: "tool", toolName: "skills_list", args: { limit: 50 } };
  }
  if (text.includes("active skills")) {
    return { type: "tool", toolName: "skills_active", args: {} };
  }
  if (text.startsWith("activate skill ")) {
    return {
      type: "tool",
      toolName: "skills_activate",
      args: { name: userText.replace(/^activate skill\s+/i, "").trim() },
    };
  }
  if (text.startsWith("open ") && text.includes("http")) {
    return {
      type: "tool",
      toolName: "open_url",
      args: { url: text.replace("open ", "").trim() },
    };
  }
  if (text.startsWith("open ")) {
    return {
      type: "tool",
      toolName: "open_app",
      args: { appName: userText.replace(/^open\s+/i, "").trim() },
    };
  }

  const topSkill = context?.skillRouting?.selected;
  if (topSkill && topSkill.score >= 0.34 && ACTION_WORDS.test(userText)) {
    return {
      type: "tool",
      toolName: "agentic_execute_plan",
      args: {
        goal: `Use skill ${topSkill.name} (${topSkill.category}) to handle: ${userText}`,
      },
    };
  }
  return null;
}

function mockReasoning(userText, context = {}) {
  const deterministic = ruleBasedToolReasoning(userText, context);
  if (deterministic) return deterministic;

  const topSkill = context?.skillRouting?.selected;
  if (topSkill && topSkill.score >= 0.34) {
    if (ACTION_WORDS.test(userText)) {
      return {
        type: "tool",
        toolName: "agentic_execute_plan",
        args: {
          goal: `Use skill ${topSkill.name} (${topSkill.category}) to handle: ${userText}`,
        },
      };
    }
    return {
      type: "text",
      content: `Best matched skill: ${topSkill.name} (${topSkill.category}, score ${topSkill.score}). Reason: ${topSkill.reason}.`,
    };
  }

  return {
    type: "text",
    content:
      "Jarvis core is online. I can run tools, route your request to skills, and generate agentic plans.",
  };
}

async function suggestAgenticCommands(goal, context = {}) {
  const g = String(goal || "").trim();
  if (!g) {
    return {
      commands: [],
      source: "empty-goal",
      error: "Goal is required to generate commands.",
    };
  }

  if (config.mode === "mock") {
    return {
      commands: [],
      source: "mock-disabled",
      error: "Planner command generation is disabled in mock mode.",
    };
  }

  const topSkills = (context?.skillRouting?.suggestions || [])
    .slice(0, 3)
    .map((s) => `${s.name}(${s.category})`)
    .join(", ");
  const selectedSkill = context?.selectedSkill
    ? `${context.selectedSkill.name} (${context.selectedSkill.category})`
    : "none";
  const skillGuide = context?.skillContext?.guideSnippet
    ? context.skillContext.guideSnippet.slice(0, 1500)
    : "none";

  const prompt = [
    "You are a local execution planner for Windows PowerShell.",
    "Generate safe, non-destructive commands only. Avoid deletes and admin/security changes.",
    "Return strict JSON only: {\"commands\":[\"cmd1\",\"cmd2\"],\"rationale\":\"...\"}",
    `Workspace root: ${config.workspaceRoot}`,
    `Top skills: ${topSkills || "none"}`,
    `Selected skill: ${selectedSkill}`,
    `Selected skill guidance: ${skillGuide}`,
    `Goal: ${g}`,
  ].join("\n");

  try {
    const raw = await callLocalHttpModel(prompt, {
      format: "json",
      options: { temperature: 0 },
    });
    const parsed = extractJsonObject(raw);
    const commands = Array.isArray(parsed?.commands)
      ? parsed.commands.map((c) => String(c || "").trim()).filter(Boolean)
      : [];
    const safeCommands = sanitizePlannerCommands(commands);

    if (!safeCommands.length) {
      return {
        commands: [],
        source: "local-llm-unsafe-or-empty",
        error: commands.length
          ? "Planner returned unsafe commands only."
          : "Planner returned an empty command list.",
      };
    }

    return {
      commands: safeCommands.slice(0, config.agenticMaxSteps),
      rationale: parsed?.rationale ? String(parsed.rationale) : "",
      source: "local-llm",
    };
  } catch (error) {
    return {
      commands: [],
      source: "local-llm-error",
      error: buildLlmErrorMessage(error),
    };
  }
}

function extractJsonObject(raw) {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      return JSON.parse(fenceMatch[1].trim());
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("No valid JSON object found in model response");
  }
}

function normalizePlan(candidate) {
  const c = candidate || {};
  if (c.type === "text" && typeof c.content === "string" && c.content.trim()) {
    return { type: "text", content: c.content.trim() };
  }
  if (c.type === "tool" && typeof c.toolName === "string") {
    if (!ALLOWED_TOOLS.includes(c.toolName)) {
      throw new Error(`Tool '${c.toolName}' is not allowed`);
    }
    return {
      type: "tool",
      toolName: c.toolName,
      args: isPlainObject(c.args) ? c.args : {},
    };
  }
  throw new Error("Model did not return a valid plan schema");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function buildLlmErrorMessage(error) {
  const detail = String(error?.message || error || "unknown error");
  if (isConnectionLikeError(detail)) {
    return (
      `Connection error: unable to reach local LLM at ${config.localLlmUrl} ` +
      `using model ${config.localLlmModel}. Details: ${detail}`
    );
  }
  return `LLM response error (${config.localLlmModel}): ${detail}`;
}

function isConnectionLikeError(detail) {
  const d = String(detail || "").toLowerCase();
  return (
    d.includes("aborted") ||
    d.includes("failed to fetch") ||
    d.includes("fetch failed") ||
    d.includes("connect") ||
    d.includes("timed out") ||
    d.includes("econnrefused") ||
    d.includes("econnreset") ||
    d.includes("local model error 5")
  );
}

function sanitizePlannerCommands(commands) {
  const blocked = [
    /\brm\s+-rf\b/i,
    /\bremove-item\b.*-recurse/i,
    /\bdel\s+\/[sq]/i,
    /\bformat\b/i,
    /\bshutdown\b/i,
    /\brestart-computer\b/i,
    /\bset-executionpolicy\b/i,
    /\bnet\s+user\b/i,
    /\breg\s+delete\b/i,
    /\bcipher\s+\/w\b/i,
    /\bdisable-/i,
    /\bmountvol\b/i,
    /\btaskkill\b/i,
    /\bsc\s+stop\b/i,
    /\bnew-azdevopsproject\b/i,
  ];
  return commands.filter((cmd) => !blocked.some((re) => re.test(cmd)));
}

function formatRecentConversation(messages) {
  if (!Array.isArray(messages) || !messages.length) return "none";
  return messages
    .map((m) => {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = String(m?.content || "").replace(/\s+/g, " ").trim().slice(0, 220);
      if (!content) return null;
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join(" | ")
    .slice(0, 1400);
}

module.exports = { reason, suggestAgenticCommands };
