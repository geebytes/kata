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
import { readLedger, reviewDir, declaredPaths, freezeSubject, writeSubject, writePolicy, appendClaim, appendEvidence, replaceEvidence, recordVerdicts, appendChallenge, resolveChallenge, amendChallenge, challengeExists, ensureAssurance, setUsage, appendRun, ledgerReport, writePlan, readPlan } from '../store/ledger.js';
import { ledgerVerdict } from '../store/verdict.js';
import { planReview } from '../producers/planner.js';
import { readSubmission } from '../producers/submission.js';
import { verifyAll } from '../producers/verifiers.js';
import type { EvidenceAdapter, VerifyContext } from '../producers/port.js';
import { createInlineAdapter } from '../assurance/adapters/inline-adapter.js';
import { createFileAdapter } from '../assurance/adapters/file-adapter.js';
import { reasonMessage } from '../kernel/decide.js';
import { envelopeFor } from '../kernel/budget.js';
import { defaultPolicy, loadPolicy } from '../kernel/policy.js';
import { diffSubjects, subjectOf } from '../kernel/subject.js';
import { classifyRisk, policyFloorChangeClaims } from '../kernel/risk.js';
import { RISK_CLASSES, SEVERITIES, type AssuranceLevel, type Challenge, type Claim, type RiskClass, type Severity, type TierName } from '../kernel/types.js';

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
        if (argv.includes('--cost')) {
            // The author-side measurement the round-shaped loop never had, plus the discovery rates it never compared. A
            // rate that cannot be computed is reported as null rather than 0, and the baseline field says so in words.
            outputResult({ ok: true, command: 'ledger status --cost', report: await ledgerReport(options.root, changeId) });
            return;
        }
        outputResult({
            ok: true,
            changeId,
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
            // The reopen count is the author-side cost the round-shaped loop never measured: repairs were per finding and
            // each one minted a revision, while nothing counted how often a claim had to be reopened afterwards.
            const reopened = { ...rest, status: 'open' as const, reopens: (claim.reopens ?? 0) + 1 };
            await appendClaim(options.root, changeId, reopened);
            outputResult({ ok: true, command: 'ledger claim reopen', claim: claim.id, reopens: reopened.reopens });
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
                // Left empty on purpose: the store stamps `at`, because the store is the only writer that knows the time.
                at: '',
                reopens: 0,
            };
            await appendClaim(options.root, changeId, claim);
            outputResult({ ok: true, command: 'ledger claim add', claim });
            return;
        }
        fail({ command: 'ledger claim', error: `unknown action "${action}"` });
        return;
    }

    if (sub === 'usage') {
        // **Where the measured numbers enter.** The kernel refuses to invent a reading — an unmeasurable limit is reported
        // as unknown rather than satisfied — so the host or the operator has to be able to state one, and this is that
        // command. Without it the budget rule would be a mechanism with no writer, which is a defect class of its own.
        if (argv[1] !== 'set') {
            fail({ command: 'ledger usage', error: 'usage takes one action: set' });
            return;
        }
        const numeric = (flag: string): number | undefined => {
            const raw = argValue(argv, flag);
            if (raw === undefined) return undefined;
            const value = Number(raw);
            if (!Number.isFinite(value) || value < 0) {
                fail({ command: 'ledger usage set', error: `${flag} must be a non-negative number` });
                return undefined;
            }
            return value;
        };
        const tokens = numeric('--tokens');
        const wallMs = numeric('--wall-ms');
        const toolCalls = numeric('--tool-calls');
        const usage = {
            ...(tokens === undefined ? {} : { tokens }),
            ...(wallMs === undefined ? {} : { wallMs }),
            ...(toolCalls === undefined ? {} : { toolCalls }),
        };
        if (Object.keys(usage).length === 0) {
            fail({ command: 'ledger usage set', error: 'nothing to record: pass --tokens, --wall-ms or --tool-calls' });
            return;
        }
        const stored = await setUsage(options.root, changeId, usage);
        outputResult({ ok: true, command: 'ledger usage set', budget: stored });
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
            for (const item of read.submission.evidence) {
                const added = await appendEvidence(options.root, changeId, item);
                if (!added.ok) {
                    fail({ command: 'ledger evidence add', error: added.why });
                    return;
                }
            }
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
        if (action === 'replace') {
            const file = argValue(argv, '--file');
            const reason = argValue(argv, '--reason');
            if (file === undefined || reason === undefined || reason.trim() === '') {
                fail({ command: 'ledger evidence replace', error: '--file <set.json> and --reason <why> are required: the one operation that may rewrite evidence must say why.' });
                return;
            }
            const read = readSubmission(JSON.parse(await readFile(file, 'utf8')) as unknown);
            if (!read.ok) {
                fail({ command: 'ledger evidence replace', errors: read.errors });
                return;
            }
            const replaced = await replaceEvidence(options.root, changeId, read.submission.evidence, reason.trim());
            outputResult({ ok: true, command: 'ledger evidence replace', reason: reason.trim(), ...replaced });
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
            // **Recorded, not merely reported.** The adapter's assurance is a measured fact about the round that just ran,
            // and gating the write on a flag is how a change whose checks kata itself observed came to be judged as having
            // no provenance at all: the value appeared in the result and nothing stored it.
            const assurance = await ensureAssurance(options.root, changeId, adapter.assurance as AssuranceLevel);
            outputResult({
                ok: true,
                command: 'ledger evidence verify',
                adapter: adapter.id,
                assurance,
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
            if (await challengeExists(options.root, changeId, id)) {
                // A silent no-op would report success while nothing was recorded — the same shape as an insert that claims
                // to have persisted. Name the collision and say what to use instead.
                fail({ command: 'ledger challenge add', error: `challenge ${id} already exists; amend it (--command with amend) or pick another id` });
                return;
            }
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
        if (action === 'amend') {
            const id = argValue(argv, '--id');
            const command = argValue(argv, '--command');
            const reason = argValue(argv, '--reason');
            if (id === undefined || command === undefined || reason === undefined) {
                fail({ command: 'ledger challenge amend', error: '--id, --command and --reason are all required' });
                return;
            }
            const amended = await amendChallenge(options.root, changeId, id, { command, reason, at: nowIso() });
            if (amended === null) {
                fail({ command: 'ledger challenge amend', error: `no challenge ${id} in this ledger` });
                return;
            }
            outputResult({ ok: true, command: 'ledger challenge amend', challenge: amended, replaced: amended.amendment?.command });
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
        // Written down as well as printed: the reading sets are the input `focus` narrows, and a plan nobody can read
        // afterwards is a printout rather than a record.
        await writePlan(options.root, changeId, plan);
        // The envelope is reported where the operator looks, and it comes from the policy rather than a second derivation:
        // a plan that says what a review must produce is incomplete without the limits it must produce it within.
        outputResult({
            ok: true,
            command: 'ledger plan',
            plan,
            stored: 'plan.json',
            envelope: envelopeFor(ledger.policy),
        });
        return;
    }

    if (sub === 'corpus') {
        // **The connection the two corpora never had.** `scoreCorpus` has existed since the old eval path was written, and
        // the new mechanism's own seed corpus has existed since it was built, and nothing joined them: the old corpus could
        // only be scored from a hand-written manifest, and the seeds were only ever read by one test file. So "what does the
        // mechanism decide on the corpus of its own failure modes" was unanswerable, which is one of the reasons six of the
        // plan's acceptance criteria say "not measurable".
        //
        // This is the referee, and it is deterministic by construction: the seeds are decided by `decide()`, the verdict is
        // compared with what each seed expects, and the rates come out of that comparison. No tokens, no round, no host.
        const { scoreSeeds, reconcileRepositoryCorpora } = await import('../store/corpus.js');
        const score = await scoreSeeds();
        // The coverage half rides along: whether the two corpora ask the same questions is cheap to answer and was never
        // asked, and it is the part a reader needs to know how to read the match count.
        const reconciliation = await reconcileRepositoryCorpora();
        outputResult({ ok: score.mismatched.length === 0, command: 'ledger corpus', ...score, reconciliation });
        if (score.mismatched.length > 0) process.exitCode = 1;
        return;
    }

    if (sub === 'decide') {
        const c0Raw = argValue(argv, '--c0');
        const tierFlag = argValue(argv, '--tier');
        const assuranceFlag = argValue(argv, '--assurance');
        const verdict = await ledgerVerdict({
            root: options.root,
            changeId,
            c0Tokens: c0Raw === undefined ? null : Number(c0Raw),
            ...(tierFlag === undefined ? {} : { tier: tierFlag as TierName }),
            ...(assuranceFlag === undefined ? {} : { assurance: assuranceFlag as AssuranceLevel }),
        });
        if (verdict.kind !== 'decided') {
            // Neither state may look like a pass: a ledger nobody wrote and a ledger that cannot be read are both refusals,
            // and the second is named separately because "unreadable" and "absent" are different facts.
            fail({ command: 'ledger decide', state: verdict.kind, error: verdict.detail });
            return;
        }
        const { decision } = verdict;
        outputResult({
            ok: decision.verdict === 'pass',
            command: 'ledger decide',
            verdict: decision.verdict,
            tier: decision.riskTier,
            claims: verdict.claims,
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
        // **A focus narrows a plan; it does not invent one.** Without a stored plan there are no reading sets to narrow, and
        // producing an impact cone by re-deriving the dependencies here would be the second answer to a question the planner
        // already answered — so it is a named state rather than a silent fallback.
        const storedPlan = await readPlan(options.root, changeId);
        if (storedPlan === null) {
            fail({ command: 'ledger focus', state: 'no-plan', error: 'no plan has been stored for this change: run `ledger plan` first, because a focus narrows the reading sets a plan produced.' });
            return;
        }
        const plan = storedPlan as { readingSets?: Array<{ claimId: string; paths: string[]; truncated: boolean }>; tier?: string };
        const sets = new Map((plan.readingSets ?? []).map((set) => [set.claimId, set]));
        const diff = diffSubjects(ledger.subject, subjectOf(current.pathDigests));
        const drifted = new Set([...diff.changed, ...diff.added, ...diff.removed]);
        const reopened = ledger.claims
            .map((claim) => {
                const set = sets.get(claim.id);
                const own = claim.dependsOn
                    .filter((dep) => dep.startsWith('path:'))
                    .map((dep) => dep.slice('path:'.length))
                    .filter((path) => drifted.has(path));
                if (own.length === 0) return null;
                // The reading set comes from the plan, intersected with what actually moved: the point of the set is that the
                // reader's context is decided by the claim, and the point of the intersection is that a claim whose other
                // paths did not move is not re-read in full.
                const read = set === undefined ? own : set.paths.filter((path) => drifted.has(path));
                return {
                    claimId: claim.id,
                    read: read.length > 0 ? read : own,
                    why: own.join(', '),
                    ...(set === undefined ? { note: 'the stored plan carries no reading set for this claim' } : {}),
                    ...(set?.truncated ? { truncated: true } : {}),
                };
            })
            .filter((entry): entry is { claimId: string; read: string[]; why: string; note?: string; truncated?: boolean } => entry !== null);
        const reopenedIds = new Set(reopened.map((entry) => entry.claimId));
        outputResult({
            ok: true,
            command: 'ledger focus',
            frozen: ledger.subject.revision,
            current: subjectOf(current.pathDigests).revision,
            tier: plan.tier ?? null,
            changed: diff.changed,
            added: diff.added,
            removed: diff.removed,
            reopened,
            // What a dispatcher may skip: the saving is stated rather than implied, so a reader can see the context this
            // narrows away instead of having to believe it.
            untouched: ledger.claims.map((claim) => claim.id).filter((id) => !reopenedIds.has(id)),
            note: reopened.length === 0
                ? 'nothing the plan covers has moved, so no claim needs re-reading'
                : `read ${reopened.reduce((total, entry) => total + entry.read.length, 0)} path(s) across ${reopened.length} claim(s)`,
        });
        return;
    }

    fail({ command: 'ledger', error: `unknown verb "${sub}"`, verbs: ['status', 'freeze', 'policy', 'claim', 'evidence', 'challenge', 'plan', 'decide', 'focus'] });
}
