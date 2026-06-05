import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import { log } from "./log.js";
import type { KanBoard } from "./kanClient.js";

const policyActionSchema = z.object({
  kind: z.literal("comment"),
  body: z.string().min(1),
});

const laneRulesSchema = z.object({
  on_enter: z.array(policyActionSchema).optional(),
  wait_for_lane: z.array(z.string().min(1)).optional(),
  wait_for_label: z.string().min(1).optional(),
  on_label: z
    .object({
      advance_to: z.string().min(1).optional(),
      comment: z.string().min(1).optional(),
    })
    .optional(),
  timeout_minutes: z.number().int().positive().optional(),
  on_timeout: policyActionSchema.optional(),
  auto_advance_after_minutes: z.number().int().positive().optional(),
  next_lane: z.string().min(1).optional(),
  terminal: z.boolean().optional(),
});

const policySchema = z.object({
  // Optional version for future schema evolution; defaults to 1.
  version: z.literal(1).optional().default(1),
  name: z.string().min(1),
  match: z.object({
    any_lanes: z.array(z.string().min(1)).min(1),
    min_matches: z.number().int().positive(),
  }),
  trigger_label: z.string().min(1),
  lanes: z.record(z.string(), laneRulesSchema),
});

export type PolicyAction = z.infer<typeof policyActionSchema>;
export type LaneRules = z.infer<typeof laneRulesSchema>;
export type Policy = z.infer<typeof policySchema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIRS = [
  path.resolve(__dirname, "../policies"),
  path.resolve(__dirname, "../../policies"),
];

let policies: Policy[] | null = null;

function loadPolicies(): Policy[] {
  if (policies) return policies;
  const out: Policy[] = [];
  for (const dir of POLICY_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const txt = fs.readFileSync(path.join(dir, f), "utf8");
      let raw: unknown;
      try {
        raw = YAML.parse(txt);
      } catch (e) {
        log.error({ file: f, err: (e as Error).message }, "policy parse failed — skipping");
        continue;
      }
      const parsed = policySchema.safeParse(raw);
      if (!parsed.success) {
        log.error(
          { file: f, issues: parsed.error.issues.slice(0, 5) },
          "policy validation failed — skipping",
        );
        continue;
      }
      out.push(parsed.data);
      log.info({ policy: parsed.data.name, file: f }, "policy loaded");
    }
  }
  policies = out;
  return out;
}

/** Pick the first policy whose `match` predicate fits the board. */
export function policyForBoard(board: KanBoard): Policy | null {
  const laneNames = new Set(board.lists.map((l) => l.name.trim().toUpperCase()));
  for (const p of loadPolicies()) {
    const matches = p.match.any_lanes.filter((n) =>
      laneNames.has(n.trim().toUpperCase()),
    ).length;
    if (matches >= p.match.min_matches) return p;
  }
  return null;
}

/** Find the lane rules for a card's current lane (case-insensitive). */
export function laneRules(policy: Policy, laneName: string): LaneRules | null {
  const want = laneName.trim().toUpperCase();
  for (const [k, v] of Object.entries(policy.lanes)) {
    if (k.trim().toUpperCase() === want) return v;
  }
  return null;
}
