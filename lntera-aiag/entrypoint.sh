#!/bin/sh
# Container entrypoint: start the Mastra server, and (best-effort) trigger an Inngest sync so any
# functions added/changed in THIS deploy register with Inngest Cloud automatically — no manual "Sync"
# click in the dashboard. The PUT to localhost/inngest makes the SDK re-register with Cloud; serveOrigin
# (src/mastra/inngest/serve-route.ts) ensures the registered callback URL is the PUBLIC origin, so a
# localhost trigger is safe and avoids a rolling-deploy race. The sync NEVER blocks or kills the server.
#
# Disable with INNGEST_AUTO_SYNC=0. Requires INNGEST_EVENT_KEY/INNGEST_SIGNING_KEY (prod) for the
# register to succeed; without them the PUT just fails quietly and the server runs normally.

if [ "${INNGEST_AUTO_SYNC:-1}" = "1" ]; then
  (
    # Poll the local server until it answers, then PUT /inngest to register. ~40 tries x 5s = ~3.5 min.
    for _ in $(seq 1 40); do
      sleep 5
      if bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||4111)+'/inngest',{method:'PUT'}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        echo "[inngest] auto-sync: functions registered with Inngest Cloud"
        break
      fi
    done
  ) &
fi

# Run the server in the foreground as PID 1 so Railway's SIGTERM reaches it for a graceful shutdown.
exec bun index.mjs
