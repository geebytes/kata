/**
 * The execution layer's trust boundary: fresh context is a **capability**, not an assertion (§3.2.1).
 *
 * Kata is a CLI. It cannot start a subagent and cannot inspect a host's session. The gate this replaces was honest about
 * that and then asserted the property anyway: `record.executedInFreshContext !== true → not_fresh_context` is a boolean
 * an agent writes about itself, and §2.1 found it load-bearing in the *passing predicate* — not a quality nicety but a
 * trust gap inside the judgment foundation.
 *
 * So the property moves to a contract with two halves, and this module is the half Kata can own:
 *
 *   - **`ReviewRunRequest`** — issued by Kata, content-addressed, carrying the revision identity, the brief hash, the
 *     budget, and the result-schema version. The `runId` is a one-time nonce.
 *   - **`ReviewExecutionReceipt`** — host-authored, measured and bound: it binds to the request by
 *     nonce and hash, advertises the capabilities it actually provides, and reports telemetry the CLI could never
 *     observe: tool calls, output bytes, tokens, truncations, wall time.
 *
 * The other half — implementing the capability set — belongs to the host platform and lives outside this repository.
 * The capabilities name environment properties, not products: any host that can isolate a session, restrict the tool set
 * and enforce a budget satisfies them.
 * Kata's half is to define the shape, require it where a node requires it, and **refuse to certify a pass that lacks
 * it**. A host without `fresh_context` cannot satisfy an escalated node: it yields `executor_unavailable` and blocks. It
 * is never silently downgraded to "the agent said it was fresh", because that is precisely the unsound state.
 *
 * `docs/verfify.md`'s rule falls out of this too: the receipt carries telemetry and capability, **never a prior
 * verdict** — facts may be cached across runs, judgments may not.
 */

/** What an executor can be trusted to provide, as advertised on its receipt. */
export type ExecutorCapability =
    /** The reviewer runs in a context that did not author the change, and the host proves it rather than the agent. */
    | 'fresh_context'
    /** The reviewer cannot write to the repository. */
    | 'read_only_fs'
    /** The host constrains which tools the reviewer may call. */
    | 'bounded_tools'
    /** The host enforces the envelope and reports exhaustion rather than letting the round run on. */
    | 'budget_enforced';

/** The review nodes, as far as capability requirements are concerned. */
export type ExecutionNode = 'review' | 'verify';

/**
 * Which capabilities a node requires.
 *
 * `review` is the always-run node, so it needs the minimum that makes an independent look meaningful: a context the
 * author did not write and a filesystem the reviewer cannot mutate. `verify` is the **escalated** node — the one a
 * `strict`/`security` profile buys back specifically for a second independent look — so it additionally requires the host
 * to bound tool use and enforce the budget. A host that cannot isolate read-only, or cannot stop a runaway round, is not
 * a host that can satisfy the node whose entire purpose is a controlled second look.
 */
export function requiredCapabilitiesForNode(node: ExecutionNode): ExecutorCapability[] {
    const base: ExecutorCapability[] = ['fresh_context', 'read_only_fs'];
    return node === 'verify' ? [...base, 'bounded_tools', 'budget_enforced'] : base;
}

/** What Kata hands to an executor: the immutable input identity plus the run nonce. */
export interface ReviewRunRequest {
    /** One-time nonce. A receipt naming anything else did not answer this request. */
    runId: string;
    /** sha256 of the canonical request body, so the receipt can bind to exactly what was issued. */
    requestSha256: string;
    node: ExecutionNode;
    revisionId: string;
    manifestHash?: string;
    /** sha256 of the brief text this run is answering. */
    briefSha256: string;
    /** sha256 of the structured ReviewIR the executor must use; it is never allowed to re-render live workspace state. */
    reviewIrSha256: string;
    /** sha256 of the semantic CandidateFreeze used to decide re-certification; it prevents revision-ID-only reuse. */
    candidateFreezeSha256?: string;
    /** The envelope the executor must enforce (§3.2.2). */
    budget: { maxHypotheses: number; maxToolCalls: number; maxOutputBytes: number; maxWallMs: number };
    /** The capabilities this node requires, so a host can decide whether it can serve the request at all. */
    requiredCapabilities: ExecutorCapability[];
    /** Version of the result schema, so a receipt and a record cannot silently disagree about the shape. */
    resultSchemaVersion: number;
}

/** Telemetry only the executor can observe. Facts, never a verdict. */
/**
 * What the executor measured. A field is `null` when the platform could not report it.
 *
 * Not measured is a distinct state from measured-as-zero, and the difference matters more here than anywhere else in this
 * design: the whole mechanism exists to replace numbers someone asserted with numbers something measured. A route that can
 * only obtain some of them must say which — the alternative is a fabricated zero, which is the same defect as
 * `executedInFreshContext: true` wearing a number.
 */
export interface ReviewExecutionTelemetry {
    /** Measured by the platform, or `null` where it could not be. */
    toolCalls: number | null;
    outputBytes: number | null;
    tokens: number | null;
    truncations: number | null;
}

const TELEMETRY_FIELDS = ['toolCalls', 'outputBytes', 'tokens', 'truncations'] as const;

/**
 * The telemetry fields this receipt could not measure, named rather than silently zero.
 *
 * A consumer exists so this is not a vocabulary with nothing reading it: `adversarial status` reports it per node, because
 * an operator asking "was this round measured" should not have to infer it from a `0`.
 */
export function unmeasuredTelemetry(telemetry: Partial<ReviewExecutionTelemetry> | undefined): string[] {
    if (!telemetry) return [...TELEMETRY_FIELDS];
    return TELEMETRY_FIELDS.filter((field) => telemetry[field] === null);
}

/** Where a receipt came from. Provenance for an auditor; never a gate criterion. */
export interface ReviewExecutionProvenance {
    /** Which host produced the receipt. */
    platform: string;
    /** The session the round ran in, so the platform's own record can be found. */
    sessionId?: string;
    /** The platform's completion line verbatim — the source the relayed figures were transcribed from. */
    completionReport?: string;
}

/** The executor's report. Authored by the host, never by the reviewer. */
export interface ReviewExecutionReceipt {
    /** Must equal the issued request's nonce. */
    runId: string;
    /** Must equal the issued request's hash. */
    requestSha256: string;
    capabilities: ExecutorCapability[];
    startedAt: string;
    endedAt: string;
    telemetry: ReviewExecutionTelemetry;
    /**
     * Present when the executor recorded where it ran.
     *
     * Expected of a relaying route — a subagent round returns its figures through the calling session — because the
     * identifiers are what let an auditor check those figures against the platform's own record.
     */
    executor?: ReviewExecutionProvenance;
    status: 'completed' | 'budget_exhausted' | 'timeout' | 'cancelled' | 'executor_unavailable';
}

/** Why a receipt was not accepted as proof the node's capabilities were actually available. */
export interface ReceiptRefusal {
    reason: 'executor_unavailable' | 'receipt_unbound' | 'capability_missing';
    detail: string;
    /** Capabilities the node required and the receipt did not advertise. */
    missing: ExecutorCapability[];
}

/**
 * Whether a receipt proves the node's required capabilities for the request it claims to answer.
 *
 * Three separate refusals, deliberately kept apart because their remedies differ:
 *
 *   - `executor_unavailable` — no receipt at all, or one whose own status says the executor could not serve the run. The
 *     remedy is a capable host, never setting a flag.
 *   - `receipt_unbound` — a receipt for a *different* run. The remedy is to re-issue, not to trust it.
 *   - `capability_missing` — a bound receipt that does not advertise everything the node requires. The remedy is a host
 *     that provides the rest.
 *
 * A `budget_exhausted` status is **not** a refusal here: it is a truthful report about the round, and its refusal happens
 * one level up, where §3.1.2's predicate turns it into a refused state. Conflating the two would make "the round ran out
 * of budget" indistinguishable from "the host could not run the round".
 */
export function verifyExecutionReceipt(input: {
    request: ReviewRunRequest;
    receipt?: ReviewExecutionReceipt;
}): { ok: true; receipt: ReviewExecutionReceipt } | { ok: false; refusal: ReceiptRefusal } {
    const { request, receipt } = input;

    if (!receipt) {
        return {
            ok: false,
            refusal: {
                reason: 'executor_unavailable',
                detail: `no execution receipt was recorded, so ${request.node} cannot be certified: a context the agent describes as fresh is not a capability`,
                missing: request.requiredCapabilities,
            },
        };
    }
    if (receipt.status === 'executor_unavailable') {
        return {
            ok: false,
            refusal: {
                reason: 'executor_unavailable',
                detail: 'the executor reported that it could not serve this request',
                missing: request.requiredCapabilities,
            },
        };
    }
    if (receipt.runId !== request.runId || receipt.requestSha256 !== request.requestSha256) {
        return {
            ok: false,
            refusal: {
                reason: 'receipt_unbound',
                detail: 'the receipt does not bind to this request, so it proves nothing about this run',
                missing: [],
            },
        };
    }
    const missing = request.requiredCapabilities.filter((capability) => !receipt.capabilities.includes(capability));
    if (missing.length > 0) {
        return {
            ok: false,
            refusal: {
                reason: 'capability_missing',
                detail: `the executor does not provide ${missing.join(', ')}, which ${request.node} requires`,
                missing,
            },
        };
    }
    return { ok: true, receipt };
}
