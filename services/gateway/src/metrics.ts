import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const metrics = {
  toolCalls: new client.Counter({
    name: "switchboard_tool_calls_total",
    help: "Tool calls routed through the gateway",
    labelNames: ["server", "tool", "outcome", "via"],
    registers: [registry],
  }),
  toolLatency: new client.Histogram({
    name: "switchboard_tool_call_duration_seconds",
    help: "End-to-end tool call latency (gateway -> upstream -> gateway)",
    labelNames: ["server", "outcome"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  }),
  upstreamUp: new client.Gauge({
    name: "switchboard_upstream_up",
    help: "1 if the last health check of the upstream succeeded",
    labelNames: ["server"],
    registers: [registry],
  }),
  authFailures: new client.Counter({
    name: "switchboard_auth_failures_total",
    help: "Rejected gateway requests",
    labelNames: ["reason"],
    registers: [registry],
  }),
};
