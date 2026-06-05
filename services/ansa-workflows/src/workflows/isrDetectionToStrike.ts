/**
 * ANSA test workflow — IsrDetectionToStrike.
 *
 * Simulates the ANSA pipeline for a newly-detected target on the Nigeria
 * Operations board:
 *
 *     1. ISR detection ingested  →  create card in DEBATE
 *     2. NIPSS staff work        →  ROE-CLEARED label applied
 *     3. Tasking / strike        →  card walks TASKING → EXECUTING
 *     4. BDA collection          →  ASSESS lane + ASSESS label → DONE
 *
 * Every Kan side-effect goes through activities on the public `kan-board-ops`
 * task queue — i.e. this workflow has zero Kan code dependency. Any other
 * service in the cluster could host an identical workflow.
 *
 * The workflow accepts signals so a real ANSA system (or operator) can pause
 * / resume / abort the pipeline mid-flight:
 *
 *     - decisionMade(advance: boolean)        → resolves the DEBATE wait
 *     - bdaReceived(summary: string)          → drives ASSESS → DONE
 *     - abort(reason: string)                 → posts comment + closes
 */
import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  sleep,
  log as wfLog,
} from "@temporalio/workflow";

// We import the activity *types* only — the actual implementations live in the
// kan-temporal-bridge service and are routed by Temporal via the queue name.
type KanBoardOps = {
  postComment(cardPublicId: string, body: string): Promise<unknown>;
  moveCardToLane(
    cardPublicId: string,
    boardPublicId: string,
    laneName: string,
  ): Promise<string>;
  addLabel(
    cardPublicId: string,
    labelName: string,
    boardPublicId?: string,
  ): Promise<void>;
  removeLabel(
    cardPublicId: string,
    labelName: string,
    boardPublicId?: string,
  ): Promise<void>;
  createCard(
    boardPublicId: string,
    laneName: string,
    title: string,
    description?: string,
    labelNames?: string[],
  ): Promise<{ publicId: string }>;
};

const kan = proxyActivities<KanBoardOps>({
  taskQueue: "kan-board-ops",
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 4 },
});

export interface IsrDetectionInput {
  boardPublicId: string;
  /** e.g. "TGT-NG-0732 — ISWAP technical, Marte-Dikwa axis" */
  targetTitle: string;
  /** Free-text description visible on the Kan card */
  detection: string;
  /** Label names to attach (must already exist on the board) */
  initialLabels?: string[];
  /** When provided, auto-decision after this many seconds */
  autoAdvanceSeconds?: number;
}

export const decisionMadeSignal = defineSignal<[boolean]>("decisionMade");
export const bdaReceivedSignal = defineSignal<[string]>("bdaReceived");
export const abortSignal = defineSignal<[string]>("abort");

export async function IsrDetectionToStrike(input: IsrDetectionInput): Promise<{
  outcome: "completed" | "aborted";
  cardPublicId: string;
}> {
  let decision: boolean | null = null;
  let bda: string | null = null;
  let abortReason: string | null = null;

  setHandler(decisionMadeSignal, (advance) => {
    wfLog.info("decisionMade", { advance });
    decision = advance;
  });
  setHandler(bdaReceivedSignal, (summary) => {
    wfLog.info("bdaReceived");
    bda = summary;
  });
  setHandler(abortSignal, (reason) => {
    wfLog.info("abort", { reason });
    abortReason = reason;
  });

  // ---------- 1. Create the card --------------------------------------------
  const card = await kan.createCard(
    input.boardPublicId,
    "DEBATE",
    input.targetTitle,
    [
      "**ANSA ISR DETECTION**",
      "",
      input.detection,
      "",
      `_Workflow: ${"IsrDetectionToStrike"}_`,
    ].join("\n"),
    input.initialLabels ?? ["FLASH", "FIND"],
  );
  wfLog.info("card created", { cardPublicId: card.publicId });

  await kan.postComment(
    card.publicId,
    "ANSA pipeline opened — awaiting NCA / JFLCC decision (signal: `decisionMade`).",
  );

  // ---------- 2. Wait for the decision (or auto-advance) --------------------
  const deadlineSec = input.autoAdvanceSeconds ?? 0;
  if (deadlineSec > 0) {
    wfLog.info(`auto-advance armed: ${deadlineSec}s`);
  }

  const decided = () => decision !== null || abortReason !== null;
  let got = true;
  if (deadlineSec > 0) {
    got = await condition(decided, `${deadlineSec} seconds`);
  } else {
    await condition(decided);
  }
  if (abortReason) {
    await kan.postComment(card.publicId, `Workflow aborted: ${abortReason}`);
    return { outcome: "aborted", cardPublicId: card.publicId };
  }
  if (!got || decision === null) {
    decision = true;
    await kan.postComment(card.publicId, "Auto-advance: no decision signal in window — proceeding.");
  } else {
    await kan.postComment(
      card.publicId,
      decision ? "Decision: ADVANCE." : "Decision: HOLD.",
    );
  }
  if (!decision) {
    return { outcome: "aborted", cardPublicId: card.publicId };
  }

  // ---------- 3. Push through the kill chain --------------------------------
  await kan.moveCardToLane(card.publicId, input.boardPublicId, "DYNAMIC");
  await kan.postComment(card.publicId, "F2T2EA loop opened — fix/track in progress.");
  await sleep("4 seconds");

  await kan.moveCardToLane(card.publicId, input.boardPublicId, "TASKING");
  await kan.postComment(card.publicId, "Tasking queued — awaiting strike package.");
  await sleep("4 seconds");

  await kan.addLabel(card.publicId, "ROE-CLEARED", input.boardPublicId);
  await kan.postComment(card.publicId, "ROE cleared by JTAC — releasing weapons authority.");
  await kan.moveCardToLane(card.publicId, input.boardPublicId, "EXECUTING");
  await kan.postComment(card.publicId, "Strike in progress — TOT 0.");
  await sleep("6 seconds");

  // ---------- 4. BDA loop ---------------------------------------------------
  await kan.moveCardToLane(card.publicId, input.boardPublicId, "ASSESS");
  await kan.postComment(
    card.publicId,
    "BDA window open — awaiting hyperspectral / FMV (signal: `bdaReceived`).",
  );

  await condition(() => bda !== null || abortReason !== null, "10 minutes");
  if (abortReason) {
    await kan.postComment(card.publicId, `Workflow aborted at BDA: ${abortReason}`);
    return { outcome: "aborted", cardPublicId: card.publicId };
  }
  const summary = bda ?? "BDA timeout — auto-confirming functional kill.";
  await kan.postComment(card.publicId, `BDA: ${summary}`);
  await kan.addLabel(card.publicId, "ASSESS", input.boardPublicId);
  await kan.moveCardToLane(card.publicId, input.boardPublicId, "DONE");
  await kan.postComment(card.publicId, "Card closed by ANSA pipeline. Workflow complete.");
  return { outcome: "completed", cardPublicId: card.publicId };
}
