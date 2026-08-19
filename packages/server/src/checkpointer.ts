/**
 * SQLite-backed LangGraph checkpointer factory.
 *
 * Replaces the process-level MemorySaver so HITL interrupt state (and thread
 * checkpoints) survive server restarts — the prerequisite for resuming a
 * paused turn after a crash/restart. Uses a SEPARATE db file from the message
 * store (checkpoints are high-frequency binary writes; isolating them keeps
 * WAL churn off octopus.db).
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { getLogger } from "@octopus/core";

const logger = getLogger("server.checkpointer");

/**
 * Create the SQLite checkpointer. Path precedence:
 * OCTOPUS_CHECKPOINT_DB_PATH env → data/checkpoints.db (alongside octopus.db).
 */
export function createSqliteCheckpointer(path?: string): SqliteSaver {
  const dbPath =
    path ??
    process.env["OCTOPUS_CHECKPOINT_DB_PATH"]?.trim() ??
    "data/checkpoints.db";
  const dir = dirname(dbPath);
  if (!isAbsolute(dir) || !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  logger.info(`SQLite checkpointer opened at ${dbPath}`);
  return new SqliteSaver(sqlite);
}
