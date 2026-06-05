#!/usr/bin/env bash
# End-to-end smoke test for the Kan ↔ Temporal integration.
# Checks: web → bridge → agents → ANSA workflow round-trip → idempotent activities.
# Pass: exits 0. Fail: exits 1 with the failing check named.

set -u
WEB="${KAN_WEB_URL:-http://localhost:3030}"
BOARD="${KAN_TEST_BOARD:-dr9x5vu0qs9x}"
EMAIL="${KAN_OPERATOR_EMAIL:-sunny.osaje@gmail.com}"
PASSWORD="${KAN_OPERATOR_PASSWORD:-ChangeMe123!}"
PASS=0; FAIL=0
declare -a FAILED

ok()   { printf "  \033[32mok\033[0m   %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31mFAIL\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); FAILED+=("$1"); }
sect() { printf "\n\033[1m▸ %s\033[0m\n" "$1"; }

# ---- 1. kan-web reachable + login ---------------------------------------
sect "Kan web"
if curl -sS -o /dev/null -w "%{http_code}" "${WEB}/login" | grep -q '^200$'; then
  ok "GET /login"
else
  bad "GET /login"
fi

COOKIE_JAR=$(mktemp)
LOGIN=$(curl -sS -X POST "${WEB}/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' -H "Origin: ${WEB}" \
  -c "${COOKIE_JAR}" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}")
if echo "${LOGIN}" | grep -q '"token":'; then
  ok "Better-Auth credentials login"
else
  bad "Better-Auth credentials login (response: $(printf '%s' "${LOGIN}" | head -c 200))"
fi

if curl -sS -b "${COOKIE_JAR}" "${WEB}/api/v1/boards/${BOARD}" | grep -q "\"publicId\":\"${BOARD}\""; then
  ok "GET /api/v1/boards/${BOARD}"
else
  bad "GET /api/v1/boards/${BOARD}"
fi

# ---- 2. bridge healthz ---------------------------------------------------
sect "Temporal bridge"
HZ=$(docker exec kan-temporal-bridge curl -sS http://localhost:8090/healthz 2>/dev/null || true)
if echo "${HZ}" | grep -q '"ok":true'; then
  ok "bridge /healthz {ok:true}"
else
  bad "bridge /healthz (response: ${HZ:-no response})"
fi
echo "${HZ}" | grep -q '"card":"running"' && ok "card-tasks worker RUNNING" || bad "card-tasks worker not RUNNING"
echo "${HZ}" | grep -q '"ops":"running"'  && ok "kan-board-ops worker RUNNING" || bad "kan-board-ops worker not RUNNING"
echo "${HZ}" | grep -q '"kanSessionFresh":true' && ok "Kan session fresh" || bad "Kan session not fresh"

# ---- 3. webhook is registered -------------------------------------------
sect "Webhook registration"
if docker exec kan-db psql -U kan -d kan_db -tA \
   -c "SELECT count(*) FROM workspace_webhooks WHERE url='http://kan-temporal-bridge:8090/events' AND active=true" \
   | grep -qE '^[1-9]'; then
  ok "workspace_webhooks row present + active"
else
  bad "no active webhook row pointing at the bridge"
fi

# ---- 4. lane agents ------------------------------------------------------
sect "Lane agents"
SUPV=$(docker exec ansa-workflows node dist/agents/startSupervisor.js list --board "${BOARD}" 2>&1 || true)
for AGENT in DecisionalDebateAgent DynamicTargetingAgent PendingTaskingAgent ExecutionAgent AssessmentAgent; do
  if echo "${SUPV}" | grep -qE "RUNNING.*${AGENT}"; then
    ok "${AGENT} RUNNING"
  else
    bad "${AGENT} not RUNNING (try: docker exec ansa-workflows node dist/agents/startSupervisor.js start --board ${BOARD})"
  fi
done

# ---- 5. ANSA workflow end-to-end -----------------------------------------
sect "ANSA IsrDetectionToStrike (e2e)"
TS=$(date +%s)
TITLE="SMOKE-${TS} — smoke test target (ephemeral)"
ISR_OUT=$(docker exec ansa-workflows node dist/start.js \
  --board "${BOARD}" \
  --title "${TITLE}" \
  --detection "Smoke-test detection emitted at $(date -u +%FT%TZ)" \
  --labels "FLASH,FIND" \
  --auto 4 --auto-bda 2>&1 || true)
if echo "${ISR_OUT}" | grep -q "outcome: 'completed'"; then
  ok "workflow ran to completion"
  CARD_ID=$(echo "${ISR_OUT}" | grep -oE "cardPublicId: '[^']+'" | head -1 | sed -E "s/.*'([^']+)'.*/\1/")
  if [ -n "${CARD_ID}" ]; then
    LANE=$(curl -sS -b "${COOKIE_JAR}" "${WEB}/api/v1/cards/${CARD_ID}" \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('list',{}).get('name',''))")
    [ "${LANE}" = "DONE" ] && ok "card landed in DONE" || bad "card lane was '${LANE}' (expected DONE)"
  else
    bad "could not extract cardPublicId from start.js output"
  fi
else
  bad "ANSA workflow did not complete (output tail: $(echo "${ISR_OUT}" | tail -3))"
fi

# ---- 6. idempotency (postComment + createCard) ---------------------------
sect "Idempotency tokens in card body"
if [ -n "${CARD_ID:-}" ]; then
  DESC=$(curl -sS -b "${COOKIE_JAR}" "${WEB}/api/v1/cards/${CARD_ID}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('description') or '')")
  echo "${DESC}" | grep -q "<!--kan-idem:" && ok "createCard embedded kan-idem token" || bad "createCard description missing kan-idem token"
fi

# ---- 7. cleanup ----------------------------------------------------------
sect "Cleanup"
if [ -n "${CARD_ID:-}" ]; then
  curl -sS -X DELETE -b "${COOKIE_JAR}" "${WEB}/api/v1/cards/${CARD_ID}" > /dev/null && ok "test card archived" || bad "could not archive test card"
fi
rm -f "${COOKIE_JAR}"

# ---- summary -------------------------------------------------------------
echo
printf "\033[1mResult: %d passed, %d failed\033[0m\n" "${PASS}" "${FAIL}"
if [ "${FAIL}" -gt 0 ]; then
  printf "\nFailing checks:\n"
  printf "  • %s\n" "${FAILED[@]}"
  exit 1
fi
exit 0
