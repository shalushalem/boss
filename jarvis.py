import ollama
import pyttsx3
import speech_recognition as sr
from AppOpener import open as open_app, close as close_app
import pywhatkit

# --- J.A.R.V.I.S. CONTACT BOOK ---
# Names MUST be lowercase. Numbers must include country code (e.g., +91)
CONTACTS = {
    "kavya": "+919876543210", 
    "boss": "+919999999999"
}

engine = pyttsx3.init()
voices = engine.getProperty('voices')
engine.setProperty('voice', voices[0].id) 
engine.setProperty('rate', 170) 

def speak(text):
    engine.say(text)
    engine.runAndWait()

def listen():
    recognizer = sr.Recognizer()
    with sr.Microphone() as source:
        print("\n[Listening... Speak now]")
        recognizer.adjust_for_ambient_noise(source, duration=1)
        audio = recognizer.listen(source)

    try:
        print("[Processing...]")
        text = recognizer.recognize_google(audio)
        print(f"You: {text}")
        return text
    except sr.UnknownValueError:
        return ""
    except sr.RequestError:
        print("[Error: Check internet connection]")
        return ""

system_prompt = {
    'role': 'system',
    'content': "From now on, your name is J.A.R.V.I.S. You are a highly advanced AI system designed to manage my local operating system, automate tasks, and assist me. You must keep your responses concise, highly intelligent, slightly dry, and strictly factual. Always address me as 'Boss'."
}

chat_history = [system_prompt]

print("System Initialized. J.A.R.V.I.S. is online.")
speak("System Initialized. I am online and ready, Boss.")
print("-" * 60)

while True:
    user_input = listen()
    if not user_input:
        continue
    
    user_text = user_input.lower()
    
    # 1. THE KILL SWITCH
    if 'shut down' in user_text or 'shutdown' in user_text or 'exit' in user_text:
        print("J.A.R.V.I.S.: Powering down. Goodbye, Boss.")
        speak("Powering down. Goodbye, Boss.")
        break

    # 2. SMART MESSAGING INTENT (Moved to the top to prevent hijacks)
    if 'send' in user_text or 'message' in user_text:
        # Check if any contact name from our book is in the user's sentence
        recipient = None
        for name in CONTACTS.keys():
            if name in user_text:
                recipient = name
                break # We found the contact!
        
        if recipient:
            phone_number = CONTACTS[recipient]
            speak(f"What is the message for {recipient}?")
            
            # Listen specifically for the message content
            message = listen()
            
            if message:
                speak(f"Transmitting to {recipient}. Please step away from the controls, Boss.")
                print(f"J.A.R.V.I.S.: Sending '{message}' to {recipient}...")
                try:
                    pywhatkit.sendwhatmsg_instantly(phone_number, message, wait_time=15, tab_close=True, close_time=4)
                    speak("Message sent successfully.")
                except Exception as e:
                    speak("I encountered a network error while trying to send the message.")
                    print(e)
            else:
                speak("I didn't catch the message content. Cancelling transmission.")
            continue # Skip the rest of the loop so he doesn't try to chat

    # 3. OPENING APPS
    if 'open ' in user_text:
        app_to_open = user_text.split('open ')[-1].split(' and ')[0].strip()
        app_to_open = app_to_open.replace('for me', '').replace('please', '').strip()
        print(f"J.A.R.V.I.S.: Opening {app_to_open}...")
        speak(f"Opening {app_to_open}, Boss.")
        try:
            open_app(app_to_open, match_closest=True)
        except Exception:
            speak(f"I encountered an error opening {app_to_open}.")
        continue

    # 4. CLOSING APPS
    if 'close ' in user_text:
        app_to_close = user_text.split('close ')[-1].split(' and ')[0].strip()
        app_to_close = app_to_close.replace('the', '').replace('for me', '').replace('please', '').strip()
        print(f"J.A.R.V.I.S.: Closing {app_to_close}...")
        speak(f"Closing {app_to_close}, Boss.")
        try:
            close_app(app_to_close, match_closest=True)
        except Exception:
            speak(f"I encountered an error closing {app_to_close}.")
        continue

    # 5. NORMAL CONVERSATION (The Brain)
    chat_history.append({'role': 'user', 'content': user_input})
    response = ollama.chat(model='llama3', messages=chat_history)
    jarvis_reply = response['message']['content']

    print(f"\nJ.A.R.V.I.S.: {jarvis_reply}\n")
    speak(jarvis_reply)
    chat_history.append({'role': 'assistant', 'content': jarvis_reply})
    