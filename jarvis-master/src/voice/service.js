const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { config } = require("../config");

const execFileAsync = promisify(execFile);

class VoiceService {
  constructor({ logger, orchestrator }) {
    this.logger = logger;
    this.orchestrator = orchestrator;
  }

  async speak(text) {
    const t = String(text || "").trim();
    if (!t) return { ok: true, skipped: true, reason: "empty_text" };
    try {
      const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Speak(${toPsSingleQuoted(t)})
Write-Output '{"spoken":true}'
`;
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
        timeout: 15000,
        windowsHide: true,
        maxBuffer: 1024 * 300,
      });
      return { ok: true, spoken: true, text: t };
    } catch (error) {
      return {
        ok: false,
        spoken: false,
        error: String(error.message || error),
        hint: "Verify Windows speech components and speaker permissions; then retry.",
      };
    }
  }

  async listen(timeoutSec = config.voiceListenTimeoutSec) {
    const safeTimeout = Number(timeoutSec) > 0 ? Number(timeoutSec) : config.voiceListenTimeoutSec;
    const script = `
Add-Type -AssemblyName System.Speech
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$rec.SetInputToDefaultAudioDevice()
$grammar = New-Object System.Speech.Recognition.DictationGrammar
$rec.LoadGrammar($grammar)
$res = $rec.Recognize([TimeSpan]::FromSeconds(${safeTimeout}))
if ($null -eq $res) {
  Write-Output '{"text":"","confidence":0}'
} else {
  $out = @{ text = $res.Text; confidence = $res.Confidence } | ConvertTo-Json -Compress
  Write-Output $out
}
`;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
        timeout: (safeTimeout + 6) * 1000,
        windowsHide: true,
        maxBuffer: 1024 * 300,
      });

      const out = String(stdout || "").trim();
      let parsed = { text: "", confidence: 0 };
      try {
        parsed = JSON.parse(out || "{}");
      } catch {
        parsed = { text: out, confidence: 0 };
      }
      return {
        ok: true,
        text: String(parsed.text || "").trim(),
        confidence: Number(parsed.confidence || 0),
        timeoutSec: safeTimeout,
      };
    } catch (error) {
      return {
        ok: false,
        text: "",
        confidence: 0,
        timeoutSec: safeTimeout,
        error: String(error.message || error),
        hint: "Verify microphone permissions and default input device settings.",
      };
    }
  }

  async chatOnce({ timeoutSec, confirmed } = {}) {
    const heard = await this.listen(timeoutSec);
    if (!heard.text) {
      return {
        ok: true,
        heard,
        chat: null,
        spoken: null,
        message: "No speech recognized in timeout window.",
      };
    }
    const chat = await this.orchestrator.handleUserInput(heard.text, { confirmed: confirmed === true });
    let spoken = null;
    if (config.voiceAutoSpeak) {
      const text = chat?.output?.text || chat?.output?.result?.message || "Done.";
      try {
        spoken = await this.speak(text);
      } catch (error) {
        spoken = { ok: false, error: String(error.message || error) };
      }
    }
    return { ok: true, heard, chat, spoken };
  }
}

function toPsSingleQuoted(input) {
  return `'${String(input).replace(/'/g, "''")}'`;
}

module.exports = { VoiceService };
