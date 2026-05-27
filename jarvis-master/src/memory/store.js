const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { config } = require("../config");

class MemoryStore {
  constructor(logger) {
    this.logger = logger;
    this.maxMessages = 500;

    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    this._initSchema();

    this.insertMessageStmt = this.db.prepare(
      "INSERT INTO messages(role, content, meta_json, created_at) VALUES (?, ?, ?, ?)"
    );
    this.selectRecentStmt = this.db.prepare(
      "SELECT id, role, content, meta_json, created_at FROM messages ORDER BY id DESC LIMIT ?"
    );
    this.countMessagesStmt = this.db.prepare("SELECT COUNT(*) AS count FROM messages");
    this.trimMessagesStmt = this.db.prepare(
      "DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY id ASC LIMIT ?)"
    );

    this.upsertProfileStmt = this.db.prepare(
      "INSERT INTO profile(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json"
    );
    this.selectProfileStmt = this.db.prepare("SELECT key, value_json FROM profile");

    this.upsertSkillStmt = this.db.prepare(
      `INSERT INTO skills(name, category, description, source_repo, source_path, skill_md_path, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         category=excluded.category,
         description=excluded.description,
         source_repo=excluded.source_repo,
         source_path=excluded.source_path,
         skill_md_path=excluded.skill_md_path,
         imported_at=excluded.imported_at`
    );
    this.activateSkillStmt = this.db.prepare(
      "INSERT INTO active_skills(name, activated_at) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET activated_at=excluded.activated_at"
    );
    this.deactivateSkillStmt = this.db.prepare("DELETE FROM active_skills WHERE name = ?");
    this.getSkillByNameStmt = this.db.prepare(
      `SELECT s.name, s.category, s.description, s.source_repo, s.source_path, s.skill_md_path, s.imported_at,
              CASE WHEN a.name IS NULL THEN 0 ELSE 1 END AS active
       FROM skills s
       LEFT JOIN active_skills a ON a.name = s.name
       WHERE s.name = ?`
    );
    this.selectActiveSkillsStmt = this.db.prepare(
      `SELECT s.name, s.category, s.description, s.source_repo, s.source_path, s.skill_md_path, s.imported_at, a.activated_at
       FROM active_skills a
       JOIN skills s ON s.name = a.name
       ORDER BY a.activated_at DESC`
    );
    this.countSkillsStmt = this.db.prepare("SELECT COUNT(*) AS count FROM skills");
    this.countActiveSkillsStmt = this.db.prepare("SELECT COUNT(*) AS count FROM active_skills");

    this.insertTaskStmt = this.db.prepare(
      "INSERT INTO tasks(goal, skill_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    );
    this.updateTaskStmt = this.db.prepare(
      "UPDATE tasks SET status=?, summary=?, updated_at=? WHERE id=?"
    );
    this.getTaskStmt = this.db.prepare(
      "SELECT id, goal, skill_name, status, summary, created_at, updated_at FROM tasks WHERE id=?"
    );
    this.listTasksStmt = this.db.prepare(
      "SELECT id, goal, skill_name, status, summary, created_at, updated_at FROM tasks ORDER BY id DESC LIMIT ? OFFSET ?"
    );
    this.listTasksByStatusStmt = this.db.prepare(
      "SELECT id, goal, skill_name, status, summary, created_at, updated_at FROM tasks WHERE status=? ORDER BY id DESC LIMIT ? OFFSET ?"
    );
    this.insertTaskRunStmt = this.db.prepare(
      "INSERT INTO task_runs(task_id, phase, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    this.listTaskRunsStmt = this.db.prepare(
      "SELECT id, task_id, phase, status, payload_json, created_at FROM task_runs WHERE task_id=? ORDER BY id ASC"
    );

    this.insertAuditStmt = this.db.prepare(
      `INSERT INTO audit_logs(event_type, actor, action, target, status, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.listAuditStmt = this.db.prepare(
      "SELECT id, event_type, actor, action, target, status, details_json, created_at FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?"
    );
    this.listAuditByTypeStmt = this.db.prepare(
      "SELECT id, event_type, actor, action, target, status, details_json, created_at FROM audit_logs WHERE event_type=? ORDER BY id DESC LIMIT ? OFFSET ?"
    );
    this.countTasksStmt = this.db.prepare("SELECT COUNT(*) AS count FROM tasks");
    this.countTaskRunsStmt = this.db.prepare("SELECT COUNT(*) AS count FROM task_runs");
    this.countAuditStmt = this.db.prepare("SELECT COUNT(*) AS count FROM audit_logs");
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profile (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        source_repo TEXT NOT NULL,
        source_path TEXT NOT NULL,
        skill_md_path TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_skills (
        name TEXT PRIMARY KEY,
        activated_at TEXT NOT NULL,
        FOREIGN KEY(name) REFERENCES skills(name) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal TEXT NOT NULL,
        skill_name TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  addMessage(role, content, meta = {}) {
    const createdAt = new Date().toISOString();
    const info = this.insertMessageStmt.run(role, content, JSON.stringify(meta), createdAt);
    const message = {
      id: info.lastInsertRowid,
      role,
      content,
      meta,
      createdAt,
    };
    this._trimIfNeeded();
    return message;
  }

  _trimIfNeeded() {
    const { count } = this.countMessagesStmt.get();
    const overBy = count - this.maxMessages;
    if (overBy > 0) this.trimMessagesStmt.run(overBy);
  }

  getRecent(limit = 20) {
    const rows = this.selectRecentStmt.all(limit);
    rows.reverse();
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      meta: safeJson(row.meta_json),
      createdAt: row.created_at,
    }));
  }

  setProfileValue(key, value) {
    this.upsertProfileStmt.run(key, JSON.stringify(value));
  }

  getProfile() {
    const rows = this.selectProfileStmt.all();
    const profile = {};
    for (const row of rows) profile[row.key] = safeJson(row.value_json);
    return profile;
  }

  importSkillsFromCodexIndex(indexPath, sourceTag = "external-codex-pack") {
    const absIndexPath = path.resolve(indexPath);
    const raw = fs.readFileSync(absIndexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.skills)) {
      throw new Error("Invalid skills index: missing skills array");
    }

    const codexRoot = path.dirname(absIndexPath);
    const codexSkillsDir = path.join(codexRoot, "skills");
    const now = new Date().toISOString();

    let imported = 0;
    for (const skill of parsed.skills) {
      const skillName = String(skill.name || "").trim();
      if (!skillName) continue;
      const category = String(skill.category || "uncategorized");
      const description = String(skill.description || "").trim() || "No description";
      const sourcePath = String(skill.source || "").trim();
      const skillDirResolved = path.resolve(codexSkillsDir, sourcePath);
      const skillMdPath = path.join(skillDirResolved, "SKILL.md");

      this.upsertSkillStmt.run(
        skillName,
        category,
        description,
        sourceTag,
        sourcePath,
        skillMdPath,
        now
      );
      imported += 1;
    }

    return {
      imported,
      sourceTag,
      indexPath: absIndexPath,
      totalInIndex: parsed.skills.length,
      categories: parsed.categories || {},
    };
  }

  listSkills({ category, q, limit = 100, offset = 0 } = {}) {
    const filters = [];
    const params = [];
    if (category) {
      filters.push("s.category = ?");
      params.push(category);
    }
    if (q) {
      filters.push("(s.name LIKE ? OR s.description LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const sql = `
      SELECT s.name, s.category, s.description, s.source_repo, s.source_path, s.skill_md_path, s.imported_at,
             CASE WHEN a.name IS NULL THEN 0 ELSE 1 END AS active
      FROM skills s
      LEFT JOIN active_skills a ON a.name = s.name
      ${where}
      ORDER BY s.category ASC, s.name ASC
      LIMIT ? OFFSET ?
    `;
    params.push(Number(limit), Number(offset));
    return this.db.prepare(sql).all(...params).map(mapSkillRow);
  }

  activateSkill(name) {
    const skill = this.getSkill(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    this.activateSkillStmt.run(name, new Date().toISOString());
    return this.getSkill(name);
  }

  deactivateSkill(name) {
    this.deactivateSkillStmt.run(name);
    return { name, active: false };
  }

  getActiveSkills() {
    return this.selectActiveSkillsStmt.all().map((row) => ({
      ...mapSkillRow({ ...row, active: 1 }),
      activatedAt: row.activated_at,
    }));
  }

  getSkill(name) {
    const row = this.getSkillByNameStmt.get(name);
    return row ? mapSkillRow(row) : null;
  }

  getSkillSummary() {
    const { count: totalSkills } = this.countSkillsStmt.get();
    const { count: activeSkills } = this.countActiveSkillsStmt.get();
    const byCategory = this.db
      .prepare("SELECT category, COUNT(*) AS count FROM skills GROUP BY category ORDER BY category")
      .all();
    return { totalSkills, activeSkills, byCategory };
  }

  createTask({ goal, skillName = null, status = "planned", summary = null }) {
    const now = new Date().toISOString();
    const info = this.insertTaskStmt.run(goal, skillName, status, now, now);
    return this.getTask(Number(info.lastInsertRowid));
  }

  updateTask(id, { status, summary }) {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Task not found: ${id}`);
    this.updateTaskStmt.run(
      status || existing.status,
      summary != null ? String(summary) : existing.summary,
      new Date().toISOString(),
      id
    );
    return this.getTask(id);
  }

  getTask(id) {
    const row = this.getTaskStmt.get(Number(id));
    return row ? mapTaskRow(row) : null;
  }

  listTasks({ status, limit = 50, offset = 0 } = {}) {
    const rows = status
      ? this.listTasksByStatusStmt.all(status, Number(limit), Number(offset))
      : this.listTasksStmt.all(Number(limit), Number(offset));
    return rows.map(mapTaskRow);
  }

  addTaskRun(taskId, { phase, status, payload = {} }) {
    const now = new Date().toISOString();
    const info = this.insertTaskRunStmt.run(
      Number(taskId),
      String(phase || "step"),
      String(status || "ok"),
      JSON.stringify(payload),
      now
    );
    return {
      id: Number(info.lastInsertRowid),
      taskId: Number(taskId),
      phase: String(phase || "step"),
      status: String(status || "ok"),
      payload,
      createdAt: now,
    };
  }

  getTaskRuns(taskId) {
    return this.listTaskRunsStmt.all(Number(taskId)).map((row) => ({
      id: row.id,
      taskId: row.task_id,
      phase: row.phase,
      status: row.status,
      payload: safeJson(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  addAuditEvent({
    eventType = "system",
    actor = "jarvis-core",
    action = "unknown",
    target = "-",
    status = "info",
    details = {},
  }) {
    const now = new Date().toISOString();
    const info = this.insertAuditStmt.run(
      String(eventType),
      String(actor),
      String(action),
      String(target),
      String(status),
      JSON.stringify(details),
      now
    );
    return {
      id: Number(info.lastInsertRowid),
      eventType,
      actor,
      action,
      target,
      status,
      details,
      createdAt: now,
    };
  }

  listAuditLogs({ eventType, limit = 200, offset = 0 } = {}) {
    const rows = eventType
      ? this.listAuditByTypeStmt.all(eventType, Number(limit), Number(offset))
      : this.listAuditStmt.all(Number(limit), Number(offset));
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      actor: row.actor,
      action: row.action,
      target: row.target,
      status: row.status,
      details: safeJson(row.details_json),
      createdAt: row.created_at,
    }));
  }

  getCounters() {
    return {
      messages: this.countMessagesStmt.get().count,
      tasks: this.countTasksStmt.get().count,
      taskRuns: this.countTaskRunsStmt.get().count,
      auditLogs: this.countAuditStmt.get().count,
    };
  }

  getState() {
    const { count } = this.countMessagesStmt.get();
    const skillSummary = this.getSkillSummary();
    return {
      messages: this.getRecent(50),
      profile: this.getProfile(),
      totalMessages: count,
      skills: skillSummary,
      counters: this.getCounters(),
      persistence: {
        type: "sqlite",
        path: config.dbPath,
      },
    };
  }
}

function safeJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function mapSkillRow(row) {
  return {
    name: row.name,
    category: row.category,
    description: row.description,
    sourceRepo: row.source_repo,
    sourcePath: row.source_path,
    skillMdPath: row.skill_md_path,
    importedAt: row.imported_at,
    active: Boolean(row.active),
  };
}

function mapTaskRow(row) {
  return {
    id: row.id,
    goal: row.goal,
    skillName: row.skill_name,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { MemoryStore };
