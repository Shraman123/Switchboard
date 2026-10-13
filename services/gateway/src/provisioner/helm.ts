// Thin wrapper around the helm binary baked into the provisioner image.
// A provisioned store is installed from the very same chart as the main store.
import { execFile } from "node:child_process";

export class HelmError extends Error {}

function helm(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("helm", args, { timeout: timeoutMs, maxBuffer: 4 << 20, signal }, (err, stdout, stderr) => {
      if (signal?.aborted) reject(new HelmError(String(signal.reason?.message ?? signal.reason ?? "aborted")));
      else if (err) {
        const killed = (err as { killed?: boolean }).killed && !stderr;
        const detail = killed ? "interrupted (timed out or the provisioner stopped)" : (stderr || err.message).trim().split("\n").slice(-3).join(" ");
        reject(new HelmError(`helm ${args[0]}: ${detail}`.slice(0, 500)));
      } else resolve(stdout);
    });
  });
}

export async function releaseStatus(release: string, namespace: string): Promise<string | null> {
  try {
    const out = await helm(["status", release, "-n", namespace, "-o", "json"], 30_000);
    return JSON.parse(out)?.info?.status ?? null;
  } catch (err) {
    if (/not found/i.test((err as Error).message)) return null;
    throw err;
  }
}

export async function upgradeInstall(opts: {
  release: string;
  namespace: string;
  chart: string;
  valuesFiles: string[];
  set: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  const seconds = Math.max(60, Math.floor(opts.timeoutMs / 1000));
  const args = ["upgrade", "--install", opts.release, opts.chart, "-n", opts.namespace, "--wait", "--timeout", `${seconds}s`, "--history-max", "3"];
  for (const f of opts.valuesFiles) args.push("-f", f);
  // --set-string: values are user-influenced (store name), never parsed as YAML.
  // Commas and backslashes are helm's own separators/escapes, so escape them.
  for (const [k, v] of Object.entries(opts.set)) args.push("--set-string", `${k}=${v.replace(/[\\,]/g, "\\$&")}`);
  await helm(args, (seconds + 30) * 1000, opts.signal);
}

export async function uninstall(release: string, namespace: string, timeoutMs: number) {
  try {
    await helm(["uninstall", release, "-n", namespace, "--wait", "--timeout", `${Math.floor(timeoutMs / 1000)}s`], timeoutMs + 30_000);
  } catch (err) {
    if (!/not found/i.test((err as Error).message)) throw err;
  }
}
