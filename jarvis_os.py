import sys
import math
import random
import time
import ollama
import speech_recognition as sr
from AppOpener import open as open_app, close as close_app
import pywhatkit
import pythoncom
import win32com.client
import json
import os

from PyQt5.QtWidgets import QApplication, QMainWindow, QVBoxLayout, QWidget, QLabel
from PyQt5.QtCore import Qt, QTimer, QThread, pyqtSignal
from PyQt5.QtGui import QPainter, QColor

# --- DYNAMIC MEMORY SYSTEM ---
MEMORY_FILE = "jarvis_memory.json"

def load_contacts():
    """Loads contact memory from file, or creates an empty one if it doesn't exist."""
    if os.path.exists(MEMORY_FILE):
        with open(MEMORY_FILE, 'r') as file:
            return json.load(file)
    return {}

def save_contact(name, number):
    """Saves a new contact to J.A.R.V.I.S.'s memory."""
    contacts = load_contacts()
    contacts[name] = number
    with open(MEMORY_FILE, 'w') as file:
        json.dump(contacts, file)

# ==========================================
# THREAD 2: THE BRAIN (AI & Automations)
# ==========================================
class JarvisBrain(QThread):
    update_ui_signal = pyqtSignal(str)
    particle_state_signal = pyqtSignal(str)

    def __init__(self):
        super().__init__()
        self.system_prompt = {
            'role': 'system',
            'content': "From now on, your name is J.A.R.V.I.S. You are a highly advanced AI system designed to manage my local operating system, automate tasks, and assist me. Keep your responses concise, highly intelligent, slightly dry, and strictly factual. Always address me as 'Boss'."
        }
        self.chat_history = [self.system_prompt]

    def speak(self, text):
        self.particle_state_signal.emit("speaking")
        self.update_ui_signal.emit(f"J.A.R.V.I.S.: {text}")
        self.speaker.Speak(text)
        self.particle_state_signal.emit("idle")

    def listen(self, timeout=5, phrase_limit=10):
        recognizer = sr.Recognizer()
        with sr.Microphone() as source:
            self.particle_state_signal.emit("listening")
            self.update_ui_signal.emit("[Listening... Speak now]")
            recognizer.adjust_for_ambient_noise(source, duration=1)
            try:
                audio = recognizer.listen(source, timeout=timeout, phrase_time_limit=phrase_limit)
            except sr.WaitTimeoutError:
                return ""

        try:
            self.particle_state_signal.emit("thinking")
            self.update_ui_signal.emit("[Processing Audio...]")
            text = recognizer.recognize_google(audio)
            self.update_ui_signal.emit(f"You: {text}")
            return text
        except sr.UnknownValueError:
            return ""
        except sr.RequestError:
            self.update_ui_signal.emit("[Error: Speech Recognition Network Issue]")
            return ""

    def run(self):
        pythoncom.CoInitialize() 
        self.speaker = win32com.client.Dispatch("SAPI.SpVoice")
        self.speaker.Rate = 2 
        
        self.particle_state_signal.emit("booting")
        self.update_ui_signal.emit("BOOTING J.A.R.V.I.S. KERNEL...")
        time.sleep(1)
        
        self.speak("System Initialized. I am online and ready, Boss.")
        
        while True:
            self.particle_state_signal.emit("idle")
            user_input = self.listen()
            
            if not user_input:
                continue
                
            user_text = user_input.lower()

            # 1. THE KILL SWITCH
            if 'shut down' in user_text or 'shutdown' in user_text or 'exit' in user_text:
                self.speak("Powering down system interface. Goodbye, Boss.")
                self.update_ui_signal.emit("SHUTDOWN_COMMAND")
                break

            # 2. DYNAMIC MESSAGING PROTOCOL
            if 'send' in user_text or 'message' in user_text:
                # Extract the name from the sentence
                # E.g., "Send a message to Kavya" -> "Kavya"
                try:
                    words = user_text.split()
                    # A simple heuristic: take the last word as the name
                    recipient = words[-1].strip().lower() 
                except:
                    self.speak("I didn't catch the name, Boss.")
                    continue

                contacts = load_contacts()
                
                # If he knows the person
                if recipient in contacts:
                    self.speak(f"What is the message for {recipient}?")
                    message = self.listen()
                    if message:
                        self.speak(f"Transmitting to {recipient}. Please step away from the controls.")
                        try:
                            pywhatkit.sendwhatmsg_instantly(contacts[recipient], message, wait_time=15, tab_close=True, close_time=4)
                            self.speak("Message sent successfully.")
                        except Exception:
                            self.speak("Network error encountered during transmission.")
                    else:
                        self.speak("Message content not recognized. Cancelling.")
                
                # If he DOESN'T know the person
                else:
                    self.speak(f"I do not have a number saved for {recipient}. Please read the phone number to me, including the country code.")
                    # Give extra time to read out a long number
                    spoken_number = self.listen(timeout=10, phrase_limit=15) 
                    
                    if spoken_number:
                        # Clean up the spoken text to try and format it like a phone number
                        formatted_number = spoken_number.replace(" ", "").replace("-", "")
                        # Add a plus if they forgot to say it
                        if not formatted_number.startswith("+"):
                            formatted_number = "+" + formatted_number
                            
                        self.speak(f"Saving {formatted_number} for {recipient}.")
                        save_contact(recipient, formatted_number)
                        self.speak("Contact saved. Please repeat your original message request, Boss.")
                    else:
                        self.speak("I did not catch the number. Cancelling protocol.")
                continue

            # 3. OPENING APPS
            if 'open ' in user_text:
                app_to_open = user_text.split('open ')[-1].split(' and ')[0].strip()
                app_to_open = app_to_open.replace('for me', '').replace('please', '').strip()
                self.speak(f"Opening {app_to_open}, Boss.")
                try:
                    open_app(app_to_open, match_closest=True)
                except Exception:
                    self.speak(f"Error locating {app_to_open}.")
                continue

            # 4. CLOSING APPS
            if 'close ' in user_text:
                app_to_close = user_text.split('close ')[-1].split(' and ')[0].strip()
                app_to_close = app_to_close.replace('the', '').replace('for me', '').strip()
                self.speak(f"Closing {app_to_close}, Boss.")
                try:
                    close_app(app_to_close, match_closest=True)
                except Exception:
                    self.speak(f"Error closing {app_to_close}.")
                continue

            # 5. NORMAL CONVERSATION (Llama 3)
            self.particle_state_signal.emit("thinking")
            self.chat_history.append({'role': 'user', 'content': user_input})
            
            try:
                response = ollama.chat(model='llama3', messages=self.chat_history)
                jarvis_reply = response['message']['content']
                self.speak(jarvis_reply)
                self.chat_history.append({'role': 'assistant', 'content': jarvis_reply})
            except Exception:
                self.speak("My local LLM connection was interrupted.")

# ==========================================
# THE HOLOGRAPHIC ENGINE
# ==========================================
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

    def set_state(self, new_state):
        self.state = new_state

    def update_animation(self):
        self.time_tracker += 0.1
        
        if self.state == "idle":
            self.current_radius = self.base_radius
            for p in self.particles: p[0] += p[2]
                
        elif self.state == "listening":
            self.current_radius = self.base_radius + (math.sin(self.time_tracker) * 15)
            for p in self.particles: p[0] += p[2] * 0.5
                
        elif self.state == "thinking":
            self.current_radius = self.base_radius
            for p in self.particles: p[0] += p[2] * 4 
                
        elif self.state == "speaking":
            self.current_radius = self.base_radius + random.uniform(-8, 8)
            for p in self.particles: p[0] += p[2] * 1.5
                
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(0, 255, 204, 220))
        
        cx, cy = self.width() // 2, self.height() // 2
        for p in self.particles:
            angle, offset, _ = p
            x = cx + (self.current_radius + offset) * math.cos(angle)
            y = cy + (self.current_radius + offset) * math.sin(angle)
            painter.drawEllipse(int(x), int(y), 4, 4)

# ==========================================
# THREAD 1: THE FULL SCREEN OS
# ==========================================
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

        self.status_label = QLabel("INITIALIZING...")
        self.status_label.setStyleSheet("color: #00ffcc; font-size: 16px; font-family: Consolas; margin-top: 30px;")
        self.status_label.setAlignment(Qt.AlignCenter)
        self.status_label.setWordWrap(True)
        self.layout.addWidget(self.status_label)

        self.brain = JarvisBrain()
        self.brain.update_ui_signal.connect(self.update_status)
        self.brain.particle_state_signal.connect(self.hologram.set_state)
        self.brain.start()

    def update_status(self, text):
        if text == "SHUTDOWN_COMMAND":
            self.close()
        else:
            self.status_label.setText(text)

    def keyPressEvent(self, event):
        if event.key() == Qt.Key_Escape:
            self.close()

if __name__ == '__main__':
    app = QApplication(sys.argv)
    app.setOverrideCursor(Qt.BlankCursor) 
    os_window = JarvisOS()
    sys.exit(app.exec_())