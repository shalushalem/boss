from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from core.config import AppConfig, load_config
from core.memory import JarvisMemory
from tools.system import ACTION_CATALOG, ActionRequest, SystemToolExecutor


@dataclass(frozen=True)
class AgentResponse:
    reply: str
    should_shutdown: bool = False


CONFIRM_WORDS = {"yes", "yeah", "yep", "confirm", "proceed", "do it", "go ahead", "approved", "sure"}
CANCEL_WORDS = {"no", "nope", "cancel", "stop", "negative", "do not", "don't", "abort"}


class JarvisAgent:
    def __init__(self, config: AppConfig | None = None):
        self.config = config or load_config()
        self.memory = JarvisMemory(self.config.memory_db_path, self.config.legacy_memory_path)
        self.executor = SystemToolExecutor(self.memory)
        self.pending_action: ActionRequest | None = None
        self.chat_history = [{"role": "system", "content": self._system_prompt()}]

    def _system_prompt(self) -> str:
        return f"""
You are J.A.R.V.I.S., a concise, dry, highly capable local operating-system assistant.
Always address the user as Boss.

You must return one strict JSON object and nothing else.
Schema:
{{
  "mode": "respond" or "action",
  "reply": "short spoken response for the user",
  "action": null or {{
    "name": "one available action name",
    "parameters": {{}}
  }}
}}

{ACTION_CATALOG}

Saved contact names: {self.memory.contact_names_for_prompt()}
Never invent phone numbers. If a contact is missing, ask the user to save it.
Use shutdown_interface when the user asks to shut down, exit, power down, or close J.A.R.V.I.S.
""".strip()

    def process_text(self, user_text: str) -> AgentResponse:
        user_text = user_text.strip()
        if not user_text:
            return AgentResponse("")

        self.memory.log_interaction("user", user_text)

        if self.pending_action:
            return self._resolve_pending_action(user_text)

        plan = self._plan_with_llm(user_text)
        if plan.get("mode") != "action" or not plan.get("action"):
            reply = str(plan.get("reply") or "I am listening, Boss.")
            self.memory.log_interaction("assistant", reply)
            return AgentResponse(reply)

        action = plan["action"] or {}
        request = self.executor.build_request(action.get("name", ""), action.get("parameters") or {})

        if request.confirmation_required:
            self.pending_action = request
            reply = self.executor.confirmation_prompt(request)
            self.memory.log_interaction("assistant", reply)
            return AgentResponse(reply)

        result = self.executor.execute(request)
        self.memory.log_interaction("assistant", result.message)
        return AgentResponse(result.message, should_shutdown=result.should_shutdown)

    def _resolve_pending_action(self, user_text: str) -> AgentResponse:
        normalized = user_text.lower().strip()
        pending = self.pending_action
        self.pending_action = None

        if any(word in normalized for word in CANCEL_WORDS):
            reply = "Cancelled, Boss."
            self.memory.log_interaction("assistant", reply)
            return AgentResponse(reply)

        if any(word in normalized for word in CONFIRM_WORDS):
            result = self.executor.execute(pending)
            self.memory.log_interaction("assistant", result.message)
            return AgentResponse(result.message, should_shutdown=result.should_shutdown)

        self.pending_action = pending
        reply = "I need a clear yes or no, Boss."
        self.memory.log_interaction("assistant", reply)
        return AgentResponse(reply)

    def _plan_with_llm(self, user_text: str) -> dict[str, Any]:
        try:
            import ollama

            messages = self.chat_history + [{"role": "user", "content": user_text}]
            response = ollama.chat(
                model=self.config.ollama_model,
                messages=messages,
                format="json",
            )
            raw_content = response["message"]["content"]
            plan = self._parse_json(raw_content)

            self.chat_history.append({"role": "user", "content": user_text})
            self.chat_history.append({"role": "assistant", "content": raw_content})
            return plan
        except Exception as exc:
            return {
                "mode": "respond",
                "reply": f"My local LLM connection was interrupted: {exc}",
                "action": None,
            }

    def _parse_json(self, raw_content: str) -> dict[str, Any]:
        try:
            return json.loads(raw_content)
        except json.JSONDecodeError:
            start = raw_content.find("{")
            end = raw_content.rfind("}")
            if start >= 0 and end > start:
                return json.loads(raw_content[start : end + 1])
            raise

