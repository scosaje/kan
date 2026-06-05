import { z } from "zod";

const envSchema = z.object({
  // Bridge
  BRIDGE_PORT: z.coerce.number().default(8090),
  BRIDGE_PUBLIC_URL: z.string().default("http://kan-temporal-bridge:8090"),
  BRIDGE_WEBHOOK_SECRET: z.string().min(16),
  LOG_LEVEL: z.string().default("info"),

  // Temporal
  TEMPORAL_ADDRESS: z.string().default("temporal-server:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("kan-card-tasks"),
  TEMPORAL_BOARD_OPS_QUEUE: z.string().default("kan-board-ops"),

  // Kan
  KAN_API_BASE: z.string().default("http://kan-web:3000/api/v1"),
  KAN_ADMIN_API_KEY: z.string().optional(),
  KAN_INTERNAL_EMAIL: z.string(),     // bot user used for REST callbacks
  KAN_INTERNAL_PASSWORD: z.string(),
  // Default workspace `ensureBoard` provisions into when the caller
  // doesn't pass one explicitly. Unset = first workspace visible to
  // the bridge user. Pin this in production once you've chosen the
  // workspace that owns MANDATE-driven boards.
  MANDATE_WORKSPACE_PUBLIC_ID: z.string().optional(),

  // Postgres (used only at bootstrap to register the webhook directly,
  // bypassing Kan's SSRF guard for internal docker-network URLs)
  POSTGRES_URL: z.string(),
});

export const config = envSchema.parse(process.env);
export type Config = typeof config;
