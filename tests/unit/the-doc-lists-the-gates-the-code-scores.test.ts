import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * **A document that enumerates the release gates must enumerate the release gates.**
 *
 * `docs/operations.md` listed five gates and said "All gates must pass for release". By the time that was read again the
 * code scored nine, three of them informational, and `allPass` was — and had always been — the wrong field to read,
 * because a gate that never received its input is reported `skipped` and excluded, so `allPass: true` can print while a
 * required gate was never measured. The correct field, `releaseReady`, is documented in the code and was in no operator
 * document at all.
 *
 * The section is the one place a human reads to find out what gates exist, so it is exactly the place a change to the
 * gate set must not forget. This reads both sides and refuses when they disagree — the same shape as the generated-skill
 * check that derives its command vocabulary from the dispatcher instead of keeping a list.
 */
const DOC = new URL('../../docs/operations.md', import.meta.url);
const CODE = new URL('../../src/eval/release-gates.ts', import.meta.url);

/** The gate names the code scores, from the literals it registers. */
function codeGates(source: string): string[] {
    return [...new Set([...source.matchAll(/name: '([a-z][a-z-]+)',/g)].map((match) => match[1] as string))];
}

/** The gate names the operator document's release-gate section lists, from its table rows. */
function documentedGates(doc: string): string[] {
    const start = doc.indexOf('## Release gates');
    expect(start, 'the release-gate section must exist, or this check silently passes').toBeGreaterThan(-1);
    const end = doc.indexOf('\n## ', start + 1);
    const section = doc.slice(start, end === -1 ? undefined : end);
    return [...new Set([...section.matchAll(/^\| `([a-z][a-z-]+)` \|/gm)].map((match) => match[1] as string))];
}

describe('the operator document lists the gates the code scores', () => {
    it('names every gate the code registers, and no gate the code does not', async () => {
        const gates = codeGates(await readFile(CODE, 'utf8'));
        const documented = documentedGates(await readFile(DOC, 'utf8'));
        expect(gates.length, 'the code must register gates, or this proves nothing').toBeGreaterThan(5);
        expect(documented, 'a gate the document does not name is a gate nobody reads before releasing').toEqual(expect.arrayContaining(gates));
        expect(gates).toEqual(expect.arrayContaining(documented));
    });

    it('tells the reader to read releaseReady rather than allPass', async () => {
        // The whole reason the section was wrong: `allPass` excludes skipped gates, so it can be true while a required
        // gate was never measured. The document must name the field that does not have that property.
        const doc = await readFile(DOC, 'utf8');
        const section = doc.slice(doc.indexOf('## Release gates'));
        expect(section).toContain('releaseReady');
        expect(section).toContain('not `allPass`');
    });
});
