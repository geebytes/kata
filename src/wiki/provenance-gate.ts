import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { judgePath } from '../core/layout.js';
import { readValidatedOptional } from '../core/schema.js';
import { readCurrentTaskRevision } from '../workflow/revision.js';
import { computeFileHash } from './record.js';
import type { WikiRecord } from './record.js';

/**
 * Whether a candidate's provenance actually holds up, checked when it would become authoritative.
 *
 * L4-06: promotion trusted its inputs. `promote()` checked only `status === 'candidate'` and flipped the record to
 * `verified`, so the trust ladder (`model_proposed` → `evidence_verified`) could be climbed by anything that could write
 * a candidate — including the Wiki's own ingestion, which mints candidates with `validationTaskId: 'llmwiki-ingest'`,
 * not a task at all, and with hashes it generated itself. A "verified" record is what `selectAuthoritativeContext`
 * serves to later tasks, so the check has to happen here, at the transition, against facts kata can verify.
 *
 * Three questions, each answerable from the repository rather than from the record's own claims:
 *   1. did the task the record names actually pass Judge? (ingestion ids are not tasks and fail this);
 *   2. do the record's source hashes still describe the sources? (a record whose sources moved on is not verified — it
 *      is stale, and `drift.ts` is where that is discovered, but promotion must not manufacture a verified record from
 *      changed sources in the first place);
 *   3. does the record name at least one piece of evidence? (an authoritative claim with nothing behind it).
 */
export interface ProvenanceFailure {
    reason: 'unknown_validation_task' | 'validation_task_not_passed' | 'source_hash_mismatch' | 'source_missing' | 'no_evidence';
    detail?: string;
}

export interface ProvenanceCheck {
    ok: boolean;
    failures: ProvenanceFailure[];
}

/** The Judge verdict a validation task left, or `null` when it left none. */
async function judgePassedFor(root: string, taskId: string): Promise<boolean | null> {
    const judge = await readValidatedOptional<{ result?: string }>('judge-result', judgePath(root, taskId)).catch(() => null);
    if (!judge) return null;
    return judge.result === 'PASS';
}

/** Whether a task directory exists at all: `llmwiki-ingest` names none. */
async function taskExists(root: string, taskId: string): Promise<boolean> {
    try {
        await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8');
        return true;
    } catch {
        return false;
    }
}

export async function checkPromotionProvenance(root: string, record: WikiRecord): Promise<ProvenanceCheck> {
    const failures: ProvenanceFailure[] = [];

    if (record.evidenceIds.length === 0) {
        failures.push({ reason: 'no_evidence' });
    }

    if (!(await taskExists(root, record.validationTaskId))) {
        failures.push({
            reason: 'unknown_validation_task',
            detail: `'${record.validationTaskId}' is not a kata task; only a task's candidate can be promoted`,
        });
    } else {
        const passed = await judgePassedFor(root, record.validationTaskId);
        if (passed !== true) {
            failures.push({
                reason: 'validation_task_not_passed',
                detail: `task '${record.validationTaskId}' has ${passed === null ? 'no Judge result' : 'not passed Judge'}`,
            });
        }
    }

    for (const [sourcePath, expectedHash] of Object.entries(record.sourceHashes)) {
        try {
            const content = await readFile(join(root, sourcePath), 'utf8');
            if (computeFileHash(content) !== expectedHash) {
                failures.push({ reason: 'source_hash_mismatch', detail: sourcePath });
            }
        } catch {
            failures.push({ reason: 'source_missing', detail: sourcePath });
        }
    }

    return { ok: failures.length === 0, failures };
}

/** The message a refusal prints: what failed, and what to do about it. */
export function provenanceRefusal(record: WikiRecord, check: ProvenanceCheck): string {
    const details = check.failures.map((failure) => `${failure.reason}${failure.detail ? ` (${failure.detail})` : ''}`).join('; ');
    const remedy = check.failures.some((failure) => failure.reason === 'source_hash_mismatch' || failure.reason === 'source_missing')
        ? ` Re-hash the record against its sources (\`kata-cli wiki revalidate --record ${record.id}\`), then promote.`
        : ' Record the candidate from a task that passed Judge, with its evidence.';
    return `Cannot promote record '${record.id}': its provenance does not hold — ${details}.${remedy}`;
}

/** The sealed revision the record's validation task is bound to, for the audit trail. */
export async function validationRevisionId(root: string, taskId: string): Promise<string | null> {
    const revision = await readCurrentTaskRevision(root, taskId).catch(() => null);
    return revision?.id ?? null;
}
