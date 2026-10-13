import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
 *
 * **A missing required flag is a usage refusal too**, and it was missing from this vocabulary until a falsifier's own mutation
 * measured it: a road printed without `--file` came back as "... is required." from the parser, which no pattern here
 * matched, so the guard stayed green with an unrunnable road in the message. A review round then measured the same hole
 * three more times — a nested action that does not exist (`unknown action "..."`), an enum flag given a value outside its
 * vocabulary (`must be one of ...`), and a flag with a shape requirement (`requires a workspace-relative ...`) — so the
 * vocabulary now carries every refusal sentence the family's parser produces.
 *
 * **Boundary: this is a list of the parser's sentences, not a structural property.** The family answers every refusal with
 * the same shape (`{ok:false, command, error}`) and exit code, so nothing in the reply distinguishes "the arguments were
 * wrong" from "the domain said no" — the sentences are the only signal. When the parser grows a refusal sentence, it
 * belongs here; the case below fails if one of the known sentences stops matching, so the vocabulary cannot rot silently.
 */
const USAGE_REFUSAL = /is not a flag the ledger family reads|unknown ledger flag|unknown verb|unknown action|unknown subcommand|unknown scope|requires --reason|is not a known|^usage:|not a function|Cannot read|is required|must be one of|requires a workspace-relative/i;

/**
 * **A refusal that names a flag is a refusal about arguments, and the sentence list is not the instrument.**
 *
 * Three review rounds measured this vocabulary missing parser sentences (`is required`, then `unknown action` / `must be one
 * of` / `requires a workspace-relative`, then nine more: `--id and --statement are both required`, `a waiver needs --reason`,
 * `--boundary must state the domain this claim closes over`, `no paths to freeze: ... pass --paths`, …). A hand list of
 * sentences cannot be complete, and it rots: the parser's next refusal sentence passes the guard while its road may be
 * unrunnable. The parser's refusals that are *about the arguments* all name a flag; the ones about the domain do not (they
 * name the state: "the subject is not frozen", "the ledger holds no evidence item E1"). So the signal is the flag, and the
 * case below derives its completeness from the family's own source instead of from this list.
 */
function namesAFlag(text: string): boolean {
    return /--[a-z][a-z-]*/u.test(text);
}

/**
 * The classifier the guard and the completeness case share. Both halves are load-bearing: the sentence list covers the
 * parser's phrasings that name no flag (`unknown verb`, `not a function`), and the flag rule covers the sentences a list kept
 * missing. Narrowing this back to the list alone fails the completeness case below, which is why the case exists.
 */
function isArgumentRefusal(text: string): boolean {
    return USAGE_REFUSAL.test(text) || namesAFlag(text);
}

/** The family the entry point dispatches a printed road to, so an unrunnable road is run rather than described. */
async function drivePrintedAny(root: string, changeId: string, command: string): Promise<string> {
    const argv = argvOf(command);
    if (argv[0] === 'ledger') return ledgerReply(root, changeId, argv.slice(1));
    if (argv[0] === 'scope') return scopeReply(root, changeId, argv.slice(1));
    throw new Error(`this guard drives the ledger and scope families; it does not know how to run: ${command}`);
}


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

async function declareFalsifier(root: string, taskId: string, find: string, mutationFile = 'src/thing.ts'): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'kata-roads-submission-'));
    roots.push(directory);
    const file = join(directory, 'submission.json');
    await writeFile(file, `${JSON.stringify({
        claims: [],
        evidence: [{ id: 'E1', type: 'executable_falsifier', command: 'npx vitest run tests/unit/example.test.ts', mutation: { file: mutationFile, find, replace: 'export const thing = 42;' } }],
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
async function scopeReply(root: string, changeId: string, argv: string[]): Promise<string> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
        const { runScopeCommand } = await import('../../src/cli/scope.js');
        const withChange = argv.includes('--change') ? argv : [...argv, '--change', changeId];
        await runScopeCommand(withChange, root);
        return chunks.join('');
    } catch (error) {
        return `${chunks.join('')}\n${(error as Error).message}`;
    } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
    }
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
            const reply = await drivePrintedAny(root, taskId, command);
            expect(reply, `the printed road must be a command the CLI accepts: ${command} -> ${reply}`).not.toMatch(USAGE_REFUSAL);
            expect(isArgumentRefusal(reply), `the printed road must not come back as a refusal about the arguments: ${command} -> ${reply}`).toBe(false);
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
            expect(await drivePrintedAny(root, taskId, command), `printed road: ${command}`).not.toMatch(USAGE_REFUSAL);
        }
    });


    it.each([
        { taskId: 'road-anchor-ambiguous', mutationFile: 'src/thing.ts', find: '= 1;', fileText: 'export const one = 1;\nexport const two = 1;\n' },
        { taskId: 'road-anchor-missing-file', mutationFile: 'src/gone.ts', find: 'export const gone = 1;', fileText: null },
    ])('the $taskId refusal names a road the CLI accepts', async ({ taskId, mutationFile, find, fileText }) => {
        const root = await fixture(taskId);
        if (fileText !== null) await writeFile(join(root, mutationFile), fileText, 'utf8');
        await declareFalsifier(root, taskId, find, mutationFile);
        const sealed = await seal(root, taskId);
        expect(sealed.success).toBe(false);
        const commands = printedCommands(String(sealed.error));
        expect(commands.length, 'the anchor refusal must name a road').toBeGreaterThan(0);
        for (const command of commands) {
            expect(command).not.toMatch(/--change </);
            expect(await drivePrintedAny(root, taskId, command), `printed road: ${command}`).not.toMatch(USAGE_REFUSAL);
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

    it('the vocabulary covers every refusal sentence the family\'s parser produces', async () => {
        // **The guard's own vocabulary, checked rather than assumed.** A review round measured three parser sentences missing
        // from it (a nested action that does not exist, an enum flag outside its vocabulary, and a flag with a shape
        // requirement), each of which let an unrunnable road pass. These are the parser's own sentences, taken from
        // `src/cli/ledger.ts`; the case fails if one stops matching, so the vocabulary cannot rot while the guard stays green.
        const parserSentences = [
            '--klasses is not a flag the ledger family reads, so it would have been silently discarded and the command would have run without it.',
            'unknown action "lst"',
            '--risk-class must be one of failure_mode, boundary, state_transition, privilege',
            '--out requires a workspace-relative file path, because the record it writes has to be inside the repository',
            '--file <set.json> (the wide form) or --file <item.json> with --id <evidence-id> (the narrow form) is required.',
            '--reason <why> is required: the one operation that may rewrite evidence must say why.',
        ];
        for (const sentence of parserSentences) {
            expect(sentence, `this parser refusal must be recognised as a usage refusal: ${sentence}`).toMatch(USAGE_REFUSAL);
        }
    });

    it('covers every argument refusal the family\'s own source produces, so the list cannot rot', async () => {
        // **Completeness derived from the source, not asserted by hand.** The parser refuses in two kinds of sentence: the ones
        // about the arguments (they name a flag) and the ones about the domain (they name the state). This reads the family's
        // own `fail({ ... error: ... })` sentences and requires the guard's predicate to recognise every flag-naming one, so a
        // new argument refusal in `src/cli/ledger.ts` fails here until the vocabulary covers it — which is what three review
        // rounds had to find by hand instead.
        const source = await readFile(join(process.cwd(), 'src', 'cli', 'ledger.ts'), 'utf8');
        const sentences: string[] = [];
        for (const match of source.matchAll(/fail\(\{([\s\S]{0,400}?)\}\)/gu)) {
            const body = match[1];
            const error = /error:\s*(?:'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/u.exec(body);
            if (!error) continue;
            const text = (error[1] ?? error[2] ?? '').replace(/\$\{[^}]*\}/gu, 'X').replace(/\\`/gu, '`');
            if (text) sentences.push(text);
        }
        expect(sentences.length, 'the scan must find the parser\'s refusals, or it proves nothing').toBeGreaterThan(20);
        const flagRefusals = sentences.filter((text) => namesAFlag(text));
        expect(flagRefusals.length, 'the parser refuses about arguments in many places').toBeGreaterThan(5);
        for (const text of flagRefusals) {
            expect(isArgumentRefusal(text), `the guard's classifier must accept this parser refusal, or a road that meets it passes: ${text}`).toBe(true);
        }
        // And the sentences the earlier rounds each found missing are checked by name, because they are the ones that were
        // wrong while the guard was green.
        for (const known of [
            '--id and --statement are both required',
            '--statement, --risk-class and --severity are all required',
            'a waiver needs --reason',
            '--boundary must state the domain this claim closes over',
        ]) {
            expect(sentences.join('\n'), `the parser still refuses in this sentence: ${known}`).toContain(known);
            expect(isArgumentRefusal(known), `and the guard recognises it as an argument refusal: ${known}`).toBe(true);
        }
    });

    it('the seal\'s undeclared-changes refusal prints a road the family accepts, with every flag it needs', async () => {
        // **A review round measured this road unrunnable**: it printed `kata-cli scope change --change <id> --add <path>` while
        // `scope change` requires `--reason`, and the guard never reached the block (it drove the ledger family only and threw
        // for anything else). The fixture leaves one undeclared file in the tree so the refusal really fires.
        const taskId = 'road-undeclared-change';
        const root = await fixture(taskId);
        await writeFile(join(root, 'src', 'extra.ts'), 'export const extra = 1;\n', 'utf8');

        const sealed = await seal(root, taskId);
        expect(sealed.success, 'an undeclared file must be refused').toBe(false);
        const message = String(sealed.error);
        expect(message, 'the refusal is the one under test').toMatch(/undeclared|does not cover/i);
        const commands = printedCommands(message);
        expect(commands.length, 'this refusal must name a road').toBeGreaterThan(0);
        const scopeRoad = commands.find((command) => command.startsWith('kata-cli scope change'));
        expect(scopeRoad, 'and the road is the one that declares the file').toBeDefined();
        expect(scopeRoad, 'with the reason the command requires, or the road cannot be walked').toMatch(/--reason/);
        // `<path>` is the operator's input here, like `<item.json>` in the anchor road — the files are named in the message
        // above it — so it is not a placeholder defect. What must be in hand is the change id and every flag the family needs.
        // The road runs: the flags it prints are the flags the family accepts.
        const answer = await drivePrintedAny(root, taskId, scopeRoad!.replace('<path>', 'src/extra.ts'));
        expect(isArgumentRefusal(answer), `the printed road must not be refused for its arguments: ${scopeRoad} -> ${answer}`).toBe(false);
    });
});
