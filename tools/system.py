from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from core.memory import JarvisMemory


@dataclass(frozen=True)
class ActionRequest:
    name: str
    parameters: dict[str, Any]
    confirmation_required: bool = True


@dataclass(frozen=True)
class ToolResult:
    ok: bool
    message: str
    should_shutdown: bool = False


ACTION_CATALOG = """
Available actions:
- open_app: parameters {"app_name": "chrome"}
- close_app: parameters {"app_name": "notepad"}
- send_whatsapp: parameters {"contact_name": "kavya", "message": "I'll be 10 minutes late."}
- save_contact: parameters {"name": "kavya", "phone_number": "+919876543210"}
- get_system_status: parameters {}
- shutdown_interface: parameters {}
Only use an action when the user clearly wants the computer to do something.
For normal questions, conversation, advice, or unclear requests, respond normally.
"""


class SystemToolExecutor:
    def __init__(self, memory: JarvisMemory):
        self.memory = memory

    def build_request(self, action_name: str, parameters: dict[str, Any] | None) -> ActionRequest:
        action_name = (action_name or "").strip()
        parameters = parameters or {}
        confirmation_required = action_name in {
            "open_app",
            "close_app",
            "send_whatsapp",
            "save_contact",
            "shutdown_interface",
        }
        return ActionRequest(action_name, parameters, confirmation_required)

    def confirmation_prompt(self, request: ActionRequest) -> str:
        params = request.parameters
        if request.name == "send_whatsapp":
            contact = params.get("contact_name", "the contact")
            message = params.get("message", "")
            return f"Boss, I am preparing to message {contact}: \"{message}\". Shall I proceed?"
        if request.name == "open_app":
            return f"Boss, I am preparing to open {params.get('app_name', 'that app')}. Shall I proceed?"
        if request.name == "close_app":
            return f"Boss, I am preparing to close {params.get('app_name', 'that app')}. Shall I proceed?"
        if request.name == "save_contact":
            return (
                f"Boss, I am preparing to save {params.get('name', 'this contact')} "
                f"as {params.get('phone_number', 'that number')}. Shall I proceed?"
            )
        if request.name == "shutdown_interface":
            return "Boss, I am preparing to shut down the J.A.R.V.I.S. interface. Shall I proceed?"
        return f"Boss, I am preparing to run {request.name}. Shall I proceed?"

    def execute(self, request: ActionRequest) -> ToolResult:
        handler_name = f"_execute_{request.name}"
        handler = getattr(self, handler_name, None)
        if handler is None:
            result = ToolResult(False, f"I do not have a protocol named {request.name}, Boss.")
        else:
            try:
                result = handler(request.parameters)
            except Exception as exc:
                result = ToolResult(False, f"Protocol {request.name} failed: {exc}")

        self.memory.log_action(request.name, request.parameters, "ok" if result.ok else "error", result.message)
        return result

    def _execute_open_app(self, parameters: dict[str, Any]) -> ToolResult:
        app_name = str(parameters.get("app_name", "")).strip()
        if not app_name:
            return ToolResult(False, "I need an app name before opening anything, Boss.")

        from AppOpener import open as open_app

        open_app(app_name, match_closest=True)
        return ToolResult(True, f"Opening {app_name}, Boss.")

    def _execute_close_app(self, parameters: dict[str, Any]) -> ToolResult:
        app_name = str(parameters.get("app_name", "")).strip()
        if not app_name:
            return ToolResult(False, "I need an app name before closing anything, Boss.")

        from AppOpener import close as close_app

        close_app(app_name, match_closest=True)
        return ToolResult(True, f"Closing {app_name}, Boss.")

    def _execute_send_whatsapp(self, parameters: dict[str, Any]) -> ToolResult:
        contact_name = str(parameters.get("contact_name", "")).strip()
        message = str(parameters.get("message", "")).strip()
        if not contact_name or not message:
            return ToolResult(False, "I need both a contact name and a message, Boss.")

        contact = self.memory.get_contact(contact_name)
        if contact is None:
            return ToolResult(
                False,
                f"I do not have a number saved for {contact_name}. Say: save contact {contact_name} plus the number.",
            )

        import pywhatkit

        pywhatkit.sendwhatmsg_instantly(contact.phone_number, message, wait_time=15, tab_close=True, close_time=4)
        return ToolResult(True, f"Message sent to {contact.display_name}, Boss.")

    def _execute_save_contact(self, parameters: dict[str, Any]) -> ToolResult:
        name = str(parameters.get("name", "")).strip()
        phone_number = str(parameters.get("phone_number", "")).strip()
        contact = self.memory.save_contact(name, phone_number)
        return ToolResult(True, f"Contact saved for {contact.display_name}, Boss.")

    def _execute_get_system_status(self, parameters: dict[str, Any]) -> ToolResult:
        try:
            import psutil
        except ImportError:
            return ToolResult(False, "psutil is not installed, so live system telemetry is unavailable.")

        cpu = psutil.cpu_percent(interval=0.2)
        memory = psutil.virtual_memory()
        battery = psutil.sensors_battery()
        battery_text = "battery unavailable"
        if battery:
            battery_text = f"battery {battery.percent:.0f}%"
            if battery.power_plugged:
                battery_text += ", plugged in"

        return ToolResult(
            True,
            f"CPU {cpu:.0f}%, RAM {memory.percent:.0f}%, {battery_text}, Boss.",
        )

    def _execute_shutdown_interface(self, parameters: dict[str, Any]) -> ToolResult:
        return ToolResult(True, "Powering down system interface. Goodbye, Boss.", should_shutdown=True)

