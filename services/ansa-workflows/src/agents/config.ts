import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

const ruleSchema = z.object({
  any_label: z.array(z.string()).optional(),
  all_labels: z.array(z.string()).optional(),
  to_lane: z.string().min(1),
  comment: z.string().optional(),
});

const autoAdvanceSchema = z.object({
  after_minutes: z.number().positive(),
  to_lane: z.string().min(1),
  comment: z.string().optional(),
});

export const agentConfigSchema = z.object({
  version: z.literal(1).optional().default(1),
  agent: z.string().min(1),
  lane: z.string().min(1),
  board_match: z.union([z.literal("any"), z.array(z.string())]).default("any"),
  mode: z.enum(["executor", "advisor"]).default("executor"),
  poll_interval_seconds: z.number().int().positive().default(30),
  sla_minutes: z.number().positive().optional(),
  on_card_arrived: z.object({ comment: z.string() }).optional(),
  on_sla_breach: z.object({ comment: z.string() }).optional(),
  advance: ruleSchema.optional(),
  auto_advance: autoAdvanceSchema.optional(),
  abort: ruleSchema.optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIRS = [
  path.resolve(__dirname, "../../agents"),
  path.resolve(__dirname, "../agents"),
];

export function loadAgentConfigs(): AgentConfig[] {
  const out: AgentConfig[] = [];
  for (const dir of AGENT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      const txt = fs.readFileSync(path.join(dir, f), "utf8");
      const raw = YAML.parse(txt);
      const parsed = agentConfigSchema.safeParse(raw);
      if (!parsed.success) {
        // eslint-disable-next-line no-console
        console.error(`agent config ${f} invalid:`, parsed.error.issues.slice(0, 3));
        continue;
      }
      out.push(parsed.data);
    }
  }
  return out;
}
