import pyttsx3

from core.brain import JarvisAgent
from core.config import load_config
from core.senses import SpeechSense


def main() -> None:
    config = load_config()
    agent = JarvisAgent(config)
    speech = SpeechSense(config, status_callback=lambda message: print(f"[Audio] {message}"))
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
        if speech.wake_word_enabled and not agent.has_pending_action:
            print(f"\n[Standing by... Say '{speech.wake_word}']")
            if not speech.wait_for_wake_word():
                continue
            print("[Wake word recognized]")

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
