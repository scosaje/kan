import { kan } from "../kanClient.js";
import { log } from "../log.js";

/**
 * Activities — every side-effect that mutates Kan goes through here so the
 * workflow stays deterministic and replay-safe.
 */
export async function postComment(cardPublicId: string, body: string) {
  log.info({ cardPublicId, body: body.slice(0, 80) }, "post comment");
  return kan.postComment(cardPublicId, body);
}

export async function advanceCardToLane(
  cardPublicId: string,
  boardPublicId: string,
  laneName: string,
) {
  const board = await kan.getBoard(boardPublicId);
  const list = board.lists.find(
    (l) => l.name.trim().toUpperCase() === laneName.trim().toUpperCase(),
  );
  if (!list) throw new Error(`Lane "${laneName}" not found on board ${boardPublicId}`);
  log.info({ cardPublicId, boardPublicId, laneName, listPublicId: list.publicId }, "advance card");
  await kan.moveCard(cardPublicId, list.publicId);
  return list.publicId;
}

export async function fetchCard(cardPublicId: string) {
  return kan.getCard(cardPublicId);
}
