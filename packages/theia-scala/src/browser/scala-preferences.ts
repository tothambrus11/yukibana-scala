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
        'yukibana.toolchainManifest': {
            type: 'string',
            default: './toolchain/manifest.json',
            description: 'Location of the WebAssembly toolchain manifest, relative to the application.',
        },
        'yukibana.engineModule': {
            type: 'string',
            default: './toolchain/host/index.js',
            description: 'Location of the browser Scala engine module.',
        },
        'yukibana.engineWorker': {
            type: 'string',
            default: './toolchain/host/worker.js',
            description: 'Location of the browser Scala engine worker.',
        },
    },
};

export interface ScalaConfiguration {
    'yukibana.outputTarget': 'js' | 'wasm';
    'yukibana.compileOnSave': boolean;
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
