const screenshot = require("screenshot-desktop");
const { PNG } = require("pngjs");
const { createWorker } = require("tesseract.js");
const { config } = require("../config");
const { getActiveWindowInfo } = require("./active-window");

class VisionMonitor {
  constructor({ logger, hub, memoryStore }) {
    this.logger = logger;
    this.hub = hub;
    this.memoryStore = memoryStore;
    this.intervalMs = config.visionIntervalMs;
    this.changeThreshold = config.visionChangeThreshold;

    this.timer = null;
    this.isCapturing = false;
    this.startedAt = null;
    this.frameCount = 0;
    this.lastError = null;
    this.lastObservation = null;
    this.lastVector = null;
    this.lastInsightAt = 0;
    this.lastOcrAt = null;
    this.ocrEnabled = config.visionEnableOcr;
    this.ocrWorkerPromise = null;
    this.ocrFailureCount = 0;
  }

  start() {
    if (this.timer) {
      return { ok: true, alreadyRunning: true, status: this.getStatus() };
    }
    this.startedAt = new Date().toISOString();
    this.timer = setInterval(() => {
      this.captureOnce().catch((error) => {
        this.lastError = String(error.message || error);
        this.logger.warn({ err: error }, "vision capture failed");
      });
    }, this.intervalMs);
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
      running: Boolean(this.timer),
      startedAt: this.startedAt,
      frameCount: this.frameCount,
      intervalMs: this.intervalMs,
      changeThreshold: this.changeThreshold,
      ocrEnabled: this.ocrEnabled,
      lastOcrAt: this.lastOcrAt,
      lastError: this.lastError,
      lastObservation: this.lastObservation,
    };
  }

  getLastObservation() {
    return this.lastObservation;
  }

  async captureOnce() {
    if (this.isCapturing) return;
    this.isCapturing = true;
    try {
      const img = await screenshot({ format: "png" });
      const png = PNG.sync.read(img);
      const vector = sampleLumaVector(png, 48, 27);
      const summary = summarizeVector(vector);

      let changeScore = 0;
      if (this.lastVector) {
        changeScore = compareVectors(this.lastVector, vector);
      }
      this.lastVector = vector;
      this.frameCount += 1;

      const now = Date.now();
      const changed = changeScore >= this.changeThreshold;
      const activeWindow = await safeActiveWindow(this.logger);
      const ocrText = await this.maybeRunOcr(img);
      const sceneHint = buildSceneHint(summary.sceneHint, activeWindow, ocrText);

      const observation = {
        at: new Date().toISOString(),
        changed,
        changeScore: round(changeScore),
        brightness: summary.brightness,
        contrast: summary.contrast,
        sceneHint,
        activeWindow,
        ocrText,
      };
      this.lastObservation = observation;
      this.hub.broadcast({ type: "vision_observation", data: observation });

      if (changed && now - this.lastInsightAt > 12000) {
        this.lastInsightAt = now;
        const insightText = `Vision update: ${sceneHint} (change ${Math.round(
          observation.changeScore * 100
        )}%).`;
        this.memoryStore.addMessage("assistant", insightText, { type: "vision", observation });
        this.hub.broadcast({ type: "assistant_text", text: insightText, source: "vision" });
      }
    } finally {
      this.isCapturing = false;
    }
  }

  async maybeRunOcr(imageBuffer) {
    if (!this.ocrEnabled) return "";
    if (this.frameCount % Math.max(1, config.visionOcrEveryNFrames) !== 0) {
      return this.lastObservation?.ocrText || "";
    }
    try {
      const worker = await this.getOcrWorker();
      const out = await withTimeout(worker.recognize(imageBuffer), 7000, "OCR timeout");
      const text = String(out?.data?.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 260);
      this.lastOcrAt = new Date().toISOString();
      this.ocrFailureCount = 0;
      return text;
    } catch (error) {
      this.ocrFailureCount += 1;
      this.lastError = `OCR failed: ${String(error.message || error)}`;
      this.logger.warn({ err: error }, "vision ocr failed");
      if (this.ocrFailureCount >= 3) {
        this.ocrEnabled = false;
        this.logger.warn("OCR auto-disabled after repeated failures");
      }
      return this.lastObservation?.ocrText || "";
    }
  }

  async getOcrWorker() {
    if (!this.ocrWorkerPromise) {
      this.ocrWorkerPromise = (async () => {
        const worker = await createWorker("eng");
        return worker;
      })();
    }
    return this.ocrWorkerPromise;
  }
}

async function safeActiveWindow(logger) {
  try {
    return (await getActiveWindowInfo()) || null;
  } catch (error) {
    logger?.warn?.({ err: error }, "active window fetch failed");
    return null;
  }
}

function buildSceneHint(base, activeWindow, ocrText) {
  const app = activeWindow?.processName ? `${activeWindow.processName}` : "";
  const ocr = ocrText ? ` Text visible: ${ocrText.slice(0, 80)}.` : "";
  if (app) {
    return `${base}. Active app: ${app}.${ocr}`;
  }
  return `${base}.${ocr}`;
}

function sampleLumaVector(png, sampleX, sampleY) {
  const { width, height, data } = png;
  const vector = [];
  for (let gy = 0; gy < sampleY; gy += 1) {
    for (let gx = 0; gx < sampleX; gx += 1) {
      const x = Math.min(width - 1, Math.floor((gx / (sampleX - 1)) * (width - 1)));
      const y = Math.min(height - 1, Math.floor((gy / (sampleY - 1)) * (height - 1)));
      const idx = (width * y + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      vector.push(luma / 255);
    }
  }
  return vector;
}

function summarizeVector(vector) {
  const mean = vector.reduce((a, b) => a + b, 0) / vector.length;
  let variance = 0;
  for (const v of vector) variance += (v - mean) ** 2;
  variance /= vector.length;
  const std = Math.sqrt(variance);

  let sceneHint = "screen looks stable";
  if (mean < 0.2) sceneHint = "very dark screen content";
  else if (mean > 0.8) sceneHint = "very bright screen content";
  else if (std > 0.28) sceneHint = "highly detailed or busy screen";
  else if (std < 0.1) sceneHint = "flat or low-detail screen";

  return {
    brightness: round(mean),
    contrast: round(std),
    sceneHint,
  };
}

function compareVectors(prev, next) {
  const len = Math.min(prev.length, next.length);
  if (len === 0) return 0;
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += Math.abs(prev[i] - next[i]);
  return sum / len;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

module.exports = { VisionMonitor };
