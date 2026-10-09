import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **The recorded digest map is the seal's own object — asserted by identity, and enforced at runtime in the freeze.**
 *
 * Four rounds defeated the guards that came before: a one-sided filter keyed on a kind the fixture did not carry (`.rs`), the
 * same with `.pyc` — the case this change exists for — then a copy built through an expression wrapper, and then (round 10) a
 * filter *after* `subjectOf` that wrapped the subject it returned, and a *conditional* copy before the call keyed on a kind
 * the sentinel happened not to carry. Every one of those was a **list** — of kinds, statements, argument shapes, sentinel keys
 * — losing to something outside the list.
 *
 * So the property is not a test invariant any more, it is in the code that writes the record:
 *
 *   · the seal marks the map it produced with a non-enumerable symbol and freezes it, so a copy (spread, `fromEntries`,
 *     `Object.assign`) loses the mark and an in-place filter raises at the write;
 *   · `freezeSubject` refuses when the map it is about to record does not carry that mark;
 *   · and it refuses when the subject does not carry *that very object*, so nothing can be substituted after the call.
 *
 * A refusal is the right failure mode: a drift that is caught is a refusal, a drift that is recorded is a lie.
 */
const hoisted = vi.hoisted(() => ({
    sealReturns: undefined as unknown,
    subjectOverride: undefined as unknown,
    seen: [] as unknown[],
}));

vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...actual,
        computePathDigests: async () => hoisted.sealReturns,
    };
});

vi.mock('../../src/kernel/subject.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/kernel/subject.js')>();
    return {
        ...actual,
        subjectOf: (digests: Record<string, string>) => {
            hoisted.seen.push(digests);
            if (hoisted.subjectOverride !== undefined) return hoisted.subjectOverride;
            return { revision: 'rev:sentinel', pathDigests: digests };
        },
    };
});

const { freezeSubject, writeSubject } = await import('../../src/store/ledger.js');
const revision = await import('../../src/workflow/revision.js');

let root = '';

/** A map the way the seal produces one: null prototype, marked, frozen. */
function sealedMap(entries: Record<string, string>): Record<string, string> {
    const map = Object.assign(Object.create(null) as Record<string, string>, entries);
    Object.defineProperty(map, revision.sealMapBrand, { value: true, enumerable: false, configurable: false, writable: false });
    return Object.freeze(map);
}

beforeEach(async () => {
    hoisted.seen.length = 0;
    hoisted.subjectOverride = undefined;
    hoisted.sealReturns = sealedMap({ 'src/pkg/mod.ts': 'hash-of-mod', 'src/pkg/stub.pyi': 'hash-of-stub' });
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
        expect(hoisted.seen[0]).toBe(hoisted.sealReturns);
        if (result.ok) expect(Object.is(result.subject.pathDigests, hoisted.sealReturns)).toBe(true);
    });

    it('refuses a map that is not the seal’s own, so a copy cannot be recorded', async () => {
        // Round 10's conditional copy: same contents, different object, no mark — the shape an identity assertion on the
        // argument alone would have accepted.
        hoisted.sealReturns = Object.freeze({ ...sealedMap({ 'src/pkg/mod.ts': 'hash-of-mod' }) });

        const result = await freezeSubject({ root, paths: ['src/pkg'] });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('not the map the seal produced');
    });

    it('refuses a subject that does not carry the seal’s map', async () => {
        // Round 10's post-call wrapper: `subjectOf` is called with the right object and the subject comes back carrying a
        // filtered one.
        const sealed = sealedMap({ 'src/pkg/mod.ts': 'hash-of-mod' });
        hoisted.sealReturns = sealed;
        hoisted.subjectOverride = { revision: 'rev:wrapped', pathDigests: { 'src/pkg/mod.ts': 'hash-of-mod' } };

        const result = await freezeSubject({ root, paths: ['src/pkg'] });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('does not carry the seal’s own content map');
    });

    it('returns a frozen, marked map from the real seal, and drops no file named __proto__', async () => {
        // The production half. A filter cannot raise on a map it does not hold, so the freeze has to be real; and the mark is
        // what a copy loses. `__proto__` is here because the seal silently dropped a file of that name (round 10, F6): the map
        // is null-prototyped so the key is an entry rather than an assignment to the prototype.
        // **At the root, where the key is exactly `__proto__`.** A file of that name inside a directory gives the key
        // `src/pkg/__proto__`, which is an ordinary key on any object — measured, because the first version of this case put
        // it under the directory and the reverted map stayed green. The hazard needs the key itself to be `__proto__`, which
        // is why the map is created with a null prototype.
        await writeFile(join(root, '__proto__'), 'a file with a dangerous name\n');
        // The real seal, not the mock: the mock exists to control the argument, and this case is about production.
        const realSeal = (await vi.importActual<typeof import('../../src/workflow/revision.js')>('../../src/workflow/revision.js')).computePathDigests;
        const map = await realSeal(root, ['__proto__', 'src/pkg']);

        expect(Object.isFrozen(map)).toBe(true);
        expect(revision.carriesSealMark(map)).toBe(true);
        expect(Object.keys(map).sort()).toEqual(['__proto__', 'src/pkg/mod.ts']);
        expect(() => {
            (map as Record<string, string>)['src/pkg/anything.mts'] = 'hash';
        }).toThrow();
    });

    it('refuses at the write gate a subject whose digests are not the seal’s map', async () => {
        // **Round 11's finding lives here.** It inserted a plain copy between the identity check and the return, so the
        // in-function checks had already run; the only place such a record can still be stopped is where it is written. This
        // case is that gate's falsifier: with the gate disabled the write succeeds and the record holds a filtered set.
        // A subject that is schema-valid and whose digests are *not* the seal's map: the schema contract passes, so the
        // only thing left to refuse it is the invariant at the write gate.
        const sealed = sealedMap({ 'src/pkg/mod.ts': 'hash-of-mod' });
        await expect(
            writeSubject(root, 'seal-identity', { revision: 'rev:aaaaaaaaaaaaaaaa', pathDigests: { 'src/pkg/mod.ts': 'hash-of-mod' } } as never),
        ).rejects.toThrow(/not the map the seal produced/);

        // And the shape that must be accepted: the seal's own map.
        await expect(
            writeSubject(root, 'seal-identity', { revision: 'rev:bbbbbbbbbbbbbbbb', pathDigests: sealed } as never),
        ).resolves.toBeUndefined();
    });

    it('distinguishes the shapes that defeated the earlier guards', () => {
        const sealed = sealedMap({ 'src/pkg/mod.ts': 'hash', 'src/pkg/stub.pyi': 'hash' });

        // A copy, however it is built, loses the mark — and the mark is what the freeze checks.
        const copied = Object.fromEntries(Object.entries(sealed).filter(([key]) => !key.endsWith('.pyi')));
        expect(revision.carriesSealMark(copied)).toBe(false);
        expect(copied).not.toBe(sealed);

        // An in-place edit of the seal's own map raises, so it cannot record a subset.
        expect(() => {
            (sealed as Record<string, string>)['src/pkg/extra.ts'] = 'hash';
        }).toThrow();

        // And the shape that must pass: nothing between the seal and the subject.
        expect(revision.carriesSealMark(sealed)).toBe(true);
    });
});
