// End-to-end test of sign-up with email confirmation, as hosted Supabase does it by default. Needs the local stack
// started with [auth.email] enable_confirmations = true (./scripts/test-e2e-email-confirm.sh does this) and the app
// served at the auth site URL (http://127.0.0.1:3000), because the PKCE verifier cookie is per host.
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const MAIL = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const email = `confirm-${Date.now()}@example.test`;

async function confirmationLink() {
  for (let i = 0; i < 30; i++) {
    const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${MAIL}/api/v1/message/${list.messages[0].ID}`)).json();
      const href = msg.HTML.match(/href="([^"]+)"/)?.[1];
      if (href) return href.replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no confirmation email arrived");
}

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Check your email to confirm the account").waitFor();
  const link = await confirmationLink();
  assert.match(decodeURIComponent(link), /redirect_to=http:\/\/127\.0\.0\.1:3000\/auth\/callback/);
  console.log("✓ sign-up sends a confirmation email that returns to /auth/callback");

  // A stale or tampered code is refused with a readable message.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`${BASE}/auth/callback?code=not-a-real-code`);
  await stranger.waitForURL(/^http:\/\/127\.0\.0\.1:3000\/login\?error=/);
  assert.match(await stranger.locator(".banner-error").innerText(), /Could not confirm the email/);
  console.log("✓ an invalid link lands on the sign-in page with an explanation");

  await page.goto(link);
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:3000\/projects$/);
  await page.getByRole("heading", { name: "Projects" }).waitFor();
  console.log("✓ the link confirms the email and signs the user in");
  console.log("\nEmail confirmation flow passed.");
} catch (e) {
  console.error("\n✗ Email confirmation flow failed:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
