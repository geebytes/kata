import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The recorded digest map is the seal's own object — asserted by identity, because no syntax check and no fixture can be
 * complete.**
 *
 * Three rounds in a row defeated the guards that came before this one, each by moving one level: a one-sided filter keyed on
 * a kind the fixture did not carry (`.rs`, round 7); the same with `.pyc`, the very case this change exists for (round 8);
 * and then, when round 8's repair parsed the function's syntax tree to forbid anything between the seal's call and the subject
 * — `delete`, `Object.assign`, property writes, and passing the map to a helper — an expression wrapper (`Object.fromEntries(
 * Object.entries(sealed).filter(…))`, reassigned back) that named the map nowhere the scanner looked (round 9).
 *
 * Every one of those is the same mistake in a different coat: the guard was a *list* — of kinds, of statements, of argument
 * shapes — and the thing being guarded is unbounded. The property that actually holds, and that no wrapper can fake, is
 * **object identity**: the map handed to `subjectOf` is the object `computePathDigests` returned. So the seal is replaced by
 * a sentinel object that is `Object.freeze`d, `subjectOf` is replaced by a recorder, and the assertion is `toBe` — a copy,
 * however it was made, is a different object; an in-place edit of a frozen map throws. Kind-independent, shape-independent.
 */
const hoisted = vi.hoisted(() => ({
    /**
     * Frozen, so an in-place filter throws instead of quietly changing what the ledger records — and it carries a `.pyi` key
     * on purpose: a filter whose predicate matches nothing in the map deletes nothing and cannot be detected, so the sentinel
     * has to hold a kind the filters of the last three rounds keyed on.
     */
    sentinel: Object.freeze({ 'src/pkg/mod.ts': 'hash-of-mod', 'src/pkg/stub.pyi': 'hash-of-stub' }) as Record<string, string>,
    seen: [] as unknown[],
}));

vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...actual,
        computePathDigests: async () => hoisted.sentinel,
    };
});

vi.mock('../../src/kernel/subject.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/kernel/subject.js')>();
    return {
        ...actual,
        subjectOf: (digests: unknown) => {
            hoisted.seen.push(digests);
            return { revision: 'rev:sentinel', pathDigests: {} };
        },
    };
});

const { freezeSubject } = await import('../../src/store/ledger.js');

let root = '';

beforeEach(async () => {
    hoisted.seen.length = 0;
    root = await mkdtemp(join(tmpdir(), 'kata-seal-identity-'));
    await mkdir(join(root, 'src', 'pkg'), { recursive: true });
    await writeFile(join(root, 'src', 'pkg', 'mod.ts'), 'export const x = 1;\n');
    await mkdir(join(root, '.kata', 'tasks', 'seal-identity'), { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('the recorded digest map is the seal’s own object', () => {
    it('hands the seal’s map itself to the subject, not a copy of it', async () => {
        const result = await freezeSubject({ root, paths: ['src/pkg'] });

        expect(result.ok).toBe(true);
        expect(hoisted.seen).toHaveLength(1);
        // `toBe`, not `toEqual`: a filtered copy is a different object however it was built, and an in-place edit of the
        // frozen sentinel throws before this point.
        expect(hoisted.seen[0]).toBe(hoisted.sentinel);
    });

    it('distinguishes the shapes that defeated the three earlier guards', () => {
        // The control the guard needs: it must fail for each evasion, or it is a guard that matches nothing. Each `attempt`
        // stands in for what `freezeSubject` does between the seal's call and `subjectOf`.
        const attempt = (between: (sealed: Record<string, string>) => Record<string, string>): unknown => {
            const sealed = hoisted.sentinel;
            const handed = between(sealed);
            return handed;
        };

        // Round 7/8: a one-sided filter on a shallow copy.
        const copied = attempt((sealed) => Object.fromEntries(Object.entries(sealed).filter(([key]) => !key.endsWith('.pyc'))));
        expect(copied).not.toBe(hoisted.sentinel);

        // Round 9: the same thing with the map named nowhere a syntax scanner would look, and reassigned to the seal's name.
        let reassigned: Record<string, string> = hoisted.sentinel;
        reassigned = Object.fromEntries(Object.entries(reassigned).filter(([key]) => !key.endsWith('.pyi')));
        expect(reassigned).not.toBe(hoisted.sentinel);

        // An in-place edit of the map the seal returned: frozen, so this raises rather than changing the recorded set.
        expect(() => {
            (hoisted.sentinel as Record<string, string>)['src/pkg/extra.ts'] = 'hash';
        }).toThrow();

        // And the shape that must pass: nothing between the call and the subject.
        expect(attempt((sealed) => sealed)).toBe(hoisted.sentinel);
    });
});
