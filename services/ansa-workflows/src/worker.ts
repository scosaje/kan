import { NativeConnection, Worker, bundleWorkflowCode } from "@temporalio/worker";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
const TASK_QUEUE = process.env.ANSA_TASK_QUEUE ?? "ansa-mandate";

async function main() {
  // Bundle both workflow modules — IsrDetectionToStrike (one-shot ANSA flow)
  // and LaneAgentWorkflow (long-running per-lane agents).
  const workflowsRoot = path.resolve(__dirname);
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: path.resolve(workflowsRoot, "./workflowsEntry.js"),
  });

  const conn = await NativeConnection.connect({ address: ADDRESS });
  const worker = await Worker.create({
    connection: conn,
    namespace: NAMESPACE,
    taskQueue: TASK_QUEUE,
    workflowBundle,
  });
  console.log(
    `[ansa-workflows] worker running on ${ADDRESS} ns=${NAMESPACE} queue=${TASK_QUEUE}`,
  );

  let shuttingDown = false;
  const stop = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ansa-workflows] ${sig} — draining`);
    try {
      await worker.shutdown();
    } catch (e) {
      console.error("[ansa-workflows] shutdown error:", (e as Error).message);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  await worker.run();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
