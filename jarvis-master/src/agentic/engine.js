const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { config } = require("../config");
const { loadSkillContext } = require("../skills/context");
const { routeSkills } = require("../skills/router");
const { enforceCommandPolicy } = require("../safety/policy");

const execFileAsync = promisify(execFile);

class AgenticEngine {
  constructor({ logger, memoryStore, hub, suggestCommandsFn }) {
    this.logger = logger;
    this.memoryStore = memoryStore;
    this.hub = hub;
    this.suggestCommandsFn = suggestCommandsFn;
  }

  createPlan(goal) {
    const g = String(goal || "").trim();
    const steps = [
      `Understand task goal: ${g}`,
      "Inspect current workspace files",
      "Use matched skill guidance and safe commands",
      "Execute only confirmed commands with audit logging",
      "Return summary and next actions",
    ];
    return {
      goal: g,
      steps,
      createdAt: new Date().toISOString(),
      mode: "safe-local-agentic-v2",
    };
  }

  async runCommand(command, options = {}) {
    const cmd = String(command || "").trim();
    if (!cmd) throw new Error("command is required");
    if (!options.confirmed) {
      return {
        requiresConfirmation: true,
        command: cmd,
        message: "Confirmation required before running agentic command.",
      };
    }

    this.assertSafeCommand(cmd);
    enforceCommandPolicy(cmd);

    const cwd = path.resolve(config.workspaceRoot);
    const startedAt = new Date().toISOString();
    try {
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-Command", cmd],
        {
          cwd,
          timeout: config.agenticCommandTimeoutMs,
          windowsHide: true,
          maxBuffer: 1024 * 1024 * 2,
        }
      );

      const result = {
        command: cmd,
        cwd,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      };
      this.memoryStore.addMessage("assistant", `Agentic command executed: ${cmd}`, {
        type: "agentic_command",
        command: cmd,
      });
      this.memoryStore.addAuditEvent({
        eventType: "agentic",
        actor: "jarvis",
        action: "command_execute",
        target: cmd,
        status: "ok",
        details: {
          cwd,
          stdoutPreview: result.stdout.slice(0, 600),
          stderrPreview: result.stderr.slice(0, 600),
        },
      });
      this.hub.broadcast({ type: "agentic_command_result", data: result });
      return { ok: true, result };
    } catch (error) {
      this.memoryStore.addAuditEvent({
        eventType: "agentic",
        actor: "jarvis",
        action: "command_execute",
        target: cmd,
        status: "error",
        details: { error: String(error.message || error) },
      });
      throw error;
    }
  }

  async executePlan(goal, options = {}) {
    const inferredRouting =
      options.context?.skillRouting ||
      routeSkills(goal, {
        skills: this.memoryStore.listSkills({ limit: 300 }),
        activeSkills: this.memoryStore.getActiveSkills(),
        limit: 5,
      });
    const selectedSkill = options.context?.skillRouting?.selected || inferredRouting.selected || null;
    const skillContext = selectedSkill ? loadSkillContext(selectedSkill) : null;
    const plan = this.createPlan(goal);

    const task =
      options.taskId != null
        ? this.memoryStore.getTask(options.taskId) || this.memoryStore.createTask({
            goal,
            skillName: selectedSkill?.name || null,
            status: "planned",
          })
        : this.memoryStore.createTask({
            goal,
            skillName: selectedSkill?.name || null,
            status: "planned",
          });

    this.memoryStore.addTaskRun(task.id, {
      phase: "planning",
      status: "ok",
      payload: {
        plan,
        selectedSkill: selectedSkill ? summarizeSkill(selectedSkill) : null,
      },
    });

    const suggested =
      (await this.suggestCommandsFn?.(goal, {
        ...(options.context || {}),
        skillRouting: inferredRouting,
        selectedSkill,
        skillContext,
      })) || { commands: [], source: "none" };
    const commands = Array.from(
      new Set((suggested.commands || []).map((c) => String(c || "").trim()).filter(Boolean))
    ).slice(0, config.agenticMaxSteps);

    if (!commands.length) {
      const summaryText = suggested.error
        ? `Planner error: ${suggested.error}`
        : "No commands suggested for this goal.";
      const updated = this.memoryStore.updateTask(task.id, {
        status: "blocked",
        summary: summaryText,
      });
      this.memoryStore.addTaskRun(task.id, {
        phase: "execution",
        status: "blocked",
        payload: {
          suggestedBy: suggested.source || "unknown",
          error: suggested.error || null,
        },
      });
      return {
        ok: true,
        result: {
          task: updated,
          plan,
          selectedSkill: selectedSkill ? summarizeSkill(selectedSkill) : null,
          suggestedBy: suggested.source || "unknown",
          commands: [],
          executed: false,
          error: suggested.error || null,
          summary: summaryText,
        },
      };
    }

    if (!options.confirmed) {
      this.memoryStore.addTaskRun(task.id, {
        phase: "execution_preview",
        status: "needs_confirmation",
        payload: { commands, suggestedBy: suggested.source || "unknown" },
      });
      const updated = this.memoryStore.updateTask(task.id, {
        status: "awaiting_confirmation",
        summary: `Waiting confirmation to run ${commands.length} commands`,
      });
      return {
        ok: true,
        result: {
          requiresConfirmation: true,
          task: updated,
          plan,
          selectedSkill: selectedSkill ? summarizeSkill(selectedSkill) : null,
          skillGuideLoaded: Boolean(skillContext),
          suggestedBy: suggested.source || "unknown",
          rationale: suggested.rationale || "",
          commands,
          message: "Confirm to execute this full plan.",
        },
      };
    }

    this.memoryStore.updateTask(task.id, {
      status: "running",
      summary: `Executing ${commands.length} commands`,
    });

    const steps = [];
    let successCount = 0;
    for (const command of commands) {
      try {
        const out = await this.runCommand(command, { confirmed: true });
        const step = { command, ok: true, output: out.result };
        steps.push(step);
        successCount += 1;
        this.memoryStore.addTaskRun(task.id, {
          phase: "command",
          status: "ok",
          payload: { command, outputPreview: out.result.stdout.slice(0, 800) },
        });
      } catch (error) {
        const step = { command, ok: false, error: String(error.message || error) };
        steps.push(step);
        this.memoryStore.addTaskRun(task.id, {
          phase: "command",
          status: "error",
          payload: step,
        });
      }
    }

    const summary = {
      total: commands.length,
      success: successCount,
      failed: commands.length - successCount,
    };
    const status = summary.failed ? "completed_with_errors" : "completed";
    const updatedTask = this.memoryStore.updateTask(task.id, {
      status,
      summary: `Execution finished: ${summary.success}/${summary.total} commands succeeded.`,
    });

    const result = {
      task: updatedTask,
      plan,
      selectedSkill: selectedSkill ? summarizeSkill(selectedSkill) : null,
      skillGuideLoaded: Boolean(skillContext),
      suggestedBy: suggested.source || "unknown",
      rationale: suggested.rationale || "",
      commands,
      executed: true,
      steps,
      summary,
    };

    this.memoryStore.addMessage(
      "assistant",
      `Agentic plan executed for goal: ${goal}. Success ${summary.success}/${summary.total}.`,
      { type: "agentic_execute_plan", goal, summary, taskId: task.id }
    );
    this.memoryStore.addAuditEvent({
      eventType: "agentic",
      actor: "jarvis",
      action: "execute_plan",
      target: String(task.id),
      status: status === "completed" ? "ok" : "warning",
      details: {
        goal,
        selectedSkill: selectedSkill?.name || null,
        summary,
      },
    });
    this.hub.broadcast({ type: "agentic_plan_result", data: result });
    return { ok: true, result };
  }

  assertSafeCommand(command) {
    const blocked = [
      /\brm\s+-rf\b/i,
      /\bRemove-Item\b.*-Recurse/i,
      /\bdel\s+\/[sq]/i,
      /\bformat\b/i,
      /\bshutdown\b/i,
      /\brestart-computer\b/i,
      /\bSet-ExecutionPolicy\b/i,
      /\bnet\s+user\b/i,
      /\breg\s+delete\b/i,
      /\bcipher\s+\/w\b/i,
      /\bDisable-/i,
      /\bsc\s+stop\b/i,
      /\btaskkill\b/i,
      /\bmountvol\b/i,
    ];
    for (const re of blocked) {
      if (re.test(command)) {
        throw new Error(`Blocked unsafe command by policy: ${command}`);
      }
    }
  }
}

function summarizeSkill(skill) {
  return {
    name: skill.name,
    category: skill.category,
    score: skill.score,
    reason: skill.reason,
  };
}

module.exports = { AgenticEngine };
