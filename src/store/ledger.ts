/**
 * The ledger store — incremental, file per fact, one writer at a time.
 *
 * The single-channel failure this replaces: a round produced one JSON document at the very end, so a round that never
 * emitted it produced nothing (28 of 62 measured). Here a claim, an evidence item, a verdict and a challenge are each
 * written the moment they exist, so there is no last step to lose. Reading reports which files exist, so "nothing was
 * recorded" is a visible state rather than an empty list.
 */
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContent } from '../core/hash.js';
import { taskDir, taskPath } from '../core/layout.js';
import { withTaskLock } from '../core/state.js';
import type { BudgetUsage } from '../kernel/budget.js';
import { defaultPolicy, loadPolicy, type Policy } from '../kernel/policy.js';
import { evaluateClaim, type ClaimState } from '../kernel/decide.js';
import { assuranceAtLeast } from '../kernel/types.js';
import { responseRate, type Probe, type ProbeAnswer } from '../kernel/discovery.js';
import { diffSubjects } from '../kernel/subject.js';
import { subjectOf } from '../kernel/subject.js';
import type { AssuranceLevel, Challenge, Claim, ClaimStatus, Evidence, EvidenceVerdict, Subject } from '../kernel/types.js';

const FILES = {
    subject: 'subject.json',
    policy: 'policy.json',
    claims: 'claims.json',
    evidence: 'evidence.json',
    verdicts: 'verdicts.json',
    challenges: 'challenges.json',
    /**
     * Append-only: every verdict ever recorded, with the producer that decided it and what it superseded.
     *
     * `verdicts.json` is a projection of this; the history is the record. A reversal used to be unobservable — the
     * projection was overwritten in place — which made the most interesting fact about a verdict the one fact the ledger
     * could not show.
     */
    verdictHistory: 'verdict-history.jsonl',
    probes: 'probes.json',
    /** What the reviewer answered, recorded with the command and the observation. */
    probeAnswers: 'probe-answers.json',
    usage: 'usage.json',
    runs: 'runs.json',
    /** The plan the operator was handed, kept so `focus` narrows a *record* rather than re-deriving one. */
    plan: 'plan.json',
} as const;

export async function appendProbe(root: string, changeId: string, probe: Probe): Promise<Probe> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.probes);
        const items = (await readJson<Probe[]>(path)) ?? [];
        if (!items.some((entry) => entry.id === probe.id)) items.push(probe);
        await writeJson(root, changeId, FILES.probes, items);
        return probe;
    });
}

export async function readProbes(root: string, changeId: string): Promise<Probe[]> {
    return (await readJson<Probe[]>(join(reviewDir(root, changeId), FILES.probes))) ?? [];
}

/**
 * Record an answer, and refuse a second one.
 *
 * A probe's answer is **write-once** for the same reason evidence is: it is a fact about what the reviewer observed. A
 * re-answer would let a reviewer that failed once keep trying until something passed, which is the opposite of an after-
 * the-fact question.
 */
export async function answerProbe(
    root: string,
    changeId: string,
    answer: ProbeAnswer,
): Promise<{ ok: true; answer: ProbeAnswer } | { ok: false; why: string }> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.probeAnswers);
        const items = (await readJson<ProbeAnswer[]>(path)) ?? [];
        if (items.some((entry) => entry.probeId === answer.probeId)) {
            return { ok: false as const, why: `${answer.probeId} has already been answered; a probe is answered once, so a reviewer cannot try until something passes` };
        }
        items.push(answer);
        await writeJson(root, changeId, FILES.probeAnswers, items);
        return { ok: true as const, answer };
    });
}

export async function readProbeAnswers(root: string, changeId: string): Promise<ProbeAnswer[]> {
    return (await readJson<ProbeAnswer[]>(join(reviewDir(root, changeId), FILES.probeAnswers))) ?? [];
}

export type LedgerRun = { at: string; producer: string; claims: number; evidence: number; diversity: string; /** Why this write happened, when it is a correction rather than an addition. */ note?: string };

export type Ledger = {
    changeId: string;
    dir: string;
    subject: Subject | null;
    policy: Policy;
    claims: Claim[];
    evidence: Evidence[];
    verdicts: EvidenceVerdict[];
    challenges: Challenge[];
    usage: BudgetUsage;
    assurance: AssuranceLevel;
    runs: LedgerRun[];
    /** The files that exist. An empty list is the honest report of a review that recorded nothing. */
    recordedFiles: string[];
    /**
     * Files that exist and cannot be parsed.
     *
     * Kept apart from `recordedFiles` because a corrupted ledger and an absent one are different facts: a read that
     * swallows a parse failure makes "nobody wrote anything" and "what was written is unreadable" the same answer, which
     * is how a broken record comes to look like a clean one.
     */
    malformedFiles: string[];
    /** Why a stored policy was refused, when one exists and does not load. `null` when none was stored or it loaded. */
    policyRejected: string | null;
    /** Sections of the stored policy this reader filled because the document predates them. */
    policyFilled: string[];
};

export function reviewDir(root: string, changeId: string): string {
    return join(taskDir(root, changeId), 'review');
}

async function readJson<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
        return null;
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Store the plan, so the reading sets it computed have a reader.
 *
 * The planner derived per-claim reading sets from the first day and **nothing consumed them** — measured in the plan
 * audit, the only `readingSet` reader in the repository was the old path's brief renderer, so the item that exists to make
 * a review cheaper per review (the context decided by the claim rather than by the whole change) bought nothing. A plan
 * nobody can read afterwards is a printout, so the plan is written down and `focus` narrows it by drift.
 */
export async function writePlan(root: string, changeId: string, plan: unknown): Promise<void> {
    await mutate(root, changeId, async () => writeJson(root, changeId, FILES.plan, plan));
}

export async function readPlan(root: string, changeId: string): Promise<unknown | null> {
    return readJson<unknown>(join(reviewDir(root, changeId), FILES.plan));
}

export async function readLedger(root: string, changeId: string): Promise<Ledger> {
    const dir = reviewDir(root, changeId);
    const recordedFiles: string[] = [];
    const malformedFiles: string[] = [];
    // **One file here is not a JSON document.** `verdict-history.jsonl` is line-delimited, so parsing it whole reports a
    // healthy audit trail as malformed — and a malformed file makes the whole ledger `unreadable`, which is how a
    // correctness fix for verdict reversals would have refused every change in the repository. The reader knows which
    // shape each file has, so it parses the one JSONL file per line and reports *its* bad lines through the same field.
    for (const name of Object.values(FILES)) {
        if (!(await exists(join(dir, name)))) continue;
        recordedFiles.push(name);
        try {
            const text = await readFile(join(dir, name), 'utf8');
            if (name.endsWith('.jsonl')) {
                if (parseJsonLines(text).malformed > 0) malformedFiles.push(name);
            } else {
                JSON.parse(text);
            }
        } catch {
            malformedFiles.push(name);
        }
    }
    const rawPolicy = await readJson<unknown>(join(dir, FILES.policy));
    const loaded = rawPolicy === null ? null : loadPolicy(rawPolicy);
    let policy = defaultPolicy();
    // **A rejected policy is reported, not substituted silently.** Falling back to the default would let a stored policy
    // that the build no longer accepts decide as though it had been read — the record would look clean while the rule that
    // was actually applied came from somewhere else.
    let policyRejected: string | null = null;
    // **Sections a stored policy predates are filled and named.** Measured: `ledgerTierCeiling` was added as required and
    // the three ledgers written before it became unreadable — `decide` refused to decide rather than read them. A reader
    // that cannot read a store of record has destroyed the record, so the fill happens here and `policyFilled` reports it:
    // a substituted rule is visible rather than silent, which is the same distinction the evidence reader keeps.
    let policyFilled: string[] = [];
    if (loaded !== null) {
        if (loaded.ok) {
            policy = loaded.policy;
            policyFilled = loaded.filled;
        } else policyRejected = loaded.error;
    }
    const usage = (await readJson<{ usage: BudgetUsage; assurance: AssuranceLevel }>(join(dir, FILES.usage))) ?? null;
    return {
        changeId,
        dir,
        subject: await readJson<Subject>(join(dir, FILES.subject)),
        policy,
        claims: (await readJson<Claim[]>(join(dir, FILES.claims))) ?? [],
        evidence: (await readJson<Evidence[]>(join(dir, FILES.evidence))) ?? [],
        verdicts: (await readJson<EvidenceVerdict[]>(join(dir, FILES.verdicts))) ?? [],
        challenges: (await readJson<Challenge[]>(join(dir, FILES.challenges))) ?? [],
        usage: usage?.usage ?? {},
        assurance: usage?.assurance ?? 'none',
        runs: (await readJson<LedgerRun[]>(join(dir, FILES.runs))) ?? [],
        recordedFiles,
        malformedFiles,
        policyRejected,
        policyFilled,
    };
}

async function writeJson(root: string, changeId: string, file: string, value: unknown): Promise<void> {
    const dir = reviewDir(root, changeId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Every mutation goes through the task lock, and there is exactly one write entry point per file. */
async function mutate<T>(root: string, changeId: string, action: () => Promise<T>): Promise<T> {
    return withTaskLock(root, changeId, action);
}

export async function freezeSubject(input: { root: string; paths: readonly string[] }): Promise<
    { ok: true; subject: Subject } | { ok: false; error: string; unreadable: string[] }
> {
    const unreadable: string[] = [];
    const digests: Record<string, string> = {};
    for (const path of [...input.paths].sort()) {
        let stats: Awaited<ReturnType<typeof stat>>;
        try {
            stats = await stat(join(input.root, path));
        } catch {
            unreadable.push(path);
            continue;
        }
        // **A declared directory is a set of files, not one unreadable path.** Task declarations name directories
        // (`openspec/changes/<id>` is one), and reading such a path as a file reported it as unreadable — which is how a
        // migration stopped on a declaration that was entirely correct. The walk skips only what is never content.
        if (stats.isDirectory()) {
            const walked = await walkFiles(join(input.root, path));
            for (const file of walked) digests[`${path}/${file}`] = hashContent(await readFile(join(input.root, path, file)));
            continue;
        }
        try {
            digests[path] = hashContent(await readFile(join(input.root, path)));
        } catch {
            unreadable.push(path);
        }
    }
    if (unreadable.length > 0) {
        // The lesson from the identity-policy defect: a path this walker cannot read must not be written as a sentinel,
        // because a sentinel is indistinguishable from a deleted file and makes the revision permanently unusable.
        return {
            ok: false,
            error: `these declared paths cannot be read, so they cannot be frozen: ${unreadable.join(', ')}`,
            unreadable,
        };
    }
    // **The declaration travels with the freeze.** `digests` is the expansion of `paths`, so it cannot be inverted; a
    // file added inside a declared directory afterwards is not one of its keys, and re-freezing those keys could not
    // notice it. Keeping the declaration is what lets drift be measured against the surface that was declared.
    return { ok: true, subject: subjectOf(digests, input.paths) };
}

/**
 * Every file under a directory, relative to it.
 *
 * Deliberately not the identity policy's walk: that one exists for revision identity and skips whatever it is told to
 * skip, while this one answers "what does this declaration hold", so it skips only directories that are never content and
 * reports nothing it cannot read — an unreadable file becomes a missing digest, which the caller's comparison then reports
 * as an added or removed path rather than as "unchanged".
 */
async function walkFiles(absolute: string, prefix = '', depth = 0): Promise<string[]> {
    if (depth > 8) return [];
    const entries = await readdir(absolute, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) found.push(...await walkFiles(join(absolute, entry.name), relative, depth + 1));
        else if (entry.isFile()) found.push(relative);
    }
    return found;
}

export async function writeSubject(root: string, changeId: string, subject: Subject): Promise<void> {
    await mutate(root, changeId, async () => writeJson(root, changeId, FILES.subject, subject));
}

export async function writePolicy(root: string, changeId: string, policy: Policy): Promise<void> {
    await mutate(root, changeId, async () => writeJson(root, changeId, FILES.policy, policy));
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * The store is the only writer that knows the time, so `at` is stamped here rather than by every caller. A claim that
 * already carries one keeps it: rewriting a claim (a waiver, a reopen) must not restamp its origin, or the author-side
 * measurement would reset every time someone acted on it.
 */
export async function appendClaim(root: string, changeId: string, claim: Claim): Promise<Claim> {
    const stamped: Claim = { ...claim, at: claim.at || nowIso(), reopens: claim.reopens ?? 0 };
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.claims);
        const claims = (await readJson<Claim[]>(path)) ?? [];
        const existing = claims.findIndex((entry) => entry.id === stamped.id);
        if (existing >= 0) claims[existing] = stamped;
        else claims.push(stamped);
        await writeJson(root, changeId, FILES.claims, claims);
        return stamped;
    });
}

/**
 * Add one evidence item, and refuse a conflicting id rather than quietly doing nothing.
 *
 * Evidence is **write-once**: an item is a fact about what was measured, so silently overwriting one would rewrite history,
 * and silently ignoring one would report success for a fact that was not written. Both used to happen — the first version
 * skipped an existing id, which is the same shape as an insert that claims to have persisted (`the challenge-id
 * collision`, measured on this repository). An identical re-add is a no-op that says so.
 */
export async function appendEvidence(
    root: string,
    changeId: string,
    evidence: Evidence,
): Promise<{ ok: true; item: Evidence; written: boolean } | { ok: false; why: string }> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.evidence);
        const items = (await readJson<Evidence[]>(path)) ?? [];
        const existing = items.find((entry) => entry.id === evidence.id);
        if (existing) {
            const same = JSON.stringify(existing) === JSON.stringify(evidence);
            return same
                ? { ok: true as const, item: existing, written: false }
                : {
                    ok: false as const,
                    why: `${evidence.id} is already recorded with different content, and evidence is write-once: an item is a fact about what was measured, so changing it would rewrite history. Use \`ledger evidence replace --reason <why>\` when the recorded item is wrong, so the correction carries its reason.`,
                };
        }
        items.push(evidence);
        await writeJson(root, changeId, FILES.evidence, items);
        return { ok: true as const, item: evidence, written: true };
    });
}

/**
 * Replace the whole evidence set, naming why.
 *
 * The one operation that may rewrite evidence, and it is a *named* operation with a **recorded reason** because there is a
 * class of case that has no other door: an item recorded under a type or a shape this build no longer accepts (measured —
 * five items of a removed type held a review approval, and they could not be re-verified, corrected or reached by any other
 * command). Verdicts for replaced items are dropped with them: a verdict is a reading of content, and content that changed
 * has no reading. The reason travels in the run ledger, so a reader sees the correction and why it happened.
 */
export async function replaceEvidence(
    root: string,
    changeId: string,
    items: readonly Evidence[],
    reason: string,
): Promise<{ replaced: number; droppedVerdicts: string[] }> {
    return mutate(root, changeId, async () => {
        const evidencePath = join(reviewDir(root, changeId), FILES.evidence);
        const verdictPath = join(reviewDir(root, changeId), FILES.verdicts);
        const before = (await readJson<Evidence[]>(evidencePath)) ?? [];
        const changed = items.filter((item) => {
            const existing = before.find((entry) => entry.id === item.id);
            return existing === undefined || JSON.stringify(existing) !== JSON.stringify(item);
        });
        const changedIds = new Set(changed.map((item) => item.id));
        await writeJson(root, changeId, FILES.evidence, [...items]);
        const verdicts = (await readJson<EvidenceVerdict[]>(verdictPath)) ?? [];
        const kept = verdicts.filter((verdict) => !changedIds.has(verdict.evidenceId));
        const dropped = verdicts.filter((verdict) => changedIds.has(verdict.evidenceId)).map((verdict) => verdict.evidenceId);
        if (dropped.length > 0) await writeJson(root, changeId, FILES.verdicts, kept);
        const runs = (await readJson<LedgerRun[]>(join(reviewDir(root, changeId), FILES.runs))) ?? [];
        runs.push({ at: nowIso(), producer: 'operator', claims: 0, evidence: changed.length, diversity: 'n/a', note: reason });
        await writeJson(root, changeId, FILES.runs, runs);
        return { replaced: changed.length, droppedVerdicts: dropped };
    });
}

/**
 * Record verdicts, and keep every reading that came before.
 *
 * **The defect this closes.** `recordVerdicts` replaced by `evidenceId`, so a second reading of one item silently became
 * *the* reading: a `refuted` verdict could be overwritten by a later `supported` one and nothing recorded that a reversal
 * had happened. On a store whose whole purpose is to be auditable that is the wrong direction — the reversal is the most
 * interesting fact about a verdict, and it was the one fact the ledger could not show.
 *
 * So there are two files now. `verdicts.json` is the *current* reading of each item (what `decide` consumes and what
 * every reader asks for), and `verdict-history.jsonl` is append-only: every verdict ever recorded, in order, with the
 * producer that decided it. The current view is a projection of the history, and the history cannot be written backwards.
 *
 * The projection is deliberately still by `evidenceId` — re-verifying an item after a correction *should* supersede the
 * old reading; what must not be lost is that the old reading existed. `superseded` records the reading a new one
 * replaced, and it is `null` when the two agreed: an agreement is not a reversal.
 */
export async function recordVerdicts(root: string, changeId: string, incoming: readonly EvidenceVerdict[]): Promise<number> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.verdicts);
        const verdicts = (await readJson<EvidenceVerdict[]>(path)) ?? [];
        const prior = new Map(verdicts.map((verdict) => [verdict.evidenceId, verdict]));
        for (const verdict of incoming) {
            const index = verdicts.findIndex((entry) => entry.evidenceId === verdict.evidenceId);
            if (index >= 0) verdicts[index] = verdict;
            else verdicts.push(verdict);
        }
        await writeJson(root, changeId, FILES.verdicts, verdicts);
        // Appended after the projection is durable, so the history never names a reading the reader cannot see.
        const historyPath = join(reviewDir(root, changeId), FILES.verdictHistory);
        const lines = incoming.map((verdict) => JSON.stringify({ ...verdict, superseded: supersededBy(prior.get(verdict.evidenceId), verdict) }));
        if (lines.length > 0) {
            await mkdir(reviewDir(root, changeId), { recursive: true });
            await appendFile(historyPath, `${lines.join('\n')}\n`, 'utf8');
        }
        return incoming.length;
    });
}

/** The reading a new verdict replaced, or `null` when it was the first or when the two agreed. */
function supersededBy(previous: EvidenceVerdict | undefined, next: EvidenceVerdict): { verdict: EvidenceVerdict['verdict']; at: string } | null {
    if (!previous) return null;
    if (previous.verdict === next.verdict) return null;
    return { verdict: previous.verdict, at: previous.at };
}

/**
 * Every verdict ever recorded, newest last, with what each one superseded.
 *
 * Read as JSONL and parsed per line: a line that cannot be parsed is *counted* rather than thrown, for the same reason
 * the ledger keeps `malformedFiles` apart from `recordedFiles` — an unreadable audit trail is a fact a reader must see,
 * and it must not be indistinguishable from an audit trail nobody wrote.
 */
function parseJsonLines(text: string): { entries: Record<string, unknown>[]; malformed: number } {
    const entries: Record<string, unknown>[] = [];
    let malformed = 0;
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
            entries.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
            malformed += 1;
        }
    }
    return { entries, malformed };
}

export async function readVerdictHistory(root: string, changeId: string): Promise<{ entries: Record<string, unknown>[]; malformed: number }> {
    let raw: string;
    try {
        raw = await readFile(join(reviewDir(root, changeId), FILES.verdictHistory), 'utf8');
    } catch {
        return { entries: [], malformed: 0 };
    }
    return parseJsonLines(raw);
}

export async function appendChallenge(root: string, changeId: string, challenge: Challenge): Promise<Challenge> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.challenges);
        const challenges = (await readJson<Challenge[]>(path)) ?? [];
        if (!challenges.some((entry) => entry.id === challenge.id)) challenges.push(challenge);
        await writeJson(root, changeId, FILES.challenges, challenges);
        return challenge;
    });
}

/**
 * Replace a counterexample's command, keeping the one it replaces.
 *
 * The state resets to `open` on purpose: the previous outcome was measured with a command that has changed, so carrying a
 * `withdrawn` verdict forward would let a correction inherit a result it never earned. The command being replaced and the
 * reason for replacing it stay in `amendment`, because "the measurement was wrong" is a fact worth keeping.
 */
export async function amendChallenge(
    root: string,
    changeId: string,
    challengeId: string,
    amendment: { command: string; reason: string; at: string },
): Promise<Challenge | null> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.challenges);
        const challenges = (await readJson<Challenge[]>(path)) ?? [];
        const index = challenges.findIndex((entry) => entry.id === challengeId);
        if (index < 0) return null;
        const current = challenges[index] as Challenge;
        const amended: Challenge = {
            ...current,
            command: amendment.command,
            state: 'open',
            amendment: { command: current.command, reason: amendment.reason, at: amendment.at },
        };
        delete amended.resolution;
        challenges[index] = amended;
        await writeJson(root, changeId, FILES.challenges, challenges);
        return amended;
    });
}

export async function challengeExists(root: string, changeId: string, challengeId: string): Promise<boolean> {
    const challenges = (await readJson<Challenge[]>(join(reviewDir(root, changeId), FILES.challenges))) ?? [];
    return challenges.some((challenge) => challenge.id === challengeId);
}

export async function resolveChallenge(
    root: string,
    changeId: string,
    challengeId: string,
    resolution: { state: Challenge['state']; observed: string; at: string; /** Whether this check observed the command fail. */ reproduced?: boolean },
): Promise<boolean> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.challenges);
        const challenges = (await readJson<Challenge[]>(path)) ?? [];
        const index = challenges.findIndex((entry) => entry.id === challengeId);
        if (index < 0) return false;
        const current = challenges[index] as Challenge;
        challenges[index] = {
            ...current,
            state: resolution.state,
            resolution: { at: resolution.at, observed: resolution.observed },
            // **A reproduction is a fact that is never cleared.** Set the moment a check observes the command failing,
            // and kept through resolution and amendment: a counterexample that once reproduced is a counterexample,
            // even after the fix makes it pass. This is what lets the discovery floor count challenges that actually
            // challenged something rather than challenges that were declared.
            ...(current.reproduced === true || resolution.reproduced === true ? { reproduced: true } : {}),
        };
        await writeJson(root, changeId, FILES.challenges, challenges);
        return true;
    });
}

/**
 * Record the assurance a round actually achieved, and only upwards.
 *
 * The adapter reports what its own isolation gave the round — `observed` when kata ran the checks itself, `relayed` when
 * they arrive as a recorded result — and that is a measured fact about the round that just happened. Two rules make it
 * trustworthy: it is written rather than merely reported (a value printed in a result and never stored decides nothing),
 * and it never lowers what is recorded, so a later weaker adapter cannot quietly demote an observed ledger.
 */
export async function ensureAssurance(root: string, changeId: string, achieved: AssuranceLevel): Promise<AssuranceLevel> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.usage);
        const current = (await readJson<{ usage: BudgetUsage; assurance: AssuranceLevel }>(path)) ?? { usage: {}, assurance: 'none' as AssuranceLevel };
        const strongest = assuranceAtLeast(achieved, current.assurance) ? achieved : current.assurance;
        if (strongest !== current.assurance) {
            await writeJson(root, changeId, FILES.usage, { ...current, assurance: strongest });
        }
        return strongest;
    });
}

export async function setUsage(root: string, changeId: string, usage: BudgetUsage): Promise<void> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.usage);
        const current = (await readJson<{ usage: BudgetUsage; assurance: AssuranceLevel }>(path)) ?? { usage: {}, assurance: 'none' as AssuranceLevel };
        await writeJson(root, changeId, FILES.usage, { ...current, usage });
    });
}

export async function appendRun(root: string, changeId: string, run: LedgerRun): Promise<void> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.runs);
        const runs = (await readJson<LedgerRun[]>(path)) ?? [];
        runs.push(run);
        await writeJson(root, changeId, FILES.runs, runs);
    });
}

/** The paths a change declares, read from its own task record — never from a hand-kept list. */
export async function declaredPaths(root: string, changeId: string): Promise<string[]> {
    const raw = await readJson<{ ownedPaths?: string[]; owned_paths?: string[] }>(taskPath(root, changeId));
    if (raw === null) return [];
    return raw.ownedPaths ?? raw.owned_paths ?? [];
}

/**
 * **The measurement the round-shaped loop never had.**
 *
 * Two costs were invisible and one question unanswerable. Invisible: how long a claim waited between being declared and
 * being supported, and how many times a claim had to be reopened — the author-side loop, which was 1–2 hours per round and
 * was never counted, while the largest single saving on this line came from *not* repairing twenty-three minor findings.
 * Unanswerable: whether the evidence ever caught anything, since nothing compared refuted verdicts against the total.
 *
 * A rate that cannot be computed is reported as `null`, never as zero: with no recorded baseline, the honest statement is
 * that the baseline does not exist yet, and the field says so rather than inviting a reader to read 0 as "found nothing".
 */
export type LedgerReport = {
    changeId: string;
    recorded: boolean;
    claims: {
        total: number;
        byStatus: Record<ClaimStatus, number>;
        /** Claims whose dependencies moved since their verdict, computed per decision (`ClaimState.stale`). */
        automaticReopens: number;
        /** Claims a person re-opened with `ledger claim reopen`, stamped by the store. */
        attributableReopens: number;
        /** The sum — the quantity the acceptance item means by "re-review", under a name that says so. */
        reReviewClaims: number;
        /** Claims that name no evidence at all. */
        withoutEvidence: number;
        /** Claims naming an evidence id no item carries: the same gap the kernel reports as `evidence_missing`. */
        namingUnrecordedEvidence: number;
        /**
         * The state of each claim, derived by the kernel's own predicate.
         *
         * `byStatus` above is what the claims *declare* (`open` and so on) and is not consulted by the decision; this is
         * what the evidence shows. Two numbers side by side is the point: an operator reading six open claims next to a
         * decision that says `pass` is reading a report whose two halves answer different questions. `null` when no
         * subject is frozen, because then no state can be derived at all and a count would be an invention.
         */
        bySupport: Record<ClaimState, number> | null;
        derived: Array<{ claimId: string; state: ClaimState }>;
    };
    evidence: {
        total: number;
        byType: Record<string, number>;
        byVerdict: Record<string, number>;
        unverified: number;
    };
    challenges: { open: number; withdrawn: number; resolved: number };
    authorSide: {
        firstClaimAt: string | null;
        lastVerifiedAt: string | null;
        claimToSupportedMs: Array<{ claimId: string; ms: number | null }>;
        medianClaimToSupportedMs: number | null;
    };
    budget: BudgetUsage;
    discovery: {
        /** Refuted verdicts over all verdicts: how often the evidence caught something, not how long anyone looked. */
        refutationRate: number | null;
        /** Withdrawn counterexamples over all counterexamples: how often the author's fix actually removed the defect. */
        challengeWithdrawalRate: number | null;
        /**
         * Answered probes over asked ones — the response rate the after-the-fact question exists to produce.
         *
         * `null` when nothing was asked, never zero: an empty denominator is an unmeasured question, and this is the same
         * rule the other two rates follow.
         */
        probeResponseRate: number | null;
        probesAsked: number;
        probesAnswered: number;
        /**
         * The change-level baseline the acceptance items compare against, or why it is absent.
         *
         * **This field used to be the constant `'none recorded yet'`** — a literal, written by no code path, so it stayed
         * that string however much data accumulated. A report field that can never take another value reads as a
         * measurement that has not started; it is now read from `buildBaseline`, the reader the retired records and the
         * run registry already had, so the number appears as soon as the data does.
         */
        baseline: { changes: number; meanReportedTokens: number | null } | { unreported: string };
    };
};

/** The baseline, or a named reason it could not be read — never a placeholder that reads as a measurement. */
/**
 * How many *different* questions a probe list asks.
 *
 * The probe's identity is the command it asks — the answer type carries no kind and no path, and both are recoverable from
 * the command anyway. Counting distinct commands means a stored list that repeats a question reports one, whatever produced
 * it, which is the property the discovery floor needs.
 */
function distinctProbeCount(items: ReadonlyArray<{ command: string }>): number {
    return new Set(items.map((item) => item.command.trim())).size;
}

async function baselineOrReason(root: string): Promise<LedgerReport['discovery']['baseline']> {
    try {
        const { buildBaseline } = await import('./baseline.js');
        const report = await buildBaseline(root);
        return { changes: report.c0.changes, meanReportedTokens: report.c0.meanReportedTokens };
    } catch (error) {
        return { unreported: `the baseline could not be read: ${(error as Error).message}` };
    }
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? (sorted[middle] as number)
        : Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

/**
 * Is the ledger still about the current content?
 *
 * The same rule the dispositions learned the hard way: a verdict must not outlive the content it was about. The ledger
 * froze a subject when it was created, so before anything is approved on its authority the frozen digests are compared
 * with what the paths hold now — and a path that cannot be read is reported rather than treated as unchanged, because
 * "invisible" and "identical" are not the same answer.
 */
export async function ledgerDrift(root: string, changeId: string): Promise<{
    changed: string[];
    added: string[];
    removed: string[];
    unreadable: string[];
    subjectRevision: string;
} | null> {
    const ledger = await readLedger(root, changeId);
    if (!ledger.subject) return null;
    // **Re-walk the declaration, not its expansion.** `Object.keys(ledger.subject.pathDigests)` is the set of files that
    // existed at the freeze; a file added inside a declared directory since then is not among them, so the comparison could
    // report "unchanged" about a directory that grew. A subject frozen before `declaredPaths` existed falls back to its
    // digest keys — the best surface that revision recorded — and that fallback is named rather than silent.
    const declared = ledger.subject.declaredPaths ?? Object.keys(ledger.subject.pathDigests);
    const frozen = await freezeSubject({ root, paths: declared });
    if (!frozen.ok) {
        return { changed: [], added: [], removed: [], unreadable: frozen.unreadable, subjectRevision: ledger.subject.revision };
    }
    const diff = diffSubjects(ledger.subject, frozen.subject);
    return {
        changed: [...diff.changed],
        added: [...diff.added],
        removed: [...diff.removed],
        unreadable: [],
        subjectRevision: ledger.subject.revision,
    };
}

export async function ledgerReport(root: string, changeId: string): Promise<LedgerReport> {
    const ledger = await readLedger(root, changeId);
    const byStatus = { open: 0, supported: 0, refuted: 0, insufficient: 0, waived: 0 } as Record<ClaimStatus, number>;
    for (const claim of ledger.claims) byStatus[claim.status] += 1;

    const byType: Record<string, number> = {};
    for (const item of ledger.evidence) byType[item.type] = (byType[item.type] ?? 0) + 1;
    const byVerdict: Record<string, number> = {};
    for (const verdict of ledger.verdicts) byVerdict[verdict.verdict] = (byVerdict[verdict.verdict] ?? 0) + 1;

    const verdictByEvidence = new Map(ledger.verdicts.map((verdict) => [verdict.evidenceId, verdict]));
    // The same predicate the gate uses, called rather than re-implemented: a report that derived support its own way would
    // be the second answer to one question, which is the defect this subsystem exists to remove.
    // **The same reader the gates ask, imported lazily because this module owns the store the reader reads.** The comment
    // already said "called rather than re-implemented"; it was called with this module's *own* copy of the six inputs,
    // which is the derivation the class is about — one of five, until they were folded into `claimDecisions`.
    const evaluations = ledger.subject === null
        ? null
        : (await import('./verdict.js')).claimDecisions(ledger);
    const bySupport = evaluations === null
        ? null
        : evaluations.reduce((totals, evaluation) => {
            totals[evaluation.state] += 1;
            return totals;
        }, { supported: 0, waived: 0, unsupported: 0, refuted: 0, missing: 0, inconclusive: 0, stale: 0, below_strength: 0, challenged: 0 } as Record<ClaimState, number>);
    const claimToSupportedMs = ledger.claims
        .map((claim) => {
            const declaredAt = Date.parse(claim.at);
            if (!Number.isFinite(declaredAt)) return { claimId: claim.id, ms: null };
            const firstSupport = claim.evidenceIds
                .map((id) => verdictByEvidence.get(id))
                .filter((verdict): verdict is EvidenceVerdict => verdict !== undefined && verdict.verdict === 'supported')
                .map((verdict) => Date.parse(verdict.at))
                .filter((time) => Number.isFinite(time))
                .sort((left, right) => left - right)[0];
            return { claimId: claim.id, ms: firstSupport === undefined ? null : firstSupport - declaredAt };
        });
    const measured = claimToSupportedMs.map((entry) => entry.ms).filter((ms): ms is number => ms !== null);

    const times = [...ledger.claims.map((claim) => claim.at), ...ledger.verdicts.map((verdict) => verdict.at)]
        .filter((value) => Number.isFinite(Date.parse(value)))
        .sort();
    const verdictTimes = ledger.verdicts.map((verdict) => verdict.at).filter((value) => Number.isFinite(Date.parse(value))).sort();

    return {
        changeId,
        recorded: ledger.recordedFiles.length > 0,
        claims: {
            total: ledger.claims.length,
            byStatus,
            /**
             * **Two facts, two names — they used to share one.**
             *
             * `decision.revalidateClaims` is the *automatic* reopen: the claims the delta says must be re-verified because
             * their dependencies moved, computed at every decision and never persisted. `claim.reopens` is the
             * *attributable* reopen: a person ran `ledger claim reopen` because they judged the claim had to be re-opened,
             * and it is stamped by the store so the decision survives.
             *
             * The acceptance item "full re-review count falls" read the second while the first is what "re-review" means to
             * the mechanism, and the second had no test exercising it — a number that could only ever read zero. Both are
             * reported now, under names that say which is which, and `reReviewClaims` is their sum for a reader who wants
             * the one number.
             */
            automaticReopens: (evaluations ?? []).filter((evaluation) => evaluation.state === 'stale').length,
            attributableReopens: ledger.claims.reduce((total, claim) => total + (claim.reopens ?? 0), 0),
            reReviewClaims: (evaluations ?? []).filter((evaluation) => evaluation.state === 'stale').length
                + ledger.claims.reduce((total, claim) => total + (claim.reopens ?? 0), 0),
            withoutEvidence: ledger.claims.filter((claim) => claim.evidenceIds.length === 0).length,
            namingUnrecordedEvidence: ledger.claims
                .filter((claim) => claim.evidenceIds.some((id) => !ledger.evidence.some((item) => item.id === id)))
                .length,
            bySupport,
            derived: (evaluations ?? []).map((evaluation) => ({ claimId: evaluation.claimId, state: evaluation.state })),
        },
        evidence: {
            total: ledger.evidence.length,
            byType,
            byVerdict,
            unverified: ledger.evidence.filter((item) => !verdictByEvidence.has(item.id)).length,
        },
        challenges: {
            open: ledger.challenges.filter((challenge) => challenge.state === 'open').length,
            withdrawn: ledger.challenges.filter((challenge) => challenge.state === 'withdrawn').length,
            resolved: ledger.challenges.filter((challenge) => challenge.state === 'resolved').length,
        },
        authorSide: {
            firstClaimAt: times[0] ?? null,
            lastVerifiedAt: verdictTimes[verdictTimes.length - 1] ?? null,
            claimToSupportedMs,
            medianClaimToSupportedMs: median(measured),
        },
        budget: ledger.usage,
        discovery: {
            refutationRate: ledger.verdicts.length === 0 ? null : (byVerdict.refuted ?? 0) / ledger.verdicts.length,
            challengeWithdrawalRate: ledger.challenges.length === 0
                ? null
                : ledger.challenges.filter((challenge) => challenge.state === 'withdrawn').length / ledger.challenges.length,
            // **Distinct questions on every count, so the rate and the floor read the same denominator.** A stored probe
            // list can hold the same question twice — a hand-written ledger, or one recorded before the generator was
            // de-duplicated — and the rate is the quantity the discovery floor reads, so counting records rather than
            // questions would let repetition raise it.
            probeResponseRate: responseRate({
                asked: distinctProbeCount(await readProbes(root, changeId)),
                answered: distinctProbeCount(await readProbeAnswers(root, changeId)),
            }),
            probesAsked: distinctProbeCount(await readProbes(root, changeId)),
            probesAnswered: distinctProbeCount(await readProbeAnswers(root, changeId)),
            // Read rather than asserted. `buildBaseline` is the only reader of the retired records and the run registry,
            // and a failure to read them is reported as the reason rather than as the constant it replaces.
            baseline: await baselineOrReason(root),
        },
    };
}
