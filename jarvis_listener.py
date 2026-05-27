from flask import Flask, request
from twilio.twiml.messaging_response import MessagingResponse

app = Flask(__name__)

# This is the endpoint Twilio will send data to
@app.route("/webhook", methods=['POST'])
def jarvis_reply():
    # 1. Read the incoming message and sender's number
    incoming_msg = request.values.get('Body', '').lower()
    sender = request.values.get('From', '')

    print(f"\n[INCOMING MESSAGE] from {sender}: {incoming_msg}")

    # 2. Create a Twilio response object
    resp = MessagingResponse()
    msg = resp.message()

    # 3. Jarvis Logic / Brain
    if 'hello' in incoming_msg or 'hi' in incoming_msg:
        msg.body("Hello sir. Systems are fully operational. How can I assist you today?")
        
    elif 'status' in incoming_msg:
        msg.body("All local servers are running perfectly.")
        
    elif 'shut down' in incoming_msg:
        msg.body("Entering sleep mode. Goodbye, sir.")
        
    else:
        msg.body("I received your message, but I don't have a specific protocol for that command yet.")

    # 4. Send the response back to Twilio (which sends it to WhatsApp)
    return str(resp)

if __name__ == "__main__":
    # Runs the Flask server on port 5000
    app.run(port=5000, debug=True)