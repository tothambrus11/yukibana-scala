/**
 * End-to-end test for the Theia workbench: boot the browser-only IDE, run the seeded Scala
 * program from the command palette, and check the output and the Problems view.
 *
 *   node e2e/ide.mjs
 *
 * Requires a built IDE with the toolchain staged:
 *   scripts/fetch-toolchain.sh && npm run build:ide && scripts/stage-ide-assets.sh
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { chromium } from "playwright";

/** Pick a free port so a stray server from an earlier run cannot silently be reused. */
async function freePort() {
    if (process.env.PORT) return Number(process.env.PORT);
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

const PORT = await freePort();
const BASE_URL = `http://127.0.0.1:${PORT}/`;
// FRONTEND=dist/cloudflare points the same suite at the deployable build.
const FRONTEND = process.env.FRONTEND ?? "packages/theia-app/lib/frontend";

function findChromium() {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
    if (!existsSync(root)) return undefined;
    for (const entry of readdirSync(root)) {
        for (const layout of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
            const candidate = `${root}/${entry}/${layout}`;
            if (existsSync(candidate)) return candidate;
        }
    }
    return undefined;
}

async function startServer() {
    const server = spawn(process.execPath, ["scripts/dev-server.mjs"], {
        env: { ...process.env, PORT: String(PORT), ROOT: FRONTEND },
        stdio: ["ignore", "pipe", "inherit"],
    });

    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            if ((await fetch(`${BASE_URL}toolchain-current.json`)).ok) return server;
        } catch {
            // not up yet
        }
        await delay(100);
    }
    server.kill();
    throw new Error("dev server did not start (did you run scripts/stage-ide-assets.sh?)");
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

/**
 * Run a command through Theia's command palette.
 *
 * Escape first: with focus in the editor a suggest widget can swallow the palette shortcut.
 */
async function runCommand(page, label) {
    for (let attempt = 0; attempt < 2; attempt++) {
        await page.keyboard.press("Escape");
        await delay(200);
        await page.keyboard.press("F1");
        try {
            await page.waitForSelector(".quick-input-widget input", { timeout: 10_000 });
        } catch (error) {
            if (attempt === 1) throw error;
            continue;
        }
        await page.keyboard.type(label, { delay: 10 });
        await delay(900);
        await page.keyboard.press("Enter");
        return;
    }
}

/** Whitespace in the rendered workbench is not worth asserting on. */
async function waitForText(page, needle, timeout) {
    const wanted = needle.replace(/\s+/g, " ").trim();
    await page.waitForFunction(
        text => document.body.innerText.replace(/\s+/g, " ").includes(text),
        wanted,
        { timeout, polling: 500 },
    );
}

/**
 * Focus the editor the workbench seeded. (Quick open is deliberately not used: Ctrl+P is
 * taken by the browser's print dialog in a headless run.)
 */
async function focusEditor(page) {
    // Lumino renamed its CSS prefix from `p-` to `lm-`; accept either.
    const tab = page.locator(".lm-TabBar-tabLabel, .p-TabBar-tabLabel").filter({ hasText: "Main.scala" }).first();
    await tab.click({ timeout: 15_000 }).catch(() => undefined);
    await page.locator(".theia-editor .monaco-editor, .monaco-editor").first().click({ timeout: 15_000 });
}

const server = await startServer();
const browser = await chromium.launch({
    headless: process.env.HEADED !== "1",
    executablePath: findChromium(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

let failures = 0;
let page;

/** What the workbench looked like when an expectation failed. */
async function describePage() {
    try {
        return await page.evaluate(() => ({
            title: document.title,
            seeded: localStorage.getItem("yukibana.workspace.seeded"),
            shell: !!document.querySelector(".theia-ApplicationShell"),
            body: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
        }));
    } catch (error) {
        return { unavailable: String(error) };
    }
}

const check = async (name, body) => {
    const started = Date.now();
    try {
        await body();
        console.log(`PASS  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
        failures++;
        const state = JSON.stringify(await describePage());
        console.log(`FAIL  ${name}\n      ${error.message.split("\n")[0]}\n      page: ${state}`);
    }
};

try {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", error => console.log("  [pageerror]", error.message.slice(0, 200)));

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

    await check("boots the browser-only workbench and seeds a workspace", async () => {
        await page.waitForSelector(".theia-ApplicationShell", { timeout: 60_000 });
        // Seeding creates a workspace and opens it, which reloads the page.
        await page.waitForFunction(
            () => document.title.includes("workspace") && !!document.querySelector(".theia-ApplicationShell"),
            null,
            { timeout: 120_000, polling: 500 },
        );
        await waitForText(page, "Main.scala", 60_000);
        await waitForText(page, "@main def hello", 30_000);
    });

    await check("runs the sample program and shows its output", async () => {
        await runCommand(page, "Scala: Run as JavaScript");
        // The toolchain downloads and instantiates 62 MB on first use.
        await waitForText(page, "squares: 1, 4, 9, 16, 25", 300_000);
        await waitForText(page, "sum = 55", 30_000);
    });

    await check("recognises Scala as a language, not plain text", async () => {
        const language = await page.evaluate(
            () => document.querySelector("#theia-statusBar")?.innerText.replace(/\s+/g, " ") ?? "",
        );
        assert(!/Plain Text/.test(language), `editor language should not be Plain Text: ${language}`);
        assert(/Scala/.test(language), `status bar should mention Scala: ${language}`);
    });

    await check("links and runs the program as WebAssembly", async () => {
        await runCommand(page, "Scala: Run as WebAssembly");
        await waitForText(page, "KB WebAssembly", 300_000);
        await waitForText(page, "squares: 1, 4, 9, 16, 25", 30_000);
    });

    await check("reports compiler errors in the Problems view", async () => {
        await focusEditor(page);
        await page.keyboard.press("Control+End");
        await page.keyboard.type('\nval broken: Int = "text"\n');
        await page.keyboard.press("Escape");
        await runCommand(page, "Scala: Compile");
        await waitForText(page, "Compilation failed with 1 error", 300_000);


        // The markers we publish drive Theia's problem counter.
        await page.waitForFunction(
            () => {
                const status = document.querySelector("#problem-marker-status") ?? document.querySelector("#theia-statusBar");
                return /[1-9]/.test(status?.textContent ?? "");
            },
            null,
            { timeout: 60_000, polling: 500 },
        );

        // The build log carries the compiler's own rendering of the error.
        await waitForText(page, "Found:", 30_000);
        await waitForText(page, "Required: Int", 10_000);
    });

    await page.screenshot({ path: "/tmp/yukibana-ide.png" });
} finally {
    await browser.close();
    server.kill();
}

console.log(failures === 0 ? "\nAll IDE tests passed." : `\n${failures} IDE test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
