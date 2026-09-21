import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContent } from '../core/hash.js';
import { changedGitPaths } from '../core/git.js';
import { taskDir } from '../core/layout.js';
import { readValidatedOptional } from '../core/schema.js';

/**
 * The factual half of a change record, derived instead of asserted.
 *
 * The measurement this answers: thirteen passes of one real change produced thirty de-duplicated findings, and twenty of
 * them — seven of the eleven `major` ones — were not about the deliverable but about *the author's prose about their own
 * work*: a ledger row, a count, a pointer, a doc sentence. The mechanism is structural rather than careless. The platform
 * requires a written record and ships nothing that can check one: code has tests, RED/GREEN, mutation evidence and
 * `claims[]`, while "is the ledger row true" had no checker at all — so the cheapest falsifiable surface a reviewer could
 * attack was prose. Repairing one row wrote another sentence, which became the next round's cheapest target; five rounds
 * landed on the same paragraph.
 *
 * The answer is not "write more carefully", which is what the author already tried, three times, converging by hand on
 * "delete the count and point at git". It is to stop asking for what a machine already knows. Every field below has a
 * mechanical source: `git status` for the paths, the evidence envelopes for the checks, the claim evaluation for the
 * claim outcomes, the tracking view for the findings. None of them is an input.
 *
 * What remains for the author is `judgement`: why this fix, what was traded away. That is the part no diff can derive,
 * and it is labelled as prose so a reader knows which half of the record is a claim about intent.
 */
export interface ChangeRecordCheck {
    checkId: string;
    name: string;
    command: string;
    exitCode: number | null;
    passed: boolean;
}

export interface ChangeRecordClaimFailure {
    checkId: string;
    acceptanceId: string;
    claimId: string;
    statement: string;
    expect: { exitCode: number };
    actualExitCode: number | null;
    missing: boolean;
}

export interface ChangeRecordFinding {
    id: string;
    severity: string;
    disposition: string;
}

export interface ChangeRecord {
    version: 1;
    taskId: string;
    revisionId: string;
    /** Every path the working tree reports as changed, sorted. Derived from git, never from the ownership declaration. */
    changedPaths: string[];
    /**
     * The changed paths that no declared owned path covers.
     *
     * This is the field that replaces a `major` finding class with a fact: a round that changed a file outside its
     * declared surface reported it only in prose — when it reported it at all — and every round produced one. Here it is
     * a list, and the difference between "the surface is the declaration" and "the surface is what changed" is visible
     * without anyone counting anything.
     */
    changedOutsideOwnership: string[];
    ownedPaths: string[];
    checks: ChangeRecordCheck[];
    claimFailures: ChangeRecordClaimFailure[];
    openFindings: ChangeRecordFinding[];
    /** Counts, so no reader (or author) has to derive them by hand and get one wrong. */
    counts: { changedPaths: number; checks: number; passing: number; failures: number; openFindings: number };
    /** The author's own words: the judgement and the trade-off. The only field not derived from a mechanical source. */
    judgement?: string;
}

export interface ChangeRecordInput {
    root: string;
    taskId: string;
    revisionId: string;
    ownedPaths: string[];
    evidence: Array<{ id?: string; checkId?: string; name?: string; command?: string; exitCode: number | null; passed?: boolean }>;
    claimFailures: ChangeRecordClaimFailure[];
    findings: ChangeRecordFinding[];
    /** The one thing a machine cannot derive. Prose, and named so. */
    judgement?: string;
}

/**
 * The derivable quantities a record's prose is not allowed to state.
 *
 * §6 of the record-integrity handover requires self-evidence for A: *plant a false derivable fact, and the seal refuses it
 * and names the field.* The refusal is the whole point — a record whose prose re-states a number the machine already
 * computed is the class of defect this change exists to retire (the measured loop spent five rounds on a paragraph of
 * counts and pointers), and a rule that is never shown to fire is a guard that reads as protection without being one.
 *
 * The check is deliberately narrow and mechanical: it looks for a sentence that states one of the quantities this record
 * derives, and it refuses the record rather than editing it. "Derive it or drop the claim" is the only honest remedy —
 * quietly correcting the number would leave the author believing their prose is being read.
 */
export interface JudgementRefusal {
    /** The quantity the sentence states, in the terms the record already uses. */
    quantity: string;
    /** The sentence, quoted back, so the author sees what was refused rather than a rule number. */
    sentence: string;
}

/**
 * The numbers, digits **or words**, because the measured loop wrote both: `r35 "two places"` and `r36 "three places"` were
 * the same defect as a digit would have been, and a check that only read digits would have passed the round that produced
 * it.
 */
const COUNT_WORD = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

const DERIVABLE_QUANTITY_PATTERNS: Array<{ quantity: string; pattern: RegExp }> = [
    // Counts. A number next to one of the words the record already counts.
    { quantity: 'counts.changedPaths', pattern: new RegExp(`\\b${COUNT_WORD}\\s+(?:files?|paths?)\\s+(?:changed|touched|modified)`, 'i') },
    { quantity: 'counts.changedPaths', pattern: new RegExp(`\\b(?:changed|touched|modified)\\s+${COUNT_WORD}\\s+(?:files?|paths?)`, 'i') },
    { quantity: 'counts.checks', pattern: new RegExp(`\\b${COUNT_WORD}\\s+checks?\\b`, 'i') },
    { quantity: 'counts.passing', pattern: new RegExp(`\\b${COUNT_WORD}\\s+(?:passed|passing)\\b`, 'i') },
    { quantity: 'counts.failures', pattern: new RegExp(`\\b${COUNT_WORD}\\s+(?:failed|failing)\\b`, 'i') },
    { quantity: 'counts.openFindings', pattern: new RegExp(`\\b${COUNT_WORD}\\s+(?:open|unfixed|unresolved)\\s+findings?\\b`, 'i') },
    // The exhaustive quantifiers. "all of them", "every file", "the complete list" — a claim about the set the record
    // already enumerates.
    { quantity: 'changedPaths', pattern: /\b(?:all|every|each)\s+(?:of\s+the\s+)?(?:changed\s+)?(?:files?|paths?|checks?)\b/i },
    { quantity: 'changedPaths', pattern: /\b(?:complete|full|exhaustive)\s+(?:list|set|count)\b/i },
];

/**
 * Whether a record's prose states something the record derives.
 *
 * Returns the refusals rather than a boolean so the message can name the quantity *and* quote the sentence: an author told
 * only "prose must not state derived facts" has to guess which sentence, and guessing is what produced three attempts at
 * the same paragraph.
 */
export function refusalForDerivableProse(judgement: string | undefined): JudgementRefusal[] {
    if (!judgement?.trim()) return [];
    const sentences = judgement.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
    const refusals: JudgementRefusal[] = [];
    for (const sentence of sentences) {
        for (const { quantity, pattern } of DERIVABLE_QUANTITY_PATTERNS) {
            if (pattern.test(sentence)) {
                refusals.push({ quantity, sentence });
                break;
            }
        }
    }
    return refusals;
}

/** Whether a declared owned path covers a changed path. Directory prefixes cover what is beneath them. */
function ownedCovers(ownedPaths: string[], path: string): boolean {
    return ownedPaths.some((owned) => {
        const normalized = owned.replaceAll('\\', '/').replace(/\/+$/, '');
        if (normalized === path) return true;
        return normalized.length > 0 && path.startsWith(`${normalized}/`);
    });
}

/**
 * Builds the record from the sources that already hold each fact.
 *
 * Deliberately takes no "changedPaths" argument. A caller that could pass one could pass a wrong one, and the whole point
 * is that the record's factual half has no channel to be asserted through — the same shape `claims[]` uses for the
 * acceptance text, applied to the record.
 */
export async function buildChangeRecord(input: ChangeRecordInput): Promise<ChangeRecord> {
    const changedPaths = [...new Set(changedGitPaths(input.root))].sort();
    const ownedPaths = [...new Set(input.ownedPaths)].sort();
    const changedOutsideOwnership = changedPaths.filter((path) => !ownedCovers(ownedPaths, path));

    const checks: ChangeRecordCheck[] = input.evidence.map((envelope) => ({
        checkId: envelope.checkId ?? envelope.name ?? envelope.command ?? '',
        name: envelope.name ?? envelope.checkId ?? envelope.command ?? '',
        command: envelope.command ?? '',
        exitCode: envelope.exitCode,
        // The same predicate the gates use: an envelope that says `passed` is trusted, and one written before the field
        // existed falls back to its exit code — reading old records the way they were written.
        passed: envelope.passed ?? envelope.exitCode === 0,
    }));

    const openFindings = input.findings
        .filter((finding) => finding.disposition !== 'fixed')
        .map((finding) => ({ id: finding.id, severity: finding.severity, disposition: finding.disposition }))
        .sort((a, b) => a.id.localeCompare(b.id));

    return {
        version: 1,
        taskId: input.taskId,
        revisionId: input.revisionId,
        changedPaths,
        changedOutsideOwnership,
        ownedPaths,
        checks,
        claimFailures: input.claimFailures,
        openFindings,
        counts: {
            changedPaths: changedPaths.length,
            checks: checks.length,
            passing: checks.filter((check) => check.passed).length,
            failures: checks.filter((check) => !check.passed).length,
            openFindings: openFindings.length,
        },
        ...(input.judgement?.trim() ? { judgement: input.judgement } : {}),
    };
}

/** A stable digest of the record, so a statement edit is visible as a change rather than as a re-read. */
export function changeRecordHash(record: ChangeRecord): string {
    return hashContent(JSON.stringify(record));
}

/** Where a task's change record for a revision lives. */
export function changeRecordPath(root: string, taskId: string, revisionId?: string): string {
    return revisionId
        ? join(taskDir(root, taskId), `change-record-${revisionId}.json`)
        : join(taskDir(root, taskId), 'change-record.json');
}

/**
 * Writes the record beside the revision it describes, and as the task's current one.
 *
 * Two files on purpose: the per-revision copy is immutable evidence of what a round did (`change-record-<revision>.json`),
 * and `change-record.json` is what a reader asks for when they want the latest without knowing a revision id. The same
 * rule `evidence` follows — the bound artefact is the one that cannot be amended.
 */
export async function writeChangeRecord(root: string, taskId: string, record: ChangeRecord): Promise<string | { refused: string[] }> {
    // §6 self-evidence for A. The record is refused, not corrected: the author's prose is the only field they wrote, and
    // silently fixing a number in it would leave them believing it is being read.
    const refusals = refusalForDerivableProse(record.judgement);
    if (refusals.length > 0) {
        return {
            refused: refusals.map((refusal) => `the judgement states ${refusal.quantity}, which this record derives: "${refusal.sentence}" — point at the record instead of restating it`),
        };
    }
    const bound = changeRecordPath(root, taskId, record.revisionId);
    await writeFile(bound, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await writeFile(changeRecordPath(root, taskId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return bound;
}

/** The record a task's latest sealed revision produced, or null when none has been written. */
export async function readChangeRecord(root: string, taskId: string): Promise<ChangeRecord | null> {
    return readValidatedOptional<ChangeRecord>('change-record', changeRecordPath(root, taskId)).catch(() => null);
}
