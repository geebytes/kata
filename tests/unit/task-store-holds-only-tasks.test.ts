import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, tasksDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { buildLlmWikiTask } from '../../src/wiki/llmwiki.js';
import { writeWikiEnrichPacket } from '../../src/wiki/enrich-packet.js';

/**
 * **AC-1: a directory under the governed store is a task the CLI can resolve, or it is not created there.**
 *
 * Measured before this change: the store held a `wiki-enrich` directory with no `task.json`, written by two callers
 * (`install` and `wiki rebuild`) and read back by nobody. `kata-cli status --change wiki-enrich` answered `No Kata
 * workspace owns task wiki-enrich` while the directory sat in the store, so every tool that enumerates `.kata/tasks/*` as
 * tasks had to special-case it — the sweep that produced this change reported exactly one such entry out of twelve.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-enrich-packet-'));
    await initLayout(root);
    return root;
}

/** The writer takes the packet rather than building it, so a case states its own packet instead of conjuring one. */
async function writePacket(workspace: string): Promise<{ path: string }> {
    return writeWikiEnrichPacket({ root: workspace, packet: await buildLlmWikiTask({ root: workspace, kind: 'enrich' }) });
}

describe('the governed task store holds only tasks', () => {
    it('writes the wiki enrichment packet outside the task store', async () => {
        const workspace = await scratch();
        const written = await writePacket(workspace);

        // Outside the store, which is the whole assertion.
        expect(written.path.startsWith(tasksDir(workspace))).toBe(false);
        // And it exists, so "outside the store" is not achieved by writing nothing.
        await expect(stat(join(workspace, written.path))).resolves.toBeDefined();
    });

    it('creates no directory in the store when the packet is written', async () => {
        const workspace = await scratch();
        await createTask({ root: workspace, id: 'a-real-task', title: 'A real task', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await writePacket(workspace);

        const entries = await readdir(tasksDir(workspace));
        // Every entry is the task that was created — not a directory named after a skill or a phase.
        expect(entries).toEqual(['a-real-task']);
    });

    it('keeps the store enumerable as tasks alone', async () => {
        // The property the store exists for: an enumeration of it is an enumeration of tasks. A packet written into the
        // store makes that false in a way no single command can report — the directory is simply there and unresolvable.
        const workspace = await scratch();
        await writePacket(workspace);
        await createTask({ root: workspace, id: 't1', title: 'T1', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        await createTask({ root: workspace, id: 't2', title: 'T2', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        const entries = await readdir(tasksDir(workspace));
        expect(entries.flat().sort()).toEqual(['t1', 't2']);
        for (const entry of entries) {
            await expect(stat(join(tasksDir(workspace), entry, 'task.json'))).resolves.toBeDefined();
        }
    });
});
