import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';

const run = promisify(execFile);
const roots: string[] = [];

async function git(root: string, args: string[]): Promise<void> {
    await run('git', args, { cwd: root });
}

async function fixture(taskId: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-anchor-seal-'));
    roots.push(root);
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.email', 'kata@example.test']);
    await git(root, ['config', 'user.name', 'Kata Test']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'thing.ts'), 'export const thing = 1;\nexport const other = 2;\n', 'utf8');
    await initLayout(root);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'fixture']);
    await runCommand('open', taskId, root, {
        isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict',
        acceptance: [{ id: 'AC-1', statement: 'A falsifier anchor still points at its site when the seal runs.' }],
        ownedPaths: ['src/thing.ts'],
    } as never);
    await runCommand('design', taskId, root);
    return root;
}

async function ledgerJson(root: string, changeId: string, argv: string[]): Promise<{ ok?: boolean; error?: string }> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
    }
    const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
    return line ? (JSON.parse(line) as { ok?: boolean; error?: string }) : {};
}

async function declareFalsifier(root: string, taskId: string, find: string): Promise<void> {
    // Outside the repository: a submission written inside it would be undeclared content, and the seal would refuse for that
    // reason instead of the one under test.
    const submission = await mkdtemp(join(tmpdir(), 'kata-anchor-submission-'));
    roots.push(submission);
    const file = join(submission, 'submission.json');
    await writeFile(file, `${JSON.stringify({
        claims: [],
        evidence: [{
            id: 'E1',
            type: 'executable_falsifier',
            command: 'npx vitest run tests/unit/example.test.ts',
            mutation: { file: 'src/thing.ts', find, replace: 'export const thing = 42;' },
        }],
    }, null, 2)}\n`, 'utf8');
    const added = await ledgerJson(root, taskId, ['evidence', 'add', '--file', file, '--reason', 'declare the instrument this change is measured by']);
    expect(added.ok, JSON.stringify(added).slice(0, 300)).toBe(true);
}

const seal = (root: string, taskId: string) => runCommand('build', taskId, root, {
    seal: true,
    ownedPaths: ['src/thing.ts'],
    checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
} as never);

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * **An anchor that no longer names a place in its file is refused where it costs least.**
 *
 * The anchors were only ever checked when a reading was written, so a repair that moved the code left the verdict on disk
 * saying `supported` about a mutation that would apply nowhere — measured eleven times across ten review rounds of one change,
 * every one found by hand. The seal now asks the read-only half of that question (`declaredAnchorProblems`, exported from
 * `src/quality/falsifier-anchors.ts` and called by `collectSealPreflight`), and names the falsifier and the command that
 * re-aims it. The sufficient half stays where it was: `ledger evidence verify` runs the mutation and is the only thing that can
 * say whether it still reddens.
 *
 * **Boundary**: the check is a string match against the file the declaration names. An anchor that is unique and still reddens
 * for a different reason — or a property whose site moved but whose anchor string survived — is not something a read-only check
 * can see, which is why the two halves are asserted side by side rather than one being claimed as the other.
 */
describe('a falsifier anchor is checked at seal time', () => {
    it('seals when every declared anchor still points at exactly one place', async () => {
        const taskId = 'anchor-unique';
        const root = await fixture(taskId);
        await declareFalsifier(root, taskId, 'export const other = 2;');
        const sealed = await seal(root, taskId);
        expect(sealed.success, JSON.stringify(sealed).slice(0, 400)).toBe(true);
    });

    it('refuses by name when an anchor matches nothing, and names the command that re-aims it', async () => {
        const taskId = 'anchor-absent';
        const root = await fixture(taskId);
        await declareFalsifier(root, taskId, 'export const thing = 1; export const tail = 9;');
        const sealed = await seal(root, taskId);
        expect(sealed.success, 'a seal must not proceed on an instrument that cannot apply').toBe(false);
        const message = String(sealed.error);
        expect(message, 'and it names the falsifier').toContain('E1');
        expect(message, 'and what is wrong with the anchor').toMatch(/matches 0 times/);
        expect(message, 'and the road that re-aims it, with the real change id').toContain(`kata-cli ledger evidence replace --change ${taskId}`);
    });

    it('refuses when an anchor matches more than once, because the defect would land at another site', async () => {
        const taskId = 'anchor-ambiguous';
        const root = await fixture(taskId);
        await writeFile(join(root, 'src', 'thing.ts'), 'export const thing = 1;\nexport const twin = 1;\n', 'utf8');
        await declareFalsifier(root, taskId, '= 1;');
        const sealed = await seal(root, taskId);
        expect(sealed.success).toBe(false);
        expect(String(sealed.error)).toMatch(/matches 2 times/);
        expect(String(sealed.error)).toContain(`kata-cli ledger evidence replace --change ${taskId}`);
    });

    it('seals when nothing was declared, because a change without a ledger has no anchors to check', async () => {
        const taskId = 'anchor-undeclared';
        const root = await fixture(taskId);
        const sealed = await seal(root, taskId);
        expect(sealed.success, JSON.stringify(sealed).slice(0, 400)).toBe(true);
    });

    it('refuses a declared falsifier that carries no mutation, rather than reporting nothing to check', async () => {
        // **A review round measured this shape: a declaration the check could not use read as "nothing to check".** The
        // ledger's own reader refuses the same document (`schemas/review-evidence.schema.json` requires `mutation`), so the
        // seal reporting no problem for it made a corrupt declaration indistinguishable from an absent one. Only records that
        // are not falsifiers are skipped now.
        const taskId = 'anchor-no-mutation';
        const root = await fixture(taskId);
        const path = join(root, '.kata', 'tasks', taskId, 'review', 'evidence.json');
        await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
        await writeFile(path, `${JSON.stringify({ evidence: [
            { id: 'E1', type: 'executable_falsifier', command: 'npx vitest run tests/unit/example.test.ts' },
            { id: 'W1', type: 'static_witness', ref: 'src/thing.ts', assertion: 'contains:thing' },
        ] }, null, 2)}\n`, 'utf8');

        const sealed = await seal(root, taskId);
        expect(sealed.success).toBe(false);
        expect(String(sealed.error), 'the mutation-less falsifier is named, and the witness is not').toMatch(/E1/);
        expect(String(sealed.error)).not.toMatch(/W1/);
    });

    it('refuses by name when the declarations cannot be read, rather than reporting nothing to check', async () => {
        const taskId = 'anchor-unreadable';
        const root = await fixture(taskId);
        await declareFalsifier(root, taskId, 'export const other = 2;');
        const path = join(root, '.kata', 'tasks', taskId, 'review', 'evidence.json');
        await writeFile(path, '{ this is not json', 'utf8');
        const sealed = await seal(root, taskId);
        expect(sealed.success).toBe(false);
        expect(String(sealed.error)).toMatch(/could not be read|not readable JSON/);
    });
});
