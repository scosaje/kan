# Kan ↔ Temporal Bridge

A small adapter that turns Kan webhook events into Temporal workflow signals
(and back), so any Kan card can drive an operational workflow.

## How it works

1. The bridge registers a webhook on every workspace it can see (idempotent,
   self-healing every 5 minutes). The webhook URL points at the bridge itself.
2. It also creates a label called `WORKFLOW` (cyan) on every board.
   **Users opt cards into Temporal by ticking that label** — anything without it
   is ignored.
3. When an opt-in card is touched (created/moved/updated), the bridge starts
   `KanCardWorkflow` with `workflowId = kan-card:{cardPublicId}`. Subsequent
   events become signals (`laneChanged`, `labelAdded`, …) on the same workflow.
4. The workflow drives the card through lanes per a YAML policy. The policy
   chosen depends on the board's lane shape — `policies/targeting-kill-chain.yaml`
   matches any board that has at least 4 of the F2T2EA lanes
   (`DECISIONAL DEBATE`, `DYNAMIC TARGETING`, `PENDING TASKING`,
   `IN EXECUTION`, `PERIODICAL ASSESSMENT`, `COMPLETED`).
   Drop more files into `policies/` to support new board shapes — no code change.
5. The workflow's activities call back into Kan's REST API to post comments,
   move the card to the next lane, etc. — fully bidirectional.

## Triggering a workflow from the UI

1. Open a card on the test board.
2. Click `+ Add label` on the right rail and pick `WORKFLOW`.
3. The bridge's next event will start a Temporal workflow for that card.
   Watch it in the Temporal UI at <http://localhost:8088>.

## Environment

| Var | Purpose |
|---|---|
| `BRIDGE_PORT` | HTTP port (default 8090) |
| `BRIDGE_PUBLIC_URL` | URL Kan posts events to (default `http://kan-temporal-bridge:8090`) |
| `BRIDGE_WEBHOOK_SECRET` | HMAC-SHA256 secret used for signature checks |
| `TEMPORAL_ADDRESS` | `host:port` (default `temporal-server:7233`) |
| `TEMPORAL_NAMESPACE` | default `default` |
| `TEMPORAL_TASK_QUEUE` | default `kan-card-tasks` |
| `KAN_API_BASE` | `http://kan-web:3000/api/v1` |
| `KAN_INTERNAL_EMAIL` / `KAN_INTERNAL_PASSWORD` | credentials of a **dedicated** Kan service account with admin role on every workspace. **Do not reuse a human operator account** — if that user is disabled, the bridge stops. The local-dev account is `kan-bridge@svc.kan.local`. To provision a new one in another environment: sign up via `/api/auth/sign-up/email`, then `INSERT` a `workspace_members` row with `role='admin', status='active', roleId=<admin role id>` for each workspace the bridge should see. |
| `POSTGRES_URL` | only used at bootstrap to insert the webhook row directly (bypasses Kan's SSRF guard for in-cluster URLs) |

## Adding a new policy

Drop a YAML file into `policies/` (or mount one read-only into the container).
Each policy declares:

```yaml
name: <id>
match:
  any_lanes: ["LANE A", "LANE B", ...]
  min_matches: 3
trigger_label: WORKFLOW
lanes:
  "LANE A":
    on_enter: [{ kind: comment, body: "..." }]
    wait_for_label: ROE-CLEARED
    on_label: { advance_to: "LANE B", comment: "..." }
  "LANE B":
    auto_advance_after_minutes: 5
    next_lane: "LANE C"
  "LANE C":
    terminal: true
```

The bridge picks the first policy whose `match` predicate fits the board.
