import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';

/**
 * L0-01: an explicitly anchored task must reach one authoritative context construction.
 *
 * `status` answers "which phase is this and what runs next"; `orient` answers "what is this task and what must I
 * read". Building the second answer inside the first made every explicit-task invocation pay two discovery passes
 * over the same task, so `status` is light by default — and it *says so*, because a reader has to be able to tell
 * "no context because none was asked for" from "no context because the task has none".
 */
describe('light status', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function captureJsonOutput(action: () => Promise<void>): Promise<Record<string, unknown>> {
        const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await action();
            const output = write.mock.calls.at(-1)?.[0];
            if (typeof output !== 'string') throw new Error('expected JSON console output');
            return JSON.parse(output.trim()) as Record<string, unknown>;
        } finally {
            write.mockRestore();
        }
    }

    async function fixture(id: string): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-status-light-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id, title: 'Light status', acceptance: [{ id: 'AC-1', statement: 'Status stays cheap.' }] });
        return root;
    }

    it('answers the dispatch question without building task context', async () => {
        const root = await fixture('light-task');

        const result = await captureJsonOutput(() => main(['status', '--change', 'light-task', '--root', root]));

        expect(result).toMatchObject({ command: 'status', taskId: 'light-task', phase: 'intake', light: true });
        expect(result).not.toHaveProperty('context');
        expect(result).not.toHaveProperty('requiredReads');
        expect(result).not.toHaveProperty('task');
        // The dispatch decision is still complete: the caller can act without a second call.
        expect(result).toHaveProperty('nextAction');
        expect(result).toHaveProperty('recommended');
        expect(result).toHaveProperty('engine');
    });

    it('returns the full projection only when it was asked for', async () => {
        const root = await fixture('full-task');

        const result = await captureJsonOutput(() => main(['status', '--change', 'full-task', '--with-context', '--root', root]));

        expect(result).toMatchObject({ command: 'status', taskId: 'full-task' });
        expect(result).not.toHaveProperty('light');
        expect(result).toHaveProperty('task');
        expect(result).toHaveProperty('requiredReads');
        expect(result).toHaveProperty('context');
    });

    it('keeps the engine stamp in both modes, so a mid-task engine change is still comparable (C7)', async () => {
        const root = await fixture('engine-task');

        const light = await captureJsonOutput(() => main(['status', '--change', 'engine-task', '--root', root]));
        const full = await captureJsonOutput(() => main(['status', '--change', 'engine-task', '--with-context', '--root', root]));

        expect(light.engine).toEqual(full.engine);
    });
});
