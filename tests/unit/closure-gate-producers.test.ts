import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { hasReddening, readFalsifierReddenings, recordFalsifierReddening } from '../../src/quality/falsifier-reddenings.js';
import { obligationIsAnswered } from '../../src/quality/repair-obligations.js';

const cleanup: string[] = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-reddening-'));
    cleanup.push(root);
    await initLayout(root);
    await createTask({ root, id: 'r-task', title: 'r-task', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
    return root;
}

const reddening = (findingId: string) => ({
    findingId,
    check: 'tests/unit/x.test.ts',
    mutation: 'revert the guard the repair added',
    revisionId: 'revision-one',
    reddenedAt: '2026-09-23T02:00:00.000Z',
});

/**
 * The store behind `closure-gate` AC-1: a finding's falsifier was **shown reddening**. Kept additive in this slice — the
 * criterion that consumes it is the next one, and it is not committed until the fixtures that close finding-shaped
 * obligations supply a reddening (measured: eleven cases across six files).
 */
describe('every producer of the closure decision is load-bearing', () => {
    const finding = { id: 'obl-1', findingId: 'a-finding', acceptanceId: 'AC-1', raisedAt: '2026-09-23T01:00:00.000Z' } as never;
    const evidence = [{ id: 'e1', exitCode: 0, kind: 'test', command: 'npx vitest run tests/unit/x.test.ts' }] as never;
    const reddening = { findingId: 'a-finding', check: 'tests/unit/x.test.ts', mutation: 'revert', revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z', observed: { before: 0, mutated: 1, after: 0 } };
    const matrix = { version: 1, rows: [{ acceptanceId: 'AC-1', implementationPaths: ['src/x.ts'], testPaths: ['tests/unit/x.test.ts'], evidence: [{ id: 'e1', kind: 'test', command: 'npx vitest run tests/unit/x.test.ts', testSelector: 'tests/unit/x.test.ts' }], verificationLevel: 'unit' }] } as never;

    // The baseline: every producer present, and the obligation is answered.
    const baseline = { obligation: finding, resolvedAcceptanceIds: ['AC-1'], evidence, matrix, reddenings: [reddening] };

    it('answers when all four producers agree', () => {
        expect(obligationIsAnswered({ ...baseline } as never).answered).toBe(true);
    });

    it('changes the verdict when the resolved acceptance ids are dropped', () => {
        expect(obligationIsAnswered({ ...baseline, resolvedAcceptanceIds: [] } as never).answered).toBe(false);
    });

    it('changes the verdict when the evidence is dropped', () => {
        expect(obligationIsAnswered({ ...baseline, evidence: [] } as never).answered).toBe(false);
    });

    it('changes the verdict when the matrix is present and the evidence does not match its row', () => {
        // The matrix is load-bearing **in the direction the implementation actually has**: with it, evidence for another
        // command is not evidence for this criterion; without it, any passing envelope is. Asserting both sides is the
        // difference between testing the producer and testing a guess about it — the first version of this case asserted the
        // opposite direction and failed, which is how the real one was found.
        const unrelated = [{ id: 'e9', exitCode: 0, kind: 'test', command: 'npx vitest run tests/unit/other.test.ts' }] as never;
        expect(obligationIsAnswered({ ...baseline, evidence: unrelated } as never).answered).toBe(false);
        expect(obligationIsAnswered({ ...baseline, matrix: undefined, evidence: unrelated } as never).answered).toBe(true);
    });

    it('changes the verdict when the reddening is dropped', () => {
        expect(obligationIsAnswered({ ...baseline, reddenings: [] } as never).answered).toBe(false);
    });
});



/**
 * A validation failure and an absent file were the same answer: `readObligations` wrapped its read in a `catch` that returned
 * `[]`, so a record that failed validation read exactly like a task with no obligations. That hid the cause of two failed
 * attempts at AC-3 — the setup assertion reported `expected [] to have a length of 2` while the obligations had in fact been
 * written — and it is the same shape as an instrument's empty answer standing in for "could not answer".
 */

/**
 * AC-5, as the independent round read it: the criterion is that the change's own falsifier enumerates **every producer of the
 * closure decision**, and enumerating the four *inputs* of `obligationIsAnswered` does not do that — a second derivation of
 * "answered" elsewhere would be invisible to it. So this asserts the producers themselves, from the source: the decision is
 * made in one function, and every consumer of it goes through that function.
 *
 * The finding that produced this case is `cg-f5`, and the blocking one behind it (`cg-f1`) was exactly a second producer: the
 * seal preflight computed the same decision without the ledger this change added.
 */
describe('the closure decision has one producer, and every consumer reaches it', () => {
    /**
     * The set is **discovered**, not listed. The first version named three files by literal path, and round 3 found a fourth
     * producer outside them (cg3-f3) — which is the same defect as a declaration that names the wrong check, one level up: an
     * enumeration written by hand enumerates what its author remembered.
     */
    const filesUnder = (dir: string): string[] => readdirSync(join(process.cwd(), dir)).flatMap((entry: string) => {
        const relative = join(dir, entry);
        return statSync(join(process.cwd(), relative)).isDirectory() ? filesUnder(relative) : [relative];
    }).filter((path) => path.endsWith('.ts'));

    /**
     * The terms a file **uses**, not the terms it mentions. The first version matched raw text, so a corpus case whose
     * `reproduction` prose says "stamp `resolvedAt` unconditionally" read as a producer of the closure decision — the same
     * defect as counting a comment as a use (wcc2-f4), and the same fix: strip what cannot be code before matching, which can
     * only under-report.
     */
    const codeOf = (text: string) => text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    const touching = () => filesUnder('src').filter((path) => {
        const text = codeOf(readFileSync(join(process.cwd(), path), 'utf8'));
        return /obligationIsAnswered|\.resolvedAt\b|resolvedAt\s*=|unresolvedObligations/.test(text);
    });

    it('is decided in one place, and every file that touches it either calls the rule or reads its output', () => {
        const decider = 'src/quality/repair-obligations.ts';
        const touchingFiles = touching();
        // The discovery has to find something, or an empty set would pass this vacuously.
        expect(touchingFiles.length).toBeGreaterThan(3);
        expect(touchingFiles).toContain(decider);

        for (const path of touchingFiles) {
            if (path === decider) continue;
            const text = codeOf(readFileSync(join(process.cwd(), path), 'utf8'));
            const calls = text.includes('obligationIsAnswered(');
            const reads = /\.resolvedAt\b/.test(text) || /resolved\.has\(/.test(text) || text.includes('unresolvedObligations');
            // Either shape is fine — one asks the rule, the other reads what it decided. What is not fine is a file that
            // decides it itself, which is what cg-f1 was.
            expect(calls || reads, `${path} touches the closure decision but neither calls the rule nor reads its output`).toBe(true);
        }
    });

    it('the decider consults the reddening ledger', () => {
        const decider = readFileSync(join(process.cwd(), 'src/quality/repair-obligations.ts'), 'utf8');
        expect(/\bconst\s+answered\s*=/.test(decider)).toBe(true);
        // The disposition, which is a reddening **or** a recorded absence — the second shape exists because a repair to a test
        // or a document has no check that can redden (cg3-f1, cg3-f3).
        expect(decider).toContain('hasFalsifierDisposition(');
    });
});
/**
 * The coverage requirement, which the brief did not state.
 *
 * The gate refuses a record as `incomplete` when a path in its remit is not named by any hypothesis's `targets`. Measured: seven
 * review records across two changes were refused for exactly this, while the brief's own text contained no occurrence of "every
 * path", "must be claimed", "remit", "uncovered" or "incomplete" — so the reviewers could not comply with a condition they were
 * never given. A requirement the reviewer cannot read is a round spent for nothing.
 */
describe('the brief states the condition its record is judged by', () => {
    it('names the remit-coverage requirement in the required-result section', () => {
        const source = readFileSync(new URL('../../src/quality/adversarial.ts', import.meta.url), 'utf8');
        // The words the gate uses, in the place the reviewer reads the record's required shape.
        expect(source).toContain('Every path under review must be claimed by a hypothesis');
        expect(source).toContain('refuses a record as incomplete');
        expect(source).toContain('targets');
    });
});

/**
 * The impact a finding carries, and the invariant that keeps it usable.
 *
 * The pass is asked for what else the repair will touch — an observation it already holds, since it has just read the call sites.
 * Measured cost of its absence: one repair broke eleven fixtures across six files, and running the suite was the only thing that
 * said so. **The invariant is the one that caught me before**: whatever the brief prescribes, the writer must accept, or a pass
 * obeying its own brief has its record refused.
 */
describe('a finding carries the impact of its repair, and the writer accepts what the brief asks for', () => {
    it('is prescribed by the brief and accepted by the schema', () => {
        const brief = readFileSync(new URL('../../src/quality/adversarial.ts', import.meta.url), 'utf8');
        const schema = JSON.parse(readFileSync(new URL('../../schemas/adversarial-review.schema.json', import.meta.url), 'utf8'));
        expect(brief).toContain('Every finding also carries an **impact**');
        // The field the brief prescribes must exist in the schema, which is `additionalProperties: false` — the defect that made
        // a pass obeying the falsifier clause unable to record anything at all.
        expect(schema.properties.findings.items.properties.impact).toBeDefined();
        expect(String(schema.properties.findings.items.properties.impact.description)).toContain('not a repair recipe');
    });

    it('is surfaced where the fixer reads it', () => {
        const ops = readFileSync(new URL('../../src/cli/ops.ts', import.meta.url), 'utf8');
        // A field nothing reads is this line's oldest finding; the status projection is where a fixer sees a finding.
        expect(ops).toContain('finding.impact');
        expect(readFileSync(new URL('../../src/quality/finding-disposition.ts', import.meta.url), 'utf8')).toContain('impact?: string;');
    });
});

/**
 * The class a finding belongs to, which is what lets one revision fix the class instead of one instance.
 *
 * Measured: two repairs on this line fixed one derivation of a concept that has four producers — the change surface — and each time
 * the next round found the next producer (`wcc2-f1`, then `kgs3-f3`). A finding names one location; listing the class is what turns
 * "fix this" into "fix these", and it is also what lets a repair batch close, since a batch closes when its findings are answered.
 */
describe('a finding names the class it is an instance of', () => {
    it('is prescribed by the brief and accepted by the schema', () => {
        const brief = readFileSync(new URL('../../src/quality/adversarial.ts', import.meta.url), 'utf8');
        const schema = JSON.parse(readFileSync(new URL('../../schemas/adversarial-review.schema.json', import.meta.url), 'utf8'));
        expect(brief).toContain('the class it is an instance of and where else that class appears');
        // The invariant R1 states, which this line has broken once already: what the brief prescribes, the writer must accept.
        expect(schema.properties.findings.items.properties.classInstances).toBeDefined();
        expect(schema.properties.findings.items.properties.classInstances.type).toBe('array');
    });

    it('is surfaced where the fixer reads it', () => {
        expect(readFileSync(new URL('../../src/quality/finding-disposition.ts', import.meta.url), 'utf8')).toContain('classInstances?: string[];');
        expect(readFileSync(new URL('../../src/cli/ops.ts', import.meta.url), 'utf8')).toContain('finding.classInstances');
    });
});

/**
 * The delta brief's history is filtered to what the delta is about.
 *
 * Measured: the unfiltered "Earlier attempts" list was 10,742 characters — 31% of a 35,038-character brief — and a controlled
 * experiment on the same revision, with only that block removed, cut the billed total by 25% and the reasoning by 44%, while
 * thinking fell from 50% of the round's content to 39% and tool results rose 24% to 31%: handed less prior material, the reviewer
 * read more and reasoned less. A conclusion about an unchanged path does not need re-deciding — the brief already says so — and
 * carrying it costs reasoning on every turn.
 */
describe('the delta history is limited to the paths that changed', () => {
    it('filters by the hypotheses whose targets changed, and does not filter when it cannot tell', () => {
        const source = readFileSync(new URL('../../src/quality/adversarial.ts', import.meta.url), 'utf8');
        expect(source).toContain('selectRelevantAttempts(previous, surface.changedPaths)');
        // The escape hatch, which matters more than the filter: withholding on a condition that cannot be evaluated would drop
        // material for a reason the reader could not check.
        expect(source).toContain('if (relevantClaims.size === 0) return (record?.attempts ?? [])');
    });
});

/**
 * The delta history is shortened **and says so**.
 *
 * The filter alone would have been silent: a reviewer handed six attempts where eleven were recorded would read the list as
 * complete. Measured after the change: six of eleven attempts are withheld on this change, the block is 253 characters instead of
 * 10,742, and the brief says which six and why — with an offer of the full list.
 */
describe('a shortened history states what it withheld', () => {
    it('renders the withheld count and the reason', () => {
        const source = readFileSync(new URL('../../src/quality/adversarial.ts', import.meta.url), 'utf8');
        expect(source).toContain('attemptsWithheld');
        expect(source).toContain('further attempt(s) are withheld');
        expect(source).toContain('Ask for the full list if you need it');
    });

    it('declares the delta type once, so a field cannot be accepted by one declaration and rejected by another', () => {
        const source = readFileSync(new URL('../../src/quality/adversarial.ts', import.meta.url), 'utf8');
        // The restatement is gone: `attemptsWithheld` was rejected by it while the named type accepted it, which is how the
        // silent version shipped. The status projection's fallback type had drifted the same way, and lost `impact`.
        expect(source).not.toContain('let delta: { from: string; sinceAt?: string; changedPaths: string[]');
        expect(source).toContain("let delta: AdversarialBriefInput['delta'] | undefined;");
    });
});

/**
 * The delta's findings list is limited to the paths that changed, and says what it withheld.
 *
 * Measured before: the block was 20,147 characters — 29% of a 69,746-character brief and 94% of the delta section — because it
 * carried every tracked finding with its full message. After: 15,749 characters and four findings withheld.
 *
 * **And the limit is the data, not the filter**: a finding carries a `path` only when the pass that filed it knew which file it was
 * about, and one that does not is kept — withholding on a condition that cannot be evaluated would drop material for a reason the
 * reader could not check. That is why the reduction is 22% rather than the whole block, and it is the same shape as `rba-f11`'s
 * unit mismatch: the record does not carry what the criterion assumed it carried.
 */
describe('the delta findings list is limited to what the delta is about', () => {
    it('filters by path, keeps what it cannot judge, and counts what it withheld', () => {
        const source = readFileSync(new URL('../../src/quality/adversarial.ts', import.meta.url), 'utf8');
        expect(source).toContain('selectRelevantFindings(await readTrackedFindings(root, taskId), surface.changedPaths)');
        expect(source).toContain('!finding.path || changed.has(finding.path)');
        expect(source).toContain('are withheld from it');
        // And the copy that made it a duplicate is gone: the class section is the one place the findings are listed.
        expect(source).not.toContain('Earlier findings and what was decided about them');
    });
});
