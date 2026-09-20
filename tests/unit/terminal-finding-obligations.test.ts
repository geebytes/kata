import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { recordFinding } from '../../src/quality/reviewer.js';
import { readObligations } from '../../src/quality/repair-obligations.js';
import { isTerminalSeverity } from '../../src/quality/finding-lifecycle.js';

/**
 * The severities that gate a node are the severities that create an obligation.
 *
 * `isTerminalSeverity` says `blocking` and `major`. The adversarial gate refuses on both, the navigation ladder counts
 * both, and the repair batch opens on both — but the obligation producer skipped everything that was not the literal
 * string `'blocking'`, so a `major` finding gated the node and could never be closed. Observed on a real task: three
 * findings repaired and re-sealed, batch still `closed: false, answered: 0`.
 */
describe('terminal findings and their obligations', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function taskRoot(id: string): Promise<string> {
        // Each case gets its own root *and* its own task id: the obligations file is per task, and reusing an id would
        // carry one case's obligations into the next. (That mistake is what made this test report three obligations.)
        const root = await mkdtemp(join(tmpdir(), 'kata-obligation-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id, title: 'Terminal findings', acceptance: [{ id: 'AC-1', statement: 'A finding is accounted for.' }] });
        return root;
    }

    it('creates an obligation for every terminal severity', async () => {
        const root = await taskRoot('terminal-task-1');
        await recordFinding({ root, taskId: 'terminal-task-1', severity: 'blocking', message: 'a blocking finding' });
        await recordFinding({ root, taskId: 'terminal-task-1', severity: 'major', message: 'a major finding' });

        const obligations = await readObligations(root, 'terminal-task-1');

        expect(obligations.map((obligation) => obligation.severity).sort()).toEqual(['blocking', 'major']);
        // The messages are the findings', so an obligation can be matched back to what raised it.
        expect(obligations.map((obligation) => obligation.message).sort()).toEqual(['a blocking finding', 'a major finding']);
    });

    it('creates none for a severity that does not gate', async () => {
        const root = await taskRoot('minor-task');
        await recordFinding({ root, taskId: 'minor-task', severity: 'minor', message: 'a minor finding' });
        await recordFinding({ root, taskId: 'minor-task', severity: 'note', message: 'a note' });

        // A non-terminal finding has no repair to be obligated to: recording one would inflate what a repair owes.
        await expect(readObligations(root, 'minor-task')).resolves.toEqual([]);
    });

    it('keeps the rule and the producer in agreement, whichever severities the rule names', async () => {
        // The assertion is against `isTerminalSeverity`, not a hardcoded pair: a future severity must join all the gates
        // and the producer at once, which is the whole point of the rule living in one place.
        const root = await taskRoot('rule-task');
        const severities = ['blocking', 'major', 'minor', 'note'] as const;
        for (const severity of severities) {
            await recordFinding({ root, taskId: 'rule-task', severity, message: `${severity} finding` });
        }

        const obligations = await readObligations(root, 'rule-task');
        // One obligation per **finding** of a terminal severity, which is why the expectation is built by filtering the
        // recorded severities rather than by counting the classes: recording two blocking findings owes two repairs.
        const terminalFindings = severities.filter((severity) => isTerminalSeverity(severity));
        expect(obligations).toHaveLength(terminalFindings.length);
        expect(new Set(obligations.map((obligation) => obligation.severity))).toEqual(new Set(terminalFindings));
        for (const obligation of obligations) expect(isTerminalSeverity(obligation.severity)).toBe(true);
    });
});
