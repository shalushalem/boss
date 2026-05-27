const { config } = require("../config");

const SCREEN_ISSUE_PATTERNS = [
  { label: "error", re: /\berror\b/i },
  { label: "exception", re: /\bexception\b/i },
  { label: "failure", re: /\bfailed|failure\b/i },
  { label: "timeout", re: /\btimeout|timed out\b/i },
  { label: "access issue", re: /\baccess denied|permission denied|unauthorized\b/i },
  { label: "missing dependency", re: /\bnot found|missing\b/i },
];

class ProactiveEngine {
  constructor({ logger, hub, memoryStore, visionMonitor }) {
    this.logger = logger;
    this.hub = hub;
    this.memoryStore = memoryStore;
    this.visionMonitor = visionMonitor;

    this.timer = null;
    this.startedAt = null;
    this.lastPulseAt = null;
    this.lastError = null;
    this.pulseCount = 0;
    this.nudgeCount = 0;
    this.lastEmitByKey = new Map();
  }

  start() {
    if (!config.proactiveEnabled) {
      return {
        ok: true,
        started: false,
        disabled: true,
        status: this.getStatus(),
      };
    }
    if (this.timer) {
      return { ok: true, alreadyRunning: true, status: this.getStatus() };
    }

    this.startedAt = new Date().toISOString();
    this.timer = setInterval(() => {
      this.pulse().catch((error) => {
        this.lastError = String(error.message || error);
        this.logger.warn({ err: error }, "proactive pulse failed");
      });
    }, Math.max(3000, config.proactiveIntervalMs));

    return { ok: true, started: true, status: this.getStatus() };
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return { ok: true, stopped: true, status: this.getStatus() };
  }

  getStatus() {
    return {
      enabled: config.proactiveEnabled,
      running: Boolean(this.timer),
      startedAt: this.startedAt,
      intervalMs: Math.max(3000, config.proactiveIntervalMs),
      lastPulseAt: this.lastPulseAt,
      pulseCount: this.pulseCount,
      nudgeCount: this.nudgeCount,
      lastError: this.lastError,
    };
  }

  async pulse() {
    if (!config.proactiveEnabled) {
      return { ok: true, skipped: true, reason: "disabled" };
    }

    this.lastPulseAt = new Date().toISOString();
    this.pulseCount += 1;

    const nudges = [];
    const pendingTaskNudge = this.buildPendingTaskNudge();
    if (pendingTaskNudge) nudges.push(pendingTaskNudge);

    const screenIssueNudge = this.buildScreenIssueNudge();
    if (screenIssueNudge) nudges.push(screenIssueNudge);

    for (const nudge of nudges) this.emitNudge(nudge);
    return { ok: true, nudges, count: nudges.length };
  }

  buildPendingTaskNudge() {
    const pending = this.memoryStore.listTasks({ status: "awaiting_confirmation", limit: 1 })[0];
    if (!pending) return null;

    const ageMs = Date.now() - Date.parse(pending.updatedAt || pending.createdAt || 0);
    if (!Number.isFinite(ageMs) || ageMs < config.proactivePendingReminderMinAgeMs) {
      return null;
    }

    const dedupeKey = `pending-task-${pending.id}`;
    if (!this.shouldEmit(dedupeKey, config.proactiveReminderCooldownMs)) return null;

    const ageSec = Math.round(ageMs / 1000);
    return {
      type: "pending_task_confirmation",
      text: `Proactive: task #${pending.id} is waiting for confirmation for ${ageSec}s. Say "yes" to continue or "cancel task" to stop it.`,
      details: {
        taskId: pending.id,
        ageSec,
      },
    };
  }

  buildScreenIssueNudge() {
    const observation = this.visionMonitor?.getLastObservation?.();
    if (!observation?.at) return null;

    const ageMs = Date.now() - Date.parse(observation.at);
    if (!Number.isFinite(ageMs) || ageMs > 90000) return null;

    const screenText = `${observation.sceneHint || ""} ${observation.ocrText || ""}`.trim();
    if (!screenText) return null;

    const matched = SCREEN_ISSUE_PATTERNS.find((p) => p.re.test(screenText));
    if (!matched) return null;

    const appName = observation.activeWindow?.processName || "current app";
    const signature = `${appName}:${String(screenText).slice(0, 120).toLowerCase()}`;
    const dedupeKey = `screen-issue-${hash(signature)}`;
    if (!this.shouldEmit(dedupeKey, config.proactiveVisionCooldownMs)) return null;

    return {
      type: "screen_issue_detected",
      text: `Proactive: I noticed a possible ${matched.label} on your screen in ${appName}. Want me to run a quick diagnosis plan?`,
      details: {
        appName,
        hint: matched.label,
        observedAt: observation.at,
      },
    };
  }

  shouldEmit(key, cooldownMs) {
    const now = Date.now();
    const last = this.lastEmitByKey.get(key) || 0;
    if (now - last < Math.max(1000, Number(cooldownMs || 0))) {
      return false;
    }
    this.lastEmitByKey.set(key, now);
    return true;
  }

  emitNudge(nudge) {
    this.nudgeCount += 1;
    this.memoryStore.addMessage("assistant", nudge.text, {
      type: "proactive_nudge",
      nudgeType: nudge.type,
      details: nudge.details || {},
    });
    this.memoryStore.addAuditEvent({
      eventType: "proactive",
      actor: "jarvis",
      action: "nudge",
      target: nudge.type,
      status: "ok",
      details: nudge.details || {},
    });
    this.hub.broadcast({
      type: "proactive_nudge",
      data: {
        at: new Date().toISOString(),
        ...nudge,
      },
    });
  }
}

function hash(input) {
  const str = String(input || "");
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

module.exports = { ProactiveEngine };
