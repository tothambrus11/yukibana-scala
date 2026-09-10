import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import * as monaco from '@theia/monaco-editor-core';

/**
 * Registers Scala with Monaco.
 *
 * Theia inherits VS Code's languages from installed plugins; a browser-only build has none,
 * so a `.scala` file opens as plain text. This is a Monarch grammar rather than the full
 * TextMate one: enough for keywords, literals, comments, string interpolation and brackets.
 */
@injectable()
export class ScalaLanguageContribution implements FrontendApplicationContribution {
    initialize(): void {
        const languages = monaco.languages;
        if (languages.getLanguages().some(language => language.id === 'scala')) {
            return;
        }

        languages.register({
            id: 'scala',
            extensions: ['.scala', '.sc'],
            aliases: ['Scala', 'scala'],
            mimetypes: ['text/x-scala'],
        });

        languages.setLanguageConfiguration('scala', {
            comments: { lineComment: '//', blockComment: ['/*', '*/'] },
            brackets: [
                ['{', '}'],
                ['[', ']'],
                ['(', ')'],
            ],
            autoClosingPairs: [
                { open: '{', close: '}' },
                { open: '[', close: ']' },
                { open: '(', close: ')' },
                { open: '"', close: '"', notIn: ['string'] },
                { open: '`', close: '`', notIn: ['string'] },
            ],
            surroundingPairs: [
                { open: '{', close: '}' },
                { open: '[', close: ']' },
                { open: '(', close: ')' },
                { open: '"', close: '"' },
            ],
            indentationRules: {
                increaseIndentPattern: /^.*(=>|=|:|\{|\(|\bthen\b|\bdo\b|\belse\b|\bmatch\b)\s*$/,
                decreaseIndentPattern: /^\s*(\}|\)|\]|\bcase\b.*=>)\s*$/,
            },
        });

        languages.setMonarchTokensProvider('scala', {
            defaultToken: '',
            tokenPostfix: '.scala',
            keywords: [
                'abstract', 'case', 'catch', 'class', 'def', 'do', 'else', 'enum', 'export', 'extends',
                'extension', 'false', 'final', 'finally', 'for', 'given', 'if', 'implicit', 'import',
                'inline', 'lazy', 'match', 'new', 'null', 'object', 'opaque', 'open', 'override',
                'package', 'private', 'protected', 'return', 'sealed', 'super', 'then', 'this', 'throw',
                'trait', 'transparent', 'true', 'try', 'type', 'using', 'val', 'var', 'while', 'with', 'yield',
            ],
            softKeywords: ['as', 'derives', 'end', 'infix', 'opaque', 'using'],
            operators: [
                '+', '-', '*', '/', '%', '=', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '!', '&', '|',
                '^', '<<', '>>', '=>', '<-', '<:', '>:', '#', '@', '?=>',
            ],
            symbols: /[=><!~?:&|+\-*/^%#@]+/,
            escapes: /\\(?:[abfnrtv\\"']|u[0-9A-Fa-f]{4})/,

            tokenizer: {
                root: [
                    [/@?[A-Z][\w$]*/, 'type.identifier'],
                    [
                        /[a-z_$][\w$]*/,
                        {
                            cases: {
                                '@keywords': 'keyword',
                                '@softKeywords': 'keyword',
                                '@default': 'identifier',
                            },
                        },
                    ],
                    { include: '@whitespace' },
                    [/@\s*[a-zA-Z_$][\w$]*/, 'annotation'],
                    [/[{}()[\]]/, '@brackets'],
                    [
                        /@symbols/,
                        {
                            cases: {
                                '@operators': 'operator',
                                '@default': '',
                            },
                        },
                    ],
                    [/\d*\.\d+([eE][-+]?\d+)?[fFdD]?/, 'number.float'],
                    [/0[xX][0-9a-fA-F]+[lL]?/, 'number.hex'],
                    [/\d+[lLfFdD]?/, 'number'],
                    [/[;,.]/, 'delimiter'],
                    [/"""/, { token: 'string.quote', next: '@tripleString' }],
                    [/"/, { token: 'string.quote', next: '@string' }],
                    [/'[^\\']'/, 'string'],
                    [/'[a-zA-Z_$][\w$]*/, 'string'],
                ],

                whitespace: [
                    [/[ \t\r\n]+/, ''],
                    [/\/\*/, 'comment', '@comment'],
                    [/\/\/.*$/, 'comment'],
                ],

                comment: [
                    [/[^/*]+/, 'comment'],
                    [/\/\*/, 'comment', '@push'],
                    [/\*\//, 'comment', '@pop'],
                    [/[/*]/, 'comment'],
                ],

                string: [
                    [/[^\\"$]+/, 'string'],
                    [/\$\{/, { token: 'delimiter.bracket', next: '@interpolation' }],
                    [/\$[a-zA-Z_$][\w$]*/, 'variable'],
                    [/@escapes/, 'string.escape'],
                    [/\\./, 'string.escape.invalid'],
                    [/"/, { token: 'string.quote', next: '@pop' }],
                ],

                tripleString: [
                    [/[^"$]+/, 'string'],
                    [/\$\{/, { token: 'delimiter.bracket', next: '@interpolation' }],
                    [/\$[a-zA-Z_$][\w$]*/, 'variable'],
                    [/"""/, { token: 'string.quote', next: '@pop' }],
                    [/"/, 'string'],
                ],

                interpolation: [
                    [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
                    { include: '@root' },
                ],
            },
        });
    }
}
