import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { appendClaim, readLedger } from '../../src/store/ledger.js';
import { claimDecisions, unsupportedClaims } from '../../src/store/verdict.js';
import { openLedgerProblems } from '../../src/store/verdict.js';
import { readUpstreamSummary } from '../../src/workflow/navigation.js';
import { seedLedger } from '../helpers/ledger.js';

/**
 * **`one-concept-several-derivations`, covered by a check rather than by prose.**
 *
 * The class is "a concept is re-derived at each call site, so one site is updated and the others keep the old answer" — the
 * sentence this line's findings have belonged to more often than any other. It was listed in the deleted class table with
 * `tests/unit/class-invariants.test.ts` as its covering check, and that file went with the module, so the class lost its
 * check and kept its instances.
 *
 * **Found by looking for the class rather than for an instance**: the count of `evaluateClaim(` call sites outside the
 * kernel was **five** — the ladder's open-problem list, its closure verdict, the change record, the archive gate and the
 * review request — each assembling the same six-input object. They agreed only because they copied the same six lines, and
 * the review request did not even copy them: it asked the verdict list whether a `supported` verdict existed, which reads
 * a claim as satisfied where the kernel reads it `stale` or below strength. Measured on that test's own fixture: it
 * recorded a `static_witness` verdict for a claim whose severity requires an executable falsifier, bound to `rev:unknown`,
 * and the fixture asserted "no gaps" while `decide` judged the claim `stale (evidence_stale_subject,
 * evidence_below_strength)`.
 *
 * So the check has two halves, and the first is the one that catches a new instance: **the kernel's input is assembled in
 * exactly one module**, and the second is that the consumers agree.
 */
const KERNEL = 'src/kernel/decide.ts';
const ASSEMBLY = 'src/store/verdict.ts';

function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) sourceFiles(path, found);
        else if (path.endsWith('.ts')) found.push(path);
    }
    return found;
}

describe('one derivation of "is this claim supported"', () => {
    it('assembles the kernel input in exactly one module outside the kernel', () => {
        const offenders = sourceFiles('src')
            .filter((path) => path !== KERNEL && path !== ASSEMBLY)
            .filter((path) => /evaluateClaim\s*\(/.test(readFileSync(path, 'utf8')));
        expect(
            offenders,
            'these modules assemble the input for `evaluateClaim` themselves, so one fact now has two derivations: '
            + `${offenders.join(', ')}. Ask \`claimDecisions\` in ${ASSEMBLY} instead.`,
        ).toEqual([]);
    });

    it('reports the same claims as the consumers that ask it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-one-derivation-'));
        try {
            await initLayout(root);
            await createTask({
                root,
                id: 'one-derivation',
                title: 'One derivation',
                acceptance: [{ id: 'AC-1', statement: 'A claim nothing supports is one answer for every reader.' }],
            });
            await seedLedger(root, 'one-derivation', { paths: ['.kata/tasks/one-derivation/task.json'] });
            await appendClaim(root, 'one-derivation', {
                id: 'C-unsupported',
                statement: 'nothing supports this yet',
                riskClass: 'boundary',
                severity: 'major',
                dependsOn: ['path:.kata/tasks/one-derivation/task.json'],
                evidenceIds: [],
                challengeIds: [],
                status: 'open',
                at: new Date().toISOString(),
                reopens: 0,
            });

            const ledger = await readLedger(root, 'one-derivation');
            const fromReader = unsupportedClaims(ledger).map((decision) => decision.claimId).sort();
            expect(fromReader).toContain('C-unsupported');

            // Every other reader names the same claim: the ladder's problem list and its closure verdict are the two that
            // decide what the operator is told to do next.
            const read = await openLedgerProblems(root, 'one-derivation');
            if (read.kind !== 'read') throw new Error(`expected a readable ledger, got ${read.detail}`);
            const problems = read.problems.map((problem) => problem.id).sort();
            expect(problems).toEqual(fromReader);

            // **The published closure verdict is gone, and this is where its property lives now.** It was a third surface
            // for the same fact — the reader's list, the problem list, and a field the router had stopped reading — so the
            // assertion is the two that decide something: the problems an operator is handed, and the verdict.
            const upstream = await readUpstreamSummary(root, 'one-derivation');
            expect(upstream.ledger?.deficits.length ?? 0).toBeGreaterThan(0);

            // And the decision agrees with the reader, which is the property the whole class is about.
            expect(upstream.ledger?.verdict).not.toBe('pass');
            expect(claimDecisions(ledger).find((decision) => decision.claimId === 'C-unsupported')?.state).not.toBe('supported');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
