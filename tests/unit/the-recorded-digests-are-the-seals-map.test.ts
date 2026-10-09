import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * **The recorded digest map is the seal's own return value — asserted structurally, because no fixture can be complete.**
 *
 * The behavioural guards in this change compare the ledger's recorded set against the seal's for the kinds their fixtures
 * carry. Three rounds in a row defeated them with a one-sided filter keyed on a kind the fixture happened not to hold — `.rs`
 * (round 7), then `.pyc` (round 8): `Object.assign(digests, sealed)` followed by `for (const key of Object.keys(digests)) if
 * (key.endsWith('.pyc')) delete digests[key];` left the ledger recording a set the seal did not, with every declared selector
 * green. `.pyc` is the case this change exists for, which is the clearest possible statement that "witness every kind" is not
 * a property a finite fixture can hold: any list of kinds is a list a future filter can step outside.
 *
 * So the property is enforced where it cannot be stepped around. `freezeSubject` no longer keeps a map of its own, and this
 * guard reads the function's syntax tree: the value handed to `subjectOf` must be exactly the value `computePathDigests`
 * returned, and the body must contain nothing that could alter an object — no `delete`, no `Object.assign`, no assignment
 * into a property or an element. Reintroducing the seam fails here regardless of which kind it filters on.
 */
const LEDGER = join(process.cwd(), 'src', 'store', 'ledger.ts');

function parseLedger(source: string): ts.SourceFile {
    return ts.createSourceFile('ledger.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The declaration of `freezeSubject`, which is the only place a recorded digest map is produced. */
function freezeSubjectBody(file: ts.SourceFile): ts.Block {
    let found: ts.Block | null = null;
    const visit = (node: ts.Node): void => {
        if (
            ts.isFunctionDeclaration(node)
            && node.name?.text === 'freezeSubject'
            && node.body
        ) {
            found = node.body;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (found === null) throw new Error('freezeSubject is not declared in src/store/ledger.ts');
    return found;
}

/** The identifiers the seal's call result is assigned to, and the identifier handed to `subjectOf`. */
function traceSeam(body: ts.Block): { sealNames: string[]; subjectArgument: string | null; offences: string[] } {
    const sealNames: string[] = [];
    let subjectArgument: string | null = null;
    const offences: string[] = [];

    const visit = (node: ts.Node): void => {
        // The seal's result, bound to a name — as a declaration (`const sealed = await …`) or as an assignment inside the
        // `try` that turns a canonicalisation refusal into a named state (`let sealed; try { sealed = await … }`).
        if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
            const initializer = unwrapAwait(node.initializer);
            if (isSealCall(initializer) && ts.isIdentifier(node.name)) sealNames.push(node.name.text);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isSealCall(unwrapAwait(node.right))) {
            if (ts.isIdentifier(node.left)) sealNames.push(node.left.text);
        }
        // `subjectOf(<identifier>, …)` — the map that becomes the subject.
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'subjectOf') {
            const first = node.arguments[0];
            subjectArgument = first !== undefined && ts.isIdentifier(first) ? first.text : `<${first?.getText() ?? 'nothing'}>`;
        }
        // Anything that could change an object after it was produced.
        if (ts.isDeleteExpression(node)) offences.push(`delete at ${node.getText().slice(0, 60)}`);
        if (
            ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.expression.getText() === 'Object'
            && ['assign', 'defineProperty', 'setPrototypeOf'].includes(node.expression.name.text)
        ) {
            offences.push(`Object.${node.expression.name.text} at ${node.getText().slice(0, 60)}`);
        }
        if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
            const target = node.left;
            if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
                offences.push(`assignment into ${target.getText().slice(0, 60)}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(body);
    return { sealNames, subjectArgument, offences };
}

function isSealCall(node: ts.Expression): boolean {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'computePathDigests';
}

function unwrapAwait(node: ts.Expression): ts.Expression {
    return ts.isAwaitExpression(node) ? node.expression : node;
}

function isAssignment(kind: ts.SyntaxKind): boolean {
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

describe('the recorded digest map is the seal’s own value', () => {
    it('hands the seal’s result to the subject, with nothing in between', async () => {
        const body = freezeSubjectBody(parseLedger(await readFile(LEDGER, 'utf8')));
        const { sealNames, subjectArgument, offences } = traceSeam(body);

        // The seal is asked once, and its answer is what the subject is built from.
        expect(sealNames).toHaveLength(1);
        expect(subjectArgument).toBe(sealNames[0]);

        // And there is no place a filter could live: no deletion, no merge, no write into an object.
        expect(offences, offences.join('\n')).toEqual([]);
    });

    it('flags a seam reintroduced by any of the shapes the rounds measured', () => {
        const source = (line: string): string => `
async function freezeSubject(input: { paths: string[] }) {
    const sealed = await computePathDigests(input.root, input.paths);
    ${line}
    return { ok: true, subject: subjectOf(sealed, input.paths) };
}`;

        // Round 8's mutation, verbatim: a one-sided filter keyed on a kind no fixture carries.
        const roundEight = source("for (const key of Object.keys(sealed)) if (key.endsWith('.pyc')) delete sealed[key];");
        expect(traceSeam(freezeSubjectBody(parseLedger(roundEight))).offences.map((entry) => entry.split(' ')[0])).toEqual(['delete']);

        // Round 7's shape, and the two other ways to move an object after it was produced.
        expect(traceSeam(freezeSubjectBody(parseLedger(source("Object.assign(sealed, {});")))).offences.map((entry) => entry.split(' ')[0])).toEqual(['Object.assign']);
        expect(traceSeam(freezeSubjectBody(parseLedger(source("sealed['src/a.ts'] = 'x';")))).offences.map((entry) => entry.split(' ')[0]))
            .toEqual(['assignment']);

        // A copy that is filtered and then handed on: no offence to find, and the argument check is what catches it.
        const viaCopy = `
async function freezeSubject(input: { paths: string[] }) {
    const sealed = await computePathDigests(input.root, input.paths);
    const kept = { ...sealed };
    for (const key of Object.keys(kept)) if (key.endsWith('.pyc')) delete kept[key];
    return { ok: true, subject: subjectOf(kept, input.paths) };
}`;
        const traced = traceSeam(freezeSubjectBody(parseLedger(viaCopy)));
        expect(traced.subjectArgument).toBe('kept');
        expect(traced.sealNames).toEqual(['sealed']);
    });
});
