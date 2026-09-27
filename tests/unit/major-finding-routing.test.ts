import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { openLedgerProblems, readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { appendClaim, readLedger } from '../../src/store/ledger.js';
import { seedLedger } from '../helpers/ledger.js';
import { decide } from '../../src/kernel/decide.js';

/**
 * **The severity gate, where it now lives — and what changed with the route.**
 *
 * This file was created because one rule ("blocking, and major in strict") was stated in three places and the three
 * disagreed: the ladder gated the major-to-repair branch on `reviewMode === 'strict'`, and the approval guard refused a
 * major finding unconditionally, so in `std` a task with one major finding could be neither approved nor routed to the
 * repair that would clear it.
 *
 * The disagreements are gone, and not because the three were synchronised: there is one rule now, in the tier policy,
 * applied by `decide` — a claim's severity decides the evidence **strength** it requires (`MIN_STRENGTH_BY_SEVERITY`,
 * `policy.evidenceStrength`, and reproducibility for `blocking`), and every claim the tier requires must be supported.
 *
 * **That is a change in the gate's definition, and it is recorded here rather than left to be discovered.** The old bar let
 * a `minor` finding pass review unrepaired by severity alone. On this route a claim that nothing supports is a deficit
 * whatever its severity — so the way to live with one is a recorded decision, `kata-cli ledger claim waive <id> --reason`,
 * which the archive gate then requires be carried somewhere. The capability is preserved and made explicit: a decision with
 * a reason, in the store the gate reads, instead of a threshold that let a problem through unnamed.
 */
describe('the severity gate is one rule, applied by the kernel', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function taskWith(severity: 'blocking' | 'major' | 'minor'): Promise<{ root: string; taskId: string }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-routing-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'routing-task',
            title: 'Routing',
            acceptance: [{ id: 'AC-1', statement: 'A claim at this severity is answered or waived.' }],
        });
        await writeFile(join(root, '.kata/tasks/routing-task/current-state.json'), `${JSON.stringify({ taskId: 'routing-task', phase: 'review', updatedAt: new Date().toISOString() }, null, 2)}\n`);
        await seedLedger(root, 'routing-task', { paths: ['.kata/tasks/routing-task/task.json'] });
        await appendClaim(root, 'routing-task', {
            id: `C-${severity}`,
            statement: `a ${severity} claim that nothing supports`,
            riskClass: 'boundary',
            severity,
            dependsOn: ['path:.kata/tasks/routing-task/task.json'],
            evidenceIds: [],
            challengeIds: [],
            status: 'open',
            at: new Date().toISOString(),
            reopens: 0,
        });
        return { root, taskId: 'routing-task' };
    }

    it('reports an unsupported claim at every severity, and routes it to the ledger repair', async () => {
        for (const severity of ['blocking', 'major', 'minor'] as const) {
            const { root, taskId } = await taskWith(severity);
            const problems = await openLedgerProblems(root, taskId);
            expect(problems.map((problem) => problem.id), `${severity} is a problem whatever its severity`).toEqual([`C-${severity}`]);

            const upstream = await readUpstreamSummary(root, taskId);
            const action = suggestCandidateAction('review', upstream);
            expect(action.nextSkill, `${severity}`).toBe('/kata-build');
            expect(action.reason, `${severity}`).toBe('satisfy_ledger_deficits');
        }
    });

    it('lets the author live with one, as a decision with a reason, and stops reporting it', async () => {
        const { root, taskId } = await taskWith('minor');
        const before = await openLedgerProblems(root, taskId);
        expect(before).toHaveLength(1);

        const claim = (await readLedger(root, taskId)).claims.find((item) => item.id === 'C-minor')!;
        await appendClaim(root, taskId, {
            ...claim,
            status: 'waived',
            waiver: { reason: 'below the bar for this change; tracked outside it', at: new Date().toISOString() },
        });

        expect(await openLedgerProblems(root, taskId), 'a waiver is a decision, so the problem is no longer open').toEqual([]);
        // And the kernel agrees: the waiver is what decides, not a severity threshold.
        const ledger = await readLedger(root, taskId);
        const decision = decide({
            subject: ledger.subject!,
            claims: ledger.claims,
            evidence: ledger.evidence,
            verdicts: ledger.verdicts,
            challenges: ledger.challenges,
            policy: ledger.policy,
            tier: 'strict',
            declaredRiskClasses: [],
            assurance: 'observed',
            usage: { toolCalls: 0, wallMs: 0, tokens: 0 },
            discovery: { independentChallenges: 0 },
        });
        expect(decision.verdict, 'the waived claim no longer decides against the change').not.toBe('fail');
    });
});
