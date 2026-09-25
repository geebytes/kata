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
/**
 * A finding whose class is not recorded is **invisible** to the termination condition, and that is a hole rather than a class.
 *
 * `roundMayClose` reads each open terminal finding's `classInstances`; one that carries none contributes nothing, so a pass that
 * recorded findings without that field would let the round close with nothing covered. The field is required by the brief, and a
 * requirement is only real where something fails without it — so this names the findings that would slip through, and the round
 * cannot close while any exists.
 */
export function findingsWithoutAClass(
    findings: ReadonlyArray<{ id: string; severity: string; classInstances?: readonly string[] }>,
): Array<{ id: string; severity: string }> {
    return findings
        .filter((finding) => isTerminalSeverity(finding.severity))
        .filter((finding) => !finding.classInstances || finding.classInstances.length === 0)
        .map((finding) => ({ id: finding.id, severity: finding.severity }));
}

/**
 * **The one decision every consumer asks** (`wcc7-f3`): *are the classes this finding names covered?*
 *
 * Three consumers answered it with three different quantifiers — the termination condition required **every** named class to be
 * covered, the obligation resolver accepted **any**, and the briefing read the **first** class in table order. They agreed only
 * because findings happen to name one class each today; the moment one names two, which the brief instructs reviewers to do, the
 * three answers diverge and the loop's termination condition disagrees with the closure rule.
 *
 * The quantifier is **every**: a finding that is an instance of two classes is not discharged by covering one of them, because the
 * point of naming the second is that a new instance could fail there too. A finding naming no class is not covered by anything.
 */
export function classCoverageOf(
    finding: { classInstances?: readonly string[] },
    coverage: ReadonlyArray<ClassCoverage>,
): { covered: boolean; uncovered: ClassCoverage[]; coveredBy: string[] } {
    const byId = new Map(coverage.map((entry) => [entry.classId, entry]));
    const named = finding.classInstances ?? [];
    const uncovered: ClassCoverage[] = [];
    const coveredBy: string[] = [];
    for (const classId of named) {
        const entry = byId.get(classId);
        if (entry?.covered) coveredBy.push(...entry.coveredBy);
        else uncovered.push(entry ?? { classId, covered: false, coveredBy: [] });
    }
    return { covered: named.length > 0 && uncovered.length === 0, uncovered, coveredBy };
}

export function classesNeedingCoverage(
    findings: ReadonlyArray<{ id: string; severity: string; classInstances?: readonly string[] }>,
    coverage: ReadonlyArray<ClassCoverage>,
): ClassCoverage[] {
    const needed = new Map<string, ClassCoverage>();
    for (const finding of findings) {
        if (!isTerminalSeverity(finding.severity)) continue;
        // Delegated, so the termination condition and the closure rule cannot grow different quantifiers again (`wcc7-f3`).
        for (const entry of classCoverageOf(finding, coverage).uncovered) needed.set(entry.classId, entry);
    }
    return [...needed.values()];
}

/** Whether a round may close: every class an open terminal finding names is covered by a check, **and every one names a class**. */
export function roundMayClose(
    findings: ReadonlyArray<{ id: string; severity: string; classInstances?: readonly string[] }>,
    coverage: ReadonlyArray<ClassCoverage>,
): { mayClose: boolean; reason: string; open: ClassCoverage[]; classless: Array<{ id: string; severity: string }> } {
    // **A finding with no class is checked first**, because it is the one case the class table cannot speak about: the round would
    // close having covered nothing for it, and silence is what makes it invisible.
    const classless = findingsWithoutAClass(findings);
    const open = classesNeedingCoverage(findings, coverage);
    if (classless.length > 0) {
        return {
            mayClose: false,
            reason: `findings that name no class, so no check can be said to cover them: ${classless.map((entry) => entry.id).join(', ')} — the termination condition reads classInstances, and one that names none contributes nothing`,
            open,
            classless,
        };
    }
    if (open.length === 0) {
        return {
            mayClose: true,
            reason: 'every class an open terminal finding names is covered by a check that reddens when it returns',
            open,
            classless,
        };
    }
    return {
        mayClose: false,
        reason: `classes with no covering check: ${open.map((entry) => entry.classId).join(', ')} — a repair without one promises the next round the same class`,
        open,
        classless,
    };
}
