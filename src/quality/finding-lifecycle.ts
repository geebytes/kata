/**
 * The severity classes the platform treats as terminal (I1 of the finding-lifecycle design).
 *
 * `blocking` and `major` are the two severities that stop a gate, and they are the two that may never be dispositioned:
 * a finding that must be repaired cannot be talked out of the way, and the disposition commands refuse it rather than
 * recording a decision the workflow does not honour. The rule lives in one place because it is stated in three: the
 * navigation ladder, the adversarial gate and the distillation gate all count exactly these two.
 */
const TERMINAL_SEVERITIES = ['blocking', 'major'] as const;

export function isTerminalSeverity(severity: string): boolean {
    return (TERMINAL_SEVERITIES as readonly string[]).includes(severity);
}

/**
 * Whether a review round has nothing left that **the workflow can act on** — the termination condition review never had.
 *
 * Measured on this line: `closure-gate` ran five rounds and `repair-by-another-author` seven, and **every round's findings were
 * about the previous round's repairs** (7, 6, 5, 5, then 7). The loop had no state meaning "this is enough": `findings defer` and
 * `accept` refuse `blocking`/`major` outright, `waive` destroys the record, and routing arrived only today — so the only exits were
 * *repair everything* or *erase*, and "everything" is an open set that each repair enlarges.
 *
 * **The condition this names is the one that can fail.** A round ends when the classes its findings belong to are covered by an
 * invariant that fails when the class returns: a class with a check is a class the workflow can hold, and a class without one is a
 * promise to repair instances forever. So the question is not "are there no findings" — a repair always produces material for the
 * next round — but **"is every class named by an open finding covered by a check that reddens when it returns"**.
 */
export type ClassCoverage = {
    /** The class a finding belongs to, as the round that recorded it named it (its `classInstances` are the other instances). */
    readonly classId: string;
    /** Whether a declared check covers the class, so a new instance fails in the suite rather than in a future round. */
    readonly covered: boolean;
    /** The checks that claim to cover it, when any. */
    readonly coveredBy: readonly string[];
};

/**
 * The classes an open **terminal** finding belongs to, and whether each is covered by a declared check.
 *
 * `coveredBy` names the check itself, so the claim is auditable: a class claiming coverage by a check that does not redden when
 * the class returns is the defect this whole design exists to remove (the line recorded eight decorative checks before the
 * falsification mechanism started catching them).
 */
export function classesNeedingCoverage(
    findings: ReadonlyArray<{ id: string; severity: string; classInstances?: readonly string[] }>,
    coverage: ReadonlyArray<ClassCoverage>,
): ClassCoverage[] {
    const byId = new Map(coverage.map((entry) => [entry.classId, entry]));
    const needed = new Map<string, ClassCoverage>();
    for (const finding of findings) {
        if (!isTerminalSeverity(finding.severity)) continue;
        for (const classId of finding.classInstances ?? []) {
            const entry = byId.get(classId);
            if (!entry || !entry.covered) needed.set(classId, entry ?? { classId, covered: false, coveredBy: [] });
        }
    }
    return [...needed.values()];
}

/** Whether a round may close: every class an open terminal finding names is covered by a check. */
export function roundMayClose(
    findings: ReadonlyArray<{ id: string; severity: string; classInstances?: readonly string[] }>,
    coverage: ReadonlyArray<ClassCoverage>,
): { mayClose: boolean; reason: string; open: ClassCoverage[] } {
    const open = classesNeedingCoverage(findings, coverage);
    if (open.length === 0) {
        return { mayClose: true, reason: 'every class an open terminal finding names is covered by a check that reddens when it returns', open };
    }
    return {
        mayClose: false,
        reason: `classes with no covering check: ${open.map((entry) => entry.classId).join(', ')} — a repair without one promises the next round the same class`,
        open,
    };
}
