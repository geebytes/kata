import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverWorktreeRecords } from '../../src/workflow/worktree.js';

/**
 * AC-8 — a recovery that recovered nothing says it found nothing, rather than reporting success with a count of zero.
 *
 * The measured defect (reading 1, F6, major): the guard's own remedy is `kata-cli worktree recover --change <task>`,
 * and that command answered `{"recovered":[],"movedCount":0}` for **every** `--change` value — including one that named
 * a task whose records were sitting in a worktree the detector could not see. The operator reads a zero count as "there
 * was nothing to move" when the truth is "this command cannot move it", and the records are gone at archive time.
 *
 * The criterion is the distinction the operator needs: an empty result is an outcome to report, not a success to imply.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-uc-nothing-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "uc", "private": true }\n');
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('recovering nothing is not success', () => {
    it('says it found nothing when the named task has no worktree-only record', async () => {
        const primary = repo('clean');
        mkdirSync(join(primary, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(primary, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const { runWorktreeCommand } = await import('../../src/cli/ops.js');
        const result = await runWorktreeCommand(['recover', '--change', 'held', '--root', primary]);
        // Zero moved must come with the fact, not instead of it.
        expect(result.movedCount, JSON.stringify(result)).toBe(0);
        expect(result.foundNothing, 'a zero count has to say what it means').toBe(true);
    });

    it('does not claim nothing was found when it moved records', async () => {
        const primary = repo('moved');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const results = await recoverWorktreeRecords({ root: primary, taskId: 'held' });
        expect(results.flatMap((entry) => entry.moved)).toEqual(['tasks/judge.json']);
    });
});
