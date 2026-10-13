import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { anchorRefusal, locateAnchor } from '../../src/quality/falsifier-anchors.js';

/**
 * AC-3 — the seal's anchor check cannot substitute for `ledger evidence verify`.
 *
 * The division of labour is the point of this change: the **seal** asks "does the anchor still point at something" (a
 * necessary condition, decided by a string match, milliseconds), while `ledger evidence verify` asks "does the mutation still
 * redden" (the sufficient one, which needs a real run). A uniquely-matching anchor whose mutation no longer reddens must
 * therefore **not** be refused at seal time — and the temptation to fold the two is real, because the failure it would catch
 * is the same failure the change exists for.
 *
 * Measured: this repository has both readings in production (`ledger evidence verify` reported `refuted` for two falsifiers
 * whose anchors were unique, when the shape rule existed twice and each copy masked the other's mutation), so a seal that
 * also asserted verdicts would have refused a change whose anchors were all pointing correctly.
 */
const preflight = readFileSync(join(process.cwd(), 'src', 'workflow', 'seal-preflight.ts'), 'utf8');

describe('an anchor that still matches is not a verdict', () => {
    it('does not refuse an anchor that matches exactly once, whatever the verdict says', () => {
        // The check's input is the location alone: a unique anchor earns no refusal, and the verdict is not an input.
        expect(anchorRefusal(locateAnchor('only once\n', 'only once'), 'src/a.ts', 'only once')).toBeUndefined();
    });

    it('reads no verdict: the seal path holds no verdict reader', () => {
        // Check the syntax rather than a few reader spellings: aliases, bracket access, and destructuring still read the
        // forbidden property even when no particular helper name is present.
        const source = ts.createSourceFile('seal-preflight.ts', preflight, ts.ScriptTarget.Latest, true);
        const collect = source.statements.find(
            (statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'collectSealPreflight',
        );
        expect(collect).toBeDefined();

        const propertyName = (node: ts.Node): string | undefined => {
            if (ts.isPropertyAccessExpression(node)) return node.name.text;
            if (ts.isElementAccessExpression(node)) {
                const argument = node.argumentExpression;
                return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : undefined;
            }
            if (ts.isBindingElement(node)) {
                const name = node.propertyName ?? node.name;
                return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
            }
            return undefined;
        };
        const isVerdictsProperty = (name: string | undefined): boolean => name?.normalize('NFKC').replace(/[^a-z]/giu, '').toLowerCase() === 'verdicts';
        const verdictReaders: string[] = [];
        const visit = (node: ts.Node): void => {
            if (isVerdictsProperty(propertyName(node))) verdictReaders.push(node.getText(source));
            ts.forEachChild(node, visit);
        };
        visit(collect!);

        expect(verdictReaders).toEqual([]);
        expect(preflight).toMatch(/no test run, no verdict/u);
    });

    it('states the division where the reader of the refusal will look', () => {
        // The refusal tells the operator what this check did *not* ask, so the two conditions are not confused by the person
        // reading it: "the anchor points at something" is not "the mutation reddens".
        expect(preflight).toMatch(/while `ledger evidence verify` remains the one that asks/u);
    });
});
