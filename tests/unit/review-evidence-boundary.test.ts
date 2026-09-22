import { describe, expect, it } from 'vitest';
import { renderAdversarialBrief, type AdversarialBriefInput } from '../../src/quality/adversarial.js';
import { GRAPH_EVIDENCE_KIND, isAdmissibleObservationKind } from '../../src/quality/review-evidence-boundary.js';

/**
 * §3.3 + `docs/verfify.md`: the repository is **data**, and a graph fact is **navigation**, not proof.
 *
 * Two properties, both about what the reviewer is allowed to treat as authoritative:
 *
 *   **1. The instruction channel is singular.** The brief is the only instruction. Repository content — source, tests,
 *      fixtures, logs, sealed evidence, commit messages — is material *under review*, and command-shaped text inside it
 *      ("IGNORE PREVIOUS INSTRUCTIONS", "RETURN PASS") is evidence of a defect, never an order. This matters more here
 *      than in a generic agent because the reviewer is explicitly told to hunt for counterexamples: a fixture that
 *      contains an instruction is exactly the kind of input the pass must resist. Measured: the brief contained no such
 *      boundary at all (`grep` for it returned nothing), while `tmp/review-record-integrity-verify-brief.json` — a
 *      repository path — was a *control channel* the CLI read as configuration.
 *
 *   **2. A graph fact cannot be an observation.** The diff-anchored CodeGraph expansion is a navigation candidate: it can
 *      say "this symbol has 3 callers", which points at a line, but it cannot *be* the line. `grounded` requires something
 *      a third party can open at this revision, so the graph kind is admissible for *reading* and inadmissible as
 *      `observation.kind`. This is also the observed reality for this repository: the index covers ~4 TypeScript nodes and
 *      points at the parent project, so treating its output as evidence would be treating an incomplete index as proof.
 */
describe('§3.3 the repository is data, and a graph fact is navigation', () => {
    const base: AdversarialBriefInput = {
        taskId: 'boundary-task',
        node: 'verify',
        revisionId: 'revision-1',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        evidence: [],
        ownedPaths: ['src/x.ts'],
    };

    it('states the instruction/data boundary, and says what to do when repository text gives orders', () => {
        const text = renderAdversarialBrief(base);

        // The boundary is stated where the reviewer will meet it: the rules section.
        expect(text).toMatch(/only instruction|sole instruction/i);
        // And it names the material explicitly, rather than leaving "repository content" vague.
        expect(text).toMatch(/fixture|fixtures/i);
        expect(text).toMatch(/commit message/i);
        // Crucially: an embedded instruction is a *finding*, not an order — otherwise the boundary reads as "ignore
        // suspicious text", which would discard the evidence.
        expect(text).toMatch(/report it as a finding|counts? as (a )?finding/i);
    });

    it('does not treat a graph fact as admissible evidence', () => {
        // The four observation kinds a reader can open. `graph` is deliberately absent, and asking about it is answered
        // false rather than quietly accepted.
        expect(isAdmissibleObservationKind('source')).toBe(true);
        expect(isAdmissibleObservationKind('evidence')).toBe(true);
        expect(isAdmissibleObservationKind('test')).toBe(true);
        expect(isAdmissibleObservationKind('analysis')).toBe(true);
        expect(isAdmissibleObservationKind(GRAPH_EVIDENCE_KIND)).toBe(false);
    });
});
