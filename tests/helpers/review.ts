/**
 * Shared fixtures for the kernel and ledger tests.
 *
 * Everything here is in-memory: the kernel takes data, and a verifier is handed an injected context, so a test can decide
 * without a repository, a process or a temp directory. That is what makes the kernel's purity checkable rather than
 * aspirational.
 */
import type { VerifyContext } from '../../src/producers/port.js';
import { defaultPolicy, type Policy } from '../../src/kernel/policy.js';
import { subjectOf } from '../../src/kernel/subject.js';
import type { Challenge, Claim, Evidence, EvidenceVerdict, Subject } from '../../src/kernel/types.js';

export function makeSubject(files: Record<string, string>): Subject {
    const digests: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
        digests[path] = `${path.length}-${content.length}-${content.slice(0, 8)}`.padEnd(16, 'f');
    }
    return subjectOf(digests);
}

export function makeContext(input: {
    subject: Subject;
    files?: Record<string, string>;
    /** A rule that can see the current file contents, so a mutation actually changes the exit code. */
    exitRule?: (command: string, files: Record<string, string>) => number | undefined;
}): VerifyContext {
    const files = { ...(input.files ?? {}) };
    return {
        root: '/tmp/does-not-exist',
        subject: input.subject,
        run: async (command: string) => {
            const code = input.exitRule?.(command, files) ?? 0;
            return { code, stdout: `ran: ${command}`, stderr: code === 0 ? '' : `${command} failed`, timedOut: false };
        },
        readText: async (relativePath: string) => (relativePath in files ? (files[relativePath] as string) : null),
        exists: async (relativePath: string) => relativePath in files,
        writeText: async (relativePath: string, content: string) => {
            files[relativePath] = content;
        },
        now: () => '2026-09-27T00:00:00.000Z',
        producer: () => ({ runId: 'test-run', actor: 'test' }),
    };
}

export function makeClaim(overrides: Partial<Claim> = {}): Claim {
    return {
        id: 'C1',
        statement: 'the invariant holds',
        riskClass: 'consistency',
        severity: 'major',
        dependsOn: ['path:src/a.ts'],
        evidenceIds: ['E1'],
        challengeIds: [],
        status: 'open',
        at: '2026-09-27T00:00:00.000Z',
        reopens: 0,
        ...overrides,
    };
}

/**
 * **A fixture per evidence type, because the union is discriminated and `oneOf` means exactly one branch.**
 *
 * The old helper always carried `static_witness`'s fields and then spread the overrides, so every fixture built as
 * `makeEvidence({type: 'executable_falsifier', command, mutation})` still carried `ref` and `assertion` — an item no
 * writer produces, and one the schema refuses. Three cases were building evidence that way and passing, because nothing
 * validated what a fixture wrote; they failed the moment the ledger enforced its schemas.
 */
export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
    const byType: Record<Evidence['type'], Record<string, unknown>> = {
        static_witness: { id: 'E1', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' },
        executable_falsifier: {
            id: 'E1', type: 'executable_falsifier', command: 'grep -q holds src/a.ts',
            mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' },
        },
        cross_artifact_contradiction: {
            id: 'E1', type: 'cross_artifact_contradiction', a: 'src/a.ts', b: 'src/b.ts', literal: 'holds',
            comparator: 'literal-in-a-not-b',
        },
        expert_concurrence: { id: 'E1', type: 'expert_concurrence', reviewers: ['one', 'two'], humanAck: 'ack-1' },
    };
    const type = (overrides.type ?? 'static_witness') as Evidence['type'];
    return { ...byType[type], ...overrides } as Evidence;
}

/** A counterexample aimed at a claim; `state: 'open'` means it still fails, which is what the kernel reports. */
export function makeChallenge(overrides: Partial<Challenge> = {}): Challenge {
    return {
        id: 'X1',
        claimId: 'C1',
        command: 'false',
        failsOn: 'rev:test',
        state: 'open',
        at: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

export function makeVerdict(overrides: Partial<EvidenceVerdict> = {}): EvidenceVerdict {
    return {
        evidenceId: 'E1',
        evidenceType: 'static_witness',
        verdict: 'supported',
        observed: 'the file contains the literal',
        at: '2026-09-27T00:00:00.000Z',
        verifier: 'test',
        subjectRevision: 'rev:unknown',
        producer: { runId: 'test-run', actor: 'test' },
        ...overrides,
    };
}

/** A policy whose tiers accept the assurance levels the tests use, so a test can isolate one rule at a time. */
export function makePolicy(overrides: Partial<Policy> = {}): Policy {
    const base = defaultPolicy();
    return { ...base, ...overrides };
}
