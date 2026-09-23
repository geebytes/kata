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

export type RepairAuthorRecord = {
    findingId: string;
    /** The session that ran the repair, as the platform reported it. */
    session: string;
    /** What the repair author was handed — the finding, its falsifier, and where it may write. */
    handed: string;
    /** What the author returned: the changes, the falsifier it ran, or why none exists. */
    report: string;
    recordedAt: string;
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
    repair: Omit<RepairAuthorRecord, 'recordedAt' | 'ceiling'> & { recordedAt?: string },
): Promise<RepairAuthorRecord> {
    const { mutateTaskArtefact } = await import('../core/state.js');
    const entry: RepairAuthorRecord = {
        ...repair,
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
