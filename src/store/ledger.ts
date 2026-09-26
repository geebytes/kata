/**
 * The ledger store — incremental, file per fact, one writer at a time.
 *
 * The single-channel failure this replaces: a round produced one JSON document at the very end, so a round that never
 * emitted it produced nothing (28 of 62 measured). Here a claim, an evidence item, a verdict and a challenge are each
 * written the moment they exist, so there is no last step to lose. Reading reports which files exist, so "nothing was
 * recorded" is a visible state rather than an empty list.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashContent } from '../core/hash.js';
import { taskDir, taskPath } from '../core/layout.js';
import { withTaskLock } from '../core/state.js';
import type { BudgetUsage } from '../kernel/budget.js';
import { defaultPolicy, loadPolicy, type Policy } from '../kernel/policy.js';
import { subjectOf } from '../kernel/subject.js';
import type { AssuranceLevel, Challenge, Claim, Evidence, EvidenceVerdict, Subject } from '../kernel/types.js';

const FILES = {
    subject: 'subject.json',
    policy: 'policy.json',
    claims: 'claims.json',
    evidence: 'evidence.json',
    verdicts: 'verdicts.json',
    challenges: 'challenges.json',
    usage: 'usage.json',
    runs: 'runs.json',
} as const;

export type LedgerRun = { at: string; producer: string; claims: number; evidence: number; diversity: string };

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
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export async function readLedger(root: string, changeId: string): Promise<Ledger> {
    const dir = reviewDir(root, changeId);
    const recordedFiles: string[] = [];
    for (const name of Object.values(FILES)) {
        if (await exists(join(dir, name))) recordedFiles.push(name);
    }
    const rawPolicy = await readJson<unknown>(join(dir, FILES.policy));
    const loaded = rawPolicy === null ? null : loadPolicy(rawPolicy);
    const policy = loaded !== null && loaded.ok ? loaded.policy : defaultPolicy();
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
        try {
            const content = await readFile(join(input.root, path));
            digests[path] = hashContent(content);
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
    return { ok: true, subject: subjectOf(digests) };
}

export async function writeSubject(root: string, changeId: string, subject: Subject): Promise<void> {
    await mutate(root, changeId, async () => writeJson(root, changeId, FILES.subject, subject));
}

export async function writePolicy(root: string, changeId: string, policy: Policy): Promise<void> {
    await mutate(root, changeId, async () => writeJson(root, changeId, FILES.policy, policy));
}

export async function appendClaim(root: string, changeId: string, claim: Claim): Promise<Claim> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.claims);
        const claims = (await readJson<Claim[]>(path)) ?? [];
        const existing = claims.findIndex((entry) => entry.id === claim.id);
        if (existing >= 0) claims[existing] = claim;
        else claims.push(claim);
        await writeJson(root, changeId, FILES.claims, claims);
        return claim;
    });
}

export async function appendEvidence(root: string, changeId: string, evidence: Evidence): Promise<Evidence> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.evidence);
        const items = (await readJson<Evidence[]>(path)) ?? [];
        if (!items.some((entry) => entry.id === evidence.id)) items.push(evidence);
        await writeJson(root, changeId, FILES.evidence, items);
        return evidence;
    });
}

/** Verdicts replace by evidence id: a re-verification supersedes an earlier reading of the same item. */
export async function recordVerdicts(root: string, changeId: string, incoming: readonly EvidenceVerdict[]): Promise<number> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.verdicts);
        const verdicts = (await readJson<EvidenceVerdict[]>(path)) ?? [];
        for (const verdict of incoming) {
            const index = verdicts.findIndex((entry) => entry.evidenceId === verdict.evidenceId);
            if (index >= 0) verdicts[index] = verdict;
            else verdicts.push(verdict);
        }
        await writeJson(root, changeId, FILES.verdicts, verdicts);
        return incoming.length;
    });
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

export async function resolveChallenge(
    root: string,
    changeId: string,
    challengeId: string,
    resolution: { state: Challenge['state']; observed: string; at: string },
): Promise<boolean> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.challenges);
        const challenges = (await readJson<Challenge[]>(path)) ?? [];
        const index = challenges.findIndex((entry) => entry.id === challengeId);
        if (index < 0) return false;
        const current = challenges[index] as Challenge;
        challenges[index] = { ...current, state: resolution.state, resolution: { at: resolution.at, observed: resolution.observed } };
        await writeJson(root, changeId, FILES.challenges, challenges);
        return true;
    });
}

export async function setAssurance(root: string, changeId: string, assurance: AssuranceLevel): Promise<void> {
    return mutate(root, changeId, async () => {
        const path = join(reviewDir(root, changeId), FILES.usage);
        const current = (await readJson<{ usage: BudgetUsage; assurance: AssuranceLevel }>(path)) ?? { usage: {}, assurance: 'none' as AssuranceLevel };
        await writeJson(root, changeId, FILES.usage, { ...current, assurance });
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
