/**
 * CLI to kick off an IsrDetectionToStrike run, then optionally drive the
 * decisionMade / bdaReceived signals from the same process. Useful for demo:
 *
 *   tsx src/start.ts \
 *     --board dr9x5vu0qs9x \
 *     --title "TGT-NG-0732 — ISWAP technical, Marte-Dikwa axis" \
 *     --detection "ATR-42 SAR contact + SIGINT cut. 4-hour fix." \
 *     --auto 8
 */
import { Connection, Client } from "@temporalio/client";
import {
  IsrDetectionToStrike,
  decisionMadeSignal,
  bdaReceivedSignal,
} from "./workflows/isrDetectionToStrike.js";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

async function main() {
  const board = arg("board", "dr9x5vu0qs9x")!;
  const title = arg("title", "TGT-NG-0900 — ANSA-detected target")!;
  const detection = arg("detection", "Synthetic detection from ANSA ISR pipeline.")!;
  const labels = (arg("labels", "FLASH,FIND")!).split(",").filter(Boolean);
  const rawAuto = Number(arg("auto", "8"));
  const autoAdvance = Number.isFinite(rawAuto) && rawAuto >= 0 ? rawAuto : 8;

  const conn = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const client = new Client({
    connection: conn,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  });

  const wfId = `ansa-isr:${Date.now()}`;
  console.log(`[start] launching ${wfId}`);
  const handle = await client.workflow.start(IsrDetectionToStrike, {
    taskQueue: process.env.ANSA_TASK_QUEUE ?? "ansa-mandate",
    workflowId: wfId,
    args: [{ boardPublicId: board, targetTitle: title, detection, initialLabels: labels, autoAdvanceSeconds: autoAdvance }],
  });

  // Optional: drive signals from the same process so the demo doesn't need an operator
  if (process.argv.includes("--auto-bda")) {
    setTimeout(() => {
      console.log("[start] sending decisionMade(true)");
      handle.signal(decisionMadeSignal, true).catch((e) =>
        console.error("[start] decisionMade signal failed:", (e as Error).message),
      );
    }, Math.max(2_000, (autoAdvance - 2) * 1_000));
    setTimeout(() => {
      console.log("[start] sending bdaReceived");
      handle
        .signal(
          bdaReceivedSignal,
          "Hyperspectral confirmed functional kill. 0 collateral.",
        )
        .catch((e) =>
          console.error("[start] bdaReceived signal failed:", (e as Error).message),
        );
    }, (autoAdvance + 22) * 1_000);
  }

  const result = await handle.result();
  console.log("[start] result:", result);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
