const os = require("os");
const { exec } = require("child_process");

function getSystemStatus() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    uptimeSeconds: os.uptime(),
    totalMemoryGb: +(os.totalmem() / 1024 ** 3).toFixed(2),
    freeMemoryGb: +(os.freemem() / 1024 ** 3).toFixed(2),
    cpuModel: cpus[0]?.model || "unknown",
    cpuCores: cpus.length,
  };
}

function openUrl(url) {
  return new Promise((resolve, reject) => {
    const sanitized = String(url || "").trim();
    if (!/^https?:\/\//i.test(sanitized)) {
      reject(new Error("URL must start with http:// or https://"));
      return;
    }
    exec(`start "" "${sanitized}"`, { shell: "cmd.exe" }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ opened: sanitized });
    });
  });
}

function openApp(appName) {
  return new Promise((resolve, reject) => {
    const sanitized = String(appName || "").trim();
    if (!sanitized) {
      reject(new Error("appName is required"));
      return;
    }
    exec(`start "" "${sanitized}"`, { shell: "cmd.exe" }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ launched: sanitized });
    });
  });
}

module.exports = { getSystemStatus, openUrl, openApp };
