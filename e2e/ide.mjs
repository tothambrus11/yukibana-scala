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

/** What the seeded examples print when their tests pass. See packages/theia-scala/src/common/examples.ts. */
const CHECKS_PASSED = "All 12 checks passed.";
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

function visibleText(page) {
    return page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
}

/**
 * Wait for text that is not on screen yet, and fail loudly if it already is.
 *
 * The trap this closes: `document.body.innerText` covers the editor *and* the Output view, and
 * a program's output stays on screen between tests. So waiting for "All 12 checks passed."
 * after an earlier run succeeds on the first poll whether or not anything ran - and a version
 * of the toolbar test did exactly that, reporting success while the button did nothing.
 */
async function waitForFreshText(page, needle, timeout) {
    const wanted = needle.replace(/\s+/g, " ").trim();
    const before = await visibleText(page);
    assert(
        !before.includes(wanted),
        `"${wanted}" was already on screen, so waiting for it would prove nothing. ` +
            "Use expectRunProduces, or assert on something only this action can produce.",
    );
    await waitForText(page, wanted, timeout);
}

/**
 * Trigger a run and prove *that run* produced the output.
 *
 * Running clears the Output channel before it starts, so the previous result disappears and
 * comes back. Watching for both edges is what distinguishes "this run worked" from "the last
 * one did" - the whole difficulty being that two runs of the same program look identical.
 *
 * Use this for every assertion about a run. `waitForText` alone is only safe for text that
 * cannot already be present.
 */
async function expectRunProduces(page, trigger, needle, timeout) {
    const wanted = needle.replace(/\s+/g, " ").trim();
    const wasPresent = (await visibleText(page)).includes(wanted);
    await trigger();

    if (wasPresent) {
        // Poll fast: the gap between the channel clearing and the result arriving is the run
        // itself, which for a warm toolchain is about a second.
        await page.waitForFunction(
            text => !document.body.innerText.replace(/\s+/g, " ").includes(text),
            wanted,
            { timeout: 60_000, polling: 50 },
        );
    }
    await waitForText(page, wanted, timeout);
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
        await waitForText(page, "@main def run", 30_000);
    });

    await check("runs the sample program and shows its output", async () => {
        // The toolchain downloads and instantiates ~35 MB on first use.
        await expectRunProduces(page, () => runCommand(page, "Scala: Run as JavaScript"), CHECKS_PASSED, 300_000);
        await waitForText(page, "3628800", 30_000);
    });

    await check("runs from the toolbar button, without the command palette", async () => {
        await focusEditor(page);
        const runButton = page.locator('[id="yukibana.scala.run"]').first();
        await runButton.waitFor({ state: "visible", timeout: 30_000 });
        assert(
            /\bRun\b/.test((await runButton.innerText()) || ""),
            "the toolbar button should say Run, not render as a bare icon",
        );
        await expectRunProduces(page, () => runButton.click(), CHECKS_PASSED, 300_000);
    });

    await check("recognises Scala as a language, not plain text", async () => {
        const language = await page.evaluate(
            () => document.querySelector("#theia-statusBar")?.innerText.replace(/\s+/g, " ") ?? "",
        );
        assert(!/Plain Text/.test(language), `editor language should not be Plain Text: ${language}`);
        assert(/Scala/.test(language), `status bar should mention Scala: ${language}`);
    });

    await check("links and runs the program as WebAssembly", async () => {
        await expectRunProduces(page, () => runCommand(page, "Scala: Run as WebAssembly"), CHECKS_PASSED, 300_000);
        await waitForText(page, "KB WebAssembly", 30_000);
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


    // Last, because it replaces Main.scala: nothing after it should depend on the examples.
    await check("autorun re-runs the program on save", async () => {
        const autorun = page.locator(".yukibana-autorun input[type=checkbox]").first();
        await autorun.waitFor({ state: "visible", timeout: 30_000 });
        assert(!(await autorun.isChecked()), "autorun should start unticked");
        await autorun.check();
        assert(await autorun.isChecked(), "ticking autorun should tick the box");

        // The marker is *computed*, so finding it proves the program ran. Asserting on a
        // literal would match the source text in the editor, which is always on screen - an
        // earlier version of this test passed that way while the program never ran at all.
        await focusEditor(page);
        await page.keyboard.press("Control+a");
        await page.keyboard.type('@main def run(): Unit = println(s"autorun ${6 * 7}")\n');
        await page.keyboard.press("Escape");
        await page.keyboard.press("Control+s");

        // Fresh rather than clear-then-fill: this text has never been printed before, and the
        // save may land while the run that ticking the box started is still going.
        await waitForFreshText(page, "autorun 42", 300_000);

        await autorun.uncheck();
        assert(!(await autorun.isChecked()), "unticking autorun should untick the box");
    });

    await page.screenshot({ path: "/tmp/yukibana-ide.png" });
} finally {
    await browser.close();
    server.kill();
}

console.log(failures === 0 ? "\nAll IDE tests passed." : `\n${failures} IDE test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
