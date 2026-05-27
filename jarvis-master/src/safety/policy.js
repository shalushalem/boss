const { config } = require("../config");

const trustProfiles = {
  strict: {
    allowedTools: new Set([
      "system_status",
      "vision_status",
      "vision_last_observation",
      "skills_list",
      "skills_active",
      "agentic_plan",
    ]),
    forceConfirmationTools: new Set(["open_app", "open_url"]),
    commandAllowPatterns: [
      /^\s*Get-/i,
      /^\s*dir\b/i,
      /^\s*ls\b/i,
      /^\s*git\s+status\b/i,
      /^\s*git\s+diff\b/i,
      /^\s*npm\.cmd\s+run\s+check\b/i,
      /^\s*type\b/i,
      /^\s*cat\b/i,
    ],
  },
  standard: {
    allowedTools: null,
    forceConfirmationTools: new Set(["open_app", "open_url"]),
    commandAllowPatterns: null,
  },
  admin: {
    allowedTools: null,
    forceConfirmationTools: new Set(["open_app", "open_url"]),
    commandAllowPatterns: null,
  },
};

let runtimeProfile = config.trustMode in trustProfiles ? config.trustMode : "standard";

function getPolicy() {
  return trustProfiles[runtimeProfile];
}

function getTrustProfileName() {
  return runtimeProfile;
}

function setTrustProfileName(next) {
  if (!(next in trustProfiles)) {
    throw new Error(`Unknown trust profile: ${next}`);
  }
  runtimeProfile = next;
  return runtimeProfile;
}

function listTrustProfiles() {
  return Object.keys(trustProfiles);
}

function enforceToolPolicy(toolName, options = {}) {
  const policy = getPolicy();
  if (policy.allowedTools && !policy.allowedTools.has(toolName)) {
    throw new Error(`Tool blocked by ${runtimeProfile} trust profile: ${toolName}`);
  }
  if (policy.forceConfirmationTools.has(toolName) && !options.confirmed) {
    return {
      requiresConfirmation: true,
      toolName,
      message: `Confirmation required by ${runtimeProfile} trust profile.`,
    };
  }
  return null;
}

function enforceCommandPolicy(command) {
  const policy = getPolicy();
  if (policy.commandAllowPatterns) {
    const allowed = policy.commandAllowPatterns.some((re) => re.test(command));
    if (!allowed) {
      throw new Error(`Command blocked by ${runtimeProfile} trust profile: ${command}`);
    }
  }
}

module.exports = {
  enforceToolPolicy,
  enforceCommandPolicy,
  getTrustProfileName,
  setTrustProfileName,
  listTrustProfiles,
};
