import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

const run = promisify(execFile);
const roots: string[] = [];

/**
 * **A road is a command, and the only honest test of a command is to run it.**
 *
 * Nine review rounds of one change went to refusals whose printed remedy could not be executed from the state they fire in —
 * a placeholder where the tool held the value, a flag the verb does not read, a verb that does not exist, or a road that
 * belongs to a different phase. Each round's fix was a pattern over the sentence, and each pattern was defeated by wording
 * one layer out. So this case does not read the sentence: it takes the commands the refusal actually prints, splits them
 * respecting quotes, and hands each one to the entry point the CLI uses, in a fixture. A **domain** refusal is expected and is
 * not the subject (the file really is missing); what must never come back is a **usage** refusal.
 *
 * The vocabulary below is the parser's own, not a guess: an earlier version looked for "unknown ledger flag" while the parser
 * says "--klasses is not a flag the ledger family reads", and a renamed flag sailed through the guard built to catch it.
 */
const USAGE_REFUSAL = /is not a flag the ledger family reads|unknown ledger flag|unknown verb|requires --reason|is not a known|^usage:|unknown scope|unknown subcommand|not a function|Cannot read/i;

async function git(root: string, args: string[]): Promise<void> {
    await run('git', args, { cwd: root });
}

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function fixture(taskId: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-roads-'));
    roots.push(root);
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.email', 'kata@example.test']);
    await git(root, ['config', 'user.name', 'Kata Test']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'thing.ts'), 'export const thing = 1;\n', 'utf8');
    await initLayout(root);
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'fixture']);
    await runCommand('open', taskId, root, {
        isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict',
        acceptance: [{ id: 'AC-1', statement: 'Every refusal this change adds names a road that runs.' }],
        ownedPaths: ['src/thing.ts'],
    } as never);
    await runCommand('design', taskId, root);
    return root;
}

async function declareFalsifier(root: string, taskId: string, find: string): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'kata-roads-submission-'));
    roots.push(directory);
    const file = join(directory, 'submission.json');
    await writeFile(file, `${JSON.stringify({
        claims: [],
        evidence: [{ id: 'E1', type: 'executable_falsifier', command: 'npx vitest run tests/unit/example.test.ts', mutation: { file: 'src/thing.ts', find, replace: 'export const thing = 42;' } }],
    }, null, 2)}\n`, 'utf8');
    const added = await ledgerReply(root, taskId, ['evidence', 'add', '--file', file, '--reason', 'declare the instrument']);
    expect(String(added), 'the fixture must declare an instrument for the refusal to be about').toContain('"ok":true');
}

/** Call the CLI's ledger entry the way the CLI does, and report the envelope and any thrown message as text. */
async function ledgerReply(root: string, changeId: string, argv: string[]): Promise<string> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } catch (error) {
        return `${chunks.join('')}\n${(error as Error).message}`;
    } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
    }
    return chunks.join('');
}

/** The commands a refusal prints: backticked, starting with the entry point. */
function printedCommands(message: string): string[] {
    return [...message.matchAll(/`(kata-cli [^`]+)`/g)].map((match) => match[1]);
}

/** Split a printed command into argv, keeping quoted values together — the CLI receives arguments, not a sentence. */
function argvOf(command: string): string[] {
    return [...command.replace(/^kata-cli\s+/, '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
        .map((match) => match[1] ?? match[2] ?? match[3]);
}

/**
 * Run a printed road through the family the CLI would dispatch it to.
 *
 * **An unhandled family throws rather than being skipped**, so the guard cannot pass by not looking: the first version of this
 * helper stripped no more than the entry point's name and handed `ledger …` to the ledger dispatcher, which answered
 * `unknown verb "ledger"` — a usage refusal manufactured by the harness, not by the refusal under test.
 */
async function drivePrinted(root: string, changeId: string, command: string): Promise<string> {
    const argv = argvOf(command);
    if (argv[0] === 'ledger') return ledgerReply(root, changeId, argv.slice(1));
    throw new Error(`this guard drives the ledger family; it does not know how to run: ${command}`);
}

const seal = (root: string, taskId: string) => runCommand('build', taskId, root, {
    seal: true,
    ownedPaths: ['src/thing.ts'],
    checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
} as never);

describe('every refusal this change adds names a command that works there', () => {
    it('the anchor refusal prints a road the CLI accepts, with the values the tool already holds', async () => {
        const taskId = 'road-anchor-absent';
        const root = await fixture(taskId);
        await declareFalsifier(root, taskId, 'export const thing = 1; export const nowhere = 9;');

        const sealed = await seal(root, taskId);
        expect(sealed.success).toBe(false);
        const commands = printedCommands(String(sealed.error));
        expect(commands.length, 'a refusal must name a road, not only describe the state').toBeGreaterThan(0);

        for (const command of commands) {
            expect(command, 'the change id is in hand, so it must not be a placeholder').not.toMatch(/--change </);
            const reply = await drivePrinted(root, taskId, command);
            expect(reply, `the printed road must be a command the CLI accepts: ${command} -> ${reply}`).not.toMatch(USAGE_REFUSAL);
        }
    });

    it('the unreadable-declaration refusal prints a road too', async () => {
        const taskId = 'road-anchor-unreadable';
        const root = await fixture(taskId);
        await declareFalsifier(root, taskId, 'export const thing = 1;');
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'evidence.json'), '{ not json', 'utf8');

        const sealed = await seal(root, taskId);
        expect(sealed.success).toBe(false);
        const commands = printedCommands(String(sealed.error));
        expect(commands.length, 'this refusal must name a road as well').toBeGreaterThan(0);
        for (const command of commands) {
            expect(command).not.toMatch(/--change </);
            expect(await drivePrinted(root, taskId, command), `printed road: ${command}`).not.toMatch(USAGE_REFUSAL);
        }
    });

    it('the detector recognises a usage refusal, so a green case means something', async () => {
        // **The guard's own reddening case.** Without this, "no usage refusal came back" could mean the pattern never matches
        // anything — which is how a renamed flag survived the earlier version of this rule in the sibling selector.
        const taskId = 'road-detector';
        const root = await fixture(taskId);
        const reply = await ledgerReply(root, taskId, ['evidence', 'list', '--klasses', 'x']);
        expect(reply).toMatch(USAGE_REFUSAL);
    });
});
