/**
 * Unit checks for the seeded example workspace.
 *
 * These need no browser, so they run in milliseconds - which matters, because the rules they
 * cover are the kind that fail silently. A workspace that is never upgraded still opens; a
 * file wrongly replaced still compiles. Both were shipped once.
 */
import {
    EXAMPLE_WORKSPACE,
    EXAMPLE_ENTRY_FILE,
    SUPERSEDED_SAMPLE_COUNT,
    isSupersededSample,
} from "../packages/theia-scala/lib/common/examples.js";

let failures = 0;
function check(name, condition, detail = "") {
    if (!condition) { failures++; }
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `\n      ${detail}`}`);
}

const names = Object.keys(EXAMPLE_WORKSPACE);

check("the entry file is one of the examples", names.includes(EXAMPLE_ENTRY_FILE), names.join(", "));
check("every example is a non-empty .scala file",
    names.every(name => name.endsWith(".scala") && EXAMPLE_WORKSPACE[name].trim().length > 0), names.join(", "));

// Exactly one entry point, or the engine cannot choose which program to run.
const declaredMains = names.filter(name => /^@main\b|\n@main\b/.test(EXAMPLE_WORKSPACE[name]));
check("exactly one file declares @main", declaredMains.length === 1, `declared in: ${declaredMains.join(", ") || "none"}`);

// The examples exist to be read; a file nobody references is a file nobody opens.
const unreferenced = names.filter(name => {
    if (name === EXAMPLE_ENTRY_FILE) { return false; }
    const object = name.replace(/\.scala$/, "");
    return !names.some(other => other !== name && EXAMPLE_WORKSPACE[other].includes(object));
});
check("every example is referenced by another", unreferenced.length === 0, `unreferenced: ${unreferenced.join(", ")}`);

// The upgrade rule: replace what we wrote, never what someone edited.
const legacySample = `@main def hello(): Unit =
  val squares = (1 to 5).map(n => n * n)
  println(s"squares: \${squares.mkString(", ")}")
  println(s"sum = \${squares.sum}")
`;
check("the previous sample is recognised as ours to replace",
    isSupersededSample(EXAMPLE_ENTRY_FILE, legacySample));
check("an edited copy of it is left alone",
    !isSupersededSample(EXAMPLE_ENTRY_FILE, legacySample + "\nval mine = 1\n"));
check("a file with another name is never replaced",
    !isSupersededSample("Shape.scala", legacySample));
check("the current entry file is not itself superseded",
    !isSupersededSample(EXAMPLE_ENTRY_FILE, EXAMPLE_WORKSPACE[EXAMPLE_ENTRY_FILE]),
    "otherwise seeding would rewrite it on every load");

// The recognise-our-own-writing list is a bridge for workspaces predating it, not a mechanism
// to extend. Growing it means another hand-escaped copy here and in examples.ts, for the entry
// file only; recording a hash when writing would cover every file with no history at all.
check("the superseded-sample list has not grown", SUPERSEDED_SAMPLE_COUNT === 1,
    `it holds ${SUPERSEDED_SAMPLE_COUNT}; see the note on SUPERSEDED_SAMPLES before adding another`);

console.log(failures === 0 ? "\nAll example checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
