import { serve } from "@hono/node-server";
import { loadDotEnv, configure, getLogger } from "@octopus/core";
import { createApp } from "./app.js";

// =============================================================================
// Entry point — loads .env, configures logging, starts the HTTP server.
// =============================================================================

// 1. Load .env files before anything reads process.env.
//    Order: project .env → ~/.deepagents/.env (shell env vars win).
loadDotEnv();

// 2. Configure logging — reads OCTOPUS_LOG_LEVEL from env (default: INFO).
configure();

const logger = getLogger("server.main");

const port = parseInt(process.env["OCTOPUS_WEB_PORT"] ?? "5050", 10);
const app = createApp();

logger.info(`Octopus server starting at http://127.0.0.1:${port}`);

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  logger.info(`Listening on http://127.0.0.1:${info.port}`);
});
