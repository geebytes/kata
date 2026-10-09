import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { freezeSubject, writeSubject } from '../../src/store/ledger.js';
import { computePathDigests, declarationKey, sealDeclarationOf } from '../../src/workflow/revision.js';
import type { Subject } from '../../src/kernel/types.js';

/**
 * **AC-21 — a subject carries the digest map made for exactly its own declaration.**
 *
 * The seal's mark answers "did a seal produce this map?", which a review round measured as *not enough*: a genuine sealed map
 * computed for a **smaller** declaration could be attached to a subject declaring the whole package, and every declared
 * selector passed — the record then held fewer paths than it declared, which is the one thing a declaration is for. The mark
 * travels with the map; the *declaration* the map was computed for has to travel with it too, and both are compared against
 * the declaration the record states, at the last gate before the bytes land.
 */
const roots: string[] = [];
const changeId = 'sealed-subset-map';

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-subset-map-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src', 'pkg'), { recursive: true });
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await writeFile(join(root, 'src', 'pkg', 'mod.ts'), 'export const one = 1;\n');
    await writeFile(join(root, 'src', 'pkg', 'other.ts'), 'export const two = 2;\n');
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a sealed map knows which declaration it answers', () => {
    it('records the declaration it was computed for, and not as a rewritable string', async () => {
        const root = await tempRoot();

        const small = await computePathDigests(root, ['src/pkg/mod.ts']);
        const wide = await computePathDigests(root, ['src/pkg']);

        expect(sealDeclarationOf(small)).toBe(declarationKey(['src/pkg/mod.ts']));
        expect(sealDeclarationOf(wide)).toBe(declarationKey(['src/pkg']));
        // The two declarations are distinguishable, which is the whole point: before this the register remembered only *that*
        // a seal produced the object.
        expect(sealDeclarationOf(small)).not.toBe(sealDeclarationOf(wide));
        // And an object the seal did not produce has no declaration to report.
        expect(sealDeclarationOf({})).toBeUndefined();
    });

    it('refuses a full declaration carrying a smaller declaration’s map, before anything is written', async () => {
        const root = await tempRoot();
        const small = await computePathDigests(root, ['src/pkg/mod.ts']);

        // The write gate, which is where a substitution introduced anywhere upstream has to get past: a record that declares
        // the whole package while its map holds one file of it.
        await expect(writeSubject(root, changeId, {
            revision: 'rev:0000000000000001',
            pathDigests: small,
            declaredPaths: ['src/pkg'],
        } as unknown as Subject)).rejects.toThrow(/computed for a different declaration/);

        // And the same shape through the freeze itself: the map the seal hands on has to answer the declaration being frozen.
        const frozen = await freezeSubject({ root, paths: ['src/pkg'] });
        expect(frozen.ok, JSON.stringify(frozen)).toBe(true);
        if (!frozen.ok) return;
        // The honest pair is accepted, so the refusal above is about the mismatch and not about the gate being closed.
        await expect(writeSubject(root, changeId, frozen.subject)).resolves.toBeUndefined();
        expect(Object.keys(frozen.subject.pathDigests).sort()).toEqual(['src/pkg/mod.ts', 'src/pkg/other.ts']);
    });

    it('accepts a subject that states no declaration, because that is a state rather than a false claim', async () => {
        const root = await tempRoot();
        const map = await computePathDigests(root, ['src/pkg']);

        // Subjects frozen before `declaredPaths` existed have none. Refusing them would refuse the store of record; the rule is
        // asked only of a record that makes a claim about its own declaration.
        await expect(writeSubject(root, changeId, {
            revision: 'rev:0000000000000002',
            pathDigests: map,
        } as unknown as Subject)).resolves.toBeUndefined();
    });
});
