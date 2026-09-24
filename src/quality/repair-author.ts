/**
 * Who made a repair, and what they were handed — the provenance a repair carries.
 *
 * `repair-by-another-author` AC-1, and its honest scope matters more than its mechanism. Checked while designing this change: a
 * handoff records `platform` (which is `"pi"` for every session on this machine) and a `role`, and nothing in `src/` records a
 * session identity at all — deliberately, because kata does not configure, route or record host models. **So there is no
 * recorded identity to compare a repair against, and "refuse a self-repair" has nothing to compare.**
 *
 * What is left is what can be recorded and read: **which session ran the repair, and what it was handed.** The ceiling is
 * stated in the record rather than hidden — on a single-user machine this is not cryptographic separation, exactly as recorded
 * for the execution receipt — and what it makes impossible is the shape this change exists to remove: **a repair whose record
 * cannot say who made it.**
 */
import { join } from 'node:path';
import { kataDir } from '../core/layout.js';
import { readValidatedOptional } from '../core/schema.js';
import { hasFalsifierDisposition, hasReddening, readFalsifierAbsences, readFalsifierReddenings } from './falsifier-reddenings.js';

export type RepairAuthorRecord = {
    findingId: string;
    /** The session that ran the repair, as the platform reported it. */
    session: string;
    /** What the repair author was handed — the finding, its falsifier, and where it may write. */
    handed: string;
    /** What the author returned: the changes, the falsifier it ran, or why none exists. */
    report: string;
    recordedAt: string;
    /**
     * **The disposition this repair consumed** — a reddening this finding has, or a recorded absence carrying a reason.
     *
     * AC-2 says the repair author's disposition *follows the rule the falsification mechanism established and consumes it rather
     * than restating it*, and until now nothing joined a repair to a disposition at all: `repair-author.ts` did not import the
     * ledger, the entry had no field for it, and no code compared the two by `findingId`. So the criterion's claim was about a
     * link that did not exist — `rba4-f2` measured it, and calls this the change's headline claim being asserted by no criterion.
     *
     * Recorded as the *shape* of what closed it rather than as a copy of the rule: a repair whose disposition is missing is
     * refused at the write, so a provenance record can never describe a repair that was not shown to work.
     */
    disposition: 'reddening' | 'absence';
    /** Stated, not hidden: this is provenance, not proof of independence. */
    ceiling: string;
};

export type RepairAuthorLedger = {
    repairs: RepairAuthorRecord[];
    updatedAt: string;
};

const CEILING = 'Provenance, not proof: two sessions on one machine are not cryptographically separated. What this record '
    + 'establishes is which session made the repair and what it was handed, which is what a record that cannot say who made a '
    + 'repair lacks.';

export function repairAuthorsPath(root: string, taskId: string): string {
    return join(kataDir(root), 'tasks', taskId, 'repair-authors.json');
}

export async function readRepairAuthors(root: string, taskId: string): Promise<RepairAuthorRecord[]> {
    const record = await readValidatedOptional<RepairAuthorLedger>('repair-authors', repairAuthorsPath(root, taskId));
    return record?.repairs ?? [];
}

export async function recordRepairAuthor(
    root: string,
    taskId: string,
    repair: Omit<RepairAuthorRecord, 'recordedAt' | 'ceiling' | 'disposition'> & { recordedAt?: string },
): Promise<RepairAuthorRecord> {
    const { mutateTaskArtefact } = await import('../core/state.js');
    // **The rule is consumed, not restated.** The ledger decides whether this repair has a disposition, and the same function
    // the closure criterion asks is the one asked here — a second copy of "the repair is done" is the class this line has spent
    // a change removing. A repair with no disposition is refused rather than recorded: provenance that cannot say the repair was
    // shown to work is provenance for something that may not have happened.
    const [reddenings, absences] = await Promise.all([
        readFalsifierReddenings(root, taskId).catch(() => []),
        readFalsifierAbsences(root, taskId).catch(() => []),
    ]);
    // **Both halves of the binding, and they are the ones the closure rule will use** (rba5-f1): this call passed neither, so
    // the guard's first line returned true and the content binding added by this change never ran on the path the criterion
    // lives on. The current revision and its content are read here for the same reason the resolver reads them.
    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const currentRevision = await readCurrentTaskRevision(root, taskId).catch(() => null);
    const binding = currentRevision
        ? { revisionId: currentRevision.id, pathDigests: currentRevision.pathDigests ?? null }
        : undefined;
    if (!hasFalsifierDisposition(reddenings, absences, repair.findingId, binding)) {
        throw new Error(`repair-author record: '${repair.findingId}' has no recorded disposition — a falsifier shown reddening, or an absence carrying a reason. Record that first (\`kata-cli falsify\`): a repair whose disposition is missing has not been shown to work, and a provenance record for it would say who made a repair nobody can check.`);
    }
    const entry: RepairAuthorRecord = {
        ...repair,
        // **The same decision, not a weaker one** (rba5-f4): this read the mere presence of a reddening entry while the check
        // above consumed the rule, so a reddening the rule does not count (an observation that is not green/red/green) would
        // have been recorded as the shape that closed it.
        disposition: hasReddening(reddenings, repair.findingId, binding) ? 'reddening' : 'absence',
        recordedAt: repair.recordedAt ?? new Date().toISOString(),
        ceiling: CEILING,
    };
    await mutateTaskArtefact(root, taskId, repairAuthorsPath(root, taskId), async () => {
        const record = await readValidatedOptional<RepairAuthorLedger>('repair-authors', repairAuthorsPath(root, taskId));
        // One finding has one repair author: re-recording replaces, so a stale record cannot sit beside a fresh one.
        const repairs = (record?.repairs ?? []).filter((existing) => existing.findingId !== entry.findingId);
        repairs.push(entry);
        return `${JSON.stringify({ repairs, updatedAt: entry.recordedAt }, null, 2)}\n`;
    });
    return entry;
}

/** Whether a repair has a recorded author — the question a reader asks before trusting that it does. */
export function hasRecordedAuthor(repairs: RepairAuthorRecord[], findingId: string): boolean {
    return repairs.some((repair) => repair.findingId === findingId && repair.session.trim().length > 0);
}
