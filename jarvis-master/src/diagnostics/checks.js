const fs = require("fs");
const path = require("path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const screenshot = require("screenshot-desktop");
const { config } = require("../config");

const execFileAsync = promisify(execFile);

async function runDiagnostics() {
  const startedAt = new Date().toISOString();
  const checks = {};

  checks.database = checkDatabasePath(config.dbPath);
  checks.workspace = checkWorkspace(config.workspaceRoot);
  checks.skillsIndex = checkPathExists(config.externalSkillsIndexPath);
  checks.localLlm = await checkLocalLlm(config.localLlmUrl, config.localLlmModel);
  checks.voice = await checkVoiceCapability();
  checks.vision = await checkVisionCapability();

  const summary = summarize(checks);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    summary,
    checks,
  };
}

function checkDatabasePath(dbPath) {
  try {
    const abs = path.resolve(dbPath);
    const dir = path.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    const writableProbe = path.join(dir, ".jarvis_write_probe.tmp");
    fs.writeFileSync(writableProbe, "ok", "utf8");
    fs.unlinkSync(writableProbe);
    return { ok: true, path: abs };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function checkWorkspace(workspaceRoot) {
  try {
    const abs = path.resolve(workspaceRoot);
    const stat = fs.statSync(abs);
    return { ok: stat.isDirectory(), path: abs };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function checkPathExists(target) {
  try {
    const abs = path.resolve(target);
    const exists = fs.existsSync(abs);
    return { ok: exists, path: abs, exists };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

async function checkLocalLlm(url, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.localLlmHealthTimeoutMs);
  try {
    const base = new URL(url);
    const tagsUrl = new URL("/api/tags", base).toString();

    const tagsRes = await fetch(tagsUrl, { method: "GET", signal: controller.signal });
    if (!tagsRes.ok) {
      const body = await tagsRes.text();
      return {
        ok: false,
        status: tagsRes.status,
        url,
        model,
        preview: body.slice(0, 200),
        hint: "Ollama service is reachable but tags endpoint returned non-OK.",
      };
    }

    const tagsJson = await tagsRes.json();
    const models = Array.isArray(tagsJson?.models) ? tagsJson.models : [];
    const names = models.map((m) => String(m?.name || ""));
    const hasModel = names.some((name) => name === model || name.startsWith(`${model}:`));
    if (hasModel) {
      return {
        ok: true,
        status: 200,
        url,
        model,
        modelFound: true,
      };
    }

    return {
      ok: false,
      status: 404,
      url,
      model,
      modelFound: false,
      preview: `Available models: ${names.slice(0, 12).join(", ")}`,
      hint: `Model '${model}' not found in Ollama tags list. Pull it or update LOCAL_LLM_MODEL.`,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      model,
      error: String(error.message || error),
      hint: "Start Ollama service and ensure localhost:11434 is reachable, then retry diagnostics.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkVoiceCapability() {
  const script = `
try {
  Add-Type -AssemblyName System.Speech
  $out = @{ ok = $true; error = $null } | ConvertTo-Json -Compress
  Write-Output $out
} catch {
  $out = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  Write-Output $out
}
`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 200,
    });
    const text = String(stdout || "").trim();
    try {
      const parsed = JSON.parse(text);
      return {
        ok: Boolean(parsed.ok),
        detail: parsed.error || "System.Speech available",
      };
    } catch {
      return { ok: false, detail: text || "Unknown voice capability response" };
    }
  } catch (error) {
    return {
      ok: false,
      detail: String(error.message || error),
      hint: "If this is a permission error, run outside sandbox and ensure mic/speech permissions are enabled.",
    };
  }
}

async function checkVisionCapability() {
  try {
    const displays = await screenshot.listDisplays();
    return {
      ok: Array.isArray(displays),
      displayCount: Array.isArray(displays) ? displays.length : 0,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error.message || error),
      hint: "Allow screen-capture permissions on Windows and run outside sandbox restrictions.",
    };
  }
}

function summarize(checks) {
  const names = Object.keys(checks);
  const okCount = names.filter((name) => checks[name]?.ok).length;
  return {
    ok: okCount === names.length,
    okCount,
    total: names.length,
    failed: names.filter((name) => !checks[name]?.ok),
  };
}

module.exports = { runDiagnostics };
