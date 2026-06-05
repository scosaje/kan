# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative agent doc

`AGENTS.md` in this directory is the canonical guide for code style, naming, database/API/frontend patterns, soft-deletion rules, activity logging, authorization, and the workflow for adding features, env vars, and migrations. Read it before making non-trivial changes; this file only covers what AGENTS.md does not.

## Repo layout

Single repo at `kan/` (no nested git roots). Treat `kan/` as the project root for all `pnpm` commands.

Monorepo managed by **pnpm workspaces + Turbo**. Workspaces are declared in `pnpm-workspace.yaml`:

- `apps/web` — Next.js 15 app (Pages Router, `--turbo`), Tailwind, Lingui i18n, tRPC client, Better Auth, react-beautiful-dnd, TipTap.
- `apps/docs` — docs site.
- `packages/api` — tRPC routers + OpenAPI bridge (`trpc-to-openapi`). Single `appRouter` composed in `src/root.ts`. Procedures: `publicProcedure`, `protectedProcedure` (see `src/trpc.ts`).
- `packages/db` — Drizzle ORM schema (`src/schema/`), repositories (`src/repository/*.repo.ts`), migrations (`migrations/`), Postgres client (`src/client.ts`), Redis (`src/redis.ts`).
- `packages/auth` — Better Auth config (consumed by API and web).
- `packages/email`, `packages/stripe`, `packages/logger`, `packages/shared` — supporting packages.
- `tooling/{eslint,prettier,tailwind,typescript}` — shared configs consumed via `workspace:*`.

Catalog versions (React 18, tRPC 11, Tailwind 3, Zod, TS) are pinned in `pnpm-workspace.yaml` — reference them as `"catalog:"` / `"catalog:react18"` in `package.json`, do not pin individually.

## Commands

Run from repo root unless noted. All `dev`/`build`/`lint`/`typecheck` go through Turbo and respect the dependency graph.

```bash
pnpm install              # install + auto-runs `pnpm lint:ws` (sherif) postinstall
pnpm dev                  # turbo watch dev --continue (all apps + watched packages)
pnpm dev:next             # web app + its deps only
pnpm build                # turbo build
pnpm lint                 # eslint across workspaces (cached)
pnpm lint:fix
pnpm typecheck            # tsc --noEmit across workspaces
pnpm format / pnpm format:fix
pnpm db:migrate           # runs drizzle-kit migrate via packages/db (loads ../../.env)
pnpm db:push              # drizzle-kit push (dev-only schema sync)
pnpm db:studio            # drizzle-kit studio
```

Single-test runs (vitest exists in `packages/api` and `apps/web`):

```bash
# from packages/api
pnpm test                                        # vitest run (unit + integration)
pnpm test:watch
pnpm vitest run src/path/to/file.test.ts         # single file
pnpm vitest run -t "name of test"                # filter by test name

# from apps/web
pnpm test
```

`packages/api/vitest.config.ts` aliases `@kan/db` to `../db/src` so tests resolve workspace TS source directly. Integration tests live in `packages/api/integration-tests/` (e.g. `webhook.integration.test.ts`) and use `test-db.ts`.

Creating migrations (do not edit existing ones):

```bash
cd packages/db && pnpm drizzle-kit generate --name "DescriptiveName"
pnpm db:migrate
```

UI components via shadcn/registry: `pnpm ui-add` (interactive turbo task).

## Environment

- Node `>=20.18.1`, pnpm `9.14.2` (enforced in root `package.json`).
- Env vars are loaded from repo-root `.env` via `dotenv -e ../../.env --` in package scripts (`with-env`).
- Adding a new env var requires updating five places — see "Adding a New Environment Variable" in `AGENTS.md` (`.env.example`, `turbo.json` `globalEnv`, both `docker-compose.yml` files, README table).

## Architecture notes (big picture)

- **Request flow:** Next.js page/component → tRPC React Query hook (`apps/web`) → tRPC handler in Next API route → `appRouter` in `packages/api/src/root.ts` → router in `packages/api/src/routers/*.ts` → repo function in `packages/db/src/repository/*.repo.ts` → Drizzle → Postgres. Auth/session is attached in tRPC context (`packages/api/src/trpc.ts`) via Better Auth's `getSession`.
- **OpenAPI:** every tRPC procedure should carry `.meta({ openapi: ... })`; `packages/api/src/openapi.ts` exposes the generated spec, enabling REST-style consumers alongside the tRPC client.
- **IDs:** internal numeric `id` columns are never exposed externally — all user-facing entities use a 12-char `publicId`. When writing queries/inputs/responses, take and return `publicId`.
- **Soft delete + indices:** queries must filter `isNull(table.deletedAt)`. Cards have a per-list sequential `index` that must be maintained on insert/move/delete inside a transaction. Most card mutations also write a `card_activity` row.
- **Logging:** use `createLogger("module-name")` from `@kan/logger`, never `console.log`. Level controlled by `LOG_LEVEL`.
- **i18n:** all user-facing strings in `apps/web` go through Lingui's `t` macro; run `pnpm lingui:extract` (from `apps/web`) to regenerate locale catalogs in `apps/web/src/locales/`.

## Temporal integration (bridge + agents)

There are **three** services on top of the stock Kan app, all under `services/`:

```
kan-temporal-bridge   webhook receiver + per-card workflow + reusable kan-board-ops activities
ansa-workflows        sample ANSA workflow (IsrDetectionToStrike) + 5 specialised lane agents + supervisor CLI
                      (the kan-board-ops *activities* are hosted by the bridge; ansa-workflows
                      runs *workflows* that call them via `proxyActivities({ taskQueue: "kan-board-ops" })`)
```

### Three layers of automation

1. **Per-card `KanCardWorkflow`** (queue: `kan-card-tasks`, in the bridge). Started automatically when a card is tagged `WORKFLOW`. Drives that single card per a YAML policy in `services/temporal-bridge/policies/`.
2. **Per-lane `LaneAgentWorkflow`** (queue: `ansa-mandate`). One long-running agent per `(boardPublicId, lane)` tuple (id: `lane-agent:{boardId}:{LANE-WITH-DASHES}` — use `agentWorkflowId()`). Watches every card entering its lane; YAML configs under `services/ansa-workflows/agents/`. Running agents are started with the supervisor CLI:
   ```
   docker exec ansa-workflows node dist/agents/startSupervisor.js start --board <boardPublicId>
   ```
3. **External workflows** (any team's, e.g. ANSA, MANDATE, sis-main). They `proxyActivities` against the public `kan-board-ops` queue. The 13 stable activities are documented in `services/temporal-bridge/src/temporal/board-ops.ts`.

### Coexistence rules

- A card **with** the `WORKFLOW` label is owned by the per-card workflow. Lane agents in `executor` mode automatically *yield* and post `[agent yielding to per-card workflow]` comments instead of moving it. (Implemented in `laneAgent.ts`.)
- A card **without** `WORKFLOW` is fair game for the lane agents (in executor mode). If a MANDATE / external workflow already drives such cards, set the affected agents to `mode: advisor` in their YAMLs (see `/home/sco/claude-projects/mandate/docs/integration/MANDATE-KAN-AGENT-MODE-NOTE.md`).

### Webhook-payload publicId rule

Kan's `card.created`/`updated`/`moved`/`deleted` webhooks carry the **public 12-char id**, not the internal numeric id (fixed at `card.ts:237, 1134, 1229`). The bridge filters anything < 12 chars defensively. If you ever change the webhook payload shape, keep the public id — the bridge dispatch dispatches off it.

### Workflow ids you'll see

- `kan-card:{cardPublicId}` — per-card workflow (one per opt-in card)
- `lane-agent:{boardPublicId}:{LANE-WITH-DASHES}` — lane agent (one per `(board, lane)` tuple)
- `ansa-isr:{epoch_ms}` — sample ANSA `IsrDetectionToStrike` runs

### Webhooks + SSRF allowlist

The bridge auto-registers a webhook per workspace (direct DB insert in `registration.ts`, idempotent, single-flight, retries every 5 min). The bridge URL is HTTP on the docker network, which Kan's webhook delivery would normally reject — `KAN_WEBHOOK_INTERNAL_HOSTS` (env on the web container, default `kan-temporal-bridge`) is the allowlist that bypasses the HTTPS+private-IP guards for that hostname only.

### Service account

Bridge → Kan is a Better-Auth session-cookie login as `kan-bridge@svc.kan.local` (a workspace admin, **not** the operator account). Provisioning is in `services/temporal-bridge/README.md`.

### Health

- `http://kan-temporal-bridge:8090/healthz` reports both worker states (`card`, `ops`), `lastKanLoginAgoMs`, `kanSessionFresh`, `uptimeSec`. 503 if either worker isn't running.
- `services/temporal-bridge/Dockerfile` ships a `HEALTHCHECK` curl probe against the same endpoint.

### Adding things

| Want to | Touch |
|---|---|
| Add a new policy for a new board shape | drop a YAML in `services/temporal-bridge/policies/`, restart the bridge |
| Add a new lane agent | YAML in `services/ansa-workflows/agents/`, restart `ansa-workflows`, re-run `supervisor start` |
| Add a new ANSA workflow | new file under `services/ansa-workflows/src/workflows/`, re-export from `workflowsEntry.ts`, rebuild |
| Add a new activity to the public surface | add to `services/temporal-bridge/src/temporal/board-ops.ts` and rebuild the bridge |

### Smoke test

```
bash /home/sco/kaban-system/kan/scripts/smoke-test.sh
```

Probes `kan-web`, the bridge `/healthz`, the supervisor `list`, and runs one ANSA workflow + one agent-only run end-to-end.

## Before committing

`pnpm lint` and `pnpm typecheck` are required (per AGENTS.md and CONTRIBUTING.md). Conventional commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`).
