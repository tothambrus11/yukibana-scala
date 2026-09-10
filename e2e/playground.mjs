/**
 * End-to-end tests: drive the playground in a real browser and check that Scala source is
 * compiled, linked and executed entirely client-side.
 *
 *   node e2e/playground.mjs
 *
 * Requires the toolchain (scripts/fetch-toolchain.sh) and a Chromium with JSPI.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT ?? 8130);
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const HEADLESS = process.env.HEADED !== "1";

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
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}vendor/scala-toolchain-wasm/manifest.json`);
      if (response.ok) return server;
    } catch {
      // not up yet
    }
    await delay(100);
  }

  server.kill();
  throw new Error("dev server did not start (did you run scripts/fetch-toolchain.sh?)");
}

const cases = [
  {
    name: "runs a top-level @main",
    source: `@main def hello(): Unit =
  val squares = (1 to 5).map(n => n * n)
  println("squares: " + squares.mkString(","))
  println("sum=" + squares.sum)
`,
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assert(result.ran, "program should run");
      assertIncludes(result.output, "squares: 1,4,9,16,25");
      assertIncludes(result.output, "sum=55");
      assert(result.mainClass === "hello", `main class should be hello, was ${result.mainClass}`);
    },
  },
  {
    name: "runs object Main with case classes, collections and pattern matching",
    source: `case class Point(x: Int, y: Int):
  def norm2: Int = x * x + y * y

object Main:
  def main(args: Array[String]): Unit =
    val points = List(Point(3, 4), Point(1, 1), Point(0, 5))
    val closest = points.minBy(_.norm2)
    closest match
      case Point(x, y) => println(s"closest=($x,$y) norm2=\${closest.norm2}")
    println(points.map(_.norm2).sorted.mkString(" "))
`,
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assertIncludes(result.output, "closest=(1,1) norm2=2");
      assertIncludes(result.output, "2 25 25");
      assert(result.mainClass === "Main", `main class should be Main, was ${result.mainClass}`);
    },
  },
  {
    name: "compiles multiple files together",
    files: {
      "Greeter.scala": `package util

object Greeter:
  def greet(name: String): String = s"hello, $name"
`,
      "Main.scala": `import util.Greeter

object Main:
  def main(args: Array[String]): Unit = println(Greeter.greet("yukibana"))
`,
    },
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assertIncludes(result.output, "hello, yukibana");
    },
  },
  {
    name: "links and runs the program as WebAssembly",
    target: "wasm",
    source: `@main def hello(): Unit =
  val squares = (1 to 6).map(n => n * n)
  println("wasm squares: " + squares.mkString(","))
`,
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assert(result.ran, "program should run");
      assert(result.target === "wasm", `target should be wasm, was ${result.target}`);
      assertIncludes(result.output, "wasm squares: 1,4,9,16,25,36");

      const names = (result.linkedFiles ?? []).map((file) => file.name);
      assert(names.includes("main.wasm"), `linker should emit main.wasm, emitted ${names.join(", ")}`);
      const wasm = result.linkedFiles.find((file) => file.name === "main.wasm");
      assert(wasm.size > 10_000, `main.wasm looks too small (${wasm.size} bytes)`);
    },
  },
  {
    name: "produces the same result from both backends",
    target: "both",
    source: `@main def hello(): Unit =
  val text = List("a", "bb", "ccc").map(_.length).sum
  println("total=" + text)
`,
    expect(result) {
      assert(result.ok, "compilation should succeed");
      assertIncludes(result.output, "total=6");
    },
  },
  {
    name: "reports a type error with position",
    source: `object Main:
  def main(args: Array[String]): Unit =
    val n: Int = "not an int"
    println(n)
`,
    expect(result) {
      assert(!result.ok, "compilation should fail");
      assert(result.errorCount >= 1, "should report at least one error");
      const [first] = result.diagnostics;
      assert(first.severity === "error", `severity should be error, was ${first.severity}`);
      assert(first.line === 3, `error should be on line 3, was ${first.line}`);
      assert(first.file?.endsWith("Main.scala"), `file should be Main.scala, was ${first.file}`);
      assertIncludes(first.message + first.text, "Int");
    },
  },
  {
    name: "reports an unresolved reference",
    source: `@main def go(): Unit = println(missingValue)
`,
    expect(result) {
      assert(!result.ok, "compilation should fail");
      assertIncludes(result.diagnostics[0].message, "Not found: missingValue");
    },
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack, needle) {
  assert(String(haystack).includes(needle), `expected output to include ${JSON.stringify(needle)}, got:\n${haystack}`);
}

const server = await startServer();
const browser = await chromium.launch({
  headless: HEADLESS,
  executablePath: findChromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

let failures = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log("  [pageerror]", error.message));

  const loadStarted = Date.now();
  await page.goto(`${BASE_URL}packages/playground/public/index.html`);
  await page.waitForFunction(() => document.body.dataset.ready === "true", null, { timeout: 180_000 });
  console.log(`toolchain ready in ${((Date.now() - loadStarted) / 1000).toFixed(1)}s\n`);

  for (const testCase of cases) {
    const files = testCase.files ?? { "Main.scala": testCase.source };
    const targets = testCase.target === "both" ? ["js", "wasm"] : [testCase.target ?? "js"];
    const started = Date.now();
    try {
      for (const target of targets) {
        const result = await page.evaluate(
          async ({ sources, linkTarget }) => {
            const { ScalaEngine } = await import("/vendor/scala-toolchain-wasm/host/index.js");
            globalThis.__engine ??= new ScalaEngine({
              workerUrl: new URL("/vendor/scala-toolchain-wasm/host/worker.js", location.origin),
              manifestUrl: new URL("/vendor/scala-toolchain-wasm/manifest.json", location.origin).href,
            });
            await globalThis.__engine.init();
            return globalThis.__engine.run(sources, { target: linkTarget });
          },
          { sources: files, linkTarget: target },
        );

        testCase.expect(result);
        const timings = [result.compileMs, result.linkMs, result.runMs]
          .filter((value) => value != null)
          .map((value) => `${Math.round(value)}ms`)
          .join(" / ");
        const label = targets.length > 1 ? `${testCase.name} [${target}]` : testCase.name;
        console.log(
          `PASS  ${label}  (${((Date.now() - started) / 1000).toFixed(1)}s${timings ? `, ${timings}` : ""})`,
        );
      }
    } catch (error) {
      failures++;
      console.log(`FAIL  ${testCase.name}\n      ${error.message.split("\n").join("\n      ")}`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? `\nAll ${cases.length} tests passed.` : `\n${failures} of ${cases.length} tests failed.`);
process.exit(failures === 0 ? 0 : 1);
