from __future__ import annotations

import math
import random
import sys
import time

import pythoncom
import win32com.client
from PyQt5.QtCore import Qt, QThread, QTimer, pyqtSignal
from PyQt5.QtGui import QColor, QPainter
from PyQt5.QtWidgets import QApplication, QGridLayout, QLabel, QMainWindow, QVBoxLayout, QWidget

from core.brain import JarvisAgent
from core.config import load_config
from core.senses import SpeechSense


class JarvisWorker(QThread):
    update_ui_signal = pyqtSignal(str)
    particle_state_signal = pyqtSignal(str)
    telemetry_signal = pyqtSignal(str, str, str)

    def __init__(self):
        super().__init__()
        self.config = load_config()
        self.agent = JarvisAgent(self.config)
        self.speech = SpeechSense()
        self._running = True

    def speak(self, text: str) -> None:
        self.particle_state_signal.emit("speaking")
        self.update_ui_signal.emit(f"J.A.R.V.I.S.: {text}")
        self.speaker.Speak(text)
        self.particle_state_signal.emit("idle")

    def listen(self) -> str:
        self.particle_state_signal.emit("listening")
        self.update_ui_signal.emit("[Listening... Speak now]")
        text = self.speech.listen()
        if text:
            self.particle_state_signal.emit("thinking")
            self.update_ui_signal.emit(f"You: {text}")
        return text

    def update_telemetry(self) -> None:
        try:
            import psutil

            cpu = f"CPU {psutil.cpu_percent(interval=None):.0f}%"
            ram = f"RAM {psutil.virtual_memory().percent:.0f}%"
            battery = psutil.sensors_battery()
            power = "PWR --"
            if battery:
                power = f"PWR {battery.percent:.0f}%"
                if battery.power_plugged:
                    power += " AC"
            self.telemetry_signal.emit(cpu, ram, power)
        except Exception:
            self.telemetry_signal.emit("CPU --", "RAM --", "PWR --")

    def run(self) -> None:
        pythoncom.CoInitialize()
        self.speaker = win32com.client.Dispatch("SAPI.SpVoice")
        self.speaker.Rate = self.config.speaker_rate

        self.particle_state_signal.emit("booting")
        self.update_ui_signal.emit("BOOTING J.A.R.V.I.S. KERNEL...")
        time.sleep(1)
        self.speak("System initialized. Agentic router online, Boss.")

        while self._running:
            self.update_telemetry()
            self.particle_state_signal.emit("idle")
            user_input = self.listen()
            if not user_input:
                continue

            response = self.agent.process_text(user_input)
            if response.reply:
                self.speak(response.reply)
            if response.should_shutdown:
                self.update_ui_signal.emit("SHUTDOWN_COMMAND")
                self._running = False


class ParticleSphere(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(600, 600)
        self.particles = []
        self.num_particles = 250
        self.base_radius = 130
        self.current_radius = 130
        self.state = "idle"
        self.time_tracker = 0

        for _ in range(self.num_particles):
            angle = random.uniform(0, 2 * math.pi)
            offset = random.uniform(-15, 15)
            speed = random.uniform(0.01, 0.03)
            self.particles.append([angle, offset, speed])

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.update_animation)
        self.timer.start(16)

    def set_state(self, new_state: str) -> None:
        self.state = new_state

    def update_animation(self) -> None:
        self.time_tracker += 0.1

        if self.state == "idle":
            self.current_radius = self.base_radius
            speed_multiplier = 1
        elif self.state == "listening":
            self.current_radius = self.base_radius + (math.sin(self.time_tracker) * 15)
            speed_multiplier = 0.5
        elif self.state == "thinking":
            self.current_radius = self.base_radius
            speed_multiplier = 4
        elif self.state == "speaking":
            self.current_radius = self.base_radius + random.uniform(-8, 8)
            speed_multiplier = 1.5
        else:
            self.current_radius = self.base_radius
            speed_multiplier = 1

        for particle in self.particles:
            particle[0] += particle[2] * speed_multiplier
        self.update()

    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(0, 255, 204, 220))

        cx, cy = self.width() // 2, self.height() // 2
        for particle in self.particles:
            angle, offset, _ = particle
            x = cx + (self.current_radius + offset) * math.cos(angle)
            y = cy + (self.current_radius + offset) * math.sin(angle)
            painter.drawEllipse(int(x), int(y), 4, 4)


class TelemetryPanel(QWidget):
    def __init__(self):
        super().__init__()
        layout = QGridLayout(self)
        layout.setHorizontalSpacing(20)

        self.cpu_label = self._make_label("CPU --")
        self.ram_label = self._make_label("RAM --")
        self.power_label = self._make_label("PWR --")
        layout.addWidget(self.cpu_label, 0, 0)
        layout.addWidget(self.ram_label, 0, 1)
        layout.addWidget(self.power_label, 0, 2)

    def _make_label(self, text: str) -> QLabel:
        label = QLabel(text)
        label.setStyleSheet("color: #00ffcc; font-size: 14px; font-family: Consolas;")
        label.setAlignment(Qt.AlignCenter)
        return label

    def update_values(self, cpu: str, ram: str, power: str) -> None:
        self.cpu_label.setText(cpu)
        self.ram_label.setText(ram)
        self.power_label.setText(power)


class JarvisOS(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.FramelessWindowHint)
        self.showFullScreen()
        self.setStyleSheet("background-color: #030303;")

        self.central_widget = QWidget()
        self.setCentralWidget(self.central_widget)
        self.layout = QVBoxLayout(self.central_widget)
        self.layout.setAlignment(Qt.AlignCenter)

        self.hologram = ParticleSphere()
        self.layout.addWidget(self.hologram, alignment=Qt.AlignCenter)

        self.telemetry_panel = TelemetryPanel()
        self.layout.addWidget(self.telemetry_panel, alignment=Qt.AlignCenter)

        self.status_label = QLabel("INITIALIZING...")
        self.status_label.setStyleSheet("color: #00ffcc; font-size: 16px; font-family: Consolas; margin-top: 30px;")
        self.status_label.setAlignment(Qt.AlignCenter)
        self.status_label.setWordWrap(True)
        self.layout.addWidget(self.status_label)

        self.worker = JarvisWorker()
        self.worker.update_ui_signal.connect(self.update_status)
        self.worker.particle_state_signal.connect(self.hologram.set_state)
        self.worker.telemetry_signal.connect(self.telemetry_panel.update_values)
        self.worker.start()

    def update_status(self, text: str) -> None:
        if text == "SHUTDOWN_COMMAND":
            self.close()
        else:
            self.status_label.setText(text)

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key_Escape:
            self.close()


def run_hud() -> None:
    app = QApplication(sys.argv)
    app.setOverrideCursor(Qt.BlankCursor)
    window = JarvisOS()
    sys.exit(app.exec_())
