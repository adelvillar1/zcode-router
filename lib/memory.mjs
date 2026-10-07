/**
 * The durable memory plane, seen from the ZCode edition.
 *
 * The store is the engine edition's own JSONL graph — ONE file on this
 * machine, the same one ZCode's MCP memory server already points at. The
 * plane resolves MEMORY_FILE_PATH before its kit home (the same contract the
 * memory MCP bin documents), so pinning here is what keeps this edition's
 * CLI off a second graph: without it memoryStorePath() would default to this
 * edition's runtime home (~/.zcode/router) and the two editions would quietly
 * keep facts that never meet. The router server pins the same value.
 *
 * Zero dependencies — this file is only the pin plus the engine checkout's
 * path (its sibling under ~/Projects, the layout node_modules/workflow-plane
 * already encodes) so `kit memory config` can hand a harness the real bin.
 */
import fs from "node:fs";
import path from "node:path";
import { HOME, KIT_DIR } from "./paths.mjs";

export const ENGINE_KIT_DIR =
  process.env.AGNOSTIC_ROUTER_KIT_DIR ?? path.resolve(KIT_DIR, "..", "agnostic-router-kit");

/** The one store: the engine edition's memory/memory.jsonl. */
export const CANONICAL_STORE =
  process.env.MEMORY_FILE_PATH ?? path.join(HOME, ".agnostic-router-kit", "memory", "memory.jsonl");

process.env.MEMORY_FILE_PATH ??= CANONICAL_STORE;

/** The memory MCP server's entrypoint in the engine checkout. */
export function memoryMcpBin() {
  return path.join(ENGINE_KIT_DIR, "bin", "agnostic-router-memory.mjs");
}

export function memoryMcpBinExists() {
  return fs.existsSync(memoryMcpBin());
}

export {
  loadGraph,
  saveGraph,
  createEntities,
  createRelations,
  addObservations,
  addFact,
  addTriple,
  resolveConflict,
  invalidate,
  gcGraph,
  deleteEntities,
  addScratch,
  consolidationEligible,
  consolidate,
  detectConflicts,
  extractMentions,
  memoryStats,
  memoryStorePath,
  searchGraph,
} from "workflow-plane/memory.mjs";
