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
import { EXAMPLE_WORKSPACE } from "../packages/theia-scala/lib/common/examples.js";
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

/**
 * What the seeded examples print when their tests pass.
 *
 * Counted from the specs rather than written down: the number is a property of `examples.ts`,
 * and a hardcoded copy turns "someone added an assertion" into a 300-second timeout whose
 * cause is invisible from the failure.
 */
const CHECKS_PASSED = `All ${countAssertions()} checks passed.`;

function countAssertions() {
    return Object.entries(EXAMPLE_WORKSPACE)
        .filter(([name]) => name.endsWith("Spec.scala"))
        .reduce((total, [, source]) => total + (source.match(/^\s*assert\w+\(/gm) ?? []).length, 0);
}
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

/**
 * Read rendered text, with whitespace normalised to single spaces.
 *
 * Normalising is not cosmetic. The editor and the Output view are both Monaco, which renders
 * spaces as non-breaking spaces: `[run 1]` in the document is really `[run\u00a01]`, so a
 * pattern written with an ordinary space matches nothing at all. Every assertion below reads
 * through here and applies its pattern to the result, so no caller can reintroduce that. One
 * predicate that ran against the raw text cost three tests a five-minute timeout each, while
 * the runs they were waiting for had long since finished and were on screen.
 */
function readText(page, selector) {
    return page.evaluate(css => {
        const node = css === "body" ? document.body : document.querySelector(css);
        return (node?.innerText ?? "").replace(/\s+/g, " ");
    }, selector);
}

/**
 * The text of the Output view, not of the whole page.
 *
 * `document.body.innerText` also covers the editor, so a program's *source* matches an
 * assertion meant for its *output* - which is how a toolbar test once passed while the button
 * did nothing. `#outputView` is `OutputWidget.ID`, which Lumino puts on the widget's node.
 */
const readOutput = page => readText(page, "#outputView");
const readBody = page => readText(page, "body");

const normalise = needle => needle.replace(/\s+/g, " ").trim();

/**
 * Poll until `predicate` accepts the text, then return it.
 *
 * Node-side rather than `page.waitForFunction`, so a predicate is an ordinary closure over
 * ordinary values instead of source shipped into the page, and so a timeout can say what it
 * was waiting for *and* what it saw instead - which is the difference between a diagnosis and
 * a five-minute "Timeout exceeded".
 */
async function waitFor(page, read, predicate, what, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const text = await read(page);
        if (predicate(text)) {
            return text;
        }
        if (Date.now() >= deadline) {
            throw new Error(`timed out after ${timeout} ms waiting for ${what}; saw: ${text.slice(-300) || "(nothing)"}`);
        }
        await delay(200);
    }
}

/** Whitespace in the rendered workbench is not worth asserting on. */
function waitForText(page, needle, timeout) {
    const wanted = normalise(needle);
    return waitFor(page, readBody, text => text.includes(wanted), JSON.stringify(wanted), timeout);
}

function waitForOutputText(page, needle, timeout) {
    const wanted = normalise(needle);
    return waitFor(page, readOutput, text => text.includes(wanted), `${JSON.stringify(wanted)} in the Output view`, timeout);
}

/** The highest `[run N]` the Output view is showing; 0 before anything has run. */
function lastRunNumber(text) {
    const numbers = [...text.matchAll(/\[run (\d+)\]/g)].map(match => Number(match[1]));
    return numbers.length > 0 ? Math.max(...numbers) : 0;
}

/**
 * Trigger a run and prove *that run* produced the output.
 *
 * Two runs of the same program print the same thing, so the only way to tell them apart is to
 * count them: each run tags its output `[run N]`. Waiting for a higher number is exact, where
 * waiting for the output to empty and refill misses the gap whenever a warm run finishes
 * between two polls - and then passes for the wrong reason.
 *
 * The number rides on the closing timings line as well as the header, because the Output view
 * virtualises its DOM: on a long run the header scrolls out of existence.
 */
async function expectRunProduces(page, trigger, needle, timeout) {
    const before = lastRunNumber(await readOutput(page));
    await trigger();
    await waitFor(page, readOutput, text => lastRunNumber(text) > before, `a run after #${before}`, timeout);
    await waitForOutputText(page, needle, timeout);
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

/**
 * What the workbench looked like when an expectation failed.
 *
 * Every assertion here reads the Output view, so that is what a failure has to show. An
 * earlier version dumped the head of `document.body.innerText`, which is the menu bar and the
 * editor - identical whether the run never started, failed to compile, or printed something
 * unexpected. The tail of the Output view distinguishes all three at a glance.
 */
async function describePage() {
    try {
        const output = await readOutput(page);
        return {
            ...(await page.evaluate(() => ({
                title: document.title,
                seeded: localStorage.getItem("yukibana.workspace.seeded"),
                shell: !!document.querySelector(".theia-ApplicationShell"),
                outputOpen: !!document.querySelector("#outputView"),
            }))),
            status: await readText(page, "#theia-statusBar"),
            output: output.length > 600 ? `...${output.slice(-600)}` : output,
        };
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
        await waitForOutputText(page, "3628800", 30_000);
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
        await waitForOutputText(page, "KB WebAssembly", 30_000);
    });

    await check("reports compiler errors in the Problems view", async () => {
        await focusEditor(page);
        await page.keyboard.press("Control+End");
        await page.keyboard.type('\nval broken: Int = "text"\n');
        await page.keyboard.press("Escape");
        await runCommand(page, "Scala: Compile");
        await waitForOutputText(page, "Compilation failed with 1 error", 300_000);


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
        await waitForOutputText(page, "Found:", 30_000);
        await waitForOutputText(page, "Required: Int", 10_000);
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

        // Scoped to the Output view, so the source line in the editor cannot satisfy it - and
        // the value is computed, so only a run that actually happened can print it.
        await waitForOutputText(page, "autorun 42", 300_000);

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
