from flask import Flask, request
from twilio.twiml.messaging_response import MessagingResponse

from core.brain import JarvisAgent
from core.config import load_config


config = load_config()
app = Flask(__name__)
agent = JarvisAgent(config)


@app.route("/webhook", methods=["POST"])
def jarvis_reply():
    incoming_msg = request.values.get("Body", "")
    sender = request.values.get("From", "")
    print(f"\n[INCOMING MESSAGE] from {sender}: {incoming_msg}")

    response = agent.process_text(incoming_msg)

    twilio_response = MessagingResponse()
    twilio_response.message(response.reply or "Systems online, Boss.")
    return str(twilio_response)


if __name__ == "__main__":
    app.run(port=config.flask_port, debug=True)

