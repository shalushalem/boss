from __future__ import annotations

import speech_recognition as sr


class SpeechSense:
    def listen(self, timeout: int = 5, phrase_limit: int = 10) -> str:
        recognizer = sr.Recognizer()
        with sr.Microphone() as source:
            recognizer.adjust_for_ambient_noise(source, duration=1)
            try:
                audio = recognizer.listen(source, timeout=timeout, phrase_time_limit=phrase_limit)
            except sr.WaitTimeoutError:
                return ""

        try:
            return recognizer.recognize_google(audio)
        except sr.UnknownValueError:
            return ""
        except sr.RequestError:
            return ""

