const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "from",
  "is",
  "are",
  "be",
  "do",
  "does",
  "me",
  "my",
  "you",
  "it",
  "this",
  "that",
  "please",
  "can",
  "could",
  "should",
  "would",
  "i",
  "we",
  "us",
  "our",
  "jarvis",
]);

function routeSkills(userText, { skills = [], activeSkills = [], limit = 5 } = {}) {
  const text = String(userText || "").trim();
  const terms = tokenize(text);
  const activeSet = new Set(activeSkills.map((s) => s.name));
  const intent = inferIntent(text);

  const scored = skills
    .map((skill) => {
      const tokens = tokenize([skill.name, skill.category, skill.description].join(" "));
      const overlap = jaccard(terms, tokens);
      const phrase = phraseBoost(text, skill);
      const activeBoost = activeSet.has(skill.name) ? 0.04 : 0;
      const intentBoost = intentBoostForSkill(intent, skill);
      const score = clamp(overlap * 0.68 + phrase * 0.24 + activeBoost + intentBoost, 0, 1);
      return {
        ...skill,
        score: round(score),
        reason: buildReason({ overlap, phrase, activeBoost, intentBoost }),
      };
    })
    .filter((s) => s.score > 0.09)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    intent,
    terms,
    suggestions: scored,
    selected: scored[0] || null,
  };
}

function inferIntent(text) {
  const t = text.toLowerCase();
  if (/\b(code|build|implement|debug|refactor|api|backend|frontend|deploy)\b/.test(t)) {
    return "engineering";
  }
  if (/\b(marketing|seo|campaign|ads|copy|content)\b/.test(t)) {
    return "marketing";
  }
  if (/\b(roadmap|product|feature|ux|ui|research)\b/.test(t)) {
    return "product";
  }
  if (/\b(board|ceo|cto|cfo|strategy|fundraising)\b/.test(t)) {
    return "c-level";
  }
  if (/\b(jira|confluence|sprint|project|scrum)\b/.test(t)) {
    return "project-management";
  }
  if (/\b(regulatory|iso|gdpr|soc2|fda|medical)\b/.test(t)) {
    return "ra-qm";
  }
  return "general";
}

function intentBoostForSkill(intent, skill) {
  if (intent === "general") return 0;
  const cat = String(skill.category || "");
  if (cat === intent) return 0.12;
  if (intent === "engineering" && cat === "engineering-advanced") return 0.08;
  return 0;
}

function buildReason({ overlap, phrase, activeBoost, intentBoost }) {
  const parts = [];
  if (overlap > 0.08) parts.push("keyword overlap");
  if (phrase > 0.3) parts.push("name/description phrase match");
  if (activeBoost > 0) parts.push("already active");
  if (intentBoost > 0) parts.push("intent-category alignment");
  return parts.length ? parts.join(", ") : "weak semantic match";
}

function phraseBoost(text, skill) {
  const t = text.toLowerCase();
  const name = skill.name.toLowerCase();
  const desc = String(skill.description || "").toLowerCase();
  let score = 0;
  if (t.includes(name)) score += 0.9;
  const nameParts = name.split("-").filter((p) => p.length > 1);
  for (const part of nameParts) {
    if (t.includes(part)) score += 0.08;
  }
  if (desc && t.length > 12) {
    const descTerms = desc.split(/\W+/).filter((w) => w.length > 1 && !STOPWORDS.has(w));
    let hits = 0;
    for (const word of descTerms.slice(0, 24)) {
      if (t.includes(word)) hits += 1;
    }
    score += Math.min(0.5, hits * 0.03);
  }
  return clamp(score, 0, 1);
}

function tokenize(text) {
  const parts = String(text || "")
    .toLowerCase()
    .split(/\W+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !STOPWORDS.has(s));
  return Array.from(new Set(parts));
}

function jaccard(aTerms, bTerms) {
  if (!aTerms.length || !bTerms.length) return 0;
  const a = new Set(aTerms);
  const b = new Set(bTerms);
  let intersection = 0;
  for (const term of a) {
    if (b.has(term)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (!union) return 0;
  return intersection / union;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

module.exports = { routeSkills };
