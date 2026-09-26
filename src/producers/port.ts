/**
 * Ports — the seams between the kernel and everything platform-shaped.
 *
 * Two rules the whole subsystem turns on: a **producer proposes** (claims, evidence, challenges) and a **verifier
 * decides** (a verdict), and the two are never the same party for the same item. That is what replaces the receipt: the
 * evidence is re-decided by execution rather than trusted because of where it came from.
 */
import type { AssuranceLevel, Claim, Evidence, EvidenceType, EvidenceVerdict, Subject } from '../kernel/types.js';

export type CommandOutcome = { code: number; stdout: string; stderr: string; timedOut: boolean };

/**
 * What a verifier is given. Everything it needs is injected, so a verifier is testable without touching a real
 * filesystem and a platform adapter can supply the same shape from anywhere.
 */
export type VerifyContext = {
    root: string;
    subject: Subject;
    run: (command: string) => Promise<CommandOutcome>;
    readText: (relativePath: string) => Promise<string | null>;
    exists: (relativePath: string) => Promise<boolean>;
    writeText: (relativePath: string, content: string) => Promise<void>;
    now: () => string;
};

/** One evidence type, decided. `verifier` names the deciding party, recorded in the verdict for audit. */
export type EvidenceVerifier = {
    type: EvidenceType;
    verifier: string;
    verify: (evidence: Evidence, context: VerifyContext) => Promise<EvidenceVerdict>;
};

/**
 * An adapter is *how* a platform supplies verdicts. Two adapters must reach the same decision for the same subject
 * (kernel invariant K6), which is the only substantive evidence that the kernel is platform-neutral.
 */
export type EvidenceAdapter = {
    id: string;
    assurance: AssuranceLevel;
    /** Capabilities this adapter can actually provide, in the neutral vocabulary. Declared, then refuted by use. */
    capabilities: string[];
    verify: (evidence: Evidence, context: VerifyContext) => Promise<EvidenceVerdict>;
};

/** A producer of claims and evidence. It never submits a verdict: that is the verifier's half. */
export type ReviewProducer = {
    id: string;
    diversity: 'model_family' | 'prompt_strategy' | 'tool_profile' | 'none';
    submit: (input: { subject: Subject; plan: unknown; context: VerifyContext }) => Promise<{
        claims: Claim[];
        evidence: Evidence[];
    }>;
};
