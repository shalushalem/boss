const express = require("express");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const { z } = require("zod");
const { config } = require("./config");
const { logger } = require("./logger");
const { MemoryStore } = require("./memory/store");
const { Orchestrator } = require("./orchestrator");
const { RealtimeHub } = require("./realtime/hub");
const { VisionMonitor } = require("./vision/monitor");
const { AgenticEngine } = require("./agentic/engine");
const { ProactiveEngine } = require("./proactive/engine");
const { routeSkills } = require("./skills/router");
const { suggestAgenticCommands } = require("./llm/provider");
const { runDiagnostics } = require("./diagnostics/checks");
const {
  getTrustProfileName,
  listTrustProfiles,
  setTrustProfileName,
} = require("./safety/policy");
const { VoiceService } = require("./voice/service");

function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  const memoryStore = new MemoryStore(logger);
  const httpServer = http.createServer(app);
  const hub = new RealtimeHub(httpServer, logger);
  const visionMonitor = new VisionMonitor({ logger, hub, memoryStore });
  const proactiveEngine = new ProactiveEngine({
    logger,
    hub,
    memoryStore,
    visionMonitor,
  });
  const agenticEngine = new AgenticEngine({
    logger,
    memoryStore,
    hub,
    suggestCommandsFn: suggestAgenticCommands,
  });
  const orchestrator = new Orchestrator({
    memoryStore,
    logger,
    hub,
    visionMonitor,
    agenticEngine,
  });
  const voiceService = new VoiceService({ logger, orchestrator });

  if (config.visionAutoStart) {
    visionMonitor.start();
    logger.info("Vision auto-start enabled");
  }
  if (config.proactiveAutoStart) {
    proactiveEngine.start();
    logger.info("Proactive auto-start enabled");
  }

  if (fs.existsSync(config.externalSkillsIndexPath)) {
    try {
      const imported = memoryStore.importSkillsFromCodexIndex(
        config.externalSkillsIndexPath,
        "claude-skills"
      );
      logger.info({ imported }, "External skills pack imported");
    } catch (error) {
      logger.warn({ err: error }, "Failed to import external skills index");
    }
  }

  app.get("/health", (_, res) => {
    res.json({
      ok: true,
      service: "jarvis-core",
      mode: config.mode,
      trustProfile: getTrustProfileName(),
      visionRunning: visionMonitor.getStatus().running,
      proactiveRunning: proactiveEngine.getStatus().running,
      at: new Date().toISOString(),
    });
  });

  app.get("/state", (_, res) => {
    res.json(memoryStore.getState());
  });

  app.get("/diagnostics", async (_, res) => {
    try {
      const result = await runDiagnostics();
      memoryStore.addAuditEvent({
        eventType: "diagnostics",
        actor: "jarvis",
        action: "run_diagnostics",
        target: "system",
        status: result.summary.ok ? "ok" : "warning",
        details: result.summary,
      });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.post("/chat", async (req, res) => {
    const schema = z.object({
      text: z.string().min(1),
      confirmed: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }

    try {
      const result = await orchestrator.handleUserInput(parsed.data.text, {
        confirmed: parsed.data.confirmed === true,
      });
      res.json({ ok: true, result });
    } catch (error) {
      logger.error({ err: error }, "chat processing failed");
      res.status(500).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.post("/vision/start", (_, res) => {
    const result = visionMonitor.start();
    res.json({ ok: true, result });
  });

  app.post("/vision/stop", (_, res) => {
    const result = visionMonitor.stop();
    res.json({ ok: true, result });
  });

  app.get("/vision/status", (_, res) => {
    res.json({ ok: true, result: visionMonitor.getStatus() });
  });

  app.post("/proactive/start", (_, res) => {
    const result = proactiveEngine.start();
    res.json({ ok: true, result });
  });

  app.post("/proactive/stop", (_, res) => {
    const result = proactiveEngine.stop();
    res.json({ ok: true, result });
  });

  app.get("/proactive/status", (_, res) => {
    res.json({ ok: true, result: proactiveEngine.getStatus() });
  });

  app.post("/proactive/pulse", async (_, res) => {
    try {
      const result = await proactiveEngine.pulse();
      res.json({ ok: true, result });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.post("/skills/import", (req, res) => {
    const schema = z.object({
      indexPath: z.string().optional(),
      sourceTag: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    const indexPath = parsed.data.indexPath || config.externalSkillsIndexPath;
    const sourceTag = parsed.data.sourceTag || "external-codex-pack";
    try {
      const result = memoryStore.importSkillsFromCodexIndex(indexPath, sourceTag);
      res.json({ ok: true, result });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.get("/skills", (req, res) => {
    const querySchema = z.object({
      category: z.string().optional(),
      q: z.string().optional(),
      limit: z.coerce.number().min(1).max(1000).optional(),
      offset: z.coerce.number().min(0).optional(),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    const items = memoryStore.listSkills(parsed.data);
    const summary = memoryStore.getSkillSummary();
    res.json({ ok: true, summary, items });
  });

  app.get("/skills/active", (_, res) => {
    const items = memoryStore.getActiveSkills();
    res.json({ ok: true, items, count: items.length });
  });

  app.post("/skills/route", (req, res) => {
    const schema = z.object({
      text: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    const result = routeSkills(parsed.data.text, {
      skills: memoryStore.listSkills({ limit: 500 }),
      activeSkills: memoryStore.getActiveSkills(),
      limit: parsed.data.limit || 5,
    });
    res.json({ ok: true, result });
  });

  app.get("/skills/:name", (req, res) => {
    const item = memoryStore.getSkill(req.params.name);
    if (!item) {
      res.status(404).json({ ok: false, error: "Skill not found" });
      return;
    }
    res.json({ ok: true, item });
  });

  app.post("/skills/activate", (req, res) => {
    const schema = z.object({ name: z.string().min(1) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    try {
      const item = memoryStore.activateSkill(parsed.data.name);
      res.json({ ok: true, item });
    } catch (error) {
      res.status(404).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.post("/skills/deactivate", (req, res) => {
    const schema = z.object({ name: z.string().min(1) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    const item = memoryStore.deactivateSkill(parsed.data.name);
    res.json({ ok: true, item });
  });

  app.post("/agentic/plan", (req, res) => {
    const schema = z.object({
      goal: z.string().min(3),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    const result = agenticEngine.createPlan(parsed.data.goal);
    res.json({ ok: true, result });
  });

  app.post("/agentic/run", async (req, res) => {
    const schema = z.object({
      command: z.string().min(1),
      confirmed: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    try {
      const result = await agenticEngine.runCommand(parsed.data.command, {
        confirmed: parsed.data.confirmed === true,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.post("/agentic/execute-plan", async (req, res) => {
    const schema = z.object({
      goal: z.string().min(3),
      confirmed: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    try {
      const result = await agenticEngine.executePlan(parsed.data.goal, {
        confirmed: parsed.data.confirmed === true,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.get("/tasks", (req, res) => {
    const schema = z.object({
      status: z.string().optional(),
      limit: z.coerce.number().min(1).max(1000).optional(),
      offset: z.coerce.number().min(0).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    const items = memoryStore.listTasks(parsed.data);
    res.json({ ok: true, items, count: items.length });
  });

  app.get("/tasks/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Invalid task id" });
      return;
    }
    const task = memoryStore.getTask(id);
    if (!task) {
      res.status(404).json({ ok: false, error: "Task not found" });
      return;
    }
    res.json({ ok: true, task });
  });

  app.get("/tasks/:id/runs", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "Invalid task id" });
      return;
    }
    const task = memoryStore.getTask(id);
    if (!task) {
      res.status(404).json({ ok: false, error: "Task not found" });
      return;
    }
    const runs = memoryStore.getTaskRuns(id);
    res.json({ ok: true, task, runs, count: runs.length });
  });

  app.post("/tasks/:id/resume", async (req, res) => {
    const id = Number(req.params.id);
    const schema = z.object({ confirmed: z.boolean().optional() });
    const parsed = schema.safeParse(req.body || {});
    if (!Number.isFinite(id) || !parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid request" });
      return;
    }
    const task = memoryStore.getTask(id);
    if (!task) {
      res.status(404).json({ ok: false, error: "Task not found" });
      return;
    }
    try {
      const result = await agenticEngine.executePlan(task.goal, {
        confirmed: parsed.data.confirmed === true,
        taskId: id,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.get("/audit", (req, res) => {
    const schema = z.object({
      eventType: z.string().optional(),
      limit: z.coerce.number().min(1).max(1000).optional(),
      offset: z.coerce.number().min(0).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    const items = memoryStore.listAuditLogs(parsed.data);
    res.json({ ok: true, items, count: items.length });
  });

  app.get("/safety/profile", (_, res) => {
    res.json({
      ok: true,
      current: getTrustProfileName(),
      available: listTrustProfiles(),
    });
  });

  app.post("/safety/profile", (req, res) => {
    const schema = z.object({ profile: z.string().min(1) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    try {
      const current = setTrustProfileName(parsed.data.profile);
      memoryStore.addAuditEvent({
        eventType: "safety",
        actor: "user",
        action: "set_trust_profile",
        target: current,
        status: "ok",
        details: {},
      });
      res.json({ ok: true, current, available: listTrustProfiles() });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.post("/voice/speak", async (req, res) => {
    const schema = z.object({ text: z.string().min(1) });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    try {
      const result = await voiceService.speak(parsed.data.text);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.post("/voice/listen", async (req, res) => {
    const schema = z.object({ timeoutSec: z.number().positive().max(60).optional() });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    try {
      const result = await voiceService.listen(parsed.data.timeoutSec);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.post("/voice/chat-once", async (req, res) => {
    const schema = z.object({
      timeoutSec: z.number().positive().max(60).optional(),
      confirmed: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.message });
      return;
    }
    try {
      const result = await voiceService.chatOnce(parsed.data);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || error) });
    }
  });

  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({
        ok: false,
        error: "Invalid JSON body",
        hint:
          "In PowerShell, prefer Invoke-RestMethod with ConvertTo-Json for /chat requests.",
      });
      return;
    }
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  });

  return { app, httpServer };
}

module.exports = { createServer };
