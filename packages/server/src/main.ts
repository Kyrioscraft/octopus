import { serve } from "@hono/node-server";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, configure, getLogger, setCheckpointer } from "@octopus/core";
import { createApp } from "./app.js";
import { logLangfuseStatus, isLangfuseEnabled } from "./langfuse-tracing.js";
import { initDb } from "./db/index.js";
import { createSqliteCheckpointer } from "./checkpointer.js";

// =============================================================================
// Entry point — loads .env, configures logging, starts the HTTP server.
// =============================================================================

// 1. Load .env files before anything reads process.env.
//    Order: project .env → ~/.deepagents/.env (shell env vars win).
loadDotEnv();

// 1b. loadDotEnv() reads `.env` from process.cwd() — if the server is started
//     outside packages/server (e.g. `node packages/server/dist/main.js` from
//     the repo root), the package's .env (LANGFUSE_* keys etc.) is missed.
//     Backfill from the directory of THIS file (dist/ → package root).
//     _loadDotEnvFile skips missing files, so an absent .env is a no-op.
loadDotEnv(dirname(dirname(fileURLToPath(import.meta.url))));

// 2. Configure logging — reads OCTOPUS_LOG_LEVEL from env (default: INFO).
configure();

// 3. Register the Langfuse OpenTelemetry span processor (v5 SDK) and log the
//    tracing status (enabled baseUrl / disabled how-to-enable) at startup.
//    The processor reads LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL from env and
//    exports CallbackHandler spans asynchronously; register it only when
//    configured so unconfigured setups carry zero OTel overhead.
if (isLangfuseEnabled()) {
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");
  new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor()],
  }).register();
}
logLangfuseStatus();

// 3. Init the DB and swap the process-level LangGraph checkpointer from
//    MemorySaver to SQLite, so HITL interrupt state survives restarts
//    (a paused thread's /resume works after a server restart). Uses a
//    SEPARATE db file from the message store to keep checkpoint WAL traffic
//    off octopus.db.
initDb();
try {
  setCheckpointer(createSqliteCheckpointer());
} catch (err) {
  const boot = getLogger("server.main");
  boot.exception("SQLite checkpointer unavailable — falling back to MemorySaver", err as Error);
}

const logger = getLogger("server.main");

const port = parseInt(process.env["OCTOPUS_WEB_PORT"] ?? "9876", 10);
// Bind explicitly to an IPv4 address. Without this @hono/node-server falls
// back to the dual-stack IPv6 wildcard "::", which on Windows creates two
// separate listen sockets (0.0.0.0:port and [::]:port). Killing one of them
// leaves the other holding the port, so the next start fails with EADDRINUSE
// even after "the" process appears to be gone. Pinning to 127.0.0.1 keeps the
// log line below truthful and makes the dev server loopback-only (Vite proxy
// already targets 127.0.0.1:9876). Set OCTOPUS_HOST to override.
const hostname = process.env["OCTOPUS_HOST"] ?? "127.0.0.1";
const app = createApp();

logger.info(`Octopus server starting at http://${hostname}:${port}`);

// Friendly guidance when the port is taken. The actual error surfaces as an
// 'error' event on the returned http.Server — that's the "Unhandled 'error'
// event" stack the user sees — so we listen for it instead of try/catch.
const handleListenError = (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    logger.error(
      `端口 ${port} 已被占用（EADDRINUSE）。` +
        `常见原因：上一次 \`node --watch\` 子进程未退出。` +
        `请用以下命令查找并结束占用进程后重启：\n` +
        `  netstat -ano | findstr :${port}\n` +
        `  taskkill /PID <上面找到的PID> /F`,
    );
  } else {
    logger.exception(`服务器监听失败 (${err.code ?? "unknown"})`, err);
  }
  // Exit non-zero so `node --watch` / process managers surface the failure.
  process.exit(1);
};

serve(
  {
    fetch: app.fetch,
    hostname,
    port,
  },
  (info) => {
    logger.info(`Listening on http://${hostname}:${info.port}`);
  },
).on("error", handleListenError);
