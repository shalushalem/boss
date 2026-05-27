import pyttsx3

from core.brain import JarvisAgent
from core.senses import SpeechSense


def main() -> None:
    agent = JarvisAgent()
    speech = SpeechSense()
    engine = pyttsx3.init()
    voices = engine.getProperty("voices")
    if voices:
        engine.setProperty("voice", voices[0].id)
    engine.setProperty("rate", 170)

    def speak(text: str) -> None:
        print(f"J.A.R.V.I.S.: {text}")
        engine.say(text)
        engine.runAndWait()

    print("System initialized. J.A.R.V.I.S. agentic console is online.")
    speak("System initialized. Agentic console online, Boss.")

    while True:
        print("\n[Listening... Speak now]")
        user_input = speech.listen()
        if not user_input:
            continue

        print(f"You: {user_input}")
        response = agent.process_text(user_input)
        if response.reply:
            speak(response.reply)
        if response.should_shutdown:
            break


if __name__ == "__main__":
    main()

