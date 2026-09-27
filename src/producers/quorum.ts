/**
 * Quorum — re-exported from the kernel, where the arithmetic lives.
 *
 * **Why this module is now a re-export.** The aggregation was pure arithmetic over verdicts with no I/O and no platform
 * name, so it belonged in `src/kernel`; keeping a second implementation beside the kernel is exactly the
 * "one concept, several derivations" shape this subsystem exists to remove. What was measured while moving it: the old
 * caller handed every producer the ledger's *whole* verdict list, so `byEvidence` never saw two values for one item and
 * `disputed` was unreachable — `security.reviewers: 2` was a number nothing enforced.
 *
 * The module is kept as a named re-export rather than deleted so that the import path documented in the design and used
 * by the producer layer keeps resolving to the one implementation.
 */
export { aggregateQuorum, groupByProducer, type QuorumOutcome, type QuorumRecord } from '../kernel/quorum.js';
