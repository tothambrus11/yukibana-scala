import { interfaces } from '@theia/core/shared/inversify';
import {
    PreferenceContribution,
    PreferenceProxy,
    PreferenceSchema,
    PreferenceService,
    createPreferenceProxy,
} from '@theia/core/lib/common/preferences';

export const scalaPreferenceSchema: PreferenceSchema = {
    title: 'Yukibana Scala',
    properties: {
        'yukibana.outputTarget': {
            type: 'string',
            enum: ['js', 'wasm'],
            default: 'js',
            description:
                'Backend the Scala.js linker uses for your program. Both run in the browser; "wasm" needs an engine with WasmGC and JSPI.',
        },
        'yukibana.compileOnSave': {
            type: 'boolean',
            default: true,
            description: 'Compile the workspace and refresh diagnostics whenever a Scala file is saved.',
        },
        'yukibana.autoRun': {
            type: 'boolean',
            default: false,
            description:
                'Run the program automatically whenever a Scala file is saved, instead of only compiling it. The Autorun checkbox in the editor toolbar toggles this.',
        },
        'yukibana.toolchainPointer': {
            type: 'string',
            default: './toolchain-current.json',
            description:
                'Small file naming the toolchain to load. It points at a content-addressed directory, so a new release is a new URL and a cached copy of an older one can never answer for it.',
        },
        'yukibana.toolchainManifest': {
            type: 'string',
            default: '',
            description:
                'Load this manifest directly instead of following the pointer. For serving a toolchain from elsewhere, such as a CDN or a local build.',
        },
        'yukibana.engineModule': {
            type: 'string',
            default: '',
            description: 'Override the browser Scala engine module URL. Empty means take it from the pointer.',
        },
        'yukibana.engineWorker': {
            type: 'string',
            default: '',
            description: 'Override the browser Scala engine worker URL. Empty means take it from the pointer.',
        },
    },
};

export interface ScalaConfiguration {
    'yukibana.outputTarget': 'js' | 'wasm';
    'yukibana.compileOnSave': boolean;
    'yukibana.autoRun': boolean;
    'yukibana.toolchainPointer': string;
    'yukibana.toolchainManifest': string;
    'yukibana.engineModule': string;
    'yukibana.engineWorker': string;
}

export const ScalaPreferences = Symbol('ScalaPreferences');
export type ScalaPreferences = PreferenceProxy<ScalaConfiguration>;

export function bindScalaPreferences(bind: interfaces.Bind): void {
    bind(ScalaPreferences).toDynamicValue(context =>
        createPreferenceProxy<ScalaConfiguration>(
            context.container.get<PreferenceService>(PreferenceService),
            scalaPreferenceSchema,
        ),
    ).inSingletonScope();
    bind(PreferenceContribution).toConstantValue({ schema: scalaPreferenceSchema });
}
