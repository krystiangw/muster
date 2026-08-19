import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import ts from 'typescript';

/**
 * The SDK's front page, compiled.
 *
 * Same argument as the curl commands in `protocol.test.ts`, one door along.
 * The README is what somebody reads before they install anything, and every
 * line of TypeScript on it is a promise about a method that exists, an option
 * that is spelled that way and a field the answer carries. Nothing checked it,
 * so a rename would have been correct in the types, correct in the tests, and
 * wrong on the page a reader starts from.
 *
 * Compiled rather than run, because a fragment is not a program: the page
 * shows an array being mapped without saying where it came from, and shows two
 * ways of making a client that cannot both be the same `client`. Each snippet
 * is given its own scope and the one free name it borrows is declared, which is
 * exactly the context the surrounding prose supplies to a reader.
 */
const README = fileURLToPath(new URL('../../../packages/sdk/README.md', import.meta.url));
const SDK = fileURLToPath(new URL('../../../packages/sdk/src/index.ts', import.meta.url));
const SNIPPETS = fileURLToPath(new URL('../../../packages/sdk/readme-snippets.ts', import.meta.url));

function snippetsIn(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((found) => found[1]!);
}

function asOneModule(snippets: string[]): string {
  const scoped = snippets.map((snippet, index) => {
    // Hoisted, because an import is only legal at the top of a module, and the
    // page prints it inside the first snippet where a reader needs to see it.
    const body = snippet.replace(/^import[^;]*;\s*$/gm, '');
    return `async function snippet${index}() {\n${body}\n}\nvoid snippet${index};`;
  });
  return [
    `import { Muster } from ${JSON.stringify(SDK)};`,
    // The two names the prose carries between snippets: the client the page
    // makes twice over, once from a signup and once from an environment, and
    // the reader's own errors, which it maps over without making them. A
    // snippet that makes its own `client` shadows this in its own scope, which
    // is what the page shows happening.
    `declare const client: Muster;`,
    `declare const errors: Array<{ key: string }>;`,
    ...scoped,
  ].join('\n\n');
}

describe('the SDK README', () => {
  it('type checks against the SDK it documents', () => {
    const snippets = snippetsIn(readFileSync(README, 'utf8'));
    assert.ok(snippets.length >= 5, `the README shows TypeScript: found ${snippets.length}`);
    const source = asOneModule(snippets);

    const options: ts.CompilerOptions = {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      noEmit: true,
    };
    const host = ts.createCompilerHost(options, true);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.readFile = (name) => (name === SNIPPETS ? source : readFile(name));
    host.fileExists = (name) => name === SNIPPETS || fileExists(name);
    host.getSourceFile = (name, version, onError, shouldCreate) =>
      name === SNIPPETS
        ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS)
        : getSourceFile(name, version, onError, shouldCreate);

    const program = ts.createProgram([SNIPPETS], options, host);
    // Only what the page said. The SDK is compiled by its own tsconfig, and
    // reporting its diagnostics here would fail this test for someone else's
    // reason.
    const complaints = [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()]
      .filter((diagnostic) => diagnostic.file?.fileName === SNIPPETS)
      .map((diagnostic) => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
        const at = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        return `line ${at.line + 1}: ${message}\n    ${source.split('\n')[at.line]?.trim() ?? ''}`;
      });
    assert.deepEqual(complaints, [], `the README does not compile:\n  ${complaints.join('\n  ')}`);
  });
});
