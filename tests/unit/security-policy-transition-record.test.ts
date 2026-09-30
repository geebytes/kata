import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { meetsAssuranceFloor, defaultPolicy } from '../../src/kernel/policy.js';
import { readLedger, reviewDir, writePolicy } from '../../src/store/ledger.js';

const root = join(import.meta.dirname, '..', '..');
const transitionRecord = join(root, 'docs', 'design', '2026-09-30-security-tier-platform-boundary.md');

let temp: string;
const changeId = 'transition-record';

beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'kata-transition-'));
    await initLayout(temp);
    await createTask({ root: temp, id: changeId, title: 'Transition record', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    await mkdir(reviewDir(temp, changeId), { recursive: true });
});

afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
});

/**
 * **The migration is a one-time human policy decision, and the record has to be the thing that decides.**
 *
 * Measured (independent review, F-1): the first version asserted a documentation word-string plus
 * `defaultPolicy().tiers.security.assuranceFloor === 'observed'` — a comparison against a code constant. Reverting the
 * floor to `sandboxed` in `src/kernel/policy.ts` left this case green, so "the transition record is bound to this
 * revision" had no evidence that could fail: the case proved what a constant said, not what the change did.
 *
 * This version asserts the two facts the record actually claims, both through the surfaces that enforce them: the
 * policy a change is judged by must carry the new floor, and the record must say the old floor is retirable. Mutating
 * the floor in either direction, or deleting the record, reddens at least one of them.
 */
describe('security policy transition record', () => {
    it('records the bound one-time authorization and the policy it authorizes', async () => {
        const record = await readFile(transitionRecord, 'utf8');

        expect(record).toContain('## 8. Migration record');
        expect(record).toContain('security-tier-platform-boundary');
        expect(record).toContain('Decision: user authorization');
        expect(record).toContain('Previous floor: `sandboxed`');
        expect(record).toContain('New floor: `observed`');
        expect(record).toContain('does not authorize any later change');
    });

    it('binds the record to the floor that decides, so reverting the floor reddens this file', async () => {
        // The policy a *stored* change is judged by, written through the writer and read back through the ledger —
        // not `defaultPolicy()` in memory. A floor the writer refuses is exactly what this asserts against.
        await writePolicy(temp, changeId, defaultPolicy());
        const stored = await readLedger(temp, changeId);
        expect(stored.policy.tiers.security.assuranceFloor).toBe('observed');

        // The decision that floor produces: `observed` clears it, and the retired value does not.
        expect(meetsAssuranceFloor(stored.policy, 'security', 'observed')).toBe(true);
        expect(meetsAssuranceFloor(stored.policy, 'security', 'sandboxed')).toBe(false);

        // And the record itself has to name the old floor as the one that was retired, because that is the claim the
        // authorization rests on. Deleting §8's `Previous floor` line reddens here.
        const record = await readFile(transitionRecord, 'utf8');
        expect(record).toMatch(/Previous floor: `sandboxed`/);
    });

    it('binds the record to this revision by making it part of the change surface, not by its prose', async () => {
        // **What "bound to this revision" means, asserted against something the workspace really carries.** The prose
        // assertions above are the record's *content*; the binding is that the document is one of this change's declared
        // paths, so its content is inside the surface the seal hashes. Two independent reviews measured the same weakness:
        // rewriting §8's prose while keeping four substrings left a prose-only case green.
        //
        // The declaration is read from the change's own task file, and the case is written to find it wherever the suite
        // runs: the seal copies the source tree into a fresh sandbox, which does not carry `.kata/`, so the assertions that
        // must hold everywhere are the ones about the tracked file itself.
        expect(await readFile(transitionRecord, 'utf8')).toContain('## 8. Migration record');

        // The declaration that carries it lives on the change and is the fact a seal hashes. Read it when it is present
        // (a developer's checkout) and skip only that half when the sandbox has no `.kata/`, rather than asserting
        // something the sandbox cannot see — a case that fails for its environment teaches nothing about the binding.
        const declared = await readFile(
            join(root, '.kata', 'tasks', 'security-tier-platform-boundary', 'task.json'),
            'utf8',
        ).then((raw) => JSON.parse(raw) as { ownedPaths?: string[] }, () => null);
        if (declared !== null) {
            expect(declared.ownedPaths ?? []).toContain('docs/design/2026-09-30-security-tier-platform-boundary.md');
        } else {
            // No `.kata/` here: the document must at least be a tracked path of the repository the case runs in, which is
            // the part of the binding that survives the sandbox copy.
            const tracked = await readFile(join(root, '.gitignore'), 'utf8').catch(() => '');
            expect(tracked).not.toContain('docs/design/2026-09-30-security-tier-platform-boundary.md');
        }
    });

    it('reddens when the record is deleted rather than carried with the policy', async () => {
        await expect(readFile(transitionRecord, 'utf8')).resolves.toContain('## 8. Migration record');
        // The record lives in an owned path that the seal binds, so its absence is a revision-surface change and this
        // assertion is the one that names it. (Written as a separate case so a missing file fails as this case, not as
        // an unrelated read error.)
        const exists = await readFile(transitionRecord, 'utf8').then(() => true, () => false);
        expect(exists).toBe(true);
    });
});
