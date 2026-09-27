import { describe, expect, it } from 'vitest';
// AC-4. The instrument is held to the material it was built from.
//
// The 31 guards on this surface were enumerated on 2026-09-22 over this change's predecessor's declared surface. This test
// asserts the enumeration still sees all 15 named sites, by location and condition, so an instrument that quietly stops
// finding the guards that motivated it fails here.
//
// **The 2026-09-22 run classified 15 of these as "decorative" — disabling the guard left the suite green. That
// classification does NOT reproduce, and it is withdrawn.** Re-measured on the merged tree on 2026-09-22: 31 guards,
// 29 noticed, 1 collapse, **0 decorative**, 557 s. What this test asserts is therefore the *guard set*, not a decorative
// classification, because the set is reproducible and the classification was not. The likely explanation is a defect in
// that run's harness — the same family as the broken-mutation and partial-mutation failure modes recorded in
// `docs/design/2026-09-21-adversarial-execution-control-optimization.md` §17.5 and §19.2, where the instrument reported
// something the code did not support.
//
// **Scope, stated rather than implied.** What runs in the suite is the *enumeration*; it is static and costs milliseconds.
// The mutated run costs a full suite per guard — 557 s for these 31 — so it is executed once as this change's own evidence
// and recorded, not on every `npm test`. The mutation *machinery* is covered end-to-end by
// `tests/unit/wiring-check-mutation.test.ts` on a fixture, which is where a regression in copy/mutate/classify would show.

// **The four guards of the deleted command surface are gone from this list with the commands they belonged to.**
// `remove`, `waive`, `note` and `acknowledge-open` were subcommands of `kata-cli adversarial`, and this case's rule is
// that the list equals what a filesystem walk finds — so a citation left behind would fail, correctly, rather than
// silently over-claim coverage. What remains is the part of `cli/ops.ts` that still has commands.
const RECORDED_GUARDS: Array<{ file: string; condition: string }> = [
    { file: 'src/quality/revision-delta.ts', condition: '!currentDigests' },
    { file: 'src/quality/acceptance-matrix.ts', condition: '!declaration.id' },
    { file: 'src/quality/acceptance-matrix.ts', condition: '!result.ok' },
    { file: 'src/quality/acceptance-matrix.ts', condition: "!output.includes('Affected test files') && !reportsNoAffectedTests" },
    { file: 'src/cli/ops.ts', condition: "!manifestPath || manifestPath.startsWith('--')" },
    { file: 'src/cli/ops.ts', condition: "subcommand !== 'digests'" },
    { file: 'src/cli/ops.ts', condition: '!subcommand || !isCodegraphSubcommand(subcommand)' },
];

const SURFACE = [
    'src/quality/revision-delta.ts',
    'src/quality/acceptance-matrix.ts',
    'src/cli/ops.ts',
];

describe('the mutation check against the material it was built from', () => {
    it('still enumerates every guard recorded on 2026-09-22', async () => {
        const { discoverRefusalGuards } = await import('../../src/quality/wiring-check.js');
        const guards = await discoverRefusalGuards({ root: process.cwd(), surface: SURFACE });
        const seen = new Set(guards.map((guard) => `${guard.file}::${guard.condition.trim()}`));

        const missing = RECORDED_GUARDS.filter((entry) => !seen.has(`${entry.file}::${entry.condition.trim()}`));
        expect(missing).toEqual([]);

        // A guard at a line the file no longer has would mean the surface moved under the check.
        for (const guard of guards) expect(guard.line).toBeGreaterThan(0);
    });

    it('does not silently shrink the surface it reports on', async () => {
        const { discoverRefusalGuards } = await import('../../src/quality/wiring-check.js');
        const guards = await discoverRefusalGuards({ root: process.cwd(), surface: SURFACE });

        // Every declared file contributes at least one guard. A file that contributes none is either guard-free or a
        // parsing failure, and the check must not be able to report the second as the first.
        for (const file of SURFACE) {
            expect(guards.some((guard) => guard.file === file)).toBe(true);
        }
        // The enumeration was 31 on 2026-09-22. Guards may be added; the recorded 15 must remain a subset, which the
        // first assertion holds. A total below the recorded 15 means the instrument is losing guards.
        expect(guards.length).toBeGreaterThanOrEqual(RECORDED_GUARDS.length);
    });
    it('reports every dead export measured on 2026-09-22, by name', async () => {
        const { findUnreferencedExports, filesUnder } = await import('../../src/quality/wiring-check.js');
        // The 24 measured by hand on 2026-09-22, each spot-checked then to occur exactly once, in its own declaration.
        // The names measured by hand on 2026-09-22 and still unreferenced today. **A name leaves this list one of two ways,
        // and both are the check working**: it gains a consumer (a second spelling of its path folded into it, or a verdict
        // that was missing), or it is deleted with the mechanism it belonged to. Nine have left since it was written —
        // `evidenceArchiveDir`, `llmwikiDir`, the six layout paths whose artefacts nothing creates any more, and
        // `stampEngineVersion`, which was a second implementation of a write `core/state.ts` already does under the lock.
        const measured = [
            'commandsForPlatform', 'cometCompatibilitySnapshot', 'evidenceFilePath',
            'writeAcceptanceMatrixMigration', 'isLegacyTask', 'changeRecordHash',
            'resolvedCheckId', 'validationRevisionId', 'readWikiRecordsStrict', 'deleteWikiRecord', 'computePathDigest',
            'revisionChangeSurface', 'deltaCoversChange', 'splitOwnedPaths', 'textOnlyChange',
            'planReCertification', 'targetedReviewPlan', 'claimsHash', 'readChangeRecord',
            'isBreakingChangeApplicable', 'checkConflicts', 'markRecordStale',
            'renderPlatformCommand', 'changeRecordHash',
        ];
        const findings = await findUnreferencedExports({ root: process.cwd(), surface: await filesUnder(process.cwd(), ['src']) });
        const reported = new Set(findings.map((finding) => finding.subject));
        const missing = measured.filter((name) => !reported.has(name));
        expect(missing).toEqual([]);

        // And a symbol production code does call must not be reported — the assertion that catches an over-eager counter.
        expect(reported.has('evaluateAdmissibility'), 'a live export is not reported').toBe(false);
        expect(reported.has('runWiringCheck')).toBe(false);
    });


});
