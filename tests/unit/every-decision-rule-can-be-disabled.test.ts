import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * **Every decision rule must be removable in principle, and its own mutation must be expressible.**
 *
 * The acceptance item "gate mutation kill = 100%" now has an instrument (`scripts/mutation-kill.mjs`), and it measured
 * **18/18** — each refusal reason's producing statement can be commented out and at least one watcher turns red. Two
 * properties make that measurement trustworthy, and both belong in the suite rather than in the script's own output,
 * because a script is only run when someone remembers to run it:
 *
 * 1. **The key sets agree.** The reason union in `src/kernel/types.ts` and the enum in
 *    `schemas/review-decision.schema.json` are the same vocabulary derived twice — one is what the kernel can decide, the
 *    other is what a consumer may read. A refusal added to one and not the other is a reason that cannot be reported, or a
 *    value a reader will never see.
 * 2. **Every code has a producing statement** in `src/kernel/decide.ts`. This is what makes the harness able to express the
 *    mutation at all: a code produced somewhere else — a variable, a table, an import — would be reported as `no-site`, which
 *    is a rule whose removal nothing would notice.
 *
 * The first version of the harness got both wrong in a way worth remembering: it searched for `export type Reason` and
 * matched `ReasonCode` by prefix, then read a fixed 4000 characters past it, so it collected `fail`, `insufficient` and
 * `verifier` from the *next* unions and reported 21 codes with one survivor. The measured answer was 18/18; the report said
 * 20/21. Both numbers are plausible, which is why the count is now cross-checked instead of trusted.
 */
const TYPES = new URL('../../src/kernel/types.ts', import.meta.url);
const DECIDE = new URL('../../src/kernel/decide.ts', import.meta.url);
const SCHEMA = new URL('../../schemas/review-decision.schema.json', import.meta.url);

/** The union as declared, bounded by its own terminating semicolon — not by a character budget. */
function unionCodes(source: string): string[] {
    const start = source.indexOf('export type ReasonCode');
    const end = source.indexOf(';', start);
    return [...new Set([...source.slice(start, end).matchAll(/\|\s*'([a-z_]+)'/g)].map((match) => match[1] as string))];
}

/** The first enum array anywhere in the schema document that holds the given member. */
function schemaEnum(node: unknown, member: string): string[] {
    if (Array.isArray(node)) {
        if (node.includes(member)) return node as string[];
        for (const item of node) {
            const found = schemaEnum(item, member);
            if (found.length > 0) return found;
        }
        return [];
    }
    if (node !== null && typeof node === 'object') {
        for (const value of Object.values(node)) {
            const found = schemaEnum(value, member);
            if (found.length > 0) return found;
        }
    }
    return [];
}

describe('every decision rule can be disabled, and says so in one vocabulary', () => {
    it('keeps the reason union and the decision schema on the same key set', async () => {
        const codes = unionCodes(await readFile(TYPES, 'utf8'));
        const schema = JSON.parse(await readFile(SCHEMA, 'utf8')) as unknown;
        const declared = schemaEnum(schema, 'budget_exhausted');

        expect(codes.length, 'the union must not be empty, or this check proves nothing').toBeGreaterThan(10);
        expect(declared).toEqual(expect.arrayContaining(codes));
        expect(codes).toEqual(expect.arrayContaining(declared));
    });

    it('finds a producing statement for every code in the kernel decision', async () => {
        const decide = await readFile(DECIDE, 'utf8');
        const codes = unionCodes(await readFile(TYPES, 'utf8'));
        // The harness comments out the statement that pushes the reason, so the statement has to be *in* this file. A code
        // produced elsewhere would come back `no-site` there, and this is where that is caught before anyone runs it.
        const withoutSite = codes.filter((code) => !decide.includes(`'${code}'`));
        expect(withoutSite, 'a refusal the kernel cannot produce from its own decision is a refusal nothing can test').toEqual([]);
    });
});
