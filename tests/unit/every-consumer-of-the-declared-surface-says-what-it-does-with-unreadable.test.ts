import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * **The consumer inventory for "what a declaration covers" — one question, every reader named.**
 *
 * `declaredContentPaths` answers two things at once: which content a declaration covers (`.paths`) and which declarations
 * cannot be read (`.unreadable`). That is the shape of the defect class this change exists to remove: an independent review
 * round found `ledgerTierForDeclaredPaths` keeping only `.paths`, so a declared path the moment it became unreadable stopped
 * contributing a risk floor — `ledger plan` refused the declaration by name while `ledger decide` published one reviewer
 * instead of the security floor's two (R5-F1). The fix was not "read `.unreadable` here too": it was to make the
 * classification surface the union of what the declaration *names* and what it *covers*, so nothing that is named can
 * disappear.
 *
 * A second round found the deeper problem: `declaredContentPaths`'s sibling consumers each made their own decision about
 * the two halves, silently, and one of them was wrong. So this case is the inventory. It does not test behaviour — the
 * behaviour of each consumer is pinned by its own selector (`one-tier-derivation.test.ts` for the resolver,
 * `review-request-preserves-its-named-facts.test.ts` for the request path, the freeze refusal in the ledger's own cases).
 * It asserts the thing no behavioural case can: that **every** consumer appears in the list below with a stated answer, so a
 * new reader cannot be added without deciding what it does with a declaration it cannot read.
 */
const ROOT = process.cwd();

/** Every file that calls `declaredContentPaths`, and what that reader does with `.unreadable`. */
const CONSUMERS: Record<string, { reads: 'refuses-on-unreadable' | 'classifies-the-union' | 'paths-only'; why: string }> = {
    'src/store/ledger.ts': {
        reads: 'refuses-on-unreadable',
        why: 'The freeze path asks `declaredContentPaths` for readability and refuses the whole declaration by name when any part of it cannot be read, so a sentinel can never be recorded as content.',
    },
    'src/store/verdict.ts': {
        reads: 'classifies-the-union',
        why: 'The tier resolver classifies the union of the declaration names and the covered content: a name the policy does not recognise contributes no match, and an unreadable name keeps the floor its spelling implies, so this reader can only raise a tier (R5-F1).',
    },
    'src/quality/defect-classes.ts': {
        reads: 'paths-only',
        why: "The instrument coverage rule asks whether the covered content contains a generator. It reads `.paths` only, so a generator inside a declared path that cannot be read is reported as outside the declared surface — a deficit, never a pass, though the reason text calls the surface incomplete rather than unreadable.",
    },
};

function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, found);
        else if (entry.endsWith('.ts')) found.push(path);
    }
    return found;
}

describe('every reader of the declared surface says what it does with an unreadable declaration', () => {
    it('lists exactly the modules that call declaredContentPaths, each with a stated answer', () => {
        const callers = sourceFiles(join(ROOT, 'src'))
            .filter((path) => readFileSync(path, 'utf8').includes('declaredContentPaths('))
            // The function's own module defines it; it is not a consumer of its own two halves.
            .filter((path) => relative(ROOT, path) !== 'src/core/repository-identity.ts')
            .map((path) => relative(ROOT, path))
            .sort();

        expect(
            callers,
            'a new reader of the declared surface must be added to CONSUMERS with what it does with `.unreadable`',
        ).toEqual(Object.keys(CONSUMERS).sort());
    });

    it('requires an answer that is one of the three recorded shapes, and a reason', () => {
        for (const [path, entry] of Object.entries(CONSUMERS)) {
            expect(['refuses-on-unreadable', 'classifies-the-union', 'paths-only']).toContain(entry.reads);
            expect(entry.why.length, `${path} must say why this answer is right`).toBeGreaterThan(40);
        }
    });

    it('keeps the resolver in the union shape, so nothing that is named can disappear', () => {
        // The one entry whose answer is load-bearing for a gate: if it ever reads `.paths` alone, a declared path that
        // becomes unreadable stops contributing a risk floor and a security change can be gated at strict (R5-F1).
        expect(CONSUMERS['src/store/verdict.ts']?.reads).toBe('classifies-the-union');
        const resolver = readFileSync(join(ROOT, 'src/store/verdict.ts'), 'utf8');
        expect(resolver).toContain('new Set([...declared, ...covered.paths])');
    });
});
