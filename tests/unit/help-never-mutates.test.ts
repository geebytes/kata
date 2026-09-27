import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { commandFamilies, SELF_HANDLED_HELP, USAGE } from '../../src/cli/usage.js';

/**
 * **AC-5: `--help` is a read, for every command.**
 *
 * Measured before this: the guard fired only for `isWorkflowCommand(command)` — nine of the thirty families — so
 * `kata-cli ledger freeze --help` did not print anything. It *froze the subject*: the argument parser simply ignored a
 * flag it did not know, and the command ran with the flags it did understand. A request to read the manual performed a
 * mutation, which is the worst shape this can take, because the operator has no reason to expect a write and therefore no
 * reason to check.
 *
 * The case is written over the dispatcher's own command list rather than a hand-copied one: a family that exists but is
 * missing from the help map gets a fallback line *and* the guard, and a family that exists in neither fails here.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function captureJsonOutput(action: () => Promise<void>): Promise<Record<string, unknown>> {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
        await action();
        // Every chunk, joined: a large document arrives in several writes, so taking only the last one parses a fragment
        // and reports a parse error where the command actually answered.
        const output = write.mock.calls.map((call) => String(call[0])).join('');
        if (output.trim() === '') throw new Error('expected JSON console output');
        return JSON.parse(output.trim()) as Record<string, unknown>;
    } finally {
        write.mockRestore();
    }
}

describe('a help request is a read, for every command family', () => {
    it('describes every family the dispatcher answers', async () => {
        // **Derived from the dispatcher's own source, not from a hand-copied list.** The guard is only safe if the map is
        // complete, so the completeness is what is checked: every `command === '<family>'` in `src/cli.ts` must have an
        // entry. Without this, adding a family reintroduces exactly the defect this case is about — a command that answers
        // `--help` by running.
        const dispatcher = await readFile(new URL('../../src/cli.ts', import.meta.url), 'utf8');
        const literals = [...dispatcher.matchAll(/command === '([a-z][a-z-]*)'/g)].map((match) => match[1] as string);
        expect(literals.length).toBeGreaterThan(20);
        const undescribed = [...new Set(literals)].filter((family) => USAGE[family] === undefined);
        expect(undescribed, 'a family the dispatcher answers must be described, or `--help` on it will run it').toEqual([]);
    });

    it('answers --help for every family that does not answer it itself', async () => {
        const families = await commandFamilies();
        expect(families.length).toBeGreaterThan(25);
        for (const family of families) {
            if (SELF_HANDLED_HELP[family] !== undefined) continue;
            const output = await captureJsonOutput(() => main([family, '--help']));
            expect(output.readOnly, `${family} --help must be a read`).toBe(true);
            expect(typeof output.usage, `${family} --help must say how to use it`).toBe('string');
        }
    });

    it('keeps the richer help a family answers itself, rather than replacing it with one line', async () => {
        // The first version of the guard intercepted `wiki --help` and answered with a usage line, dropping the verb list
        // the wiki parser had been returning — a regression introduced by the fix. The exception is stated in one place and
        // its claim (that the family answers, rather than that it is exempt) is what is checked here.
        expect(commandFamilies()).toEqual(expect.arrayContaining(Object.keys(SELF_HANDLED_HELP)));
        const help = await captureJsonOutput(() => main(['wiki', '--help']));
        expect(help.command).toBe('wiki help');
        expect(Array.isArray(help.commands)).toBe(true);
    });

    it('does not freeze the subject when help is asked of the freeze verb', async () => {
        // The measured defect, end to end: this exact invocation used to mint a revision.
        root = await mkdtemp(join(tmpdir(), 'kata-help-readonly-'));
        await initLayout(root);
        await createTask({
            root,
            id: 'help-task',
            title: 'Help task',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/a.ts'],
        });
        const reviewDirectory = join(root, '.kata/tasks/help-task/review');

        const output = await captureJsonOutput(() =>
            main(['ledger', 'freeze', '--change', 'help-task', '--root', root, '--help']),
        );
        expect(output.readOnly).toBe(true);
        // Nothing was written: the review directory does not even exist, so the freeze did not run.
        await expect(readdir(reviewDirectory)).rejects.toThrow();
    });

    it('dispatches the same verb when help is not asked', async () => {
        // The other direction: the guard must not make the command unreachable.
        root = await mkdtemp(join(tmpdir(), 'kata-help-dispatches-'));
        await initLayout(root);
        // The owned path has to exist: `freeze` refuses an unreadable declaration, which is a different assertion than the
        // one this case makes, and a case that cannot tell the two apart would pass for the wrong reason.
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
        await createTask({
            root,
            id: 'dispatch-task',
            title: 'Dispatch task',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/a.ts'],
        });

        const output = await captureJsonOutput(() =>
            main(['ledger', 'freeze', '--change', 'dispatch-task', '--root', root]),
        );
        expect(output.readOnly).toBeUndefined();
        expect(String(output.revision)).toMatch(/^rev:/);
    });
});
