import { describe, expect, it } from 'vitest';
import { checkObligations } from '../../src/quality/obligation-check.js';
import type { RepairDeclaration } from '../../src/quality/repair-declarations.js';
import type { ClosureObligation } from '../../src/quality/recurrence-packet.js';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';

/**
 * **The obligation a round contracts is read as the round wrote it.**
 *
 * Measured on `the-gates-can-be-repaired` at `revision-2ab47a7a2b63b784`: the seal refused the first repair of a class the
 * seal itself had asked for, because `obligation-check` enforces two fields the reviewer protocol cannot write in the
 * shape it demands — `inventory` entries are looked up as file paths (`entryPathOf` splits the entry at the first colon),
 * and `effectivenessTest` must be a substring of a check id, name, command or scope path, while the field is a sentence
 * describing what reddens. Both refusals are unfalsifiable in the direction that matters: no repair can make a prose
 * contract satisfy a parser that only reads paths, so the seal blocks every future attempt and names a remedy (a new
 * round) that the phase machine makes unreachable from the phase the seal leaves behind.
 *
 * The repair reads the fields the way the protocol commits them — the path an entry names, the check a declaration names —
 * and where a declaration names no check at all, it says so as its own state rather than reporting the absence of a match
 * as if the test had been run and failed. That state is decided by a recorded operator decision and never reported as a
 * pass: an unverifiable contract that could be waved through by silence would be the false assurance this project refuses,
 * and one that can never be decided at all is the deadlock measured above.
 *
 * The fixture files are real: the inventory is resolved against the repository, so the cases read the same `existsSync` the
 * seal does rather than a stub.
 */
/**
 * The repository itself is the fixture for the inventory half: the seal resolves an entry against the workspace root, so a
 * temp directory would make every entry unresolvable for a reason the case is not about.
 */
const WORKSPACE = process.cwd();

/** The sites the declarations below name, real files in this repository. */
const SITE_A = 'src/workflow/verdict-binding.ts';
const SITE_B = 'src/workflow/user-choice-gate.ts';
const SURFACE = [SITE_B];
const CHECK_PATH = 'tests/unit/a-damaged-gate-record-is-not-an-absent-one.test.ts';

function obligation(overrides: Partial<ClosureObligation> = {}): ClosureObligation {
    return {
        states: ['a record that names no binding at all', 'a record bound to sealed content'],
        sourceOfTruth: `one predicate in ${SITE_A} that every reader asks`,
        inventory: [`${SITE_A} bindsToRevision (the predicate other verdicts ask)`, `${SITE_B} the reuse rule and the removal rule`],
        invariant: 'one derivation answers whether a record still speaks for the current content',
        repairSurface: SURFACE,
        effectivenessTest: `${CHECK_PATH}: the case that counts pointer reads`,
        ifRecursAgain: 'rewrite_mechanism',
        ...overrides,
    };
}

function declaration(closure: ClosureObligation, conclusion = 'behaviour_defect'): RepairDeclaration {
    return { defectClass: 'refusal-cannot-be-executed', conclusion, at: '2026-10-16T00:00:00.000Z', closureObligation: closure };
}

function envelope(overrides: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
    return {
        id: 'E1',
        taskId: 'held',
        checkId: `AC-2-test-${CHECK_PATH}`,
        name: `AC-2 test ${CHECK_PATH}`,
        kind: 'test',
        command: `npx vitest run ${CHECK_PATH}`,
        exitCode: 0,
        startedAt: '2026-10-17T00:00:00.000Z',
        finishedAt: '2026-10-17T00:00:01.000Z',
        diffHash: 'd'.repeat(64),
        scope: { paths: [CHECK_PATH] },
        ...overrides,
    } as EvidenceEnvelope;
}

function run(input: {
    closure: ClosureObligation;
    evidence?: EvidenceEnvelope[];
    waivers?: Array<{ path: string; reason: string; approvedBy: string; createdAt: string }>;
}): ReturnType<typeof checkObligations> {
    return checkObligations({
        root: WORKSPACE,
        open: [declaration(input.closure)],
        declaredPaths: [...SURFACE, SITE_A],
        evidence: input.evidence ?? [envelope()],
        movedPaths: [...SURFACE],
        baselineDigests: new Map(),
        currentDigests: {},
        waivers: input.waivers ?? [],
    } as never);
}

describe('an obligation is read as the round wrote it', () => {
    it('resolves an inventory entry to the file it names, not to the whole sentence', () => {
        // The reviewer's shape: `<path> <symbol> (what that site does)`. `entryPathOf` split at the first colon and looked
        // the rest up as a filename, so every entry named a file that cannot exist and the seal refused a repair for a
        // contract it had asked for — 10 of 10 entries on the change that measured this.
        const [check] = run({ closure: obligation() });
        expect(check.unmet.filter((detail) => detail.includes('inventory')), `every entry names a real file: ${check.unmet.join(' | ')}`).toEqual([]);
        expect(check.satisfied.some((detail) => detail.includes('inventory')), 'the inventory is confirmed rather than skipped').toBe(true);
    });

    it('names an entry that resolves to no file, instead of reporting the whole list as missing', () => {
        const [check] = run({ closure: obligation({ inventory: [`${SITE_A} bindsToRevision`, 'the dead import that no longer exists'] }) });
        const inventory = check.unmet.filter((detail) => detail.includes('inventory'));
        expect(inventory.length, `an entry naming no file is unmet: ${check.unmet.join(' | ')}`).toBe(1);
        expect(inventory[0]).toContain('the dead import that no longer exists');
        expect(inventory[0], 'and it must not report the entry that does resolve').not.toContain('verdict-binding.ts');
    });

    it('accepts an effectiveness test that names the check the seal ran', () => {
        const [check] = run({ closure: obligation({ effectivenessTest: `${CHECK_PATH} — the case that counts reads` }) });
        expect(check.unmet.filter((detail) => detail.includes('effectivenessTest')), check.unmet.join(' | ')).toEqual([]);
    });

    it('reports an effectiveness test that names no check as unverifiable, not as a test that ran and did not match', () => {
        // **The state that blocked this change.** The recorded field reads "A selector that reddens while any site still
        // violates the invariant: (a) … (b) … (c) …" — a description of an instrument, naming no file, no check id and no
        // command. "No passing check in this seal matches" is a false negative: nothing could ever match, so the sentence
        // tells the operator a test exists that did not produce this evidence, and the same text is printed on every
        // future attempt.
        const prose = 'A selector that reddens while any site still violates the invariant: an assertion that the predicate '
            + 'and the gate return the same answer, and a case counting reads of the pointer.';
        const [check] = run({ closure: obligation({ effectivenessTest: prose }) });
        const detail = check.unmet.find((entry) => entry.includes('effectivenessTest'));
        expect(detail, 'an unreadable contract is still unmet — it is never a silent pass').toBeDefined();
        expect(detail, `the refusal names the state rather than a missing match: ${detail}`).toMatch(/names no check/u);
        expect(detail, 'and it does not claim a check ran and did not match').not.toMatch(/no passing check/u);
    });

    /**
     * **The boundaries of the reader's own rules, on both sides.**
     *
     * Round 10's F6 is the reason these cases exist: the six cases above covered exactly one branch, so nothing decided the
     * substring rule, the eight-character threshold, the token resolver or the profile gate — and a reader that decides none
     * of its own boundaries by a measured fact is the instrument-unsound shape, which is how the class recurs. Each case
     * below names the rule it pins, and each one fails if that rule is changed in either direction.
     */
    it('matches a decorated declaration against the check it names, and never reports it as a check that did not pass', () => {
        // F1's measured shape: a backticked path read against the passing envelope of exactly that test. The decoration is
        // not in the command, so the raw comparison missed it and the seal printed "it names a check, and that check did not
        // run or did not pass" about the check that had just passed.
        const [check] = run({ closure: obligation({ effectivenessTest: `\`${CHECK_PATH}\` — the case that counts reads` }) });
        expect(check.unmet.filter((detail) => detail.includes('effectivenessTest')), check.unmet.join(' | ')).toEqual([]);
        expect(check.satisfied.join(' | ')).toContain('effectiveness test ran and passed');

        // And the same declaration with a `:12` line suffix, the other decoration the field carries in practice.
        const [withLine] = run({ closure: obligation({ effectivenessTest: `${CHECK_PATH}:12` }) });
        expect(withLine.unmet.filter((detail) => detail.includes('effectivenessTest')), withLine.unmet.join(' | ')).toEqual([]);
    });

    it('reads a short check id by the same rule as a long one, in both directions', () => {
        // F1's P5 boundary: two checks of one shape got opposite readings on either side of eight characters.
        //
        // **Every field is short on purpose.** The first version of this case used `test` with the command `vitest run`, and
        // the mutation that restores the eight-character filter did *not* redden it: `'vitest'.includes('test')` matched
        // through the command, so the case passed for a reason it was not about. A boundary case has to leave the rule it
        // pins as the only way to pass.
        const short = envelope({ checkId: 'lint', name: 'lint', command: 'lint', scope: undefined });

        // (a) A short id that PASSED satisfies the declaration — the eight-character filter used to answer "names no check"
        //     here, which is the state whose own text says no repair can change it.
        const [passing] = run({ closure: obligation({ effectivenessTest: 'lint' }), evidence: [short] });
        expect(passing.unmet.filter((detail) => detail.includes('effectivenessTest')), passing.unmet.join(' | ')).toEqual([]);
        expect(passing.satisfied.join(' | ')).toContain('effectiveness test ran and passed');

        // (b) The same short id that FAILED is reported as a check that ran and did not pass — NOT as an unverifiable
        //     contract, because that state offers the recorded-decision road and would let an operator waive a contract the
        //     seal has in fact decided.
        const [failing] = run({
            closure: obligation({ effectivenessTest: 'lint' }),
            evidence: [envelope({ checkId: 'lint', name: 'lint', command: 'lint', scope: undefined, exitCode: 1 })],
        });
        const detail = failing.unmet.find((entry) => entry.includes('effectivenessTest'));
        expect(detail, 'the failure is reported').toBeDefined();
        expect(detail, `it names the check that answered: ${detail}`).toContain('lint');
        expect(detail, 'and it does not offer the unverifiable-contract state').not.toMatch(/names no check/u);

        // (c) And the same failing evidence cannot be waived by a decision: the road belongs to the state above, not here.
        const [decided] = run({
            closure: obligation({ effectivenessTest: 'lint' }),
            evidence: [envelope({ checkId: 'lint', name: 'lint', command: 'lint', scope: undefined, exitCode: 1 })],
            waivers: [{ path: 'obligation:refusal-cannot-be-executed', reason: 'we accept the failing check', approvedBy: 'operator', createdAt: '2026-10-17T00:00:00.000Z' }],
        });
        expect(decided.unmet.filter((entry) => entry.includes('effectivenessTest')).length, 'a check that ran and failed is not waivable by this road').toBe(1);
        expect(decided.recordedGaps.join(' | ')).not.toContain('we accept the failing check');
    });

    it('accepts an inventory entry only where it names a path, and only when that path is a file', () => {
        // F2's measured shapes: a sentence naming no site, satisfied by a directory and by an unrelated existing file.
        const [directory] = run({ closure: obligation({ inventory: ['the reader that used to exist in src was removed by the repair'] }) });
        expect(directory.unmet.filter((detail) => detail.includes('inventory')).join(' | '), 'a directory is not a site')
            .toContain('name no file');

        const [unrelatedFile] = run({ closure: obligation({ inventory: ['the dead import was in package.json and nowhere else, no site named'] }) });
        expect(unrelatedFile.unmet.filter((detail) => detail.includes('inventory')).join(' | '), 'a path mentioned in prose is not the site the entry names')
            .toContain('name no file');

        // **And the shapes a reviewer does write still resolve**, so the narrowing is not a check that rejects honest work:
        // the documented `<path> <symbol>` shape, a backticked path, and a path carrying a separator anywhere in the entry.
        for (const entry of [
            `${SITE_A} bindsToRevision (the predicate other verdicts ask)`,
            `\`${SITE_A}\`:12 the predicate`,
            `the predicate at ${SITE_A} that every reader asks`,
        ]) {
            const [check] = run({ closure: obligation({ inventory: [entry] }) });
            expect(check.unmet.filter((detail) => detail.includes('inventory')), `"${entry}" names a real file: ${check.unmet.join(' | ')}`).toEqual([]);
        }
    });

    it('turns an unverifiable contract into a recorded gap when the operator has decided, and never into a pass', () => {
        // The decision road: the operator records why the contract cannot be verified and who approves proceeding. The
        // obligation leaves `unmet` — the seal proceeds — but it is reported as a declared gap, so no reader can mistake it
        // for a satisfied contract.
        const prose = 'A selector that reddens while any site still violates the invariant: (a) … (b) …';
        const decision = { path: 'obligation:refusal-cannot-be-executed', reason: 'the field is a description, not a selector; the repair carries 31 verified falsifiers instead', approvedBy: 'operator', createdAt: '2026-10-17T00:00:00.000Z' };
        const [check] = run({ closure: obligation({ effectivenessTest: prose }), waivers: [decision] });
        expect(check.unmet.filter((detail) => detail.includes('effectivenessTest')), check.unmet.join(' | ')).toEqual([]);
        expect(check.recordedGaps.join(' '), 'the gap is recorded with its reason and approver').toContain('the field is a description');
        expect(check.recordedGaps.join(' ')).toContain('operator');
        expect(check.satisfied.join(' '), 'and it is never reported as satisfied').not.toMatch(/effectiveness test ran and passed/u);
    });

    it('does not let a decision about another class stand in for this one', () => {
        const prose = 'A selector that reddens while any site still violates the invariant.';
        const other = { path: 'obligation:instrument-unsound', reason: 'x', approvedBy: 'operator', createdAt: '2026-10-17T00:00:00.000Z' };
        const [check] = run({ closure: obligation({ effectivenessTest: prose }), waivers: [other] });
        expect(check.unmet.some((detail) => detail.includes('effectivenessTest')), 'the class is part of the decision').toBe(true);
    });
});
