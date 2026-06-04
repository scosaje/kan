/**
 * One-shot bootstrap CLI: provisions the SAR boards/lists + link table in a
 * workspace. Idempotent — safe to re-run on every deploy.
 *
 *   pnpm --filter @kan/sar-bridge bootstrap -- --workspace <id> --user <uuid> [--phase2]
 *
 * Reads POSTGRES_URL from the environment (use the repo's `with-env` wrapper or
 * export it yourself).
 */
import { createDrizzleClient } from "@kan/db/client";

import { bootstrap } from "../boardBootstrap";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const workspaceRaw = arg("--workspace");
  const createdBy = arg("--user");
  const includePhase2 = process.argv.includes("--phase2");

  if (!workspaceRaw || !createdBy) {
    console.error(
      "usage: bootstrap --workspace <numericWorkspaceId> --user <kanUserUuid> [--phase2]",
    );
    process.exit(2);
    return;
  }
  const workspaceId = Number(workspaceRaw);
  if (!Number.isInteger(workspaceId)) {
    console.error(`--workspace must be a numeric id, got '${workspaceRaw}'`);
    process.exit(2);
    return;
  }

  const db = createDrizzleClient();
  const summary = await bootstrap(db, workspaceId, createdBy, { includePhase2 });
  console.log(
    `SAR bootstrap complete: ${summary.boardsCreated} boards created (${summary.boardsExisting} existing), ` +
      `${summary.listsCreated} lists created (${summary.listsExisting} existing).`,
  );
}

main().catch((err) => {
  console.error("SAR bootstrap failed:", err);
  process.exit(1);
});
