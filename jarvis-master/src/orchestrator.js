const { reason } = require("./llm/provider");
const { runTool } = require("./tools/registry");
const { routeSkills } = require("./skills/router");
const { config } = require("./config");
const { loadSkillContext } = require("./skills/context");

class Orchestrator {
  constructor({ memoryStore, logger, hub, visionMonitor, agenticEngine }) {
    this.memoryStore = memoryStore;
    this.logger = logger;
    this.hub = hub;
    this.visionMonitor = visionMonitor;
    this.agenticEngine = agenticEngine;
  }

  async handleUserInput(userText, options = {}) {
    const normalizedText = String(userText || "").trim();
    this.memoryStore.addMessage("user", normalizedText);
    this.memoryStore.addAuditEvent({
      eventType: "chat",
      actor: "user",
      action: "chat_input",
      target: "chat",
      status: "ok",
      details: { text: normalizedText.slice(0, 500) },
    });
    this.hub.broadcast({ type: "user_input", text: normalizedText });

    const skillRouting = routeSkills(normalizedText, {
      skills: this.memoryStore.listSkills({ limit: 300 }),
      activeSkills: this.memoryStore.getActiveSkills(),
      limit: 5,
    });
    if (
      config.autoActivateSkills &&
      skillRouting.selected &&
      !skillRouting.selected.active &&
      skillRouting.selected.score >= config.autoActivateMinScore
    ) {
      try {
        const activated = this.memoryStore.activateSkill(skillRouting.selected.name);
        skillRouting.selected = { ...skillRouting.selected, active: true };
        skillRouting.autoActivated = activated.name;
      } catch (error) {
        this.logger.warn({ err: error }, "Auto activation failed");
      }
    }
    this.hub.broadcast({ type: "skill_routing", data: skillRouting });

    const pendingTask = this.getPendingConfirmationTask();
    if (config.implicitConfirmationEnabled && !options.confirmed && pendingTask) {
      const pendingIntent = classifyPendingTaskIntent(normalizedText);
      if (pendingIntent === "confirm") {
        return this.resumePendingTaskFromConversation(normalizedText, pendingTask);
      }
      if (pendingIntent === "cancel") {
        return this.cancelPendingTaskFromConversation(normalizedText, pendingTask, skillRouting);
      }
    }

    const selectedSkill = skillRouting.selected || null;
    const skillContext = selectedSkill ? loadSkillContext(selectedSkill) : null;
    const visionContext = this.visionMonitor?.getLastObservation?.() || null;
    const recentMessages = this.getConversationContextForLlm();

    const plan = await reason(normalizedText, {
      skillRouting,
      activeSkills: this.memoryStore.getActiveSkills(),
      selectedSkill,
      skillContext,
      visionContext,
      recentMessages,
      pendingTask: pendingTask ? summarizeTaskForContext(pendingTask) : null,
    });
    this.logger.info({ plan }, "Generated plan");
    this.memoryStore.addAuditEvent({
      eventType: "chat",
      actor: "jarvis",
      action: "plan_generated",
      target: plan.type === "tool" ? plan.toolName : "text",
      status: "ok",
      details: { planType: plan.type },
    });

    if (plan.type === "tool") {
      let toolOutput;
      try {
        toolOutput = await runTool(plan.toolName, plan.args, {
          ...options,
          visionMonitor: this.visionMonitor,
          agenticEngine: this.agenticEngine,
          memoryStore: this.memoryStore,
          context: {
            skillRouting,
            activeSkills: this.memoryStore.getActiveSkills(),
            selectedSkill,
            skillContext,
            visionContext,
          },
        });
      } catch (error) {
        this.memoryStore.addAuditEvent({
          eventType: "tool",
          actor: "jarvis",
          action: "run_tool",
          target: plan.toolName,
          status: "error",
          details: { error: String(error.message || error) },
        });
        throw error;
      }
      this.memoryStore.addMessage("assistant", JSON.stringify(toolOutput), {
        type: "tool_result",
        toolName: plan.toolName,
      });
      this.hub.broadcast({ type: "tool_result", toolName: plan.toolName, data: toolOutput });
      return {
        mode: "tool",
        plan,
        output: toolOutput,
        routing: skillRouting,
      };
    }

    const responseText = plan.content || "I did not understand that yet.";
    this.memoryStore.addMessage("assistant", responseText, { type: "text" });
    this.hub.broadcast({ type: "assistant_text", text: responseText });
    return {
      mode: "text",
      output: { text: responseText },
      routing: skillRouting,
    };
  }

  getPendingConfirmationTask() {
    const pending = this.memoryStore.listTasks({ status: "awaiting_confirmation", limit: 1 });
    return pending[0] || null;
  }

  getConversationContextForLlm() {
    const maxMessages = Math.max(2, config.conversationContextMessages);
    const maxChars = Math.max(100, config.conversationContextChars);
    const recent = this.memoryStore.getRecent(Math.max(maxMessages * 3, maxMessages + 6));
    return recent
      .filter((item) => item.role === "user" || item.role === "assistant")
      .filter((item) => item.meta?.type !== "tool_result")
      .map((item) => ({
        role: item.role,
        content: clampText(item.content, maxChars),
        createdAt: item.createdAt,
      }))
      .slice(-maxMessages);
  }

  async resumePendingTaskFromConversation(userText, pendingTask) {
    const activeSkills = this.memoryStore.getActiveSkills();
    const skillRouting = routeSkills(pendingTask.goal, {
      skills: this.memoryStore.listSkills({ limit: 300 }),
      activeSkills,
      limit: 5,
    });
    const selectedSkill = skillRouting.selected || null;
    const skillContext = selectedSkill ? loadSkillContext(selectedSkill) : null;
    const visionContext = this.visionMonitor?.getLastObservation?.() || null;

    try {
      const toolOutput = await this.agenticEngine.executePlan(pendingTask.goal, {
        confirmed: true,
        taskId: pendingTask.id,
        context: {
          skillRouting,
          activeSkills,
          selectedSkill,
          skillContext,
          visionContext,
        },
      });

      this.memoryStore.addAuditEvent({
        eventType: "chat",
        actor: "jarvis",
        action: "implicit_task_resume",
        target: String(pendingTask.id),
        status: "ok",
        details: { userText: clampText(userText, 160) },
      });
      this.memoryStore.addMessage("assistant", JSON.stringify(toolOutput), {
        type: "tool_result",
        toolName: "agentic_execute_plan",
        taskId: pendingTask.id,
        implicitConfirmation: true,
      });
      this.hub.broadcast({
        type: "tool_result",
        toolName: "agentic_execute_plan",
        data: toolOutput,
        implicitConfirmation: true,
      });

      return {
        mode: "tool",
        plan: {
          type: "tool",
          toolName: "agentic_execute_plan",
          args: {
            goal: pendingTask.goal,
            taskId: pendingTask.id,
            confirmed: true,
            implicitConfirmation: true,
          },
        },
        output: toolOutput,
        routing: skillRouting,
        implicitConfirmation: true,
      };
    } catch (error) {
      const text = `I could not resume task #${pendingTask.id}. ${String(
        error.message || error
      )}`;
      this.memoryStore.addAuditEvent({
        eventType: "chat",
        actor: "jarvis",
        action: "implicit_task_resume",
        target: String(pendingTask.id),
        status: "error",
        details: { error: String(error.message || error) },
      });
      this.memoryStore.addMessage("assistant", text, {
        type: "text",
        implicitConfirmation: true,
      });
      this.hub.broadcast({ type: "assistant_text", text });
      return {
        mode: "text",
        output: { text },
        routing: skillRouting,
        implicitConfirmation: true,
      };
    }
  }

  cancelPendingTaskFromConversation(userText, pendingTask, skillRouting) {
    const updatedTask = this.memoryStore.updateTask(pendingTask.id, {
      status: "cancelled",
      summary: "Cancelled by user conversational response.",
    });
    const text = `Cancelled pending task #${pendingTask.id}.`;
    this.memoryStore.addAuditEvent({
      eventType: "chat",
      actor: "jarvis",
      action: "implicit_task_cancel",
      target: String(pendingTask.id),
      status: "ok",
      details: { userText: clampText(userText, 160) },
    });
    this.memoryStore.addMessage("assistant", text, {
      type: "text",
      cancelledTaskId: pendingTask.id,
    });
    this.hub.broadcast({ type: "assistant_text", text, source: "orchestrator" });
    return {
      mode: "text",
      output: { text, task: updatedTask },
      routing: skillRouting,
      implicitCancellation: true,
    };
  }
}

module.exports = { Orchestrator };

function summarizeTaskForContext(task) {
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    updatedAt: task.updatedAt,
  };
}

function classifyPendingTaskIntent(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;

  const confirmPatterns = [
    /\byes\b/i,
    /\byeah\b/i,
    /\byep\b/i,
    /\bsure\b/i,
    /\bokay?\b/i,
    /\bconfirm(?:ed)?\b/i,
    /\bgo ahead\b/i,
    /\bproceed\b/i,
    /\bcontinue\b/i,
    /\bdo it\b/i,
    /\brun it\b/i,
    /\bresume\b/i,
  ];
  if (confirmPatterns.some((re) => re.test(t))) {
    return "confirm";
  }

  const cancelPatterns = [
    /^no$/i,
    /\bcancel(?: task)?\b/i,
    /\bstop\b/i,
    /\babort\b/i,
    /\bdo not\b/i,
    /\bdon't\b/i,
    /\bskip\b/i,
  ];
  if (cancelPatterns.some((re) => re.test(t))) {
    return "cancel";
  }

  return null;
}

function clampText(input, maxChars) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}
