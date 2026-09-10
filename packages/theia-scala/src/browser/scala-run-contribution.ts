import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { CommonMenus, FrontendApplicationContribution, StatusBar, StatusBarAlignment } from '@theia/core/lib/browser';
import { KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser/keybinding';
import { Diagnostic, DiagnosticSeverity } from '@theia/core/shared/vscode-languageserver-protocol';
import { OutputChannelManager, OutputChannelSeverity } from '@theia/output/lib/browser/output-channel';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileChangeType } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { LinkTarget, ScalaDiagnostic, ScalaRunResult, WORKSPACE_PREFIX } from '../common';
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
}

const PROBLEM_OWNER = 'scala';
const STATUS_BAR_ID = 'yukibana-scala-status';
const OUTPUT_CHANNEL = 'Scala';
const COMPILE_ON_SAVE_DELAY_MS = 400;
const SEEDED_FLAG = 'yukibana.workspace.seeded';
const DEFAULT_WORKSPACE = 'file:///workspace';

const SAMPLE_SOURCE = `@main def hello(): Unit =
  val squares = (1 to 5).map(n => n * n)
  println(s"squares: \${squares.mkString(", ")}")
  println(s"sum = \${squares.sum}")
`;

/**
 * Wires the browser Scala toolchain into the workbench: commands to compile and run, program
 * output in the Output view, compiler diagnostics in the Problems view, and toolchain state
 * in the status bar.
 */
@injectable()
export class ScalaRunContribution
    implements CommandContribution, MenuContribution, KeybindingContribution, FrontendApplicationContribution
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

    protected compileOnSaveTimer: number | undefined;
    protected running = false;

    onStart(): void {
        this.engine.onStatusChanged(status => this.renderStatus(status));
        this.renderStatus(this.engine.currentStatus);

        this.engine.onOutput(line => this.channel.appendLine(line));

        this.fileService.onDidFilesChange(event => {
            if (!this.preferences['yukibana.compileOnSave']) {
                return;
            }
            const touchedScala = event.changes.some(
                change => change.type !== FileChangeType.DELETED && change.resource.path.ext === '.scala',
            );
            if (touchedScala) {
                this.scheduleCompile();
            }
        });

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
                const info = this.engine.engineInfo;
                this.messages.info(
                    `Scala toolchain ready. WebAssembly output ${info?.supportsWasmTarget ? 'available' : 'unavailable'}.`,
                );
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

    protected scheduleCompile(): void {
        if (this.compileOnSaveTimer !== undefined) {
            window.clearTimeout(this.compileOnSaveTimer);
        }
        this.compileOnSaveTimer = window.setTimeout(() => {
            this.compileOnSaveTimer = undefined;
            this.compile({ quiet: true }).catch(() => undefined);
        }, COMPILE_ON_SAVE_DELAY_MS);
    }

    async compile(options: { quiet?: boolean } = {}): Promise<void> {
        const { files, uris } = await this.sources.collect();
        if (Object.keys(files).length === 0) {
            if (!options.quiet) {
                this.messages.warn('No Scala sources found in the workspace.');
            }
            return;
        }

        const result = await this.engine.compile(files);
        this.publishDiagnostics(result, uris);

        if (options.quiet) {
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

    async run(target: LinkTarget): Promise<void> {
        if (this.running) {
            this.messages.info('A Scala program is already running.');
            return;
        }

        const { files, uris } = await this.sources.collect();
        if (Object.keys(files).length === 0) {
            this.messages.warn('No Scala sources found in the workspace.');
            return;
        }

        this.running = true;
        const channel = this.channel;
        channel.clear();
        channel.show({ preserveFocus: true });
        channel.appendLine(`Compiling ${Object.keys(files).length} file(s), linking to ${this.describeTarget(target)}...`);

        try {
            const result = await this.engine.run(files, target);
            this.publishDiagnostics(result, uris);

            if (!result.ok) {
                channel.appendLine(result.compilerOutput || 'Compilation failed.', OutputChannelSeverity.Error);
                this.messages.error(`Scala compilation failed with ${result.errorCount} error(s).`);
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
            channel.appendLine(message, OutputChannelSeverity.Error);
            this.messages.error(`Scala run failed: ${message}`);
        } finally {
            this.running = false;
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
        return `--- ${parts.join(', ')} ---`;
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
        return {
            range: {
                start: { line, character },
                end: { line, character: character + 1 },
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
            tooltip: status.detail ?? 'Scala toolchain (WebAssembly)',
            command: status.state === 'failed' ? ScalaCommands.LOAD_TOOLCHAIN.id : ScalaCommands.RUN.id,
        });
    }

    /**
     * A workbench with an empty file system is not much of a demo, so on a first visit create
     * a workspace with a sample program and open it.
     *
     * Opening a workspace reloads the page, so a flag in local storage keeps that to once.
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
            await this.fileService.create(root.resolve('Main.scala'), SAMPLE_SOURCE);
            await this.workspaceService.open(root);
            return;
        }

        const root = new URI(roots[0].resource.toString());
        const sample = root.resolve('Main.scala');
        if (await this.fileService.exists(sample)) {
            await this.editorManager.open(sample);
            return;
        }

        const { files } = await this.sources.collect();
        if (Object.keys(files).length > 0) {
            return;
        }

        await this.fileService.create(sample, SAMPLE_SOURCE);
        await this.editorManager.open(sample);
    }
}
