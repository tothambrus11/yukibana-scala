import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { LinkTarget, ScalaEngineInfo, ScalaRunResult } from '../common';

/** The part of `@yukibana/scala-engine`'s client that this extension uses. */
interface EngineClient {
    init(): Promise<ScalaEngineInfo>;
    /** Optional: a distribution older than this frontend does not provide it. */
    warmUp?(target?: LinkTarget): Promise<{ ok: boolean; durationMs: number }>;
    compile(files: Record<string, string>, options?: string[]): Promise<ScalaRunResult>;
    run(files: Record<string, string>, config?: { mainClass?: string; target?: LinkTarget }): Promise<ScalaRunResult>;
    on(event: 'progress' | 'stdout' | 'error', listener: (payload: any) => void): () => void;
    /** Optional: stops the worker, so a reload does not leave the old one running. */
    terminate?(): void;
}

interface EngineModule {
    ScalaEngine: new (config: { workerUrl: string | URL; manifestUrl: string }) => EngineClient;
}

export type EngineState = 'idle' | 'loading' | 'ready' | 'failed' | 'busy';

/** What the engine's progress stages mean to someone watching the status bar. */
const STAGE_LABELS: Record<string, string> = {
    manifest: 'reading manifest',
    classpath: 'downloading classpath',
    compiler: 'loading compiler',
    ready: 'ready',
    // Macro support links a second copy of the compiler, which takes about a minute the
    // first time a workspace uses one. Saying so beats a status bar that looks stuck.
    macros: 'preparing macro support (one-off, ~1 min)',
    compiling: 'compiling',
    linking: 'linking',
    running: 'running',
};

export interface EngineStatus {
    state: EngineState;
    detail?: string;
}

/**
 * The engine is loaded at runtime from the toolchain distribution rather than bundled into
 * the Theia frontend. That keeps the 62 MB toolchain (and the worker that drives it) out of
 * the webpack graph, and lets the toolchain be upgraded without rebuilding the IDE - the
 * host runtime ships inside the distribution, so it can never drift from the compiler
 * bundle whose contracts it implements.
 *
 * `import()` is hidden from TypeScript and webpack on purpose: TypeScript would rewrite it to
 * `require` under `module: commonjs`, and webpack would try to resolve and bundle a path that
 * only exists at runtime.
 */
const dynamicImport = new Function('specifier', 'return import(specifier);') as (
    specifier: string,
) => Promise<EngineModule>;

@injectable()
export class ScalaEngineService {
    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    protected engine: EngineClient | undefined;
    protected loading: Promise<EngineClient> | undefined;
    protected info: ScalaEngineInfo | undefined;

    protected readonly onStatusChangedEmitter = new Emitter<EngineStatus>();
    readonly onStatusChanged: Event<EngineStatus> = this.onStatusChangedEmitter.event;

    protected readonly onOutputEmitter = new Emitter<string>();
    /** Lines written by the running program, as they arrive. */
    readonly onOutput: Event<string> = this.onOutputEmitter.event;

    protected status: EngineStatus = { state: 'idle' };

    @postConstruct()
    protected init(): void {
        // Loading is deliberately not started here: a workbench that never compiles Scala
        // should not download the toolchain.
    }

    get currentStatus(): EngineStatus {
        return this.status;
    }

    get engineInfo(): ScalaEngineInfo | undefined {
        return this.info;
    }

    protected setStatus(state: EngineState, detail?: string): void {
        this.status = { state, detail };
        this.onStatusChangedEmitter.fire(this.status);
    }

    /**
     * Where the toolchain lives, following the pointer unless something overrides it.
     *
     * The pointer is the only file that must be fresh; it names a content-addressed directory,
     * so everything it points at can be cached forever without any risk of a stale copy
     * answering for a new release. `cacheBust` skips even that one cached response, for when
     * someone explicitly asks to reload.
     */
    protected async resolveToolchain(cacheBust = false): Promise<{ manifest: string; host: string; worker: string }> {
        const base = new URL(document.baseURI);
        const manifestOverride = this.preferences.get<string>('yukibana.toolchainManifest', '');
        const moduleOverride = this.preferences.get<string>('yukibana.engineModule', '');
        const workerOverride = this.preferences.get<string>('yukibana.engineWorker', '');

        let fromPointer: { manifest?: string; host?: string; worker?: string } = {};
        let pointerBase = base;
        if (!manifestOverride || !moduleOverride || !workerOverride) {
            const pointerUrl = new URL(
                this.preferences.get<string>('yukibana.toolchainPointer', './toolchain/current.json'),
                base,
            );
            if (cacheBust) {
                pointerUrl.searchParams.set('reload', String(Date.now()));
            }
            const response = await fetch(pointerUrl.href, { cache: cacheBust ? 'reload' : 'no-cache' });
            if (!response.ok) {
                throw new Error(`Could not read ${pointerUrl.href}: ${response.status} ${response.statusText}`);
            }
            fromPointer = await response.json();
            pointerBase = pointerUrl;
        }

        const resolve = (override: string, pointed: string | undefined, fallback: string): string =>
            override
                ? new URL(override, base).href
                : new URL(pointed ?? fallback, pointerBase).href;

        return {
            manifest: resolve(manifestOverride, fromPointer.manifest, './toolchain/manifest.json'),
            host: resolve(moduleOverride, fromPointer.host, './toolchain/host/index.js'),
            worker: resolve(workerOverride, fromPointer.worker, './toolchain/host/worker.js'),
        };
    }

    protected bypassCacheOnNextLoad = false;

    /**
     * Throw away the loaded toolchain and load it again, ignoring any cached copy.
     *
     * The one manual escape hatch, for a browser holding something stale from before the
     * content-addressed layout existed. Everything it re-fetches is re-resolved through the
     * pointer, so this picks up a new release as well as a repaired one.
     */
    async reload(): Promise<EngineClient> {
        this.engine?.terminate?.();
        this.engine = undefined;
        this.loading = undefined;
        this.info = undefined;
        this.bypassCacheOnNextLoad = true;
        return this.ready();
    }

    /** Load the toolchain, reusing an in-flight load. */
    async ready(): Promise<EngineClient> {
        if (this.engine) {
            return this.engine;
        }
        this.loading ??= this.load();
        return this.loading;
    }

    protected async load(): Promise<EngineClient> {
        this.setStatus('loading', 'Loading Scala toolchain');
        try {
            const urls = await this.resolveToolchain(this.bypassCacheOnNextLoad);
            this.bypassCacheOnNextLoad = false;
            const { ScalaEngine } = await dynamicImport(urls.host);
            const engine = new ScalaEngine({ workerUrl: urls.worker, manifestUrl: urls.manifest });

            engine.on('progress', ({ stage }: { stage: string }) => this.setStatus('loading', STAGE_LABELS[stage] ?? stage));
            engine.on('stdout', ({ chunk }: { chunk: string }) => this.onOutputEmitter.fire(chunk));

            const info = await engine.init();
            // A distribution this frontend is newer than answers `init` perfectly well; what it
            // cannot do is everything asked of it afterwards. `warmUp` is the cheapest tell -
            // it has existed since 0.2.0, so its absence dates the toolchain precisely.
            this.info = { ...info, olderThanFrontend: typeof engine.warmUp !== 'function' };
            this.engine = engine;
            this.setStatus('ready');

            // Pay the one-off costs - the classpath scan and the first link's IR parse - now,
            // in the background, rather than in the user's first Run. Nothing here may fail the
            // load: the engine is already usable, and the next real compile does the same work.
            //
            // `.catch()` alone was not enough. A toolchain older than this frontend has no
            // `warmUp` at all, so the call threw *synchronously*, before any promise existed -
            // straight past the catch, into the try below, and reported as "the toolchain failed
            // to load". An optimisation took down the thing it was optimising.
            void Promise.resolve()
                .then(() => engine.warmUp?.(this.preferences.get<LinkTarget>('yukibana.outputTarget', 'js')))
                .catch(() => undefined);

            return engine;
        } catch (error) {
            this.loading = undefined;
            const detail = error instanceof Error ? error.message : String(error);
            this.setStatus('failed', detail);
            throw error;
        }
    }

    /** Compile, link and run a set of sources. Keys are workspace-relative file names. */
    async run(files: Record<string, string>, target: LinkTarget): Promise<ScalaRunResult> {
        const engine = await this.ready();
        this.setStatus('busy', 'Compiling');
        try {
            const result = await engine.run(files, { target });
            this.setStatus('ready');
            return result;
        } catch (error) {
            this.setStatus('ready');
            throw error;
        }
    }

    /** Compile only - used for on-save diagnostics. */
    async compile(files: Record<string, string>): Promise<ScalaRunResult> {
        const engine = await this.ready();
        this.setStatus('busy', 'Compiling');
        try {
            const result = await engine.compile(files);
            this.setStatus('ready');
            return result;
        } catch (error) {
            this.setStatus('ready');
            throw error;
        }
    }
}
