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

    it('binds the record to this revision by carrying the floor decision in the record itself', async () => {
        // **The evidence has to hold where the seal evaluates it.** F-4, third attempt at this clause: the first version
        // compared a code constant (reverting the floor left it green); the second asserted the record was among the
        // sealed revision's `pathDigests` (always true, because the digests are derived from the declaration); the third
        // asserted the task declaration carried the path — and the seal runs this suite in a sandbox copied from the
        // tracked files, which does not carry `.kata/`, so that branch degenerated too.
        //
        // What survives every environment is the record's own content bound to the decision: the record must state the
        // floor that was retired and the floor that replaced it, and the policy a stored change is judged by must be the
        // one the record describes. Mutating either side reddens here, in a checkout or in the sandbox alike.
        const record = await readFile(transitionRecord, 'utf8');
        expect(record).toMatch(/Previous floor: `sandboxed`/);
        expect(record).toMatch(/New floor: `observed`/);

        // The decision the record describes, made real through the writer and the reader: this is what fails when the
        // floor is reverted, because the store refuses to write a retired floor at all.
        await writePolicy(temp, changeId, defaultPolicy());
        const stored = await readLedger(temp, changeId);
        expect(stored.policy.tiers.security.assuranceFloor).toBe('observed');
        expect(meetsAssuranceFloor(stored.policy, 'security', 'observed')).toBe(true);
        expect(meetsAssuranceFloor(stored.policy, 'security', 'sandboxed')).toBe(false);

        // And the record's stated retirement is the one the policy enforces: the value the record calls retired is the
        // value the decision layer refuses, in the same run. Coupling the two is what makes this a binding rather than
        // two independent facts about the same subject.
        const historical = await readFile(join(root, 'src', 'kernel', 'types.ts'), 'utf8');
        expect(historical).toMatch(/LEGACY_ASSURANCE_LEVELS\s*=\s*\[[^\]]*'sandboxed'/);
    });

    it('carries the binding through a surface the seal actually copies, so removing it reddens here', async () => {
        // R5-4: the "bound to this revision" half had no falsifier. Deleting the record from the *task declaration* left all
        // four cases green — and the seal evaluates this suite in a copy made from the tracked files, which does not carry
        // `.kata/`, so a declaration-only assertion could never hold where it is read. Measured with the copier itself:
        // `.kata/` is absent from the copy and this document is present.
        //
        // The binding therefore has to be asserted on a surface the copy carries: the change's declaration is mirrored in
        // the record's own §8, and the repository's own record of which paths the change owns is the tracked list below.
        const { listRepositoryFiles } = await import('../../src/core/repository-identity.js');
        const carried = await listRepositoryFiles(root);
        const recordRelative = 'docs/design/2026-09-30-security-tier-platform-boundary.md';
        expect(carried).toContain(recordRelative);

        // The declaration is written twice — once on the task (a checkout only) and once in the record's own §8 — and the
        // tracked copy is the one the seal can see. Removing the document, or dropping it from that list, reddens here.
        const record = await readFile(transitionRecord, 'utf8');
        expect(record).toContain('Binding: this document is an owned path and is sealed with the policy change');
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
