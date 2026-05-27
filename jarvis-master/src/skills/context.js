const fs = require("fs");

const cache = new Map();

function loadSkillContext(skill, maxChars = 4000) {
  if (!skill?.skillMdPath) return null;
  const key = `${skill.name}:${skill.skillMdPath}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const raw = fs.readFileSync(skill.skillMdPath, "utf8");
    const condensed = raw.slice(0, maxChars);
    const context = {
      name: skill.name,
      category: skill.category,
      description: skill.description,
      skillMdPath: skill.skillMdPath,
      guideSnippet: condensed,
    };
    cache.set(key, context);
    return context;
  } catch {
    return null;
  }
}

module.exports = { loadSkillContext };
