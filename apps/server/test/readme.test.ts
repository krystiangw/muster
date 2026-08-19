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
const MANIFEST = fileURLToPath(new URL('../../../packages/sdk/package.json', import.meta.url));

function snippetsIn(markdown: string): string[] {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((found) => found[1]!);
}

/** The import lines the page prints, in the order it prints them. */
function importsIn(snippets: string[]): string[] {
  return snippets.flatMap((snippet) => snippet.match(/^import[^;]*;$/gm) ?? []);
}

function asOneModule(snippets: string[]): string {
  const scoped = snippets.map((snippet, index) => {
    // Hoisted, because an import is only legal at the top of a module, and the
    // page prints it inside the first snippet where a reader needs to see it.
    const body = snippet.replace(/^import[^;]*;\s*$/gm, '');
    return `async function snippet${index}() {\n${body}\n}\nvoid snippet${index};`;
  });
  return [
    // The page's own import, pointed at the source rather than the published
    // package. Rewriting the specifier and keeping the names is the whole
    // point: an import of a symbol this SDK does not export has to fail here,
    // and it would not if the line were replaced with a correct one.
    ...importsIn(snippets).map((line) => line.replace(/'[^']+'/, JSON.stringify(SDK))),
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
    const markdown = readFileSync(README, 'utf8');
    const snippets = snippetsIn(markdown);
    assert.ok(snippets.length >= 5, `the README shows TypeScript: found ${snippets.length}`);

    // The specifier is a string, so the compiler cannot check it: pointing the
    // import at the source is exactly what stops it noticing a wrong package
    // name. It is checked against the manifest instead, together with the
    // install line above it, because those two and the import are one claim.
    const name = JSON.parse(readFileSync(MANIFEST, 'utf8')).name as string;
    assert.match(markdown, new RegExp(`npm install ${name}\\b`), 'the page installs this package');
    const specifiers = importsIn(snippets).map((line) => /'([^']+)'/.exec(line)?.[1]);
    assert.ok(specifiers.length > 0, 'and imports from it');
    for (const specifier of specifiers) assert.equal(specifier, name, 'and imports from it');

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
