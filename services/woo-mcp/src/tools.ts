import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WooClient, WooError } from "./woo.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

// Trim WooCommerce's very large payloads to what a model (or a person) needs.
const slimProduct = (p: Json) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  price: p.price,
  regular_price: p.regular_price,
  sale_price: p.sale_price || undefined,
  sku: p.sku || undefined,
  stock_status: p.stock_status,
  stock_quantity: p.stock_quantity ?? undefined,
  permalink: p.permalink,
  date_created: p.date_created,
});

const slimOrder = (o: Json) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  date_created: o.date_created,
  total: o.total,
  currency: o.currency,
  payment_method: o.payment_method_title,
  customer: {
    name: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ") || undefined,
    email: o.billing?.email || undefined,
  },
  items: (o.line_items ?? []).map((li: Json) => ({ product_id: li.product_id, name: li.name, quantity: li.quantity, total: li.total })),
});

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const fail = (err: unknown) => {
  const msg = err instanceof WooError ? `WooCommerce error${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}` : `Error: ${(err as Error).message}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
};

const guard =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

export function registerTools(server: McpServer, woo: WooClient) {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List products in the WooCommerce store, newest first. Optionally filter by a search term.",
      inputSchema: {
        search: z.string().optional().describe("Text to search for in product names"),
        status: z.enum(["any", "publish", "draft", "pending", "private"]).optional().describe("Defaults to any"),
        per_page: z.number().int().min(1).max(100).optional().describe("Defaults to 20"),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const rows = await woo.request<Json[]>("GET", "/products", {
        search: a.search,
        status: a.status ?? "any",
        per_page: a.per_page ?? 20,
        page: a.page,
        orderby: "date",
        order: "desc",
      });
      return { count: rows.length, products: rows.map(slimProduct) };
    }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description: "Create a simple product in the WooCommerce store. It is published (visible on the storefront) unless status is set to draft.",
      inputSchema: {
        name: z.string().min(1).max(200),
        regular_price: z.union([z.string(), z.number()]).describe("Price in the store currency, e.g. 499 or \"499.00\""),
        description: z.string().max(5000).optional(),
        sku: z.string().max(100).optional(),
        stock_quantity: z.number().int().min(0).optional().describe("If set, stock is tracked"),
        status: z.enum(["publish", "draft"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    guard(async (a) => {
      const price = Number(a.regular_price);
      if (!Number.isFinite(price) || price < 0) throw new Error("regular_price must be a non-negative number");
      const p = await woo.request<Json>("POST", "/products", {}, {
        name: a.name,
        type: "simple",
        regular_price: price.toFixed(2),
        description: a.description,
        sku: a.sku,
        status: a.status ?? "publish",
        ...(a.stock_quantity !== undefined ? { manage_stock: true, stock_quantity: a.stock_quantity } : {}),
      });
      return slimProduct(p);
    }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first. Filter by creation time with `after` / `before` (ISO 8601, store local time, e.g. 2026-10-11T00:00:00) and by status.",
      inputSchema: {
        after: z.string().optional().describe("Only orders created after this ISO 8601 time"),
        before: z.string().optional().describe("Only orders created before this ISO 8601 time"),
        status: z.enum(["any", ...ORDER_STATUSES]).optional().describe("Defaults to any"),
        per_page: z.number().int().min(1).max(100).optional().describe("Defaults to 20"),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const rows = await woo.request<Json[]>("GET", "/orders", {
        after: a.after,
        before: a.before,
        status: a.status ?? "any",
        per_page: a.per_page ?? 20,
        page: a.page,
        orderby: "date",
        order: "desc",
      });
      return { count: rows.length, orders: rows.map(slimOrder) };
    }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order by its ID, including line items, billing details and notes count.",
      inputSchema: { order_id: z.number().int().positive() },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const o = await woo.request<Json>("GET", `/orders/${a.order_id}`);
      return { ...slimOrder(o), billing: o.billing, customer_note: o.customer_note || undefined, date_modified: o.date_modified };
    }),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: "Change an order's status, optionally adding a private order note explaining why.",
      inputSchema: {
        order_id: z.number().int().positive(),
        status: z.enum(ORDER_STATUSES),
        note: z.string().max(1000).optional().describe("Private note added to the order"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(async (a) => {
      const o = await woo.request<Json>("PUT", `/orders/${a.order_id}`, {}, { status: a.status });
      if (a.note) await woo.request("POST", `/orders/${a.order_id}/notes`, {}, { note: a.note, customer_note: false });
      return slimOrder(o);
    }),
  );
}
