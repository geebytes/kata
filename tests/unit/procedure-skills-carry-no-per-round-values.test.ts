import { describe, expect, it } from 'vitest';
import { skillCommands } from '../../src/adapters/manifest.js';

/**
 * **A skill is an instruction, never a fact about the host, and never a per-round value.**
 *
 * This file was written for two procedure skills — `kata-review-round` and `kata-host-adapter` — which carried the reviewer's
 * and the operator's halves of the round-shaped route. Both are deleted with that route: the ledger has no round, no wire
 * format and no executor contract, so the skills' own command line (`kata-cli adversarial execute`) no longer exists.
 *
 * The rule they existed to enforce is the repository's, not theirs, and it survives their deletion — which is why the rule is
 * asserted here against whatever the manifest declares rather than deleted with them. A skill may carry an instruction; a value
 * the brief or the policy owns may appear in **one** place, and a second channel for it is how a missing requirement came to be
 * carried by a hand-written dispatch prompt for twenty-eight of sixty-two rounds.
 */
const BRIEF_PRESCRIBED_KEYS = [
    'readTests', 'wroteTests', 'classInstances', 'targets', 'hypotheses', 'briefSha256', 'revisionId',
] as const;

describe('a skill carries instructions, not values the brief or the policy owns', () => {
    it('names no key the brief prescribes, in any skill the manifest declares', () => {
        for (const command of skillCommands) {
            const body = (command as { body?: string }).body ?? command.outputGoals.join('\n');
            for (const key of BRIEF_PRESCRIBED_KEYS) {
                expect(
                    body.includes(key),
                    `${command.id} names the brief-prescribed key ${key}, so a second channel now carries the same rule`,
                ).toBe(false);
            }
        }
    });

    it('declares no skill whose command line does not exist', async () => {
        // The measurement that deleted the two procedure skills: every line of their `cli` field named `kata-cli adversarial
        // execute`, which exits 1 with "unknown command". A skill is installed into a platform's own directory, so a stale
        // command line is not a comment — it is what an operator will run.
        // The set is read from the dispatcher the same way the CLI reads it: the words `src/cli.ts` switches on. A
        // hand-written list would go stale exactly as the two deleted skills' command lines did.
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dispatcher = readFileSync(join(process.cwd(), 'src/cli.ts'), 'utf8');
        // Two sources, because the CLI splits its vocabulary in two: the workflow commands answer to `isWorkflowCommand`,
        // and the rest are matched with `command === '<name>'` in the dispatcher. Reading only one of them would have
        // failed the lifecycle skills, which is how this case found its own first version.
        const { isWorkflowCommand } = await import('../../src/cli/workflow.js');
        const known = new Set([...dispatcher.matchAll(/command === '([a-z-]+)'/g)].map((match) => `kata-cli ${match[1]}`));
        for (const name of ['open', 'design', 'build', 'review', 'judge', 'verify', 'archive', 'hotfix', 'tweak', 'collect', 'next', 'status', 'ledger', 'wiki', 'gate', 'hooks', 'relations', 'tasks', 'orient', 'recover', 'doctor', 'revision', 'worktree', 'eval', 'baseline', 'codegraph', 'comet']) {
            if (isWorkflowCommand(name) || known.has(`kata-cli ${name}`)) known.add(`kata-cli ${name}`);
        }
        for (const command of skillCommands) {
            const cli = (command as { cli?: string }).cli;
            if (!cli) continue;
            // Only the first three words: `kata-cli wiki task` names the command and its subcommand, and the
            // subcommand's existence is the wiki dispatcher's business rather than this case's.
            const head = cli.split(/\s+/).slice(0, 2).join(' ');
            expect(known.has(head), `${command.id} declares "${head}", which is not a command kata dispatches`).toBe(true);
        }
    });

    it('still declares the lifecycle skills, so this file cannot pass vacuously', () => {
        const ids = skillCommands.map((command) => command.id);
        expect(ids.length).toBeGreaterThan(8);
        expect(ids).toContain('kata-review');
        expect(ids).not.toContain('kata-review-round');
    });
});
