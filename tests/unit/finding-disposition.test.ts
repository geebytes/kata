import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import {
    applyDisposition,
    dispositionDenial,
    deferredFindings,
    readTrackedFindings,
    unfixed,
} from '../../src/quality/finding-disposition.js';

/**
 * A finding has a life: open, fixed, deferred or accepted (F1 of the finding-lifecycle design).
 *
 * Before this, a finding was either present or gone — "known, decided to defer, remembered" had nowhere to live, so it
 * survived only in the author's notes, came back as a new finding in the next pass, and was invisible when the task
 * closed. The rules under test are the design's invariants: blocking/major cannot be dispositioned at all (I1), a
 * deferral is explicit and carries why/by/when (I2), and a record that never said is read as open.
 */
describe('a finding has a disposition', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-findings-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'finding-task',
            title: 'Findings',
            acceptance: [{ id: 'AC-1', statement: 'Findings have a life.' }],
        });
        await mkdir(join(root, '.kata/tasks/finding-task'), { recursive: true });
        await writeFile(join(root, '.kata/tasks/finding-task/review.json'), JSON.stringify({
            taskId: 'finding-task',
            status: 'pending',
            findings: [
                { id: 'f-blocking', taskId: 'finding-task', severity: 'blocking', message: 'must fix' },
                { id: 'f-major', taskId: 'finding-task', severity: 'major', message: 'should fix' },
                { id: 'f-minor', taskId: 'finding-task', severity: 'minor', message: 'worth fixing later', path: 'src/a.ts' },
            ],
        }), 'utf8');
        return root;
    }

    it('reads a record that never said as open', async () => {
        const root = await workspace();
        const findings = await readTrackedFindings(root, 'finding-task');

        expect(findings.map((finding) => finding.id)).toEqual(['f-blocking', 'f-major', 'f-minor']);
        expect(findings.every((finding) => finding.disposition === 'open')).toBe(true);
        expect(unfixed(findings)).toHaveLength(3);
    });

    it('refuses to disposition a blocking or major finding (I1)', async () => {
        const root = await workspace();
        const findings = await readTrackedFindings(root, 'finding-task');
        const blocking = findings.find((finding) => finding.id === 'f-blocking')!;
        const major = findings.find((finding) => finding.id === 'f-major')!;

        for (const finding of [blocking, major]) {
            expect(dispositionDenial(finding, 'deferred', 'later')).toMatch(/must be repaired/);
            expect(dispositionDenial(finding, 'accepted', 'not a defect')).toMatch(/must be repaired/);
        }
    });

    it('requires a reason for a minor finding, and records who decided and when', async () => {
        const root = await workspace();
        const findings = await readTrackedFindings(root, 'finding-task');
        const minor = findings.find((finding) => finding.id === 'f-minor')!;

        expect(dispositionDenial(minor, 'deferred', undefined)).toMatch(/requires --reason/);
        expect(dispositionDenial(minor, 'deferred', 'the follow-up task owns it')).toBeNull();

        await applyDisposition(root, 'finding-task', minor.source, 'f-minor', {
            disposition: 'deferred',
            reason: 'the follow-up task owns it',
            by: 'reviewer-1',
            at: '2026-09-18T12:00:00.000Z',
        });

        const record = JSON.parse(await readFile(join(root, '.kata/tasks/finding-task/review.json'), 'utf8')) as {
            findings: Array<{ id: string; disposition?: string; dispositionReason?: string; dispositionBy?: string }>;
        };
        const written = record.findings.find((finding) => finding.id === 'f-minor')!;
        expect(written).toMatchObject({
            disposition: 'deferred',
            dispositionReason: 'the follow-up task owns it',
            dispositionBy: 'reviewer-1',
        });

        const reread = await readTrackedFindings(root, 'finding-task');
        expect(deferredFindings(reread).map((finding) => finding.id)).toEqual(['f-minor']);
    });

    it('keeps the finding visible after it is dispositioned — it changes when it is read, not whether (I5)', async () => {
        const root = await workspace();
        const findings = await readTrackedFindings(root, 'finding-task');
        const minor = findings.find((finding) => finding.id === 'f-minor')!;
        await applyDisposition(root, 'finding-task', minor.source, 'f-minor', {
            disposition: 'accepted',
            reason: 'the guard covers it',
            by: 'reviewer-1',
            at: '2026-09-18T12:00:00.000Z',
        });

        const replayed = await readTrackedFindings(root, 'finding-task');
        // Still counted as unfixed, still listed: an accepted finding is a decision, not a disappearance.
        expect(unfixed(replayed).map((finding) => finding.id)).toEqual(['f-blocking', 'f-major', 'f-minor']);
    });

    it('reads findings from an adversarial pass as well as the review', async () => {
        const root = await workspace();
        await writeFile(join(root, '.kata/tasks/finding-task/adversarial-verify.json'), JSON.stringify({
            node: 'verify',
            status: 'recorded',
            revisionId: 'revision-1',
            createdAt: '2026-09-18T12:00:00.000Z',
            executedInFreshContext: true,
            attempts: [{ hypothesis: 'x', method: 'y', outcome: 'refuted' }],
            findings: [{ id: 'a-nit', taskId: 'finding-task', severity: 'nit', message: 'cosmetic' }],
        }), 'utf8');

        const findings = await readTrackedFindings(root, 'finding-task');
        expect(findings.map((finding) => finding.id)).toContain('a-nit');
        expect(findings.find((finding) => finding.id === 'a-nit')?.source).toBe('verify');
    });
});
