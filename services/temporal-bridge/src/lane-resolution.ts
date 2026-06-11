/**
 * fromLane resolution for `card.moved` webhooks.
 *
 * Kan's real payload encodes a move as `changes.listId = {from, to}` where
 * both sides are list *publicIds* (see packages/api card.update — it never
 * sends the source lane's name). The bridge needs the lane NAME to build
 * the `FROM->TO` transition key, so the publicId is resolved against the
 * board's lists. The `changes.list.from.name` shape is preferred when
 * present (synthetic/test payloads) and costs no board fetch.
 */

export interface KanWebhookChangeSet {
  [k: string]: { from: unknown; to: unknown } | undefined;
}

export interface BoardLists {
  lists: { publicId: string; name: string }[];
}

/**
 * Lane the card just arrived in, for lane-agent fan-out. A card "arrives"
 * in a lane when it is moved there OR created there in-place (mandate's
 * nomination cards land directly in NOMINATED and never produce a
 * card.moved). Updates and deletes are not arrivals.
 */
export function laneArrivalLane(
  event: string,
  list: { name: string } | undefined,
): string | undefined {
  if (event !== "card.moved" && event !== "card.created") return undefined;
  return list?.name;
}

// Pull the source lane name out of `changes.list.from.name`.
export function readListChangeFromName(
  changes: KanWebhookChangeSet | undefined,
): string | undefined {
  if (!changes) return undefined;
  const listChange = changes.list;
  if (!listChange || typeof listChange !== "object") return undefined;
  const from = (listChange as { from?: unknown }).from;
  if (!from || typeof from !== "object") return undefined;
  const name = (from as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

// Pull the source list publicId out of `changes.listId.from`.
export function readListChangeFromId(
  changes: KanWebhookChangeSet | undefined,
): string | undefined {
  if (!changes) return undefined;
  const listIdChange = changes.listId;
  if (!listIdChange || typeof listIdChange !== "object") return undefined;
  const from = (listIdChange as { from?: unknown }).from;
  return typeof from === "string" ? from : undefined;
}

/**
 * Resolve the source lane name for a card move, trying the direct name
 * shape first and falling back to a board lookup for the real Kan
 * publicId shape. Returns undefined (never throws) when the payload has
 * no move information or the lookup fails — callers already treat a
 * missing fromLane as "cannot validate transition".
 */
export async function resolveFromLaneName(
  changes: KanWebhookChangeSet | undefined,
  boardPublicId: string,
  getBoard: (boardPublicId: string) => Promise<BoardLists>,
): Promise<string | undefined> {
  const direct = readListChangeFromName(changes);
  if (direct) return direct;

  const fromId = readListChangeFromId(changes);
  if (!fromId) return undefined;

  try {
    const board = await getBoard(boardPublicId);
    return board.lists.find((l) => l.publicId === fromId)?.name;
  } catch {
    return undefined;
  }
}
