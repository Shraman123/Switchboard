// Browser QA: storefront checkout (COD) and a tour of the dashboard.
// Uses the locally installed Chrome (no browser download).
//   ADMIN_PASSWORD=... OUT=./shots node qa.mjs
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT ?? "./shots";
const STORE = process.env.STORE ?? "http://store.localtest.me";
const GW = process.env.GATEWAY ?? "http://gateway.localtest.me";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(60000);
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true, animations: "disabled", timeout: 15000 }).catch((e) => console.log("     (screenshot skipped:", e.message.split(String.fromCharCode(10))[0] + ")"));
const step = async (name, fn) => {
  try {
    await fn();
    console.log("ok  ", name);
  } catch (e) {
    console.log("FAIL", name, e.message.split("\n")[0]);
    await shot(`fail-${name.replace(/\W+/g, "-")}`);
  }
};


await step("storefront: add to cart", async () => {
  // WooCommerce's standard add-to-cart link (same handler as the button).
  await page.goto(`${STORE}/?add-to-cart=${process.env.PRODUCT_ID ?? 14}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.goto(`${STORE}/cart/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByText(/Nolen Gur Sandesh/).first().waitFor({ timeout: 60000 });
  await shot("01-product");
});

await step("checkout with cash on delivery", async () => {
  await page.goto(`${STORE}/checkout/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#email", { timeout: 60000 });
  await page.fill("#email", "ui-test@example.com");
  const fill = async (sel, v) => {
    const el = page.locator(sel);
    if (await el.count()) await el.first().fill(v);
  };
  await fill("#billing-first_name", "Arup");
  await fill("#billing-last_name", "Das");
  await fill("#billing-address_1", "4 College Street");
  await fill("#billing-city", "Kolkata");
  await fill("#billing-postcode", "700073");
  await fill("#billing-phone", "9000000001");
  const state = page.locator("#billing-state");
  if (await state.count()) {
    const tag = await state.evaluate((e) => e.tagName);
    if (tag === "SELECT") await state.selectOption({ label: "West Bengal" });
    else await state.fill("West Bengal");
  }
  await shot("02-checkout");
  await page.getByRole("button", { name: /place order/i }).click();
  await page.waitForURL(/order-received/, { timeout: 30000 });
  await shot("03-order-received");
  console.log("     order url:", page.url());
});

await page.close();
page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await step("dashboard login", async () => {
  await page.goto(GW);
  await page.fill('input[type="email"]', process.env.ADMIN_EMAIL ?? "admin@switchboard.local");
  await page.fill('input[type="password"]', process.env.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("MCP servers").waitFor();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /tools$/ }).first().click();
  await shot("10-servers");
});

await step("chat", async () => {
  await page.goto(`${GW}/#chat`);
  await page.getByPlaceholder(/Ask about/).fill("What orders came in today?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".msg.assistant .bubble").filter({ hasNotText: "Thinking" }).first().waitFor({ timeout: 60000 });
  await page.locator(".step summary").first().click().catch(() => {});
  await shot("11-chat");
});

await step("keys", async () => {
  await page.goto(`${GW}/#keys`);
  await page.getByPlaceholder(/Key name/).fill("ui-qa");
  await page.getByRole("button", { name: "Generate key" }).click();
  await page.locator(".newkey").waitFor();
  await shot("12-keys");
});

await step("members", async () => {
  await page.goto(`${GW}/#members`);
  await page.getByText("Team members").waitFor();
  await shot("13-members");
});

await step("audit", async () => {
  await page.goto(`${GW}/#audit`);
  await page.waitForTimeout(1500);
  await shot("14-audit");
});

await step("mobile layout", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${GW}/#servers`);
  await page.waitForTimeout(1500);
  await shot("15-mobile");
});

await browser.close();
