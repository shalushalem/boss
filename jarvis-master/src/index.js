const { config } = require("./config");
const { createServer } = require("./server");
const { logger } = require("./logger");

function main() {
  const { httpServer } = createServer();
  httpServer.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        mode: config.mode,
      },
      "Jarvis Phase 1 local core started"
    );
  });
}

main();
