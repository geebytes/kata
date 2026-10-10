import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { runScopeCommand } from '../../src/cli/scope.js';
import { createTask } from '../../src/core/task.js';
import { unbackedDefectClasses, type DeclaredDefectClass } from '../../src/quality/defect-classes.js';

/**
 * **A remedy is a command, and the only honest test of a command is to run it.**
 *
 * Two rounds fixed this rule as text: round 7 removed `--change <id>` for a change already in hand, round 8 added the
 * `--reason` the CLI requires. Each round's guard was a *pattern* over the sentence, and an independent round then defeated
 * it three ways — rename a flag or the verb, keep the good command and append a broken second one, embed a placeholder the
 * regexes miss. Pattern-checking a command asks whether it looks runnable; running it decides that it is.
 *
 * So this case takes the remedies the defect-class rule actually emits, and hands each command to the entry point the CLI
 * uses, in a fixture. A domain refusal is expected and is not the subject (the path really is missing, the class really is
 * damaged); what must never come back is a usage refusal — a flag the verb does not know, a verb that does not exist, or a
 * required flag that is missing.
 */
// **The CLI's own words, taken from the parser rather than guessed.** The first version of this pattern looked for
// "unknown ledger flag" and the parser says "--klasses is not a flag the ledger family reads", so a renamed flag sailed
// through the guard that exists to catch it. Both spellings are matched, and the case that proves the pattern reddens is
// MR9-A in the commit message.
const USAGE_REFUSAL = /is not a flag the ledger family reads|unknown ledger flag|unknown verb|requires --reason|is not a known|^usage:|unknown scope|unknown subcommand|not a function|Cannot read/i;

describe('every refusal names a command the CLI accepts', () => {
    const roots: string[] = [];
    const changeId = 'a-remedy-that-runs';
    let root = '';

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
    });

    async function prepare(): Promise<void> {
        root = await mkdtemp(join(tmpdir(), 'kata-remedy-'));
        roots.push(root);
        await mkdir(join(root, 'src'), { recursive: true });
        await mkdir(join(root, 'tmp'), { recursive: true });
        await mkdir(join(root, 'dist'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
        await writeFile(join(root, 'tmp', 'gen.ts'), 'export const generated = true;\n');
        await writeFile(join(root, 'dist', 'inst.ts'), 'export const instrument = true;\n');
        await writeFile(join(root, 'outside.ts'), 'export const outside = true;\n');
        await symlink(join(root, 'outside.ts'), join(root, 'tmp', 'link-outside.ts'));
        await createTask({ root, id: changeId, title: 'A remedy that runs', acceptance: [{ id: 'AC-1', statement: 'the remedy runs' }] });
        const taskPath = join(root, '.kata', 'tasks', changeId, 'task.json');
        const stored = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
        await writeFile(taskPath, `${JSON.stringify({ ...stored, ownedPaths: ['src/a.ts', 'tmp/gen.ts', 'dist'] }, null, 2)}\n`);
    }

    /** The shape the CLI uses: call the dispatcher, capture the envelope it prints, report a parse refusal as an error. */
    async function run(argv: string[]): Promise<Record<string, unknown>> {
        const chunks: string[] = [];
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            chunks.push(String(chunk));
            return true;
        });
        const previousExitCode = process.exitCode;
        let thrown: unknown;
        try {
            if (argv[0] === 'ledger') await runLedgerCommand(argv.slice(1), { root, changeId });
            else if (argv[0] === 'scope') await runScopeCommand([...argv.slice(1), '--root', root], root);
            else thrown = new Error(`unknown subcommand '${argv[0]}'`);
        } catch (error) {
            thrown = error;
        } finally {
            stdout.mockRestore();
            process.exitCode = previousExitCode;
        }
        const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
        if (line) return JSON.parse(line) as Record<string, unknown>;
        return thrown === undefined ? {} : { error: (thrown as Error).message };
    }

    /** Every `kata-cli …` command a sentence mentions, as the argv the CLI would receive. */
    function commandsIn(text: string): string[][] {
        // A placeholder is only acceptable where the operator must supply the value; the tool's own values are interpolated.
        return [...text.matchAll(/`(kata-cli [^`]+)`/g)].map((match) =>
            match[1]
                .replace(/^kata-cli\s+/, '')
                .split(/\s+/)
                .map((token) => token.replace(/^['"]|['"]$/g, '')),
        );
    }

    it('emits only commands whose verbs and flags the CLI accepts', async () => {
        await prepare();
        const classes: DeclaredDefectClass[] = [
            // no generator named at all
            { class: 'instrument-unsound', oracle: 'mechanizable' },
            // names a file that does not resolve
            { class: 'comparison-unnamed', oracle: 'mechanizable', generator: 'tmp/does-not-exist.ts', relation: 'reddens' },
            // names a directory
            { class: 'corrupt-read-as-absent', oracle: 'mechanizable', generator: 'src', relation: 'two agree' },
            // names a link whose target is outside the workspace
            { class: 'refusal-cannot-be-executed', oracle: 'mechanizable', generator: 'tmp/link-outside.ts', relation: 'reddens' },
            // names a file inside a declaration the change cannot carry
            { class: 'one-fact-derived-twice', oracle: 'mechanizable', generator: 'dist/inst.ts', relation: 'two agree' },
        ];
        const unbacked = await unbackedDefectClasses(classes, root, ['src/a.ts', 'tmp/gen.ts', 'dist'], changeId);
        expect(unbacked.length, JSON.stringify(unbacked)).toBeGreaterThanOrEqual(4);

        const executed: string[] = [];
        for (const entry of unbacked) {
            // **Running the command is not enough on its own**: a placeholder in a value the tool holds still *runs* (the
            // CLI treats `<id>` as an id and fails for a domain reason), so the textual half of the rule is asserted here
            // too, where it cannot be separated from the executable half (MR9-E).
            expect(entry.remedy, entry.remedy).not.toMatch(/--change\s*</);
            expect(entry.remedy, entry.remedy).not.toMatch(/--add\s*</);
            expect(entry.remedy, entry.remedy).toContain('--change ' + changeId);
            const commands = commandsIn(entry.remedy);
            // Every remedy names at least one command, or it is not a remedy an operator can act on.
            expect(commands.length, entry.remedy).toBeGreaterThan(0);
            for (const argv of commands) {
                executed.push(argv.join(' '));
                const envelope = await run(argv);
                const error = typeof envelope.error === 'string' ? envelope.error : '';
                // A domain refusal is fine. A usage refusal means the sentence tells the operator to run something the CLI
                // does not know how to run — which is the whole of this case.
                expect(USAGE_REFUSAL.test(error), `${argv.join(' ')} → ${error}`).toBe(false);
            }
        }
        // Executed, not merely counted: an empty loop would pass every assertion above.
        expect(executed.length, 'no command was run, so nothing was established').toBeGreaterThanOrEqual(4);
    });
});
