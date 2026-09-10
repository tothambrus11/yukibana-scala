import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileStat } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser';

export interface ScalaSources {
    /** Workspace-relative file name -> source text, as handed to the compiler. */
    files: Record<string, string>;
    /** The same names mapped back to their editor URIs, for diagnostics. */
    uris: Map<string, URI>;
}

const SCALA_EXTENSION = '.scala';
const SKIPPED_DIRECTORIES = new Set(['out', 'target', 'node_modules', '.git']);

/**
 * Collects the Scala sources of the open workspace.
 *
 * Unsaved editor content wins over what is on disk, so that Run reflects what the user sees
 * without forcing a save first.
 */
@injectable()
export class ScalaWorkspace {
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    async collect(): Promise<ScalaSources> {
        const files: Record<string, string> = {};
        const uris = new Map<string, URI>();

        for (const root of this.workspaceService.tryGetRoots()) {
            const rootUri = new URI(root.resource.toString());
            for (const uri of await this.findScalaFiles(root)) {
                const name = this.relativeName(rootUri, uri);
                files[name] = await this.readSource(uri);
                uris.set(name, uri);
            }
        }

        // A file opened outside the workspace (or before one was opened) is still runnable.
        for (const editor of this.editorManager.all) {
            const uri = editor.editor.uri;
            if (!uri.path.toString().endsWith(SCALA_EXTENSION)) {
                continue;
            }
            const name = uri.path.base;
            if (!(name in files)) {
                files[name] = editor.editor.document.getText();
                uris.set(name, uri);
            }
        }

        return { files, uris };
    }

    protected relativeName(root: URI, uri: URI): string {
        const relative = root.relative(uri);
        return relative ? relative.toString() : uri.path.base;
    }

    protected async readSource(uri: URI): Promise<string> {
        const editor = this.editorManager.all.find(widget => widget.editor.uri.toString() === uri.toString());
        if (editor?.editor.document.dirty) {
            return editor.editor.document.getText();
        }
        const content = await this.fileService.read(uri);
        return content.value;
    }

    protected async findScalaFiles(stat: FileStat): Promise<URI[]> {
        const found: URI[] = [];
        const visit = async (current: FileStat): Promise<void> => {
            if (current.isDirectory) {
                const resolved = current.children ? current : await this.fileService.resolve(current.resource);
                for (const child of resolved.children ?? []) {
                    if (child.isDirectory && SKIPPED_DIRECTORIES.has(child.resource.path.base)) {
                        continue;
                    }
                    await visit(child);
                }
            } else if (current.resource.path.toString().endsWith(SCALA_EXTENSION)) {
                found.push(new URI(current.resource.toString()));
            }
        };

        await visit(await this.fileService.resolve(stat.resource));
        return found;
    }
}
