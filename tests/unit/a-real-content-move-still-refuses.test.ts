import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **The control for the exclusion: a real content move must still refuse.**
 *
 * Excluding build output from the frozen subject is only correct if it does not become "ignore anything that changed". A
 * declared source file that is edited or deleted still has to move the subject and refuse the request, naming that path —
 * and a request that would brief a reviewer on content that is no longer the change is exactly what the drift rule is for.
 *
 * The pair is the point: same command, same fixture, one difference — what moved.
 */
const changeId = 'real-move';
let root = '';
let previousExitCode: number | string | null | undefined;
const chunks: string[] = [];

async function ledger(argv: string[]): Promise<Record<string, unknown>> {
    chunks.length = 0;
    process.exitCode = 0;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        spy.mockRestore();
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : (JSON.parse(text.slice(start)) as Record<string, unknown>);
}

const refusal = async (): Promise<string> => String((await ledger(['run', '--out', join(root, 'request.json')])).error ?? '');

beforeEach(async () => {
    previousExitCode = process.exitCode;
    root = await mkdtemp(join(tmpdir(), 'kata-real-move-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src', 'pkg', '__pycache__'), { recursive: true });
    await writeFile(join(root, 'src', 'pkg', 'mod.ts'), 'export const holds = true;\n');
    await writeFile(join(root, 'src', 'pkg', 'extra.ts'), 'export const other = 1;\n');
    await writeFile(join(root, 'src', 'pkg', '__pycache__', 'mod.cpython-312.pyc'), 'cache-a');
    await writeTaskRecord(root, { id: changeId, phase: 'implement', ownedPaths: ['src/pkg'] });
    await ledger(['policy', '--init']);
    await ledger(['freeze']);
    await ledger(['plan']);
});

afterEach(async () => {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('a real content move still refuses', () => {
    it('says nothing about drift when only a cache moved', async () => {
        // The state that made the reported workflow impossible: `verify` runs the acceptance commands, so a cache moves
        // between the freeze and the request. It must not be drift.
        await writeFile(join(root, 'src', 'pkg', '__pycache__', 'mod.cpython-312.pyc'), 'cache-b-different');

        expect(await refusal()).not.toContain('has moved since it was frozen');
    });

    it('refuses and names the source path when a declared source file was deleted', async () => {
        await unlink(join(root, 'src', 'pkg', 'extra.ts'));

        const why = await refusal();

        expect(why).toContain('has moved since it was frozen');
        expect(why).toContain('src/pkg/extra.ts');
    });

    it('refuses and names the source path when a declared source file was added', async () => {
        // **Round 11's F5.** The refusal names `changed ∪ added ∪ removed`, and only the changed and removed halves were
        // witnessed: a mutation that dropped `added` stayed green, so "an added declared path is named" rested on nothing.
        // A new source file under a declared directory is exactly the case this change is about — the declaration covers the
        // directory, so a file appearing in it has to move the subject.
        await writeFile(join(root, 'src', 'pkg', 'appeared.ts'), 'export const appeared = true;\n');

        const why = await refusal();

        expect(why).toContain('has moved since it was frozen');
        expect(why).toContain('src/pkg/appeared.ts');
    });

    it('refuses and names the source path when a declared source file was edited', async () => {
        await writeFile(join(root, 'src', 'pkg', 'mod.ts'), 'export const holds = false;\n');

        const why = await refusal();

        expect(why).toContain('has moved since it was frozen');
        expect(why).toContain('src/pkg/mod.ts');
    });
});
