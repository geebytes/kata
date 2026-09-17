import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindsToRevision } from '../../src/workflow/verdict-binding.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision, type TaskRevision } from '../../src/workflow/revision.js';
import { evaluateReviewClearance } from '../../src/workflow/distill-gates.js';
import { requireUserChoiceGate } from '../../src/workflow/user-choice-gate.js';

/**
 * One rule for every verdict: it names the revision, or the content it reviewed.
 *
 * Binding a review, a judgement, a verification or a user's choice to the revision *id* alone made every re-seal expire
 * it — the id covers the manifest hash **and** the check ids, so sealing the same content again issues a new one. A
 * re-seal therefore re-asked the platform/model choice, re-ran the review and invalidated the distillation verdicts for
 * an artefact nobody had changed.
 */
describe('a verdict binds by revision id or by content', () => {
    const current = { revisionId: 'revision-new', manifestHash: 'aa'.repeat(32) };

    it('accepts the same revision', () => {
        expect(bindsToRevision({ revisionId: 'revision-new' }, current)).toBe(true);
    });

    it('accepts the same content under a new id', () => {
        expect(bindsToRevision({ revisionId: 'revision-old', manifestHash: 'aa'.repeat(32) }, current)).toBe(true);
    });

    it('refuses different content under a new id', () => {
        expect(bindsToRevision({ revisionId: 'revision-old', manifestHash: 'bb'.repeat(32) }, current)).toBe(false);
    });

    it('refuses an id from another revision when neither content is known (legacy artefacts)', () => {
        expect(bindsToRevision({ revisionId: 'revision-old' }, current)).toBe(false);
    });

    it('lets a verdict that names no revision stand when nothing is sealed', () => {
        // A user's choice is recorded before the first seal; it is not stale, it is early.
        expect(bindsToRevision({}, { revisionId: null, manifestHash: null })).toBe(true);
    });

    it('refuses a verdict naming a revision that is no longer there', () => {
        expect(bindsToRevision({ revisionId: 'revision-old' }, { revisionId: null, manifestHash: null })).toBe(false);
    });

    it('refuses a missing verdict', () => {
        expect(bindsToRevision(null, current)).toBe(false);
    });
});

describe('a re-seal of the same content keeps the gates satisfied', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function sealedTwice(): Promise<{ root: string; taskId: string; first: TaskRevision; second: TaskRevision }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-verdict-binding-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'binding-task',
            title: 'Same content, new seal',
            acceptance: [{ id: 'AC-1', statement: 'The gates survive a re-seal.' }],
        });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/owned.ts'), 'export const value = 1;\n', 'utf8');

        // Two seals of byte-identical content: the revision id covers the check ids too, so a different check set (which
        // is what a later seal discovers) issues a new id for the same bytes.
        const first = await createTaskRevision({ root, taskId: 'binding-task', ownedPaths: ['src'], checkIds: ['lint', 'test'] });
        const second = await createTaskRevision({ root, taskId: 'binding-task', ownedPaths: ['src'], checkIds: ['lint', 'test', 'typecheck'] });
        return { root, taskId: 'binding-task', first, second };
    }

    it('gives the two seals the same content identity, and says so', async () => {
        const { first, second } = await sealedTwice();
        expect(second.id).not.toBe(first.id);
        expect(second.manifestHash).toBe(first.manifestHash);
    });

    it('keeps an approved review cleared', async () => {
        const { root, taskId, first, second } = await sealedTwice();
        await writeFile(join(root, '.kata/tasks', taskId, 'review.json'), JSON.stringify({
            taskId,
            revisionId: first.id,
            manifestHash: first.manifestHash,
            status: 'approved',
            reviewEvidence: 'Read the diff; the gate binding is the point of the change.',
            findings: [],
        }), 'utf8');

        await expect(evaluateReviewClearance(root, taskId, second.id)).resolves.toMatchObject({ cleared: true });
    });

    it('keeps the user’s choice valid instead of asking again', async () => {
        const { root, taskId, second } = await sealedTwice();
        // The choice was made at the first seal and is about the same bytes.
        const gatePath = join(root, '.kata/tasks', taskId, 'user-choice-implementation_gate.json');
        await writeFile(gatePath, JSON.stringify({
            taskId,
            boundary: 'implementation_gate',
            revisionId: 'revision-earlier',
            manifestHash: second.manifestHash,
            createdAt: new Date().toISOString(),
            choice: 'continue_current',
            approvedAt: new Date().toISOString(),
        }), 'utf8');

        await expect(requireUserChoiceGate({ root, taskId, boundary: 'implementation_gate', revisionId: second.id }))
            .resolves.toMatchObject({ choice: 'continue_current' });
    });
});
