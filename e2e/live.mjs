/**
 * Drive the deployed site in a real browser.
 *
 * Unlike the other suites this talks to production, so it proves the thing users touch -
 * the deployed frontend, the deployed toolchain, and Cloudflare in between.
 */
import { chromium } from "playwright";
import { existsSync, readdirSync } from "node:fs";

const URL_UNDER_TEST = process.env.SITE ?? "https://scala.yukibana.dev/";
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  for (const entry of readdirSync(root)) {
    for (const layout of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const candidate = `${root}/${entry}/${layout}`;
      if (existsSync(candidate)) return candidate;
    }
  }
}

const args = [
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--ignore-certificate-errors",
  // Chrome's post-quantum key share makes the ClientHello ~1.8 KB, which the egress relay
  // drops mid-handshake; QUIC bypasses the HTTP proxy entirely. Neither matters to the page.
  "--disable-features=PostQuantumKyber,X25519MLKEM768,TLS13KyberSupport",
  "--disable-quic",
];
if (proxy) args.push(`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>");
console.log(`browser proxy: ${proxy ?? "(none)"}`);

const browser = await chromium.launch({ executablePath: findChromium(), args });
try {
  const page = await browser.newPage();
  const notes = [];
  page.on("pageerror", e => notes.push("pageerror: " + String(e.message).slice(0, 200)));
  page.on("console", m => { if (m.type() === "error") notes.push("console: " + m.text().slice(0, 200)); });
  page.on("requestfailed", r => notes.push(`requestfailed: ${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ""}`));
  page.on("response", r => { if (r.status() >= 400) notes.push(`http ${r.status()}: ${r.url().slice(0, 120)}`); });

  console.log("loading", URL_UNDER_TEST);
  await page.goto(URL_UNDER_TEST, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".monaco-editor", { timeout: 180000 });
  console.log("workbench up");

  // Give the engine time to load the toolchain, then run the seeded sample.
  await page.waitForTimeout(15000);
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("F5").catch(() => undefined);

  const finished = await page.waitForFunction(
    () => {
      const text = document.body.innerText || "";
      if (/squares:\s*1/.test(text)) return { ok: true, text: text.slice(0, 400) };
      if (/Failed to fetch|Could not load|failed/i.test(text)) return { ok: false, text: text.slice(0, 800) };
      return null;
    },
    null,
    { timeout: 240000, polling: 1000 },
  ).then(h => h.jsonValue()).catch(e => ({ ok: false, text: "(timed out) " + String(e.message).slice(0, 200) }));

  console.log("\nRESULT ok=" + finished.ok);
  console.log(finished.text.replace(/\s+/g, " ").slice(0, 600));
  const status = await page.evaluate(() => (document.querySelector("#theia-statusBar")?.innerText || "").replace(/\s+/g, " ").slice(0, 200));
  console.log("\nstatus bar:", status);
  console.log("\nnotes:\n" + [...new Set(notes)].slice(0, 25).map(n => "  " + n).join("\n"));
  await page.screenshot({ path: "/tmp/live.png", fullPage: false });
} finally {
  await browser.close();
}
process.exit(0);
