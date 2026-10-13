// Provisioner: a level-triggered reconcile loop over desired state in Postgres.
//
// The gateway API only writes rows (status 'provisioning' / 'deleting'); this
// process, the only component with Kubernetes API rights, makes the cluster
// match. Because it re-reads state every tick and every step is idempotent, a
// restart mid-provisioning simply resumes; a deadline per row turns anything
// stuck into a clean 'failed' with the reason.
import http from "node:http";
import { config } from "../config.js";
import { migrate, pool } from "../db.js";
import { deleteHosted, hostedNeedingWork, provisionHosted } from "./hosted.js";
import { deleteStore, provisionStore, storesNeedingWork } from "./stores.js";

const TICK_MS = 3000;
const RETRY_BACKOFF_MS = 15_000;

for (let i = 1; ; i++) {
  try {
    await pool.query("SELECT 1");
    break;
  } catch (err) {
    if (i >= 60) throw err;
    console.log(`waiting for database (${(err as Error).message})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await migrate();

// Leader election: a session-level advisory lock held on a dedicated
// connection. A second replica (e.g. during a rollout) idles until it wins.
const lockConn = await pool.connect();
let leader = false;
async function tryLead() {
  if (leader) return true;
  const r = await lockConn.query("SELECT pg_try_advisory_lock(727002) AS ok");
  leader = r.rows[0].ok;
  if (leader) console.log("provisioner: acquired leadership");
  return leader;
}

const inFlight = new Set<string>();
const lastAttempt = new Map<string, number>();

function launch(id: string, work: () => Promise<void>) {
  if (inFlight.has(id) || inFlight.size >= config.provisioning.concurrency) return;
  if (Date.now() - (lastAttempt.get(id) ?? 0) < RETRY_BACKOFF_MS) return;
  inFlight.add(id);
  lastAttempt.set(id, Date.now());
  work()
    .catch((err) => console.error(`reconcile ${id} crashed`, err))
    .finally(() => inFlight.delete(id));
}

let lastTickOk = Date.now();
async function tick() {
  try {
    if (await tryLead()) {
      // Deletions first: they free quota for pending creations.
      const [stores, hosted] = await Promise.all([storesNeedingWork(), hostedNeedingWork()]);
      const work = [...stores.map((s) => ({ ...s, kind: "store" as const })), ...hosted.map((h) => ({ ...h, kind: "hosted" as const }))];
      work.sort((a, b) => Number(b.status === "deleting") - Number(a.status === "deleting"));
      for (const w of work) {
        if (w.kind === "store") launch(w.id, () => (w.status === "deleting" ? deleteStore(w as any) : provisionStore(w as any)));
        else launch(w.id, () => (w.status === "deleting" ? deleteHosted(w as any) : provisionHosted(w as any)));
      }
    }
    lastTickOk = Date.now();
  } catch (err) {
    console.error("provisioner tick failed", err);
  }
  setTimeout(tick, TICK_MS);
}
tick();

// Liveness: the loop is alive. Readiness: and it can reach its database.
http
  .createServer(async (req, res) => {
    const alive = Date.now() - lastTickOk < 60_000;
    if (req.url === "/readyz") {
      const db = await pool.query("SELECT 1").then(() => true, () => false);
      res.writeHead(alive && db ? 200 : 503).end(JSON.stringify({ alive, db, leader, inFlight: inFlight.size }));
      return;
    }
    res.writeHead(alive ? 200 : 503).end(JSON.stringify({ alive, leader }));
  })
  .listen(8081, () => console.log("provisioner health on :8081"));

process.on("SIGTERM", () => {
  // In-flight helm runs are abandoned; the next leader resumes them.
  console.log("provisioner shutting down");
  process.exit(0);
});
