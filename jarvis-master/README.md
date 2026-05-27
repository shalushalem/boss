# Jarvis Local Ecosystem - Phase 1

This is a local-first foundation for your Jarvis ecosystem.

## What is implemented now

- Local API server (`/health`, `/state`, `/chat`)
- Realtime WebSocket event stream (`/ws`)
- Persistent conversation store (SQLite)
- Tool execution layer with confirmation guard
- First tools:
  - `system_status`
  - `open_app`
  - `open_url`
  - `vision_status`
  - `vision_last_observation`
  - `agentic_plan`
  - `skills_list`
  - `skills_active`
  - `skills_activate`
- Continuous "Eyes" module:
  - Screen capture loop
  - Visual change detection
  - Brightness/contrast scene hints + active app/window metadata
  - OCR text extraction on periodic frames
  - Vision events pushed over WebSocket
- Pluggable reasoning modes:
  - `local` (default, Ollama-style local model endpoint)
  - `mock` (fallback mode for offline testing without model)
- External skills pack integration:
  - imports `external/claude-skills/.codex/skills-index.json`
  - 198 skills across 9 categories (engineering, marketing, product, etc.)
- Intelligent skill router:
  - auto-matches user intent to best skills
  - boosts active skills without overriding relevance
  - optional auto-activation for high-confidence matches
- Persistent task execution memory:
  - `tasks` and `task_runs` tables for resumable execution
  - `audit_logs` table for tool/agentic/safety traces
- Runtime safety profiles:
  - `strict`, `standard`, `admin` trust modes
- Local voice interface:
  - `speak`, `listen`, and one-shot voice chat endpoints
- Conversation quality upgrades:
  - recent conversation context fed into local reasoning prompt
  - implicit task confirmation/cancellation from natural replies (`yes`, `cancel task`)
- Proactive intelligence engine:
  - background nudges for pending confirmations
  - screen-issue detection nudges from vision/OCR signals
  - `/proactive/start|stop|status|pulse` APIs

## Project structure

```txt
src/
  config.js
  index.js
  logger.js
  server.js
  orchestrator.js
  llm/provider.js
  memory/store.js
  vision/monitor.js
  agentic/engine.js
  safety/policy.js
  skills/context.js
  realtime/hub.js
  proactive/engine.js
  voice/service.js
  vision/active-window.js
  tools/
    registry.js
    system.js
```

## Run locally

1. Install dependencies
```powershell
npm.cmd install --cache .npm-cache
```

2. Create environment file
```powershell
Copy-Item .env.example .env
```

3. Start Jarvis core
```powershell
npm.cmd run dev
```

4. Test health
```powershell
curl.exe http://localhost:7070/health
```

4a. Run diagnostics (recommended before first real run)
```powershell
curl.exe http://localhost:7070/diagnostics
```

5. Test chat
```powershell
curl.exe -X POST http://localhost:7070/chat ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"system status\"}"
```

6. Start Jarvis eyes (continuous vision monitor)
```powershell
curl.exe -X POST http://localhost:7070/vision/start
```

7. Vision status
```powershell
curl.exe http://localhost:7070/vision/status
```

8. Stop vision
```powershell
curl.exe -X POST http://localhost:7070/vision/stop
```

8a. Proactive engine controls
```powershell
curl.exe http://localhost:7070/proactive/status
curl.exe -X POST http://localhost:7070/proactive/start
curl.exe -X POST http://localhost:7070/proactive/pulse
curl.exe -X POST http://localhost:7070/proactive/stop
```

9. Agentic plan
```powershell
curl.exe -X POST http://localhost:7070/agentic/plan ^
  -H "Content-Type: application/json" ^
  -d "{\"goal\":\"scan workspace and summarize project status\"}"
```

10. Agentic run (confirmation required)
```powershell
curl.exe -X POST http://localhost:7070/agentic/run ^
  -H "Content-Type: application/json" ^
  -d "{\"command\":\"Get-ChildItem -Force\",\"confirmed\":true}"
```

10a. Execute full agentic plan (preview first, then confirm)
```powershell
curl.exe -X POST http://localhost:7070/agentic/execute-plan ^
  -H "Content-Type: application/json" ^
  -d "{\"goal\":\"scan workspace and summarize project status\"}"
```

10b. Resume a task by id
```powershell
curl.exe -X POST http://localhost:7070/tasks/1/resume ^
  -H "Content-Type: application/json" ^
  -d "{\"confirmed\":true}"
```

11. Skills catalog summary
```powershell
curl.exe http://localhost:7070/skills
```

12. Activate a skill
```powershell
curl.exe -X POST http://localhost:7070/skills/activate ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"browser-automation\"}"
```

13. Active skills
```powershell
curl.exe http://localhost:7070/skills/active
```

14. Preview skill routing for a request
```powershell
curl.exe -X POST http://localhost:7070/skills/route ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"setup ci cd pipeline for my app\",\"limit\":5}"
```

15. List tasks and runs
```powershell
curl.exe http://localhost:7070/tasks
curl.exe http://localhost:7070/tasks/1/runs
```

16. Safety profile management
```powershell
curl.exe http://localhost:7070/safety/profile
curl.exe -X POST http://localhost:7070/safety/profile ^
  -H "Content-Type: application/json" ^
  -d "{\"profile\":\"strict\"}"
```

17. Audit logs
```powershell
curl.exe http://localhost:7070/audit?limit=20
```

18. Voice endpoints
```powershell
curl.exe -X POST http://localhost:7070/voice/speak ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"Hello from Jarvis\"}"
curl.exe -X POST http://localhost:7070/voice/listen ^
  -H "Content-Type: application/json" ^
  -d "{\"timeoutSec\":8}"
curl.exe -X POST http://localhost:7070/voice/chat-once ^
  -H "Content-Type: application/json" ^
  -d "{\"timeoutSec\":8}"
```

## Stability Playbook (Recommended)

1. Run diagnostics and resolve failed checks:
- `localLlm` failed: start Ollama and ensure the model in `.env` is available.
- `voice` failed: grant microphone/speech permissions and verify default audio devices.
- `vision` failed: grant screen-capture permissions.

2. Keep defaults for safe operation:
- `TRUST_MODE=standard`
- `AGENTIC_MAX_STEPS=4`
- `VISION_OCR_EVERY_N_FRAMES=4`

3. Use strict mode when needed:
- Set trust profile to `strict` before sensitive sessions.
- Only read-safe command patterns are allowed in strict mode.

4. Use task resume for interrupted runs:
- Start with `agentic/execute-plan` (preview).
- Confirm once ready.
- Resume by task id if process is interrupted.

## Safety behavior

- `open_app` and `open_url` require confirmation.
- First call returns `requiresConfirmation: true`.
- Re-send with `confirmed: true` to execute.

Example:
```json
{"text":"open notepad","confirmed":true}
```

## Current skills snapshot

- Conversation orchestration (local runtime)
- Persistent memory across restarts (SQLite)
- System diagnostics (`system_status`)
- Desktop app launching (`open_app`, confirmation-gated)
- Website launching (`open_url`, confirmation-gated)
- Realtime event stream over WebSocket
- Continuous screen monitoring ("eyes")
- Visual scene-change detection and context hints
- Vision state querying via tools and API
- Agentic planning from goals
- Agentic command execution with confirmation + safety policy
- Full plan execution workflow (`agentic_execute_plan`) with resumable task tracking
- Task/run persistence for long-running workflows
- Audit trail storage for chat/tool/agentic/safety events
- External skill-pack ingestion (198 imported skills from `claude-skills`)
- Skill search/list/filter/activate/deactivate APIs
- Auto skill routing with confidence scoring and reasons
- Auto-activation of high-confidence matched skills
- Runtime trust profile switching (`strict`, `standard`, `admin`)
- Semantic vision context (OCR + active app/window data)
- Voice I/O endpoints for local interaction loop
- Conversation continuity context for better follow-up replies
- Implicit confirmation/cancellation in chat for pending tasks
- Proactive nudges for pending tasks and detected on-screen issues

## Phase roadmap

## Phase 1 (current)
- Local core API
- Basic tool runtime
- Mock/local model provider hook
- Command safety checks

## Phase 2
- Better planner/router
- Skill/plugin framework
- Task scheduler + reminders
- Richer vision intelligence (OCR + object-level understanding)

## Phase 3
- Mobile app + notifications
- Secure remote access tunnel
- Multi-device auth and sync

## Phase 4
- Cloud control plane + edge agents
- High-availability command bus
- Enterprise-grade audit/security controls
