const { z } = require("zod");
const { getSystemStatus, openUrl, openApp } = require("./system");
const { enforceToolPolicy } = require("../safety/policy");

const toolSchemas = {
  system_status: z.object({}),
  open_url: z.object({
    url: z.string().min(8),
  }),
  open_app: z.object({
    appName: z.string().min(1),
  }),
  vision_status: z.object({}),
  vision_last_observation: z.object({}),
  agentic_plan: z.object({
    goal: z.string().min(3),
  }),
  agentic_execute_plan: z.object({
    goal: z.string().min(3),
  }),
  skills_list: z.object({
    category: z.string().optional(),
    q: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  skills_activate: z.object({
    name: z.string().min(1),
  }),
  skills_active: z.object({}),
};

const dangerousTools = new Set(["open_url", "open_app"]);

async function runTool(toolName, args = {}, options = {}) {
  const schema = toolSchemas[toolName];
  if (!schema) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid tool args for ${toolName}: ${parsed.error.message}`);
  }

  const policyGate = enforceToolPolicy(toolName, options);
  if (policyGate) {
    return {
      ...policyGate,
      args: parsed.data,
    };
  }

  const requiresConfirmation = dangerousTools.has(toolName);
  if (requiresConfirmation && !options.confirmed) {
    return {
      requiresConfirmation: true,
      toolName,
      args: parsed.data,
      message: `Confirmation required before running ${toolName}.`,
    };
  }

  if (toolName === "system_status") {
    const result = { ok: true, result: getSystemStatus() };
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data },
    });
    return result;
  }
  if (toolName === "open_url") {
    const result = await openUrl(parsed.data.url);
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data },
    });
    return { ok: true, result };
  }
  if (toolName === "open_app") {
    const result = await openApp(parsed.data.appName);
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data },
    });
    return { ok: true, result };
  }
  if (toolName === "vision_status") {
    if (!options.visionMonitor) {
      throw new Error("Vision monitor not available");
    }
    const result = { ok: true, result: options.visionMonitor.getStatus() };
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data },
    });
    return result;
  }
  if (toolName === "vision_last_observation") {
    if (!options.visionMonitor) {
      throw new Error("Vision monitor not available");
    }
    const result = { ok: true, result: options.visionMonitor.getLastObservation() };
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data },
    });
    return result;
  }
  if (toolName === "agentic_plan") {
    if (!options.agenticEngine) {
      throw new Error("Agentic engine not available");
    }
    const result = { ok: true, result: options.agenticEngine.createPlan(parsed.data.goal) };
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data },
    });
    return result;
  }
  if (toolName === "agentic_execute_plan") {
    if (!options.agenticEngine) {
      throw new Error("Agentic engine not available");
    }
    return options.agenticEngine.executePlan(parsed.data.goal, {
      confirmed: options.confirmed === true,
      context: options.context || {},
    });
  }
  if (toolName === "skills_list") {
    if (!options.memoryStore) {
      throw new Error("Memory store not available");
    }
    const items = options.memoryStore.listSkills(parsed.data || {});
    const result = { ok: true, result: { count: items.length, items } };
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data, count: items.length },
    });
    return result;
  }
  if (toolName === "skills_activate") {
    if (!options.memoryStore) {
      throw new Error("Memory store not available");
    }
    const item = options.memoryStore.activateSkill(parsed.data.name);
    const result = { ok: true, result: item };
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data },
    });
    return result;
  }
  if (toolName === "skills_active") {
    if (!options.memoryStore) {
      throw new Error("Memory store not available");
    }
    const items = options.memoryStore.getActiveSkills();
    const result = { ok: true, result: { count: items.length, items } };
    options.memoryStore?.addAuditEvent({
      eventType: "tool",
      actor: "jarvis",
      action: "run_tool",
      target: toolName,
      status: "ok",
      details: { args: parsed.data, count: items.length },
    });
    return result;
  }

  throw new Error(`Unsupported tool: ${toolName}`);
}

module.exports = { runTool, toolSchemas };
