
export type ReviewSeverity = 'blocking' | 'major' | 'minor' | 'note';

/**
 * **The recording half of this module is gone.** `ReviewFindingInput`, `FindingReproduction` and `recordFinding` were the
 * producer of `review.json`'s findings — the round-shaped route's way of recording a problem. Their last caller was an
 * eval fixture, and the four consumers that judged those findings (the approval's severity refusal, its revision-binding
 * message, the judge's input, verify's input) are all deleted or re-pointed at the ledger, so nothing read what this wrote.
 *
 * What is kept is the **shape**, because a record written before this change may still carry findings and the approval
 * round-trips them: `ReviewFinding` describes what `readReview` returns, and `ReviewSeverity` is the vocabulary the repair
 * scope still names. Keeping a shape that is read is not the same as keeping a producer nobody has.
 */
/**
 * The shape a finding has in a review record, kept because the approval round-trips it.
 *
 * `reproduction` is inline rather than a named interface now: its only reader was the producer, and a named type with one
 * reference is the shape this session has been removing rather than adding.
 */
export interface ReviewFinding {
  id: string;
  taskId: string;
  acceptanceId?: string;
  severity: ReviewSeverity;
  message: string;
  path?: string;
  /** How the reviewer confirmed it, when they did — a reproduction oracle, never authorship of the fix. */
  reproduction?: {
    findingId: string;
    /** The declared checks the reviewer re-ran, in the order it ran them. */
    ranChecks: Array<{ checkId: string; testSelector?: string; passed: boolean }>;
    /** True when no declared check could reproduce it, so the finding carried a Build obligation. */
    missingTest: boolean;
  };
  impact?: string;
  classInstances?: string[];
  falsifier?: string;
}
