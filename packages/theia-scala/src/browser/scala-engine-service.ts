import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { LinkTarget, ScalaEngineInfo, ScalaRunResult } from '../common';

/** The part of `@yukibana/scala-engine`'s client that this extension uses. */
interface EngineClient {
    init(): Promise<ScalaEngineInfo>;
    compile(files: Record<string, string>, options?: string[]): Promise<ScalaRunResult>;
    run(files: Record<string, string>, config?: { mainClass?: string; target?: LinkTarget }): Promise<ScalaRunResult>;
    on(event: 'progress' | 'stdout' | 'error', listener: (payload: any) => void): () => void;
}

interface EngineModule {
    ScalaEngine: new (config: { workerUrl: string | URL; manifestUrl: string }) => EngineClient;
}

export type EngineState = 'idle' | 'loading' | 'ready' | 'failed' | 'busy';

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

    protected get moduleUrl(): string {
        return this.preferences.get<string>('yukibana.engineModule', './toolchain/host/index.js');
    }

    protected get workerUrl(): string {
        return this.preferences.get<string>('yukibana.engineWorker', './toolchain/host/worker.js');
    }

    protected get manifestUrl(): string {
        return this.preferences.get<string>('yukibana.toolchainManifest', './toolchain/manifest.json');
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
            const base = new URL(document.baseURI);
            const { ScalaEngine } = await dynamicImport(new URL(this.moduleUrl, base).href);
            const engine = new ScalaEngine({
                workerUrl: new URL(this.workerUrl, base).href,
                manifestUrl: new URL(this.manifestUrl, base).href,
            });

            engine.on('progress', ({ stage }: { stage: string }) => this.setStatus('loading', stage));
            engine.on('stdout', ({ chunk }: { chunk: string }) => this.onOutputEmitter.fire(chunk));

            this.info = await engine.init();
            this.engine = engine;
            this.setStatus('ready');
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
