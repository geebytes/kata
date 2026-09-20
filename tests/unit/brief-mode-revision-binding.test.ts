import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { addAdversarialFinding, resolveBriefMode, writeAdversarialRecord } from '../../src/quality/adversarial.js';

/**
 * A round is framed by the findings that bind to the revision it is about.
 *
 * `resolveBriefMode` read every tracked finding with no revision filter, so a finding still open in a record from an
 * earlier revision framed the next round as *"an open major finding is unrepaired, so this round checks the repair"*.
 * That window is the normal path, not an edge: a pass is recorded at the revision it answered, a repair re-seals to a
 * new one, and the record is only replaced when the *next* pass is recorded — which is after the brief is issued.
 */
describe('the framing a brief carries', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function taskSealedAt(id: string, content: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-framing-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id, title: 'Framing', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/x.ts'), content, 'utf8');
        await createTaskRevision({ root, taskId: id, ownedPaths: ['src/x.ts'], checkIds: [] });
        return root;
    }

    async function recordOpenMajorAt(root: string, taskId: string, revisionId: string): Promise<void> {
        await writeAdversarialRecord(root, taskId, {
            node: 'review', status: 'recorded', revisionId, createdAt: new Date().toISOString(),
            executedInFreshContext: true, contextNote: 'fixture',
            briefSha256: 'a'.repeat(64), attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }], findings: [],
        });
        await addAdversarialFinding(root, taskId, 'review', { id: 'older-major', severity: 'major', message: 'a major finding' });
    }

    // The rule is scoped: a finding is dropped only when its record names a revision that is neither current nor
    // content-equal. A record naming no revision, or one naming a revision while the workspace has none (the state a task
    // is in before its first seal), is still the round's to check — the conservative direction.
    it('ignores a finding recorded against an earlier revision', async () => {
        const root = await taskSealedAt('framing-task', 'export const x = 1;\n');
        await recordOpenMajorAt(root, 'framing-task', 'revision-earlier');

        // The repair landed: new content, a new revision. The record still sits at the old one, as it does until the next
        // pass is recorded — and the brief is issued before that.
        await writeFile(join(root, 'src/x.ts'), 'export const x = 2;\n', 'utf8');
        await createTaskRevision({ root, taskId: 'framing-task', ownedPaths: ['src/x.ts'], checkIds: [] });

        const { reason } = await resolveBriefMode(root, 'framing-task', 'review');
        expect(reason).not.toContain('is unrepaired');
    });

    it('still frames a round as checking the repair when the finding binds to this revision', async () => {
        const root = await taskSealedAt('framing-current', 'export const x = 1;\n');
        const { readCurrentTaskRevision } = await import('../../src/workflow/revision.js');
        const current = await readCurrentTaskRevision(root, 'framing-current');
        await recordOpenMajorAt(root, 'framing-current', current!.id);

        // The conservative direction survives: a finding about the revision in hand is still this round's to check.
        const { reason } = await resolveBriefMode(root, 'framing-current', 'review');
        expect(reason).toContain('is unrepaired');
    });
});
