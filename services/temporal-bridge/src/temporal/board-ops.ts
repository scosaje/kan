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
import { ApplicationFailure, Context } from "@temporalio/activity";
import { config } from "../config.js";
import { kan, KanHttpError, type KanCard } from "../kanClient.js";
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
    ?? (config.MANDATE_WORKSPACE_PUBLIC_ID || await _firstWorkspaceId());

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

// ---- card not found -----------------------------------------------------
/**
 * Failure type for a card Kan says does not exist (deleted, or never was).
 * It is non-retryable: retrying cannot bring the card back. Callers that
 * track cards (LaneAgentWorkflow) match on this type and stop tracking.
 */
export const KAN_CARD_NOT_FOUND = "KanCardNotFound";

async function onCard<T>(cardPublicId: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (
      e instanceof KanHttpError &&
      e.status === 404 &&
      e.path.startsWith(`/cards/${cardPublicId}`)
    ) {
      throw ApplicationFailure.nonRetryable(e.message, KAN_CARD_NOT_FOUND);
    }
    throw e;
  }
}

// ---- read ---------------------------------------------------------------
export async function getCard(cardPublicId: string) {
  return onCard(cardPublicId, () => kan.getCard(cardPublicId));
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
  try {
    if (hasComment(await kan.getCard(cardPublicId), idemTag(tok))) {
      log.info({ cardPublicId, tok }, "ops.postComment dedup hit");
      return;
    }
  } catch {
    /* if pre-check fails, post anyway — duplicate beats silent miss */
  }
  log.info({ cardPublicId, body: body.slice(0, 80) }, "ops.postComment");
  return onCard(cardPublicId, () => kan.postComment(cardPublicId, `${body}\n${idemTag(tok)}`));
}

/** True when one of the card's comments carries `tag`. */
function hasComment(card: KanCard, tag: string): boolean {
  return (card.activities ?? []).some((a) => (a.comment?.comment ?? "").includes(tag));
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
  await onCard(cardPublicId, () => kan.moveCard(cardPublicId, list.publicId));
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

/**
 * Create the labels in `labels` that the board lacks (name match is
 * case-insensitive; an existing label keeps its colour). createCard and
 * addLabel only attach labels the board already has — createCard silently
 * drops unknown names — so a workflow gives a board its palette with this
 * first. Idempotent.
 *
 * ponytail: check-then-create, so two workflows racing on a brand-new board
 * can both create a label; Kan then shows it twice and lookups take the
 * first. A per-board lock if that ever matters.
 */
export async function ensureLabels(
  boardPublicId: string,
  labels: { name: string; colour: string }[],
): Promise<{ created: string[] }> {
  const board = await kan.getBoard(boardPublicId);
  const have = new Set((board.labels ?? []).map((l) => l.name.trim().toUpperCase()));
  const created: string[] = [];
  for (const { name, colour } of labels ?? []) {
    const key = (name ?? "").trim().toUpperCase();
    if (!key || have.has(key)) continue;
    await kan.createLabel(boardPublicId, name.trim(), colour);
    have.add(key);
    created.push(name.trim());
  }
  if (created.length) log.info({ boardPublicId, created }, "ops.ensureLabels");
  return { created };
}

export async function createCard(
  boardPublicId: string,
  laneName: string,
  title: string,
  description?: string,
  labelNames?: string[],
  key?: string,
): Promise<{ publicId: string }> {
  const board = await kan.getBoard(boardPublicId);
  const list = board.lists.find(
    (l) => l.name.trim().toUpperCase() === laneName.trim().toUpperCase(),
  );
  if (!list) throw new Error(`Lane "${laneName}" not on board ${boardPublicId}`);

  // Idempotency: bake the token into the description so a retried createCard
  // can locate any existing card with the same token and return it instead of
  // creating a duplicate. A caller `key` (stable across reconciler replays,
  // which run under a fresh workflow id) wins over the activity's own token.
  const tok = key || idempotencyToken();
  const taggedDesc = `${description ?? ""}\n\n${idemTag(tok)}`;

  // Pre-check every lane: the card may have moved on since a first attempt.
  type CardLite = { publicId: string; description?: string | null };
  const dup = board.lists
    .flatMap((l) => ((l as unknown as { cards?: CardLite[] }).cards ?? []))
    .find((c) => (c.description ?? "").includes(idemTag(tok)));
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

// ---- one workflow action, one call ----------------------------------------

/** What a workflow action wants the card to look like afterwards. */
export interface CardSync {
  lane?: string;
  addLabels?: string[];
  removeLabels?: string[];
  title?: string;
  description?: string;
  comment?: string;
}

const META_BLOCK_RE = /<!--mandate-meta:[\s\S]*?-->/;
const IDEM_BLOCK_RE = /<!--kan-idem:[\s\S]*?-->/g;

/**
 * `next` with the hidden blocks of `prev` it lacks put back: the
 * mandate-meta block (without it operator drags stop reaching the workflow)
 * and the kan-idem tag (without it a replayed createCard makes a duplicate).
 */
export function keepHiddenBlocks(next: string, prev: string | null | undefined): string {
  let out = next;
  const meta = (prev ?? "").match(META_BLOCK_RE)?.[0];
  if (meta && !META_BLOCK_RE.test(out)) out = `${out.trimEnd()}\n\n${meta}`;
  for (const tag of (prev ?? "").match(IDEM_BLOCK_RE) ?? []) {
    if (!out.includes(tag)) out = `${out.trimEnd()}\n\n${tag}`;
  }
  return out;
}

/**
 * Bring a card to the state one workflow action wants, from a single read:
 * GET /cards/{id} already carries the card's lane, its labels and comments,
 * and the board's lanes and labels. Then write only what differs — move if
 * in another lane, toggle only labels whose presence differs, rewrite
 * title/description only if changed, comment only if no comment carries
 * `key`. A retry or a reconciler replay with the same key converges on the
 * same card instead of repeating the action (about 5 Kan requests per rich
 * action instead of about 14).
 *
 * Labels the board lacks are skipped, as createCard does. Returns what it
 * changed.
 */
export async function syncCard(
  cardPublicId: string,
  boardPublicId: string,
  spec: CardSync,
  key?: string,
): Promise<{ changed: string[] }> {
  const card = await onCard(cardPublicId, () => kan.getCard(cardPublicId));
  const board = card.list?.board;
  const up = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();
  const changed: string[] = [];

  if (spec.lane && up(card.list?.name) !== up(spec.lane)) {
    const list = board?.lists.find((l) => up(l.name) === up(spec.lane));
    if (!list) throw new Error(`Lane "${spec.lane}" not on board ${boardPublicId}`);
    await onCard(cardPublicId, () => kan.moveCard(cardPublicId, list.publicId));
    changed.push(`lane:${list.name}`);
  }

  const has = new Set((card.labels ?? []).map((l) => up(l.name)));
  const toggles = [
    ...(spec.addLabels ?? []).filter((n) => !has.has(up(n))).map((n) => ["+", n] as const),
    ...(spec.removeLabels ?? []).filter((n) => has.has(up(n))).map((n) => ["-", n] as const),
  ];
  for (const [sign, name] of toggles) {
    const lbl = board?.labels.find((l) => up(l.name) === up(name));
    if (!lbl) continue;
    // Kan's label endpoint toggles; presence was checked above.
    await onCard(cardPublicId, () =>
      kan.request("PUT", `/cards/${cardPublicId}/labels/${lbl.publicId}`),
    );
    changed.push(`${sign}${lbl.name}`);
  }

  const patch: { title?: string; description?: string } = {};
  if (spec.title && spec.title !== card.title) patch.title = spec.title;
  if (spec.description != null) {
    const next = keepHiddenBlocks(spec.description, card.description);
    if (next !== (card.description ?? "")) patch.description = next;
  }
  if (Object.keys(patch).length) {
    await onCard(cardPublicId, () => kan.request("PUT", `/cards/${cardPublicId}`, patch));
    changed.push(...Object.keys(patch));
  }

  if (spec.comment) {
    const tag = idemTag(key || idempotencyToken());
    if (!hasComment(card, tag)) {
      await onCard(cardPublicId, () => kan.postComment(cardPublicId, `${spec.comment}\n${tag}`));
      changed.push("comment");
    }
  }

  log.info({ cardPublicId, boardPublicId, changed }, "ops.syncCard");
  return { changed };
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
