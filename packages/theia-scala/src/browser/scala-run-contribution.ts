import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import * as React from '@theia/core/shared/react';
import { Emitter } from '@theia/core/lib/common/event';
import { PreferenceService, PreferenceScope } from '@theia/core/lib/common/preferences';
import {
    TabBarToolbar,
    TabBarToolbarContribution,
    TabBarToolbarRegistry,
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { Widget } from '@theia/core/lib/browser/widgets';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { CommonMenus, FrontendApplicationContribution, StatusBar, StatusBarAlignment } from '@theia/core/lib/browser';
import { KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import { Diagnostic, DiagnosticSeverity } from '@theia/core/shared/vscode-languageserver-protocol';
import { OutputChannelManager, OutputChannelSeverity } from '@theia/output/lib/browser/output-channel';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileChangeType } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { EditorManager, EditorWidget } from '@theia/editor/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { LinkTarget, ScalaDiagnostic, ScalaEngineInfo, ScalaRunResult, WORKSPACE_PREFIX, SCALA_EXTENSION, missingWasmFeatures } from '../common';
import { EXAMPLE_WORKSPACE, EXAMPLE_ENTRY_FILE, canBeSuperseded, isSupersededSample } from '../common/examples';
import { EngineStatus, ScalaEngineService } from './scala-engine-service';
import { ScalaPreferences } from './scala-preferences';
import { ScalaWorkspace } from './scala-workspace';

export namespace ScalaCommands {
    export const RUN: Command = {
        id: 'yukibana.run',
        category: 'Scala',
        label: 'Run',
    };
    export const RUN_AS_WASM: Command = {
        id: 'yukibana.runAsWasm',
        category: 'Scala',
        label: 'Run as WebAssembly',
    };
    export const RUN_AS_JS: Command = {
        id: 'yukibana.runAsJs',
        category: 'Scala',
        label: 'Run as JavaScript',
    };
    export const COMPILE: Command = {
        id: 'yukibana.compile',
        category: 'Scala',
        label: 'Compile',
    };
    export const LOAD_TOOLCHAIN: Command = {
        id: 'yukibana.loadToolchain',
        category: 'Scala',
        label: 'Load Toolchain',
    };

    export const RELOAD_TOOLCHAIN: Command = {
        id: 'yukibana.scala.reloadToolchain',
        category: 'Scala',
        label: 'Reload Toolchain (ignore cached copy)',
    };
}

/**
 * Say what the toolchain is, and when something is unavailable, why.
 *
 * "WebAssembly output unavailable" on its own is a dead end for whoever reads it. It nearly
 * always means the loaded compiler bundle predates the runtime asking it for those exports -
 * a stale cache serving a mix of two releases - which is fixable in one reload.
 */
export function describeToolchain(info: ScalaEngineInfo | undefined): string {
    if (!info) {
        return 'Scala toolchain is not loaded.';
    }

    const parts = [`Scala toolchain ready (host ${info.hostVersion ?? 'unknown'}).`];
    parts.push(`WebAssembly output ${info.supportsWasmTarget ? 'available' : 'unavailable'}.`);
    parts.push(`Quoted macros ${info.supportsMacros ? 'expand in the browser' : 'are not supported'}.`);

    if (!info.supportsWasmTarget && info.missingExports?.length) {
        parts.push(`The loaded compiler is missing: ${info.missingExports.join(', ')}.`);
    }
    if (info.versionMismatch) {
        parts.push(
            `It was built with host ${info.manifestHostVersion}, but this runtime is ` +
                `${info.hostVersion} - a cached copy of an older release is being served. ` +
                'Run "Scala: Reload Toolchain" to fetch the current one.',
        );
    } else if (info.olderThanFrontend) {
        parts.push(
            `This toolchain (host ${info.hostVersion ?? 'unknown'}) is older than this editor ` +
                'expects, so a cached copy of an earlier release is being served. Run ' +
                '"Scala: Reload Toolchain" to fetch the current one.',
        );
    }

    return parts.join(' ');
}

/**
 * Everything known about a failure, as lines for the output channel.
 *
 * Errors crossing a worker boundary arrive flattened - our own carry a `cause` and sometimes
 * the fields the worker managed to salvage - so unpacking them here is the difference between
 * a report that names a URL and one that says "Failed to fetch".
 */
export function describeFailure(error: unknown): string[] {
    const lines: string[] = [];
    let current: unknown = error;

    for (let depth = 0; current && depth < 4; depth++) {
        const asError = current as { name?: string; message?: string; stack?: string; cause?: unknown };
        const name = typeof asError.name === 'string' ? asError.name : 'Error';
        const message = typeof asError.message === 'string' ? asError.message : String(current);
        lines.push(depth === 0 ? `${name}: ${message}` : `caused by ${name}: ${message}`);
        if (typeof asError.stack === 'string' && depth === 0) {
            lines.push(...asError.stack.split('\n').slice(1, 6).map(line => '    ' + line.trim()));
        }
        current = asError.cause;
    }

    if (/failed to fetch/i.test(lines[0] ?? '')) {
        lines.push(
            'A network request failed without saying which. Open DevTools, reload, and look ' +
                'for the request marked failed in the Network tab - that names the asset.',
        );
    }
    return lines;
}

const PROBLEM_OWNER = 'scala';
const STATUS_BAR_ID = 'yukibana-scala-status';
const OUTPUT_CHANNEL = 'Scala';
/** How long to wait for edits to stop before reacting to them. */
const AFTER_EDIT_DELAY_MS = 400;
const SEEDED_FLAG = 'yukibana.workspace.seeded';
const DEFAULT_WORKSPACE = 'file:///workspace';


/**
 * Wires the browser Scala toolchain into the workbench: a Run button and an Autorun checkbox
 * on the editor toolbar, commands to compile and run, program output in the Output view,
 * compiler diagnostics in the Problems view, and toolchain state in the status bar.
 */
@injectable()
export class ScalaRunContribution
    implements
        CommandContribution,
        MenuContribution,
        KeybindingContribution,
        FrontendApplicationContribution,
        TabBarToolbarContribution
{
    @inject(ScalaEngineService) protected readonly engine: ScalaEngineService;
    @inject(ScalaWorkspace) protected readonly sources: ScalaWorkspace;
    @inject(ScalaPreferences) protected readonly preferences: ScalaPreferences;
    @inject(OutputChannelManager) protected readonly outputChannels: OutputChannelManager;
    @inject(ProblemManager) protected readonly problems: ProblemManager;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(StatusBar) protected readonly statusBar: StatusBar;
    @inject(FileService) protected readonly fileService: FileService;
    @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService;
    @inject(EditorManager) protected readonly editorManager: EditorManager;
    @inject(PreferenceService) protected readonly preferenceService: PreferenceService;

    /**
     * Run and Autorun, on the editor's toolbar.
     *
     * Running used to be a command, which meant knowing it existed. These are the two controls
     * someone actually reaches for, in the place they look for them: a button that runs the
     * program now, and a checkbox that keeps running it as they edit.
     */
    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        const isVisible = (widget?: Widget) => this.isScalaEditor(widget);

        // Declared, not rendered. Theia blanks a toolbar item's text as soon as it has an icon
        // ("only present text if there is no icon"), so `$(play) Run` is a bare triangle - but
        // a label with no icon is a supported case it styles for. Taking it back gives us the
        // keybinding appended to the tooltip, command enablement, the action-item classes and
        // keyboard activation, all of which a hand-rolled button has to reimplement or drop.
        registry.registerItem({
            id: 'yukibana.scala.run',
            command: ScalaCommands.RUN.id,
            text: 'Run',
            tooltip: 'Compile and run the Scala program',
            priority: 0,
            group: 'navigation',
            isVisible,
        });

        registry.registerItem({
            id: 'yukibana.scala.autorun',
            priority: 1,
            group: 'navigation',
            isVisible,
            // A real checkbox rather than a toggled icon: "is autorun on?" should be answerable
            // by looking, not by remembering what the highlighted state meant. A checkbox is
            // the one thing the declarative API cannot express, so this one is rendered.
            onDidChange: this.onAutoRunChangedEmitter.event,
            render: () => this.renderAutoRunCheckbox(),
        });
    }

    protected renderAutoRunCheckbox(): React.ReactNode {
        return React.createElement(
            'label',
            {
                key: 'yukibana-autorun',
                className: `yukibana-autorun ${TabBarToolbar.Styles.TAB_BAR_TOOLBAR_ITEM} enabled`,
                title: 'Run the program again every time you save',
                // The class above brings Theia's toolbar-item layout; these are the two things
                // it has no opinion about, so a stylesheet for them would not earn its build step.
                style: { padding: '0 6px', whiteSpace: 'nowrap' },
            },
            React.createElement('input', {
                type: 'checkbox',
                checked: this.autoRunEnabled,
                style: { margin: '0 4px 0 0', cursor: 'pointer' },
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => this.setAutoRun(event.target.checked),
            }),
            'Autorun',
        );
    }

    /** The toolbar is per-widget; these belong to an editor holding Scala. */
    protected isScalaEditor(widget?: Widget): boolean {
        return widget instanceof EditorWidget && widget.editor.uri.path.ext === SCALA_EXTENSION;
    }

    protected readonly onAutoRunChangedEmitter = new Emitter<void>();

    /**
     * Whether autorun is on, held here rather than read from preferences on each render.
     *
     * The checkbox is a controlled input, so its state has to change the instant it is clicked.
     * Writing the preference and re-reading it does not: the write is asynchronous, and in a
     * browser-only workbench it may not land at all, so the box ticks and immediately snaps
     * back. This field is what the checkbox reflects; the preference is where it is persisted
     * and where someone can set it by hand.
     */
    protected autoRunEnabled = false;

    /** Counts runs this session, so one run's output is distinguishable from the next. */
    protected runCount = 0;

    /** A save arrived while a run was in flight; run again once it finishes. */
    protected runQueuedWhileBusy = false;

    /**
     * Move the field the checkbox reflects, and redraw only when it actually changed.
     *
     * Coerced, not asserted: the preference proxy is typed `boolean` but returns `undefined`
     * when nothing has been written and no default reaches it, and `checked={undefined}` turns
     * React's checkbox into an uncontrolled input that stops tracking this field at all.
     */
    protected applyAutoRun(enabled: boolean | undefined): void {
        if (!!enabled !== this.autoRunEnabled) {
            this.autoRunEnabled = !!enabled;
            this.onAutoRunChangedEmitter.fire();
        }
    }

    protected async setAutoRun(enabled: boolean): Promise<void> {
        this.applyAutoRun(enabled);

        if (enabled) {
            // Acting immediately is the point of ticking it - otherwise nothing happens until
            // the next save, which reads as the checkbox not working.
            this.runQuietly();
        }

        // Persistence is a nicety; the checkbox must not wait for it or depend on it.
        try {
            await this.preferenceService.set('yukibana.autoRun', enabled, PreferenceScope.User);
        } catch {
            // A workbench with nowhere to store preferences still gets a working checkbox.
        }
    }

    protected afterEditTimer: number | undefined;
    protected running = false;

    onStart(): void {
        this.warnIfBrowserCannotRunScala();
        this.applyAutoRun(this.preferences['yukibana.autoRun']);
        // The injected proxy, not the global service: it already filters to this schema's own
        // keys, so the listener does not run for every preference in the workbench.
        this.preferences.onPreferenceChanged(change => {
            // Settings is the other way to turn this on, and the checkbox has to agree with it.
            // `PreferenceChange` carries no value in this Theia version, so read it back.
            if (change.preferenceName === 'yukibana.autoRun') {
                this.applyAutoRun(this.preferences['yukibana.autoRun']);
            }
        });

        this.engine.onStatusChanged(status => {
            this.renderStatus(status);
            this.warnOnceAboutStaleToolchain();
        });
        this.renderStatus(this.engine.currentStatus);

        this.engine.onOutput(line => this.channel.appendLine(line));

        this.fileService.onDidFilesChange(event => {
            const autoRun = this.autoRunEnabled;
            if (!autoRun && !this.preferences['yukibana.compileOnSave']) {
                return;
            }
            const touchedScala = event.changes.some(
                change => change.type !== FileChangeType.DELETED && change.resource.path.ext === SCALA_EXTENSION,
            );
            if (touchedScala) {
                // Autorun means run: compiling alone would leave the output showing the result
                // of the previous edit, which is worse than not reacting at all.
                this.scheduleAfterEdit(autoRun ? 'run' : 'compile');
            }
        });
    }

    /**
     * Say up front when this browser cannot run the compiler at all.
     *
     * Without this the editor opens, looks entirely healthy, and only admits the problem when
     * someone presses Run - by which point whatever else went wrong along the way (Theia's own
     * storage failing, say) has had time to look like the cause.
     */
    protected warnIfBrowserCannotRunScala(): void {
        const missing = missingWasmFeatures();
        if (missing.length === 0) {
            return;
        }
        this.messages.warn(
            'This browser cannot run Scala: it lacks ' + missing.join(', ') + '. ' +
                'The compiler runs on WebAssembly JSPI, which today means Chrome or Edge 137 or ' +
                'newer. Editing works; compiling and running do not.',
        );
    }

    protected staleToolchainReported = false;

    /**
     * Say so, once, when the loaded toolchain is not the one this frontend was built against.
     *
     * Silence here is expensive: the browser is running an older compiler than we think, which
     * shows up as features that "don't work" and results that do not match the code. It happens
     * when a cached copy of a previous release is served - `/toolchain/*` was once marked
     * immutable for a year - and it is not self-healing, because the stale copy is what answers
     * the request. Only the person at the keyboard can fix it, so only they can be told.
     */
    protected warnOnceAboutStaleToolchain(): void {
        const info = this.engine.engineInfo;
        if (this.staleToolchainReported || !(info?.versionMismatch || info?.olderThanFrontend)) {
            return;
        }
        this.staleToolchainReported = true;
        this.messages.warn(describeToolchain(info));
    }

    /** Opening an editor only works once the shell has a layout, so seed here, not in onStart. */
    onDidInitializeLayout(): void {
        this.seedWorkspace().catch(error => console.warn('[yukibana] could not seed the workspace', error));
    }

    protected get channel() {
        return this.outputChannels.getChannel(OUTPUT_CHANNEL);
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(ScalaCommands.RUN, {
            execute: () => this.run(this.preferences['yukibana.outputTarget']),
        });
        commands.registerCommand(ScalaCommands.RUN_AS_JS, { execute: () => this.run('js') });
        commands.registerCommand(ScalaCommands.RUN_AS_WASM, { execute: () => this.run('wasm') });
        commands.registerCommand(ScalaCommands.COMPILE, { execute: () => this.compile() });
        commands.registerCommand(ScalaCommands.LOAD_TOOLCHAIN, {
            execute: async () => {
                await this.engine.ready();
                this.messages.info(describeToolchain(this.engine.engineInfo));
            },
        });

        commands.registerCommand(ScalaCommands.RELOAD_TOOLCHAIN, {
            execute: async () => {
                // Discards the loaded toolchain and re-resolves it, ignoring any cached copy.
                // The one thing a person can do about a browser holding something stale, and
                // it should not require knowing about hard reloads.
                this.staleToolchainReported = false;
                try {
                    await this.engine.reload();
                    this.messages.info(describeToolchain(this.engine.engineInfo));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.messages.error(`Could not reload the Scala toolchain: ${message}`);
                }
            },
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        for (const command of [ScalaCommands.RUN, ScalaCommands.COMPILE]) {
            menus.registerMenuAction(CommonMenus.EDIT_FIND, {
                commandId: command.id,
                label: `${command.category}: ${command.label}`,
            });
        }
    }

    registerKeybindings(keybindings: KeybindingRegistry): void {
        keybindings.registerKeybinding({ command: ScalaCommands.RUN.id, keybinding: 'f5' });
        keybindings.registerKeybinding({ command: ScalaCommands.COMPILE.id, keybinding: 'ctrlcmd+shift+b' });
    }

    /**
     * React to an edit, once the edits stop.
     *
     * Saving fires per file, and a formatter or a multi-file change fires several times in a
     * row; without the delay, typing would queue a compile per keystroke behind the one
     * already running.
     */
    protected scheduleAfterEdit(action: 'compile' | 'run'): void {
        if (this.afterEditTimer !== undefined) {
            window.clearTimeout(this.afterEditTimer);
        }
        this.afterEditTimer = window.setTimeout(() => {
            this.afterEditTimer = undefined;
            this.runOrCompileQuietly(action);
        }, AFTER_EDIT_DELAY_MS);
    }

    /** React now, without the debounce: the edits that prompted this are already in. */
    protected runOrCompileQuietly(action: 'compile' | 'run'): void {
        if (action === 'run') {
            this.runQuietly();
        } else {
            this.compile({ quiet: true }).catch(() => undefined);
        }
    }

    /** Start a run at the configured target and ignore how it goes; the Output view has it. */
    protected runQuietly(): void {
        this.run(this.preferences['yukibana.outputTarget'], { quiet: true }).catch(() => undefined);
    }

    async compile(options: { quiet?: boolean } = {}): Promise<void> {
        const { quiet = false } = options;
        const { files, uris } = await this.sources.collect();
        if (Object.keys(files).length === 0) {
            if (!quiet) {
                this.messages.warn('No Scala sources found in the workspace.');
            }
            return;
        }

        const result = await this.engine.compile(files);
        this.publishDiagnostics(result, uris);

        if (quiet) {
            return;
        }

        const channel = this.channel;
        channel.show({ preserveFocus: true });
        if (result.ok) {
            channel.appendLine(
                `Compiled ${Object.keys(files).length} file(s) in ${Math.round(result.compileMs)} ms.`,
            );
            if (result.warningCount > 0) {
                channel.appendLine(result.compilerOutput, OutputChannelSeverity.Warning);
            }
            return;
        }

        // Diagnostics also go to the Problems view, but a build log is expected to say what
        // went wrong without switching views.
        channel.appendLine(result.compilerOutput, OutputChannelSeverity.Error);
        channel.appendLine(`Compilation failed with ${result.errorCount} error(s).`, OutputChannelSeverity.Error);
    }

    /**
     * @param quiet suppress the pop-ups. Autorun fires on every save, and a toast per failed
     *   save while someone is mid-edit is noise; the Output view still says everything.
     */
    async run(target: LinkTarget, options: { quiet?: boolean } = {}): Promise<void> {
        const { quiet = false } = options;
        if (this.running) {
            if (quiet) {
                // An autorun save arriving mid-run: the edit that triggered it is newer than
                // what is running, so remember to run again rather than drop it. Dropping left
                // the Output showing the previous edit's result with nothing to say why.
                this.runQueuedWhileBusy = true;
            } else {
                this.messages.info('A Scala program is already running.');
            }
            return;
        }

        const { files, uris } = await this.sources.collect();
        if (Object.keys(files).length === 0) {
            if (!quiet) {
                this.messages.warn('No Scala sources found in the workspace.');
            }
            return;
        }

        this.running = true;
        const channel = this.channel;
        channel.clear();
        channel.show({ preserveFocus: true });
        // Numbered so two runs of the same program are distinguishable - in a bug report, and
        // in the tests, which otherwise cannot tell this run's output from the last one's.
        this.runCount += 1;
        channel.appendLine(
            `[run ${this.runCount}] Compiling ${Object.keys(files).length} file(s), ` +
                `linking to ${this.describeTarget(target)}...`,
        );

        try {
            const result = await this.engine.run(files, target);
            this.publishDiagnostics(result, uris);

            if (!result.ok) {
                channel.appendLine(result.compilerOutput || 'Compilation failed.', OutputChannelSeverity.Error);
                if (!quiet) {
                    this.messages.error(`Scala compilation failed with ${result.errorCount} error(s).`);
                }
                return;
            }

            if (!result.ran) {
                channel.appendLine(result.error ?? 'Nothing to run.', OutputChannelSeverity.Warning);
                return;
            }

            if (result.warningCount > 0) {
                channel.appendLine(`${result.warningCount} warning(s).`, OutputChannelSeverity.Warning);
            }

            channel.appendLine(`--- ${result.mainClass} ---`);
            channel.appendLine(result.output && result.output.length > 0 ? result.output : '(no output)');
            channel.appendLine(this.describeTimings(result));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // The toast gets the sentence; the channel gets everything that might identify the
            // cause. A bare "Failed to fetch" is impossible to act on, and by the time someone
            // reports it the console has usually been closed.
            for (const line of describeFailure(error)) {
                channel.appendLine(line, OutputChannelSeverity.Error);
            }
            if (!quiet) {
                this.messages.error(`Scala run failed: ${message}`);
            }
        } finally {
            this.running = false;
            if (this.runQueuedWhileBusy) {
                this.runQueuedWhileBusy = false;
                // Directly, not through the debounce: the burst it exists to coalesce ended
                // while this run was in flight, so waiting again is pure latency.
                this.runOrCompileQuietly('run');
            }
        }
    }

    protected describeTarget(target: LinkTarget): string {
        return target === 'wasm' ? 'WebAssembly' : 'JavaScript';
    }

    protected describeTimings(result: ScalaRunResult): string {
        const parts = [
            `compile ${Math.round(result.compileMs)} ms`,
            result.linkMs !== undefined ? `link ${Math.round(result.linkMs)} ms` : undefined,
            result.runMs !== undefined ? `run ${Math.round(result.runMs)} ms` : undefined,
            result.linkedBytes !== undefined
                ? `${(result.linkedBytes / 1024).toFixed(1)} KB ${this.describeTarget(result.target ?? 'js')}`
                : undefined,
        ].filter(Boolean);
        // The run number rides on the *last* line as well as the header. The Output view is a
        // Monaco editor and virtualises its DOM, so the header scrolls out of existence on a
        // long run - the tail is the only part reliably on screen, for a reader or a test.
        return `--- ${parts.join(', ')} --- [run ${this.runCount}]`;
    }

    /** Map compiler diagnostics onto the Problems view. */
    protected publishDiagnostics(result: ScalaRunResult, uris: Map<string, URI>): void {
        const byUri = new Map<string, Diagnostic[]>();
        for (const uri of uris.values()) {
            byUri.set(uri.toString(), []);
        }

        for (const diagnostic of result.diagnostics) {
            const name = diagnostic.file?.startsWith(WORKSPACE_PREFIX)
                ? diagnostic.file.slice(WORKSPACE_PREFIX.length)
                : diagnostic.file ?? undefined;
            const uri = name ? uris.get(name) : undefined;
            if (!uri) {
                continue;
            }
            byUri.get(uri.toString())?.push(this.toDiagnostic(diagnostic));
        }

        for (const [uri, diagnostics] of byUri) {
            this.problems.setMarkers(new URI(uri), PROBLEM_OWNER, diagnostics);
        }
    }

    protected toDiagnostic(diagnostic: ScalaDiagnostic): Diagnostic {
        // The compiler reports 1-based lines and 0-based columns; LSP wants both 0-based.
        const line = Math.max(0, (diagnostic.line ?? 1) - 1);
        const character = Math.max(0, diagnostic.column ?? 0);
        // Underline the expression the compiler objected to, when it said how far it runs.
        // Without an end, one character is all we can honestly claim.
        const end =
            diagnostic.endLine != null && diagnostic.endColumn != null
                ? { line: Math.max(line, diagnostic.endLine - 1), character: Math.max(0, diagnostic.endColumn) }
                : { line, character: character + 1 };
        return {
            range: {
                start: { line, character },
                end,
            },
            severity:
                diagnostic.severity === 'error'
                    ? DiagnosticSeverity.Error
                    : diagnostic.severity === 'warning'
                      ? DiagnosticSeverity.Warning
                      : DiagnosticSeverity.Information,
            code: diagnostic.code ?? undefined,
            source: 'scalac',
            message: diagnostic.message,
        };
    }

    protected renderStatus(status: EngineStatus): void {
        const text = {
            idle: '$(coffee) Scala',
            loading: `$(sync~spin) Scala: ${status.detail ?? 'loading'}`,
            ready: '$(check) Scala ready',
            busy: `$(sync~spin) Scala: ${status.detail ?? 'working'}`,
            failed: '$(error) Scala unavailable',
        }[status.state];

        this.statusBar.setElement(STATUS_BAR_ID, {
            text,
            alignment: StatusBarAlignment.LEFT,
            priority: 100,
            tooltip: this.engine.engineInfo ? describeToolchain(this.engine.engineInfo) : (status.detail ?? 'Scala toolchain (WebAssembly)'),
            command: status.state === 'failed' ? ScalaCommands.LOAD_TOOLCHAIN.id : ScalaCommands.RUN.id,
        });
    }

    /**
     * A workbench with an empty file system is not much of a demo, so on a first visit create
     * a workspace with a sample program and open it.
     *
     * Opening a workspace reloads the page, so a flag in local storage keeps *that* to once;
     * the seeding itself is idempotent and runs every time, repairing whatever is missing.
     */
    protected async seedWorkspace(): Promise<void> {
        const roots = this.workspaceService.tryGetRoots();

        if (roots.length === 0) {
            if (localStorage.getItem(SEEDED_FLAG)) {
                return;
            }
            localStorage.setItem(SEEDED_FLAG, 'true');

            const root = new URI(DEFAULT_WORKSPACE);
            if (!(await this.fileService.exists(root))) {
                await this.fileService.createFolder(root);
            }
            await this.writeExampleWorkspace(root);
            // Opening reloads the page, so seeding runs again from the top - the pass above is
            // what makes the workspace non-empty before that happens.
            await this.workspaceService.open(root);
            return;
        }

        const root = new URI(roots[0].resource.toString());
        const entry = root.resolve(EXAMPLE_ENTRY_FILE);
        // Deliberately not gated on the entry file being absent. A workspace that already has
        // `Main.scala` is the common case - anyone who opened this before the examples existed
        // has exactly that, and the old gate meant they kept a lone hello-world forever. It
        // also repairs a workspace missing one example file, whether deleted or half-written,
        // instead of leaving it in a state where every run fails.
        await this.writeExampleWorkspace(root);
        await this.editorManager.open(entry);
    }

    /**
     * Write any example file that is missing, and replace one we recognise as our own.
     *
     * Never overwrites something a person may have written: a file is replaced only when its
     * contents match a sample an earlier version of this extension seeded, byte for byte.
     */
    protected async writeExampleWorkspace(root: URI): Promise<void> {
        // Reads only what can matter: this runs on every load, each file costs a round-trip to
        // the OPFS worker, and `canBeSuperseded` settles five of the six from the name alone,
        // so five reads and their decodes never happen.
        //
        // Sequential on purpose. Issuing the six as a `Promise.all` is the obvious next step
        // and saves a few tens of milliseconds off a path that is already off the critical
        // path - but it made the seeded workspace come out incomplete, and an example that
        // fails to compile costs a visitor far more than the wait.
        for (const [name, source] of Object.entries(EXAMPLE_WORKSPACE)) {
            const file = root.resolve(name);
            if (!(await this.fileService.exists(file))) {
                await this.fileService.create(file, source);
                continue;
            }
            if (!canBeSuperseded(name)) {
                continue;
            }
            const existing = await this.fileService.read(file);
            if (isSupersededSample(name, existing.value)) {
                await this.fileService.write(file, source);
            }
        }
    }
}
