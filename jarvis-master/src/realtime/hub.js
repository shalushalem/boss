const { WebSocketServer } = require("ws");

class RealtimeHub {
  constructor(server, logger) {
    this.logger = logger;
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "ready", message: "Jarvis WS connected" }));
    });
  }

  broadcast(event) {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }
}

module.exports = { RealtimeHub };
