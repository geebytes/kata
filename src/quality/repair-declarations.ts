import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { taskDir } from '../core/layout.js';
import { ESCALATION_EXITS, ROOT_CAUSE_CONCLUSIONS, type ClosureObligation, type EscalationExit } from './recurrence-packet.js';
import type { ReviewRound } from './repair.js';

/**
 * **A declared repair, and whether it has already been spent.**
 *
 * The recurrence packet can detect that a class came back inside a repair, and (since the closure obligation landed) it can
 * require the round to say what would make the class impossible. Neither of those stops anything: the conclusion routes back
 * to `repair`, the repair seals a new revision, and the next round is free to find a neighbour of the site that was fixed.
 * Measured on one change: five consecutive rounds, three classes, three sites — each round concluding `instrument_unsound`
 * and each repair widening the same enumeration.
 *
 * `ifRecursAgain` is the answer to that, and this module turns it into a decision. A class whose **latest** root-cause
 * conclusion asked for a repair, and which then **recurred after that conclusion was recorded, on a later revision of the
 * repair chain**, has spent its declared repair — the exit is due, and the exits are the three the vocabulary names, none of
 * which is another repair.
 *
 * **The ordering is the whole mechanism, and the first version did not have it.** The predicate was the bare conjunction
 * "the class is still a stop-line candidate AND its latest conclusion asked for a repair", which is *exactly the state a
 * root-cause round leaves behind*: the round concluded a repair for a recurrence that was already in the history, so the
 * declaration itself made the exit due, and the repair it had just contracted could never be attempted. A conclusion is a
 * statement about the past; what makes its exit due is something happening *after* it.
 *
 * `not_same_class` clears a class rather than spending it: a round that demonstrated the findings are no longer one class
 * has answered the question, so an older repair conclusion for that class is history rather than an obligation — until the
 * class occurs again after that clearing.
 */
export interface RepairDeclaration {
    /** The defect class the round named. */
    defectClass: string;
    /**
     * When the conclusion was **recorded**, from the record itself: `recordedAt` on a current record, and the same field
     * preserved by the archived copy. Rows archived before the field existed carry only `archivedAt`, which is the later of
     * the two and is used as a fallback. Absent when the record carries neither — and then the order cannot be established,
     * which is reported rather than assumed in either direction.
     */
    at?: string;
    /** The revision the conclusion applied to, when the record names one. */
    revisionId?: string;
    /** The round's conclusion: one of `behaviour_defect | instrument_unsound | workflow_routing_error | claim_scope_error | not_same_class`. */
    conclusion: string;
    /** The exit the round's closure obligation declared, when it carried one. */
    ifRecursAgain?: string;
    /** The class-level closure the round contracted the next repair to, when it carried one. */
    closureObligation?: ClosureObligation;
}

export interface RepairDeclarationsRead {
    kind: 'readable' | 'unreadable';
    declarations: RepairDeclaration[];
    /** Why the record could not be read, when it could not — its own fact, never folded into "nothing declared". */
    detail?: string;
    /**
     * Declarations that could not be attributed to the chain in hand: the record named no revision, or one that is not on
     * this chain. Counted rather than dropped, because them dropping silently is the same "no declaration" reading that
     * routes back to another repair.
     */
    unattributable?: number;
}

/** The conclusions that ask for a repair, and therefore spend the class' status as "still being worked on". */
const REPAIR_CONCLUSIONS = new Set(['behaviour_defect', 'instrument_unsound', 'workflow_routing_error']);

/** The conclusion that answers the class question instead of spending it. */
const CLEARING_CONCLUSION = 'not_same_class';

/** One class appearing in one round, with the facts the ordering needs. */
export interface ClassOccurrence {
    defectClass: string;
    /** The round row's own timestamp: rounds are appended in order and never re-sorted, so this is the occurrence's order. */
    roundAt: string;
    /** The revision the round measured, when the row names one. */
    revisionId?: string;
    /** Whether the occurrence is a defect the round's own repair introduced or missed. */
    origin: 'original' | 'repair';
}

/**
 * Every classified finding, as an occurrence in append order.
 *
 * `classRecurrence` answers "how often did this class appear"; this answers "when, on which revision, and from whose
 * repair", which is what the exit decision needs and what the aggregate deliberately does not carry.
 */
export function classOccurrences(rounds: readonly ReviewRound[]): ClassOccurrence[] {
    return rounds.flatMap((round) => (round.findings ?? []).flatMap((finding) => {
        if (typeof finding.class !== 'string' || finding.class === '') return [];
        return [{
            defectClass: finding.class,
            roundAt: round.at,
            ...(round.revisionId === undefined ? {} : { revisionId: round.revisionId }),
            // A row with no `origin` is an occurrence whose authorship is unknown; the conservative reading for the exit
            // decision is "not a repair's", because attributing it to a repair would spend an exit on evidence that does not
            // say so. `repairOrigin` counting in the aggregate is a different question with a different default.
            origin: finding.origin === 'repair' ? 'repair' as const : 'original' as const,
        }];
    }));
}

/** A class whose declared repair has been spent: it recurred after a round already concluded a repair for it. */
export interface DueExit {
    defectClass: string;
    /** When the spent declaration was recorded, so the operator can read the round that asked for the repair. */
    declaredAt?: string;
    /** What that round concluded. */
    conclusion: string;
    /** The exit that round's closure obligation named, when it named one. */
    declaredExit?: string;
    /** The revision the declaration applied to, when the record named one. */
    declaredRevisionId?: string;
    /** The round the recurrence was observed in, and the revision it was measured on: what makes the exit due. */
    recurredAt: string;
    recurredRevisionId?: string;
}

/** What one class's declaration history shows about whether its exit is now due. */
export interface ExitDueAssessment {
    due: DueExit[];
    /**
     * Classes whose declaration asks for a repair and which are still recurring, but where the order could not be
     * established — the declaration carries no timestamp, or its revision is not on this chain. Reported by name: these are
     * the classes the mechanism cannot decide, and folding them into "not due" would hide the state it exists to catch.
     */
    undecidable: string[];
}

/**
 * Which classes have spent a declared repair and recurred again since.
 *
 * The predicate is deliberately conjunctive and **ordered**:
 *
 * 1. the class's latest declaration concluded a repair (`behaviour_defect | instrument_unsound | workflow_routing_error`);
 * 2. a **repair-origin** occurrence of that class exists **after** that declaration was recorded;
 * 3. that occurrence is on a **later revision of the repair chain** than the declaration, when both name revisions — the
 *    repair was sealed in between. A recurrence on the declaration's own revision is the same review looking again, not a
 *    failed repair.
 *
 * A class that recurs but was never declared is the ordinary case the packet exists for (it goes back to repair with a
 * contract), and a class whose latest declaration was `not_same_class` was answered rather than spent.
 */
export function classesWhoseExitIsDue(
    declarations: readonly RepairDeclaration[],
    occurrences: readonly ClassOccurrence[],
    chain: readonly string[] = [],
): ExitDueAssessment {
    const chainIndex = new Map(chain.map((revisionId, index) => [revisionId, index]));
    const due: DueExit[] = [];
    const undecidable: string[] = [];
    const classes = [...new Set(occurrences.map((occurrence) => occurrence.defectClass))].sort();
    for (const defectClass of classes) {
        const forClass = declarations.filter((declaration) => declaration.defectClass === defectClass);
        // The latest declaration decides: a round that later demonstrated `not_same_class` has answered the class question,
        // so an older repair conclusion for it is history. Chronology is the read order of the records, which is append order
        // for both the history file and the active record.
        const latest = forClass[forClass.length - 1];
        if (latest === undefined) continue;
        if (latest.conclusion === CLEARING_CONCLUSION) continue;
        if (!REPAIR_CONCLUSIONS.has(latest.conclusion)) continue;
        // **Three answers, not two.** `after` spends the exit; `before` is the repair still owed; `unplaceable` is a record the
        // mechanism cannot read, and only that last one is reported — folding it into "before" would let the loop run on an
        // unreadable declaration, and folding `before` into it would report a healthy history as broken.
        const orders = occurrences
            .filter((occurrence) => occurrence.defectClass === defectClass && occurrence.origin === 'repair')
            .map((occurrence) => ({ occurrence, order: orderOf(occurrence, latest, chainIndex) }));
        const after = orders.filter((entry) => entry.order === 'after').map((entry) => entry.occurrence);
        if (after.length === 0) {
            // Nothing recurred after the declaration: either the repair has not been attempted yet — the state that must route
            // back to Build with the contract in hand — or the class' recurrence is entirely the one the declaration was
            // written about. An unplaceable occurrence is neither, and is named so an operator can repair the record.
            if (orders.some((entry) => entry.order === 'unplaceable')) undecidable.push(defectClass);
            continue;
        }
        const last = after[after.length - 1];
        due.push({
            defectClass,
            ...(latest.at === undefined ? {} : { declaredAt: latest.at }),
            ...(latest.revisionId === undefined ? {} : { declaredRevisionId: latest.revisionId }),
            conclusion: latest.conclusion,
            ...(latest.ifRecursAgain === undefined ? {} : { declaredExit: latest.ifRecursAgain }),
            recurredAt: last.roundAt,
            ...(last.revisionId === undefined ? {} : { recurredRevisionId: last.revisionId }),
        });
    }
    return { due, undecidable };
}

/**
 * Where one occurrence sits relative to a declaration, as a three-way answer rather than a boolean.
 *
 * A boolean would fold "this came before" together with "the record cannot place this", and they are opposite facts: the
 * first says the repair is still owed, the second says the mechanism cannot tell — and only the second needs an operator.
 *
 * The timestamp is the load-bearing fact, because a conclusion is recorded between rounds and a round row's `at` is written
 * by the same clock. The chain position refines it where both sides are on the chain: a recurrence on the declaration's own
 * revision is the same review looking again, not a repair that failed. A revision the chain does not hold is *unplaceable*
 * rather than "later" — a round recorded against content this chain never sealed says nothing about whether a repair between
 * them held, and reading it as a recurrence would spend an exit on a foreign round.
 */
function orderOf(
    occurrence: ClassOccurrence,
    declaration: RepairDeclaration,
    chainIndex: ReadonlyMap<string, number>,
): 'after' | 'before' | 'unplaceable' {
    if (declaration.at === undefined) return 'unplaceable';
    if (occurrence.roundAt <= declaration.at) return 'before';
    // A row written before rounds named revisions, or a declaration that named none: the timestamp is the whole record, and
    // it is the fact the decision rests on. (When a chain is in hand, `readRepairDeclarations` has already counted the
    // unattributable declarations; refusing these here instead would make every legacy history undecidable, which is the
    // state that never ends.)
    if (occurrence.revisionId === undefined || declaration.revisionId === undefined) return 'after';
    const occurredAt = chainIndex.get(occurrence.revisionId);
    const declaredAt = chainIndex.get(declaration.revisionId);
    if (occurredAt === undefined || declaredAt === undefined) return 'unplaceable';
    return occurredAt > declaredAt ? 'after' : 'before';
}

/**
 * Read every declaration this change has recorded: the archived rounds (oldest first) and the active one.
 *
 * The history is where a superseded round's conclusion survives — the active record is replaced whenever review is entered
 * again — and both carry `recurrenceAnalysis` only when the recurrence packet was active for that round, so a change with
 * no recurrence history reads as `declarations: []` rather than as an error.
 *
 * **Read through the schema, not through `JSON.parse` alone** (`origin`: this reader's first version). A record whose
 * `recurrenceAnalysis` is well-formed JSON but a malformed conclusion was silently dropped, so a damaged declaration left
 * the reader reporting "nothing was ever declared" — the reading that routes back to another repair, and the one direction
 * where the wrong answer restarts the loop. Anything this reader cannot make sense of is now `unreadable`, named with its
 * file and line, and the caller publishes that instead of `reviewExitDue`.
 */
export async function readRepairDeclarations(
    root: string,
    taskId: string,
    chain: readonly string[] = [],
): Promise<RepairDeclarationsRead> {
    const dir = taskDir(root, taskId);
    const history = await readFile(join(dir, 'review-history.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        return error.code === 'ENOENT' ? '' : error;
    });
    if (history instanceof Error) {
        return {
            kind: 'unreadable',
            declarations: [],
            detail: `review-history.jsonl could not be read (${history.code ?? history.message})`,
        };
    }
    const declarations: RepairDeclaration[] = [];
    const lines = history.split('\n').filter((line) => line.trim() !== '');
    for (const [index, line] of lines.entries()) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            // A line that cannot be parsed is named with its number: reporting the truncated set as "everything declared"
            // would let a damaged history read as a change that never declared anything.
            return {
                kind: 'unreadable',
                declarations: [],
                detail: `review-history.jsonl line ${String(index + 1)} is not JSON`,
            };
        }
        const read = declarationsOfRecord(parsed);
        if (!read.ok) {
            return { kind: 'unreadable', declarations: [], detail: `review-history.jsonl line ${String(index + 1)}: ${read.why}` };
        }
        declarations.push(...read.declarations);
    }
    const activePath = join(dir, 'review.json');
    const active = await readFile(activePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
        return error.code === 'ENOENT' ? '' : error;
    });
    if (active instanceof Error) {
        return {
            kind: 'unreadable',
            declarations: [],
            detail: `review.json could not be read (${active.code ?? active.message})`,
        };
    }
    if (active !== '') {
        let parsed: unknown;
        try {
            parsed = JSON.parse(active);
        } catch {
            return { kind: 'unreadable', declarations: [], detail: 'review.json is not JSON' };
        }
        const read = declarationsOfRecord(parsed);
        if (!read.ok) return { kind: 'unreadable', declarations: [], detail: `review.json: ${read.why}` };
        declarations.push(...read.declarations);
    }
    // **Scoped to the chain in hand.** A declaration this chain does not contain is another lineage's conclusion, and
    // letting it decide this one's exit is the scope error with teeth: a class name is not a chain. Declarations that name
    // no revision cannot be attributed at all, and are counted rather than filtered away in silence.
    if (chain.length === 0) return { kind: 'readable', declarations, unattributable: declarations.filter((entry) => entry.revisionId === undefined).length };
    const onChain = new Set(chain);
    const scoped = declarations.filter((entry) => entry.revisionId !== undefined && onChain.has(entry.revisionId));
    return {
        kind: 'readable',
        declarations: scoped,
        unattributable: declarations.length - scoped.length,
    };
}

/** One record's declarations: what the round concluded, for which classes, and the contract it carried. */
export function declarationsOfRecord(value: unknown): { ok: true; declarations: RepairDeclaration[] } | { ok: false; why: string } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: true, declarations: [] };
    const record = value as Record<string, unknown>;
    const analysis = record.recurrenceAnalysis;
    if (analysis === undefined || analysis === null) return { ok: true, declarations: [] };
    if (typeof analysis !== 'object' || Array.isArray(analysis)) {
        return { ok: false, why: 'recurrenceAnalysis is not an object' };
    }
    const analysisRecord = analysis as Record<string, unknown>;
    const conclusion = analysisRecord.conclusion;
    if (typeof conclusion !== 'string' || !(ROOT_CAUSE_CONCLUSIONS as readonly string[]).includes(conclusion)) {
        return { ok: false, why: `recurrenceAnalysis.conclusion is not one of ${ROOT_CAUSE_CONCLUSIONS.join(', ')}` };
    }
    const triggerClasses = analysisRecord.triggerClasses;
    if (!Array.isArray(triggerClasses) || triggerClasses.length === 0
        || !triggerClasses.every((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')) {
        return { ok: false, why: 'recurrenceAnalysis.triggerClasses must be a non-empty list of class names' };
    }
    const obligation = closureObligationOf(analysisRecord.closureObligation);
    if (obligation instanceof Error) return { ok: false, why: obligation.message };
    // **Two fields, in order of what they mean.** `recordedAt` is when the conclusion was written; `archivedAt` is when the
    // record was replaced, which is later and is only a legacy fallback for rows written before the writer stamped one.
    const at = typeof record.recordedAt === 'string'
        ? record.recordedAt
        : typeof record.archivedAt === 'string'
            ? record.archivedAt
            : undefined;
    const revisionId = typeof record.reviewedRevisionId === 'string'
        ? record.reviewedRevisionId
        : typeof record.revisionId === 'string'
            ? record.revisionId
            : undefined;
    return {
        ok: true,
        declarations: triggerClasses.map((defectClass) => ({
            defectClass,
            ...(at === undefined ? {} : { at }),
            ...(revisionId === undefined ? {} : { revisionId }),
            conclusion,
            ...(obligation === null ? {} : { ifRecursAgain: obligation.ifRecursAgain, closureObligation: obligation }),
        })),
    };
}

/** The obligation a record carries, or the reason it cannot be one. Absent is `null`; malformed is an `Error`. */
/**
 * The seven-field obligation reader, exported so a *corrective action's* declaration is validated by the same rule.
 *
 * A corrective action discharges a class contract, and a second validator would be a second definition of the class — the
 * defect this repository names `one-fact-derived-twice`, in the very place the class vocabulary lives.
 */
export function closureObligationOf(value: unknown): ClosureObligation | null | Error {
    if (value === undefined) return null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return new Error('recurrenceAnalysis.closureObligation is not an object');
    }
    const record = value as Record<string, unknown>;
    const list = (field: string): string[] | null => {
        const entry = record[field];
        if (!Array.isArray(entry) || entry.length === 0 || !entry.every((item): item is string => typeof item === 'string' && item.trim() !== '')) return null;
        return entry.map((item) => item.trim());
    };
    const text = (field: string): string | null => {
        const entry = record[field];
        return typeof entry === 'string' && entry.trim() !== '' ? entry.trim() : null;
    };
    const states = list('states');
    const inventory = list('inventory');
    const repairSurface = list('repairSurface');
    const sourceOfTruth = text('sourceOfTruth');
    const invariant = text('invariant');
    const effectivenessTest = text('effectivenessTest');
    const ifRecursAgain = text('ifRecursAgain');
    if (states === null || inventory === null || repairSurface === null || sourceOfTruth === null
        || invariant === null || effectivenessTest === null || ifRecursAgain === null) {
        return new Error('recurrenceAnalysis.closureObligation is missing or malformed in one of its seven fields');
    }
    // The exit is a closed vocabulary, and this reader is the one that has to know: a record carrying a value no route can
    // act on is a declaration the operator cannot execute, which is the same defect the packet's validator refuses on entry.
    if (!(ESCALATION_EXITS as readonly string[]).includes(ifRecursAgain)) {
        return new Error(`recurrenceAnalysis.closureObligation.ifRecursAgain is not one of ${ESCALATION_EXITS.join(', ')}`);
    }
    return {
        states,
        sourceOfTruth,
        inventory,
        invariant,
        repairSurface,
        effectivenessTest,
        ifRecursAgain: ifRecursAgain as EscalationExit,
    };
}

/**
 * The classes a later round has already answered with `not_same_class`.
 *
 * The packet is derived from the whole round history, so a class it keeps seeing stays a candidate however the rounds after
 * it concluded — and every round thereafter is dispatched as a root-cause round that must produce a conclusion for a
 * question a previous round already answered. A class whose **latest** declaration cleared it, with no occurrence after
 * that declaration, has been answered and must stop raising the packet until it occurs again.
 */
export function clearedClasses(
    declarations: readonly RepairDeclaration[],
    occurrences: readonly ClassOccurrence[],
): string[] {
    const cleared: string[] = [];
    for (const defectClass of new Set(declarations.map((declaration) => declaration.defectClass))) {
        const forClass = declarations.filter((declaration) => declaration.defectClass === defectClass);
        const latest = forClass[forClass.length - 1];
        if (latest === undefined || latest.conclusion !== CLEARING_CONCLUSION) continue;
        const recurred = occurrences.some((occurrence) => occurrence.defectClass === defectClass
            && latest.at !== undefined
            && occurrence.roundAt > latest.at);
        if (!recurred) cleared.push(defectClass);
    }
    return cleared.sort();
}

/**
 * The closure obligations this change is currently under, keyed by the revision the declaring round ran against.
 *
 * What makes an obligation *open* is the same ordering the exit decision uses: the conclusion asks for a repair, and no
 * repair-origin occurrence of the class exists after it. The seal asks this question about the revision it supersedes, so
 * the obligation it must satisfy is the one contracted on the content it is replacing.
 */
export function openClosureObligations(
    declarations: readonly RepairDeclaration[],
    occurrences: readonly ClassOccurrence[],
): RepairDeclaration[] {
    const open: RepairDeclaration[] = [];
    for (const defectClass of new Set(declarations.map((declaration) => declaration.defectClass))) {
        const forClass = declarations.filter((declaration) => declaration.defectClass === defectClass);
        const latest = forClass[forClass.length - 1];
        if (latest === undefined || latest.closureObligation === undefined) continue;
        if (!REPAIR_CONCLUSIONS.has(latest.conclusion)) continue;
        const recurred = occurrences.some((occurrence) => occurrence.defectClass === defectClass
            && occurrence.origin === 'repair'
            && latest.at !== undefined
            && occurrence.roundAt > latest.at);
        if (!recurred) open.push(latest);
    }
    return open;
}
