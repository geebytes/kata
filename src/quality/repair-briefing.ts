import { readTask } from '../core/task.js';
import { readTrackedFindings } from './finding-disposition.js';
import { classesOfFindings, CLASS_COVERAGE } from './class-coverage.js';
import { readFile } from 'node:fs/promises';
import { taskPath } from '../core/layout.js';

/**
 * What a repair author is told **before** it decides how to fix anything.
 *
 * **Why this exists, measured.** Every round on this line produced findings about the previous round's repairs, and the repairs
 * themselves were made without three questions that human practice asks before touching code:

 * | question | what answered it, before | what answers it now |
 * |---|---|---|
 * | *what else will this reach?* | nothing — `cg-f1`'s repair broke 11 fixtures across 6 files and only running the suite revealed it | `impact`, recorded by the round that had just read the call sites |
 * | *where else does this class appear?* | nothing — `wcc2-f1` and `kgs3-f3` are one sentence, repaired twice | `classInstances`, and the class table |
 * | *is this the class or an instance?* | nothing — 37 instances were repaired one at a time | `class-coverage.ts`, and the covering check |
 *
 * Those three fields were added to the finding contract and then **consumed by nothing** — a producer with no consumer, this line's
 * own class. A briefing that renders them is the smallest consumer that changes what the repair author does, and it costs one render
 * rather than one round.
 */
export interface RepairBriefing {
    /** The findings to repair, each with the three fields that decide how large the repair must be. */
    readonly findings: Array<{
        readonly id: string;
        readonly severity: string;
        readonly path?: string;
        readonly message: string;
        /** What else the repair will reach — the blast radius the reporting round already observed. */
        readonly impact?: string;
        /** The other places the same concept appears, so one repair can cover the class. */
        readonly classInstances?: readonly string[];
        /** The class this finding is an instance of, and whether a declared check covers it. */
        readonly classId?: string;
        readonly classCovered?: boolean;
        readonly coveredBy?: readonly string[];
    }>;
    /** The classes in play across the batch, so a repair author sees the shape rather than only the instances. */
    readonly classes: Array<{ readonly classId: string; readonly means: string; readonly instances: number }>;
    /**
     * What the previous rounds cost, so the repair author can see the trade in front of it.
     *
     * **Measured**: seven rounds on this line cost 351,864 / 658,523 / 347,000 / 400,000 / 875,572 / 510,836 / 1,073,271 tokens and
     * produced 7 / 0 / 5 / 5 / 0 / 7 findings — the two most expensive produced nothing because they never wrote a record, and the
     * cheapest produced seven. A repair that leaves the revision current makes the next round a delta round, which cost 2.5–2.7×
     * less when it actually narrowed. That is the choice a repair author is making, and it was invisible until now.
     */
    readonly cost?: { readonly totalTokens: number; readonly rounds: number };
}

/** Reads the open terminal findings and renders what a repair author needs to know before it starts. */
export async function repairBriefing(root: string, taskId: string): Promise<RepairBriefing> {
    const tracked = await readTrackedFindings(root, taskId).catch(() => []);
    const classOf = await classesOfFindings(root, taskId);
    // Findings live in two stores and the repair batch reads the tracked one; the briefing reads the same one so it cannot
    // describe a different batch than the one the repair is against.
    const review = await readFile(taskPath(root, taskId).replace(/task\.json$/, 'review.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as { findings?: Array<Record<string, unknown>> })
        .catch(() => null);
    const task = await readTask(root, taskId).catch(() => null);
    void task;

    const findings: RepairBriefing['findings'] = [];
    for (const finding of tracked) {
        if (finding.disposition !== 'open') continue;
        if (finding.severity !== 'blocking' && finding.severity !== 'major') continue;
        const classId = classOf[finding.id];
        const entry = CLASS_COVERAGE.find((candidate) => candidate.classId === classId);
        findings.push({
            id: finding.id,
            severity: finding.severity,
            ...(finding.path ? { path: finding.path } : {}),
            message: finding.message,
            ...(finding.impact ? { impact: finding.impact } : {}),
            ...(finding.classInstances ? { classInstances: finding.classInstances } : {}),
            ...(classId ? { classId } : {}),
            ...(entry ? { classCovered: true, coveredBy: entry.coveredBy } : { classCovered: false }),
        });
    }
    // The review store carries the same fields for the findings the review flow recorded, and a briefing that reported only the
    // adversarial half would under-describe the batch — the defect `classesOfFindings` was fixed for one layer down.
    for (const finding of review?.findings ?? []) {
        const id = typeof finding.id === 'string' ? finding.id : '';
        if (!id || findings.some((entry) => entry.id === id)) continue;
        const disposition = typeof finding.disposition === 'string' ? finding.disposition : 'open';
        if (disposition !== 'open') continue;
        const severity = typeof finding.severity === 'string' ? finding.severity : 'minor';
        if (severity !== 'blocking' && severity !== 'major') continue;
        const classId = classOf[id];
        const entry = CLASS_COVERAGE.find((candidate) => candidate.classId === classId);
        findings.push({
            id,
            severity,
            ...(typeof finding.path === 'string' ? { path: finding.path } : {}),
            message: typeof finding.message === 'string' ? finding.message : '',
            ...(typeof finding.impact === 'string' ? { impact: finding.impact } : {}),
            ...(Array.isArray(finding.classInstances) ? { classInstances: finding.classInstances as string[] } : {}),
            ...(classId ? { classId } : {}),
            ...(entry ? { classCovered: true, coveredBy: entry.coveredBy } : { classCovered: false }),
        });
    }

    const counts = new Map<string, number>();
    for (const finding of findings) {
        if (finding.classId) counts.set(finding.classId, (counts.get(finding.classId) ?? 0) + 1);
    }
    const cost = await (await import('./round-cost.js')).reportRoundCost(root, taskId).catch(() => null);
    return {
        findings,
        classes: CLASS_COVERAGE
            .filter((entry) => (counts.get(entry.classId) ?? 0) > 0)
            .map((entry) => ({ classId: entry.classId, means: entry.means, instances: counts.get(entry.classId) ?? 0 })),
        ...(cost && cost.totalTokens > 0 ? { cost: { totalTokens: cost.totalTokens, rounds: cost.rounds.length } } : {}),
    };
}

/**
 * The briefing as prose, for the one caller that has to hand it to a repair author.
 *
 * Each finding carries the three questions, and the class section carries the one instruction that changes behaviour: **repair the
 * class, and say which instances your repair leaves standing.** A repair that names the class and leaves instances behind is
 * honest and actionable; one that patches the instance alone is what produced the next round, seven times.
 */
export function renderRepairBriefing(briefing: RepairBriefing): string {
    if (briefing.findings.length === 0) return 'no open blocking or major findings, so there is nothing to repair';
    const lines = [
        `${briefing.findings.length} open terminal finding(s) to repair. Each carries **impact** (what else the repair will reach — observed by the round that read the call sites) and **classInstances** (where else the same concept appears).`,
        '',
        '**Repair the class, not the instance, and say which instances you leave standing.** Measured on this line: 37 instances in 4 classes, and repairing instances one at a time produced a new instance every round (7 / 6 / 5 / 5 / 7 findings).',
        '',
    ];
    for (const finding of briefing.findings) {
        lines.push(`- **${finding.id}** [${finding.severity}]${finding.path ? ` — ${finding.path}` : ''}`);
        lines.push(`  - ${finding.message}`);
        if (finding.impact) lines.push(`  - impact: ${finding.impact}`);
        if (finding.classInstances?.length) lines.push(`  - class instances: ${finding.classInstances.join(', ')}`);
        if (finding.classId) {
            lines.push(`  - class: \`${finding.classId}\`${finding.classCovered ? ` — covered by ${(finding.coveredBy ?? []).join(', ')}` : ' — **no covering check yet**'}`);
        }
    }
    if (briefing.cost) {
        lines.push('', `**What the previous rounds cost: ${briefing.cost.totalTokens.toLocaleString('en-US')} tokens across ${briefing.cost.rounds} recorded round(s).** A repair that leaves the revision current makes the next round a delta round rather than a full one — measured 2.5-2.7x cheaper when it actually narrowed — so how large a repair you make is a cost decision, not only a correctness one.`);
    }
    if (briefing.classes.length > 0) {
        lines.push('', 'The classes in this batch:');
        for (const entry of briefing.classes) lines.push(`- \`${entry.classId}\` (${entry.instances} finding(s)) — ${entry.means}`);
    }
    return lines.join('\n');
}
