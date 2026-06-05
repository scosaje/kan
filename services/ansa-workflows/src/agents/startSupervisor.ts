/**
 * Supervisor CLI for the lane agents.
 *
 *   start   --board <publicId>   # start one LaneAgentWorkflow per agent YAML
 *   list    --board <publicId>   # show running agents + inflight counts
 *   stop    --board <publicId>   # send `stop` signal to every agent on this board
 *
 * This is intentionally a CLI rather than a long-running supervisor workflow;
 * Temporal already supervises the agents themselves (their continueAsNew loop
 * keeps them alive indefinitely). The CLI is the operator's launcher / status
 * tool.
 */
import {
  Connection,
  Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { loadAgentConfigs } from "./config.js";
import { agentWorkflowId } from "./ids.js";
import {
  LaneAgentWorkflow,
  inflightQuery,
  configQuery,
  stopSignal,
} from "./laneAgent.js";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
const TASK_QUEUE = process.env.ANSA_TASK_QUEUE ?? "ansa-mandate";

const wfId = agentWorkflowId;

async function client() {
  const conn = await Connection.connect({ address: ADDRESS });
  return new Client({ connection: conn, namespace: NAMESPACE });
}

async function start(boardPublicId: string) {
  const c = await client();
  const configs = loadAgentConfigs();
  if (!configs.length) {
    console.error("no agent configs found");
    process.exit(2);
  }
  console.log(`[supervisor] starting ${configs.length} agents on board ${boardPublicId}`);

  for (const cfg of configs) {
    const id = wfId(boardPublicId, cfg.lane);
    try {
      await c.workflow.start(LaneAgentWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: id,
        args: [{ boardPublicId, config: cfg }],
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });
      console.log(`  ✓ ${cfg.agent} → ${id}`);
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) {
        console.log(`  · ${cfg.agent} → ${id} (already running)`);
      } else {
        console.error(`  ✗ ${cfg.agent} → ${id}: ${(e as Error).message}`);
      }
    }
  }
}

async function list(boardPublicId: string) {
  const c = await client();
  const configs = loadAgentConfigs();
  console.log(`[supervisor] agents on board ${boardPublicId}`);
  for (const cfg of configs) {
    const id = wfId(boardPublicId, cfg.lane);
    const handle = c.workflow.getHandle(id);
    try {
      const desc = await handle.describe();
      const inflight = await handle.query(inflightQuery).catch(() => []);
      console.log(
        `  [${desc.status.name.padEnd(8)}] ${cfg.agent.padEnd(28)} mode=${cfg.mode.padEnd(8)} inflight=${inflight.length} runId=${desc.runId.slice(0, 8)}`,
      );
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        console.log(`  [missing ] ${cfg.agent.padEnd(28)} ${id}`);
      } else {
        console.log(`  [error   ] ${cfg.agent}: ${(e as Error).message}`);
      }
    }
  }
}

async function stop(boardPublicId: string) {
  const c = await client();
  const configs = loadAgentConfigs();
  for (const cfg of configs) {
    const id = wfId(boardPublicId, cfg.lane);
    try {
      await c.workflow.getHandle(id).signal(stopSignal);
      console.log(`  → stop ${id}`);
    } catch (e) {
      if (!(e instanceof WorkflowNotFoundError)) {
        console.error(`  ✗ ${id}: ${(e as Error).message}`);
      }
    }
  }
}

async function main() {
  const cmd = process.argv[2] ?? "list";
  const board = arg("board", "dr9x5vu0qs9x")!;
  if (cmd === "start") await start(board);
  else if (cmd === "stop") await stop(board);
  else if (cmd === "list") await list(board);
  else {
    console.error("usage: supervisor [start|list|stop] --board <publicId>");
    process.exit(2);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
