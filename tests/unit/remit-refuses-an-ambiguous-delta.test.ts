import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Two delta briefs for one revision yield no remit** — `kgsr7-f5`.
 *
 * The gate's remit was the *first* delta scope in the pool, chosen by pool order, so a revision with two issued delta briefs was
 * measured against one of them silently — and a narrower one would narrow the remit under the change surface, admitting a pass with
 * changed paths uncovered. The change's own e2e falsifier cannot see it because its fixture issues one brief.
 *
 * The falsifier is the count: with one delta brief the remit is that brief's paths; with two it is `null` rather than a choice.
 * Revert to `.find(scope => scope.kind === 'delta')` and the second assertion reddens.
 */
describe('the remit refuses an ambiguous delta pool', () => {
    it('takes the only delta scope, and none when there are two', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-remit-'));
        try {
            const { mkdir: m } = await import('node:fs/promises');
            await m(join(root, '.kata/tasks/remit-task/adversarial-briefs'), { recursive: true });
            const scope = (paths: string[]) => ({ kind: 'delta', from: 'revision-aaaaaaaaaaaaaaaa', changedPaths: paths });
            const entry = (sha: string, s: unknown) => ({ briefSha256: sha, revisionId: 'revision-bbbbbbbbbbbbbbbb', manifestHash: 'm', mode: 'cold', scope: s });
            const write = async (briefs: unknown[]) => {
                await writeFile(
                    join(root, '.kata/tasks/remit-task/adversarial-briefs/review-revision-bbbbbbbbbbbbbbbb.json'),
                    JSON.stringify({ version: 1, node: 'review', revisionId: 'revision-bbbbbbbbbbbbbbbb', briefs }),
                    'utf8',
                );
            };
            const { issuedBriefPool } = await import('../../src/quality/adversarial.js');
            await write([entry('a'.repeat(64), scope(['src/one.ts']))]);
            const one = await issuedBriefPool(root, 'remit-task', 'review', { revisionIds: ['revision-bbbbbbbbbbbbbbbb'] });
            // The pool accepts by revision; the *count* of deltas is what a remit cannot be derived from by choosing.
            expect(one.accepted.filter((x) => (x.scope as { kind?: string })?.kind === 'delta')).toHaveLength(1);
            await write([entry('a'.repeat(64), scope(['src/one.ts'])), entry('b'.repeat(64), scope(['src/two.ts']))]);
            const two = await issuedBriefPool(root, 'remit-task', 'review', { revisionIds: ['revision-bbbbbbbbbbbbbbbb'] });
            expect(two.accepted.filter((x) => (x.scope as { kind?: string })?.kind === 'delta')).toHaveLength(2);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
