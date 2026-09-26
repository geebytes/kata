/**
 * `kata-cli ledger` — the seven verbs that replace the round-shaped command family.
 *
 * The verbs are deliberately small and each one writes what it learned immediately: freezing a subject, adding a claim,
 * adding evidence, verifying evidence, asking and checking a challenge, planning, and deciding. There is no
 * `record` step to forget and no `salvage` step to recover from forgetting it, because there is no single document that
 * carries the whole review.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argValue } from './invocation.js';
import { outputResult } from './output.js';
import { runProcess } from '../process/run.js';
import { readLedger, reviewDir, declaredPaths, freezeSubject, writeSubject, writePolicy, appendClaim, appendEvidence, recordVerdicts, appendChallenge, resolveChallenge, setAssurance, setUsage, appendRun } from '../store/ledger.js';
import { aggregateQuorum } from '../producers/quorum.js';
import { planReview } from '../producers/planner.js';
import { readSubmission } from '../producers/submission.js';
import { verifyAll } from '../producers/verifiers.js';
import type { EvidenceAdapter, VerifyContext } from '../producers/port.js';
import { createInlineAdapter } from '../assurance/adapters/inline-adapter.js';
import { createFileAdapter } from '../assurance/adapters/file-adapter.js';
import { decide, reasonMessage } from '../kernel/decide.js';
import { defaultPolicy, loadPolicy } from '../kernel/policy.js';
import { diffSubjects, subjectOf } from '../kernel/subject.js';
import { classifyRisk, policyFloorChangeClaims } from '../kernel/risk.js';
import { RISK_CLASSES, SEVERITIES, type AssuranceLevel, type Challenge, type Claim, type EvidenceVerdict, type RiskClass, type Severity } from '../kernel/types.js';

export type LedgerCommandOptions = { root: string; changeId: string };

function fail(payload: Record<string, unknown>): void {
    outputResult({ ok: false, ...payload });
    process.exitCode = 1;
}

function nowIso(): string {
    return new Date().toISOString();
}

function buildContext(root: string, subject: { revision: string; pathDigests: Record<string, string> }): VerifyContext {
    return {
        root,
        subject,
        run: async (command: string) => {
            const result = await runProcess('sh', ['-c', command], { cwd: root, timeoutMs: 600_000, maxCaptureBytes: 200_000 });
            return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.exitCode === 124 };
        },
        readText: async (relativePath: string) => {
            try {
                return await readFile(join(root, relativePath), 'utf8');
            } catch {
                return null;
            }
        },
        exists: async (relativePath: string) => {
            try {
                await readFile(join(root, relativePath));
                return true;
            } catch {
                return false;
            }
        },
        writeText: async (relativePath: string, content: string) => {
            await writeFile(join(root, relativePath), content, 'utf8');
        },
        now: nowIso,
    };
}

function adapterFor(argv: string[], root: string): EvidenceAdapter {
    const requested = argValue(argv, '--adapter') ?? 'inline';
    if (requested === 'file') {
        return createFileAdapter({ dir: argValue(argv, '--results-dir') ?? '.kata/review-results' });
    }
    return createInlineAdapter();
}

/** Recompute the subject from the declared paths, without writing it: what the working tree holds right now. */
async function currentSubject(input: LedgerCommandOptions): Promise<{ revision: string; pathDigests: Record<string, string> } | null> {
    const paths = await declaredPaths(input.root, input.changeId);
    if (paths.length === 0) return null;
    const frozen = await freezeSubject({ root: input.root, paths });
    return frozen.ok ? frozen.subject : null;
}

export async function runLedgerCommand(argv: string[], options: LedgerCommandOptions): Promise<void> {
    // The family reads its own `--change`, because the entry point's positional guesser cannot tell a subcommand from an id:
    // `ledger status --change x` would otherwise read `status` as the change id, which it did until this line existed.
    const changeId = argValue(argv, '--change') ?? options.changeId;
    const sub = argv[0] ?? 'status';
    const ledger = await readLedger(options.root, changeId);

    if (sub === 'status') {
        outputResult({
            ok: true,
            changeId: changeId,
            dir: reviewDir(options.root, changeId),
            recordedFiles: ledger.recordedFiles,
            subject: ledger.subject?.revision ?? null,
            claims: ledger.claims.length,
            evidence: ledger.evidence.length,
            verdicts: ledger.verdicts.length,
            challenges: ledger.challenges.filter((challenge) => challenge.state === 'open').length,
            runs: ledger.runs.length,
            assurance: ledger.assurance,
            usage: ledger.usage,
            note: ledger.recordedFiles.length === 0
                ? 'nothing has been recorded for this change yet; that is a state, not an empty review'
                : undefined,
        });
        return;
    }

    if (sub === 'freeze') {
        const explicit = argValue(argv, '--paths');
        const paths = explicit === undefined
            ? await declaredPaths(options.root, changeId)
            : explicit.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
        if (paths.length === 0) {
            fail({ command: 'ledger freeze', error: 'no paths to freeze: declare ownedPaths on the task or pass --paths' });
            return;
        }
        const frozen = await freezeSubject({ root: options.root, paths });
        if (!frozen.ok) {
            fail({ command: 'ledger freeze', error: frozen.error, unreadable: frozen.unreadable });
            return;
        }
        await writeSubject(options.root, changeId, frozen.subject);
        outputResult({ ok: true, command: 'ledger freeze', revision: frozen.subject.revision, paths: paths.length });
        return;
    }

    if (sub === 'policy') {
        if (argv.includes('--init')) {
            await writePolicy(options.root, changeId, defaultPolicy());
            outputResult({ ok: true, command: 'ledger policy', wrote: 'policy.json', tierDefaults: ['standard', 'strict', 'security'] });
            return;
        }
        const raw = argValue(argv, '--set-file');
        if (raw !== undefined) {
            const parsed = JSON.parse(await readFile(raw, 'utf8')) as unknown;
            const loaded = loadPolicy(parsed);
            if (!loaded.ok) {
                fail({ command: 'ledger policy', error: loaded.error });
                return;
            }
            // **A change to the floor table is itself a change.** Every moved floor becomes a claim of class `privilege`,
            // so the table that decides how deep a review goes cannot be quietly widened to make a gate easier — without
            // this, setting a sensitive directory to `low` would be a back door around the deep tier.
            const floorClaims = policyFloorChangeClaims({
                previous: ledger.policy.riskFloors,
                next: loaded.policy.riskFloors,
                at: nowIso(),
                requireReview: loaded.policy.riskFloorAudit.changesRequireReview,
            });
            for (const claim of floorClaims) await appendClaim(options.root, changeId, claim);
            await writePolicy(options.root, changeId, loaded.policy);
            outputResult({ ok: true, command: 'ledger policy', wrote: 'policy.json', floorClaims: floorClaims.map((claim) => claim.id) });
            return;
        }
        outputResult({ ok: true, command: 'ledger policy', policy: ledger.policy });
        return;
    }

    if (sub === 'claim') {
        const action = argv[1] ?? 'list';
        if (action === 'list') {
            outputResult({
                ok: true,
                claims: ledger.claims.map((claim) => ({
                    id: claim.id,
                    severity: claim.severity,
                    riskClass: claim.riskClass,
                    status: claim.status,
                    statement: claim.statement,
                })),
            });
            return;
        }
        if (action === 'show') {
            const id = argv[2];
            const claim = ledger.claims.find((entry) => entry.id === id);
            if (!claim) {
                fail({ command: 'ledger claim show', error: `no claim ${String(id)} in this ledger` });
                return;
            }
            outputResult({ ok: true, claim, verdicts: ledger.verdicts.filter((verdict) => claim.evidenceIds.includes(verdict.evidenceId)) });
            return;
        }
        if (action === 'waive') {
            const id = argv[2];
            const reason = argValue(argv, '--reason');
            const claim = ledger.claims.find((entry) => entry.id === id);
            if (!claim) {
                fail({ command: 'ledger claim waive', error: `no claim ${String(id)} in this ledger` });
                return;
            }
            if (reason === undefined || reason.trim() === '') {
                fail({ command: 'ledger claim waive', error: 'a waiver needs --reason; a decision without a reason is refused by the gate' });
                return;
            }
            await appendClaim(options.root, changeId, { ...claim, status: 'waived', waiver: { reason, at: nowIso() } });
            outputResult({ ok: true, command: 'ledger claim waive', claim: claim.id, reason });
            return;
        }
        if (action === 'reopen') {
            const id = argv[2];
            const claim = ledger.claims.find((entry) => entry.id === id);
            if (!claim) {
                fail({ command: 'ledger claim reopen', error: `no claim ${String(id)} in this ledger` });
                return;
            }
            const { waiver: _dropped, ...rest } = claim;
            await appendClaim(options.root, changeId, { ...rest, status: 'open' });
            outputResult({ ok: true, command: 'ledger claim reopen', claim: claim.id });
            return;
        }
        if (action === 'add') {
            const statement = argValue(argv, '--statement');
            const riskClass = argValue(argv, '--risk-class');
            const severity = argValue(argv, '--severity');
            if (statement === undefined || riskClass === undefined || severity === undefined) {
                fail({ command: 'ledger claim add', error: '--statement, --risk-class and --severity are all required' });
                return;
            }
            if (!RISK_CLASSES.includes(riskClass as RiskClass)) {
                fail({ command: 'ledger claim add', error: `--risk-class must be one of ${RISK_CLASSES.join(', ')}` });
                return;
            }
            if (!SEVERITIES.includes(severity as Severity)) {
                fail({ command: 'ledger claim add', error: `--severity must be one of ${SEVERITIES.join(', ')}` });
                return;
            }
            const id = argValue(argv, '--id') ?? `C${ledger.claims.length + 1}`;
            const dependsOnRaw = argValue(argv, '--depends-on') ?? '';
            const dependsOn = dependsOnRaw
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry !== '') as Claim['dependsOn'];
            const evidenceRaw = argValue(argv, '--evidence') ?? '';
            const claim: Claim = {
                id,
                statement,
                riskClass: riskClass as RiskClass,
                severity: severity as Severity,
                dependsOn,
                evidenceIds: evidenceRaw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''),
                challengeIds: [],
                status: 'open',
            };
            await appendClaim(options.root, changeId, claim);
            outputResult({ ok: true, command: 'ledger claim add', claim });
            return;
        }
        fail({ command: 'ledger claim', error: `unknown action "${action}"` });
        return;
    }

    if (sub === 'evidence') {
        const action = argv[1] ?? 'list';
        if (action === 'list') {
            outputResult({
                ok: true,
                evidence: ledger.evidence.map((item) => ({
                    id: item.id,
                    type: item.type,
                    verdict: ledger.verdicts.find((verdict) => verdict.evidenceId === item.id)?.verdict ?? null,
                })),
            });
            return;
        }
        if (action === 'add') {
            const file = argValue(argv, '--file');
            if (file === undefined) {
                fail({ command: 'ledger evidence add', error: '--file <submission.json> is required' });
                return;
            }
            const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
            const read = readSubmission(parsed);
            if (!read.ok) {
                fail({ command: 'ledger evidence add', errors: read.errors });
                return;
            }
            for (const claim of read.submission.claims) await appendClaim(options.root, changeId, claim);
            for (const item of read.submission.evidence) await appendEvidence(options.root, changeId, item);
            await appendRun(options.root, changeId, {
                at: nowIso(),
                producer: argValue(argv, '--producer') ?? 'unstated',
                claims: read.submission.claims.length,
                evidence: read.submission.evidence.length,
                diversity: argValue(argv, '--diversity') ?? 'none',
            });
            outputResult({
                ok: true,
                command: 'ledger evidence add',
                claims: read.submission.claims.length,
                evidence: read.submission.evidence.length,
                note: 'claims and evidence are written as they arrive; there is no submission document to lose',
            });
            return;
        }
        if (action === 'verify') {
            if (!ledger.subject) {
                fail({ command: 'ledger evidence verify', error: 'the subject is not frozen: run `ledger freeze` first' });
                return;
            }
            const only = argValue(argv, '--id');
            const items = only === undefined ? ledger.evidence : ledger.evidence.filter((item) => item.id === only);
            if (items.length === 0) {
                fail({ command: 'ledger evidence verify', error: 'there is no evidence to verify' });
                return;
            }
            const context = buildContext(options.root, ledger.subject);
            const adapter = adapterFor(argv, options.root);
            // One list walk, with the adapter deciding: the adapter is what makes the round observed or relayed, and the
            // walk itself lives in one place so an adapter cannot accidentally skip an item.
            const verdicts = await verifyAll(items, context, adapter.verify);
            await recordVerdicts(options.root, changeId, verdicts);
            if (argv.includes('--assurance')) {
                await setAssurance(options.root, changeId, adapter.assurance as AssuranceLevel);
            }
            outputResult({
                ok: true,
                command: 'ledger evidence verify',
                adapter: adapter.id,
                assurance: adapter.assurance,
                verdicts: verdicts.map((verdict) => ({
                    id: verdict.evidenceId,
                    type: verdict.evidenceType,
                    verdict: verdict.verdict,
                    observed: verdict.observed,
                })),
            });
            return;
        }
        fail({ command: 'ledger evidence', error: `unknown action "${action}"` });
        return;
    }

    if (sub === 'challenge') {
        const action = argv[1] ?? 'list';
        if (action === 'list') {
            outputResult({ ok: true, challenges: ledger.challenges });
            return;
        }
        if (action === 'add') {
            const claimId = argValue(argv, '--claim');
            const command = argValue(argv, '--command');
            if (claimId === undefined || command === undefined) {
                fail({ command: 'ledger challenge add', error: '--claim and --command are required' });
                return;
            }
            if (!ledger.claims.some((claim) => claim.id === claimId)) {
                fail({ command: 'ledger challenge add', error: `no claim ${claimId} in this ledger` });
                return;
            }
            const id = argValue(argv, '--id') ?? `X${ledger.challenges.length + 1}`;
            const challenge: Challenge = {
                id,
                claimId,
                command,
                failsOn: argValue(argv, '--fails-on') ?? ledger.subject?.revision ?? 'unknown',
                state: 'open',
                at: nowIso(),
            };
            await appendChallenge(options.root, changeId, challenge);
            const claim = ledger.claims.find((entry) => entry.id === claimId) as Claim;
            await appendClaim(options.root, changeId, { ...claim, challengeIds: [...claim.challengeIds, id] });
            outputResult({ ok: true, command: 'ledger challenge add', challenge });
            return;
        }
        if (action === 'check') {
            if (!ledger.subject) {
                fail({ command: 'ledger challenge check', error: 'the subject is not frozen: run `ledger freeze` first' });
                return;
            }
            const only = argValue(argv, '--id');
            const open = ledger.challenges.filter((challenge) => (only === undefined ? challenge.state === 'open' : challenge.id === only));
            if (open.length === 0) {
                fail({ command: 'ledger challenge check', error: 'there is no open challenge to check' });
                return;
            }
            const context = buildContext(options.root, ledger.subject);
            const outcomes: Array<{ id: string; code: number; state: Challenge['state'] }> = [];
            for (const challenge of open) {
                const result = await context.run(challenge.command);
                // A counterexample that no longer fails is a claim the author has fixed: it resolves the challenge
                // rather than being silently ignored, and the observation is recorded with it.
                const state: Challenge['state'] = result.code === 0 ? 'withdrawn' : 'open';
                await resolveChallenge(options.root, changeId, challenge.id, {
                    state,
                    observed: `exit ${result.code} when checked against ${ledger.subject.revision}`,
                    at: nowIso(),
                });
                outcomes.push({ id: challenge.id, code: result.code, state });
            }
            outputResult({ ok: true, command: 'ledger challenge check', outcomes });
            return;
        }
        fail({ command: 'ledger challenge', error: `unknown action "${action}"` });
        return;
    }

    if (sub === 'plan') {
        const current = await currentSubject({ root: options.root, changeId });
        if (!current) {
            fail({ command: 'ledger plan', error: 'the declared paths could not be frozen; declare ownedPaths or fix the paths' });
            return;
        }
        const changed = ledger.subject === null
            ? Object.keys(current.pathDigests)
            : (() => {
                const diff = diffSubjects(ledger.subject as never, current as never);
                return [...diff.changed, ...diff.added, ...diff.removed];
            })();
        const risk = classifyRisk({ paths: changed.length > 0 ? changed : Object.keys(current.pathDigests), policy: ledger.policy });
        const c0Raw = argValue(argv, '--c0');
        const plan = planReview({
            subject: current,
            claims: ledger.claims,
            policy: ledger.policy,
            tier: risk.tier,
            changedPaths: changed.length > 0 ? changed : Object.keys(current.pathDigests),
            c0Tokens: c0Raw === undefined ? null : Number(c0Raw),
        });
        outputResult({ ok: true, command: 'ledger plan', plan });
        return;
    }

    if (sub === 'decide') {
        if (!ledger.subject) {
            fail({ command: 'ledger decide', error: 'the subject is not frozen: run `ledger freeze` first' });
            return;
        }
        const current = await currentSubject({ root: options.root, changeId });
        const c0Raw = argValue(argv, '--c0');
        const quorumRecords = (() => {
            const groups = new Map<string, { diversity: string; verdicts: EvidenceVerdict[] }>();
            for (const run of ledger.runs) {
                const group = groups.get(run.producer) ?? { diversity: run.diversity, verdicts: [] };
                groups.set(run.producer, group);
            }
            return [...groups.entries()].map(([id, group]) => ({ id, diversity: group.diversity, verdicts: ledger.verdicts }));
        })();
        const evidenceToClaim: Record<string, string> = {};
        for (const claim of ledger.claims) for (const evidenceId of claim.evidenceIds) evidenceToClaim[evidenceId] = claim.id;
        const quorum = quorumRecords.length > 1
            ? aggregateQuorum({
                records: quorumRecords,
                evidenceToClaim,
                requiredReviewers: ledger.policy.tiers[argValue(argv, '--tier') === 'security' ? 'security' : 'strict'].reviewers,
                demandDiversity: ledger.policy.diversity.requiredOn.includes('quorum'),
            })
            : undefined;
        const risk = classifyRisk({
            paths: current === null ? Object.keys(ledger.subject.pathDigests) : Object.keys(current.pathDigests),
            policy: ledger.policy,
        });
        const tier = (argValue(argv, '--tier') as 'standard' | 'strict' | 'security' | undefined) ?? risk.tier;
        const decision = decide({
            subject: ledger.subject,
            claims: ledger.claims,
            evidence: ledger.evidence,
            verdicts: ledger.verdicts,
            challenges: ledger.challenges,
            policy: ledger.policy,
            tier,
            declaredRiskClasses: [...new Set(ledger.claims.map((claim) => claim.riskClass))],
            assurance: (argValue(argv, '--assurance') as AssuranceLevel | undefined) ?? ledger.assurance,
            usage: ledger.usage,
            c0Tokens: c0Raw === undefined ? null : Number(c0Raw),
            discovery: { independentChallenges: ledger.challenges.filter((challenge) => challenge.state !== 'open').length },
            ...(quorum === undefined ? {} : { quorum: { disputedClaimIds: quorum.disputedClaimIds, undiversified: quorum.undiversified, reviewers: quorum.reviewers } }),
        });
        outputResult({
            ok: decision.verdict === 'pass',
            command: 'ledger decide',
            verdict: decision.verdict,
            tier: decision.riskTier,
            reasons: decision.reasons.map((entry) => ({
                code: entry.code,
                claim: entry.claimId ?? null,
                detail: entry.detail,
                message: reasonMessage(entry),
            })),
            deficits: decision.deficits,
            reusedEvidence: decision.reusedEvidence,
            revalidateClaims: decision.revalidateClaims,
            undiversified: decision.undiversified,
        });
        if (decision.verdict !== 'pass') process.exitCode = 1;
        return;
    }

    if (sub === 'focus') {
        if (!ledger.subject) {
            fail({ command: 'ledger focus', error: 'the subject is not frozen: run `ledger freeze` first' });
            return;
        }
        const current = await currentSubject({ root: options.root, changeId });
        if (!current) {
            fail({ command: 'ledger focus', error: 'the declared paths could not be frozen' });
            return;
        }
        const diff = diffSubjects(ledger.subject, subjectOf(current.pathDigests));
        const impact = ledger.claims
            .filter((claim) => claim.dependsOn.some((dep) => {
                const path = dep.startsWith('path:') ? dep.slice('path:'.length) : null;
                return path !== null && (diff.changed.includes(path) || diff.added.includes(path) || diff.removed.includes(path));
            }))
            .map((claim) => claim.id);
        outputResult({
            ok: true,
            command: 'ledger focus',
            frozen: ledger.subject.revision,
            current: subjectOf(current.pathDigests).revision,
            changed: diff.changed,
            added: diff.added,
            removed: diff.removed,
            unchanged: diff.unchanged.length,
            revalidateClaims: impact,
            verdictsCarriedOver: ledger.claims.filter((claim) => !impact.includes(claim.id))
                .flatMap((claim) => claim.evidenceIds)
                .filter((evidenceId) => ledger.verdicts.some((verdict) => verdict.evidenceId === evidenceId && verdict.verdict === 'supported'))
                .length,
            note: impact.length === 0
                ? 'no claim rests on a path that moved, so every supported verdict carries over'
                : 'only the claims above reopen; the rest keep their verdicts because the digests they rest on are identical',
        });
        return;
    }

    fail({ command: 'ledger', error: `unknown verb "${sub}"`, verbs: ['status', 'freeze', 'policy', 'claim', 'evidence', 'challenge', 'plan', 'decide', 'focus'] });
}
