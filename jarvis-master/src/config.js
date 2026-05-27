const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const config = {
  port: Number(process.env.PORT || 7070),
  mode: process.env.JARVIS_MODE || "local",
  localLlmUrl: process.env.LOCAL_LLM_URL || "http://127.0.0.1:11434/api/generate",
  localLlmModel: process.env.LOCAL_LLM_MODEL || "llama3.1:8b",
  localLlmTimeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS || 25000),
  localLlmRetries: Number(process.env.LOCAL_LLM_RETRIES || 2),
  localLlmHealthTimeoutMs: Number(process.env.LOCAL_LLM_HEALTH_TIMEOUT_MS || 12000),
  jarvisName: process.env.JARVIS_NAME || "Jarvis",
  dataDir: process.env.DATA_DIR || path.resolve(process.cwd(), "data"),
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), "data", "jarvis.db"),
  visionIntervalMs: Number(process.env.VISION_INTERVAL_MS || 4000),
  visionAutoStart: String(process.env.VISION_AUTO_START || "false").toLowerCase() === "true",
  visionChangeThreshold: Number(process.env.VISION_CHANGE_THRESHOLD || 0.08),
  workspaceRoot: process.env.WORKSPACE_ROOT || process.cwd(),
  agenticCommandTimeoutMs: Number(process.env.AGENTIC_COMMAND_TIMEOUT_MS || 20000),
  externalSkillsIndexPath:
    process.env.EXTERNAL_SKILLS_INDEX_PATH ||
    path.resolve(process.cwd(), "external", "claude-skills", ".codex", "skills-index.json"),
  autoActivateSkills:
    String(process.env.AUTO_ACTIVATE_SKILLS || "true").toLowerCase() === "true",
  autoActivateMinScore: Number(process.env.AUTO_ACTIVATE_MIN_SCORE || 0.45),
  agenticMaxSteps: Number(process.env.AGENTIC_MAX_STEPS || 4),
  trustMode: process.env.TRUST_MODE || "standard",
  voiceAutoSpeak: String(process.env.VOICE_AUTO_SPEAK || "false").toLowerCase() === "true",
  voiceListenTimeoutSec: Number(process.env.VOICE_LISTEN_TIMEOUT_SEC || 8),
  visionEnableOcr: String(process.env.VISION_ENABLE_OCR || "true").toLowerCase() === "true",
  visionOcrEveryNFrames: Number(process.env.VISION_OCR_EVERY_N_FRAMES || 4),
  conversationContextMessages: Number(process.env.CONVERSATION_CONTEXT_MESSAGES || 12),
  conversationContextChars: Number(process.env.CONVERSATION_CONTEXT_CHARS || 220),
  implicitConfirmationEnabled:
    String(process.env.IMPLICIT_CONFIRMATION_ENABLED || "true").toLowerCase() === "true",
  proactiveEnabled: String(process.env.PROACTIVE_ENABLED || "true").toLowerCase() === "true",
  proactiveAutoStart: String(process.env.PROACTIVE_AUTO_START || "false").toLowerCase() === "true",
  proactiveIntervalMs: Number(process.env.PROACTIVE_INTERVAL_MS || 12000),
  proactiveReminderCooldownMs: Number(process.env.PROACTIVE_REMINDER_COOLDOWN_MS || 60000),
  proactivePendingReminderMinAgeMs: Number(
    process.env.PROACTIVE_PENDING_REMINDER_MIN_AGE_MS || 45000
  ),
  proactiveVisionCooldownMs: Number(process.env.PROACTIVE_VISION_COOLDOWN_MS || 90000),
};

module.exports = { config };
