/** Shared types between the Theia extension's parts and the browser Scala engine. */

export const SCALA_LANGUAGE_ID = 'scala';

/** Which linker backend produces the artifact that runs in the page. */
export type LinkTarget = 'js' | 'wasm';

export interface ScalaDiagnostic {
    severity: 'error' | 'warning' | 'info';
    code: string | null;
    /** The error's name, e.g. `TypeMismatch`; only structured diagnostics carry it. */
    name?: string | null;
    /** Absolute path inside the engine's virtual workspace, e.g. `/workspace/Main.scala`. */
    file: string | null;
    /** 1-based line, 0-based column - what the compiler's own output shows. */
    line: number | null;
    column: number | null;
    /** The end of the offending range, when the compiler reported one. */
    endLine?: number | null;
    endColumn?: number | null;
    message: string;
    text: string;
}

export interface ScalaEntryPoint {
    mainClass: string;
    kind: 'object' | 'topLevelMain';
}

export interface ScalaRunResult {
    ok: boolean;
    ran?: boolean;
    exitCode: number;
    diagnostics: ScalaDiagnostic[];
    errorCount: number;
    warningCount: number;
    compilerOutput: string;
    entryPoints: ScalaEntryPoint[];
    irFileCount: number;
    compileMs: number;
    mainClass?: string;
    target?: LinkTarget;
    linkMs?: number;
    linkedBytes?: number;
    linkedFiles?: Array<{ name: string; size: number }>;
    output?: string;
    runMs?: number;
    error?: string;
}

export interface ScalaEngineInfo {
    ready: boolean;
    supportsWasmTarget: boolean;
    /** Whether this build expands quoted macros in the browser. */
    supportsMacros?: boolean;
    /** This runtime's version, and the one the loaded distribution was built with. */
    hostVersion?: string;
    manifestHostVersion?: string | null;
    versionMismatch?: boolean;
    warmCompiles?: boolean;
    incrementalLinking?: boolean;
    /** Exports the loaded compiler bundle does not provide. */
    missingExports?: string[];
    /**
     * The loaded distribution predates this frontend.
     *
     * Distinct from `versionMismatch`, which compares the two halves of one distribution and so
     * cannot see this: a wholly stale toolchain is internally consistent and looks fine from
     * the inside. What gives it away is the frontend asking for something it does not have.
     */
    olderThanFrontend?: boolean;
}

/** The workspace-relative file name the engine compiles under. */
export const WORKSPACE_PREFIX = '/workspace/';
