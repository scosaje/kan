/**
 * Stable, language-agnostic surface that ANY Temporal workflow can call to
 * drive Kan board operations. Hosted on the dedicated task queue
 * `kan-board-ops` (configurable via TEMPORAL_BOARD_OPS_QUEUE).
 *
 * Activity contracts are stable — change names/signatures only with care.
 * Workflows in other codebases (Python, Go, Java) can register matching
 * activity stubs and call them by name; Temporal routes the work here.
 *
 *   // Example (TypeScript workflow somewhere else)
 *   const ops = proxyActivities<{
 *     postComment: (cardPublicId: string, body: string) => Promise<void>;
 *     moveCardToLane: (cardPublicId: string, boardPublicId: string, lane: string) => Promise<string>;
 *     addLabel: (cardPublicId: string, labelName: string) => Promise<void>;
 *     createCard: (...) => Promise<{ publicId: string }>;
 *     ...
 *   }>({ taskQueue: "kan-board-ops", startToCloseTimeout: "30 seconds" });
 *   await ops.postComment("abc123def456", "BDA available");
 */
import crypto from "node:crypto";
import { Context } from "@temporalio/activity";
import { config } from "../config.js";
import { kan } from "../kanClient.js";
import { log } from "../log.js";

/**
 * Stable idempotency token derived from the calling Temporal task. We embed
 * this as an HTML comment in `comment` bodies and card descriptions so that a
 * retried activity sees a prior success and short-circuits — preventing
 * duplicate comments / cards on transient failures.
 *
 * Falls back to a random uuid when invoked outside an activity context (tests).
 */
function idempotencyToken(): string {
  try {
    const info = Context.current().info;
    const wfId = info.workflowExecution?.workflowId ?? "no-wf";
    return `${wfId}#${info.activityType}#${info.activityId}`;
  } catch {
    return crypto.randomUUID();
  }
}

const IDEM_PREFIX = "<!--kan-idem:";
const IDEM_SUFFIX = "-->";
const idemTag = (tok: string) => `${IDEM_PREFIX}${tok}${IDEM_SUFFIX}`;

// ---- provisioning -------------------------------------------------------

/**
 * Idempotent board provisioner. Find a board by `name` in the
 * configured workspace (or the first workspace visible to the bridge
 * user if `MANDATE_WORKSPACE_PUBLIC_ID` is unset). If it exists, return
 * its publicId. If absent, create a new board with the supplied lane
 * names and return its publicId.
 *
 * `lanes` is taken as the authoritative list of column names. On an
 * existing board, the function validates that every requested lane is
 * present (case-insensitive) and logs a warning for any extras; it
 * does NOT add or reorder lanes — that's an operator-driven change.
 *
 * Returns:
 *   `{ publicId, created }` — `created` is true when this call
 *   provisioned the board, false when it pre-existed.
 *
 * Callers (MANDATE workflows) should store the returned `publicId` in
 * workflow state and use it for subsequent createCard / moveCardToLane
 * calls. The `name` argument is the human-readable label and need not
 * round-trip — Kan generates its own slug.
 */
export async function ensureBoard(
  boardName: string,
  lanes: string[],
  workspacePublicId?: string,
): Promise<{ publicId: string; created: boolean }> {
  if (!boardName) throw new Error("ensureBoard: boardName must be non-empty");
  if (!lanes?.length) throw new Error("ensureBoard: lanes must be non-empty");

  const wsId = workspacePublicId
    ?? config.MANDATE_WORKSPACE_PUBLIC_ID
    ?? await _firstWorkspaceId();

  // Look for an existing board by case-insensitive name match. We list
  // by workspace so the search is bounded.
  const boards = await kan.listBoards(wsId);
  const want = boardName.trim().toUpperCase();
  const existing = boards.find((b) => b.name.trim().toUpperCase() === want);
  if (existing) {
    // Validate lane coverage on the existing board. Missing lanes are
    // surfaced as a warning so operators can fix the board manually;
    // the bridge does not silently mutate existing boards.
    const have = new Set(
      (existing.lists ?? []).map((l) => l.name.trim().toUpperCase()),
    );
    const missing = lanes.filter((l) => !have.has(l.trim().toUpperCase()));
    if (missing.length) {
      log.warn(
        { board: boardName, publicId: existing.publicId, missing },
        "ensureBoard: existing board is missing requested lanes — leaving as-is",
      );
    }
    return { publicId: existing.publicId, created: false };
  }

  // Create it.
  const created = await kan.createBoard(wsId, boardName, lanes, []);
  log.info(
    { board: boardName, publicId: created.publicId, lanes, workspace: wsId },
    "ops.ensureBoard provisioned new board",
  );
  return { publicId: created.publicId, created: true };
}

async function _firstWorkspaceId(): Promise<string> {
  const wss = await kan.listWorkspaces();
  if (!wss.length) {
    throw new Error(
      "ensureBoard: bridge user has access to no workspaces; " +
        "set MANDATE_WORKSPACE_PUBLIC_ID env var or grant access",
    );
  }
  return wss[0]!.workspace.publicId;
}

// ---- read ---------------------------------------------------------------
export async function getCard(cardPublicId: string) {
  return kan.getCard(cardPublicId);
}
export async function getBoard(boardPublicId: string) {
  return kan.getBoard(boardPublicId);
}
export async function listBoards(workspacePublicId: string) {
  return kan.listBoards(workspacePublicId);
}
export async function listWorkspaces() {
  return kan.listWorkspaces();
}

// ---- write --------------------------------------------------------------
export async function postComment(cardPublicId: string, body: string) {
  // Idempotency: embed a comment-only token. Retries pre-check the card's
  // existing comments and skip if the same token is already there.
  const tok = idempotencyToken();
  const tagged = `${body}\n${idemTag(tok)}`;
  try {
    type CardWithComments = { comments?: { comment?: string; content?: string }[] };
    const c = (await kan.getCard(cardPublicId)) as unknown as CardWithComments;
    const dup = (c.comments ?? []).some((cm) =>
      (cm.comment ?? cm.content ?? "").includes(idemTag(tok)),
    );
    if (dup) {
      log.info({ cardPublicId, tok }, "ops.postComment dedup hit");
      return;
    }
  } catch {
    /* if pre-check fails, post anyway — duplicate beats silent miss */
  }
  log.info({ cardPublicId, body: body.slice(0, 80) }, "ops.postComment");
  return kan.postComment(cardPublicId, tagged);
}

export async function moveCardToLane(
  cardPublicId: string,
  boardPublicId: string,
  laneName: string,
): Promise<string> {
  const board = await kan.getBoard(boardPublicId);
  const list = board.lists.find(
    (l) => l.name.trim().toUpperCase() === laneName.trim().toUpperCase(),
  );
  if (!list) throw new Error(`Lane "${laneName}" not on board ${boardPublicId}`);
  await kan.moveCard(cardPublicId, list.publicId);
  log.info({ cardPublicId, boardPublicId, laneName }, "ops.moveCardToLane");
  return list.publicId;
}

export async function addLabel(
  cardPublicId: string,
  labelName: string,
  boardPublicId?: string,
) {
  const card = await kan.getCard(cardPublicId);
  if ((card.labels ?? []).some((l) => l.name.toUpperCase() === labelName.toUpperCase())) {
    return;
  }
  const boardId = boardPublicId ?? card.board?.publicId;
  if (!boardId)
    throw new Error("addLabel: pass boardPublicId — card response has no board");
  const board = await kan.getBoard(boardId);
  const lbl = board.labels.find((l) => l.name.toUpperCase() === labelName.toUpperCase());
  if (!lbl) throw new Error(`Label "${labelName}" not on board ${boardId}`);
  await kan.request("PUT", `/cards/${cardPublicId}/labels/${lbl.publicId}`);
  log.info({ cardPublicId, labelName, boardId }, "ops.addLabel");
}

export async function removeLabel(
  cardPublicId: string,
  labelName: string,
  boardPublicId?: string,
) {
  const card = await kan.getCard(cardPublicId);
  if (!(card.labels ?? []).some((l) => l.name.toUpperCase() === labelName.toUpperCase())) {
    return;
  }
  const boardId = boardPublicId ?? card.board?.publicId;
  if (!boardId)
    throw new Error("removeLabel: pass boardPublicId — card response has no board");
  const board = await kan.getBoard(boardId);
  const lbl = board.labels.find((l) => l.name.toUpperCase() === labelName.toUpperCase());
  if (!lbl) return;
  await kan.request("PUT", `/cards/${cardPublicId}/labels/${lbl.publicId}`);
  log.info({ cardPublicId, labelName, boardId }, "ops.removeLabel");
}

export async function createCard(
  boardPublicId: string,
  laneName: string,
  title: string,
  description?: string,
  labelNames?: string[],
): Promise<{ publicId: string }> {
  const board = await kan.getBoard(boardPublicId);
  const list = board.lists.find(
    (l) => l.name.trim().toUpperCase() === laneName.trim().toUpperCase(),
  );
  if (!list) throw new Error(`Lane "${laneName}" not on board ${boardPublicId}`);

  // Idempotency: bake the token into the description so a retried createCard
  // can locate any existing card with the same token and return it instead of
  // creating a duplicate.
  const tok = idempotencyToken();
  const taggedDesc = `${description ?? ""}\n\n${idemTag(tok)}`;

  // Pre-check: search the list's cards for the token.
  type ListWithCards = { cards?: { publicId: string; description?: string | null }[] };
  const lwc = list as unknown as ListWithCards;
  const dup = (lwc.cards ?? []).find((c) =>
    (c.description ?? "").includes(idemTag(tok)),
  );
  if (dup) {
    log.info({ boardPublicId, tok, publicId: dup.publicId }, "ops.createCard dedup hit");
    return { publicId: dup.publicId };
  }

  const labelPublicIds = (labelNames ?? [])
    .map((n) => board.labels.find((l) => l.name.toUpperCase() === n.toUpperCase())?.publicId)
    .filter((x): x is string => !!x);
  const card = await kan.request<{ publicId: string }>("POST", `/cards`, {
    title,
    description: taggedDesc,
    listPublicId: list.publicId,
    labelPublicIds,
    memberPublicIds: [],
    position: "end",
  });
  log.info({ boardPublicId, laneName, title, publicId: card.publicId }, "ops.createCard");
  return { publicId: card.publicId };
}

export async function setCardTitle(cardPublicId: string, title: string) {
  return kan.request("PUT", `/cards/${cardPublicId}`, { title });
}
export async function setCardDescription(cardPublicId: string, description: string) {
  return kan.request("PUT", `/cards/${cardPublicId}`, { description });
}
export async function setCardDueDate(cardPublicId: string, isoOrNull: string | null) {
  return kan.request("PUT", `/cards/${cardPublicId}`, { dueDate: isoOrNull });
}
export async function deleteCard(cardPublicId: string) {
  return kan.request("DELETE", `/cards/${cardPublicId}`);
}
