/**
 * The one place each kata identifier's shape is decided.
 *
 * Two of them are minted by kata and therefore strict; one is quoted from an upstream document and therefore only has to
 * be an identifier. The schema assets cannot import this file (they are vendored into projects for other tooling), so a
 * test asserts the two agree instead of the shapes being derived — the arrangement the evidence kinds already use.
 */

/** Task ids: minted by `kata open`, used in paths and in the artifact filenames. */
export const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Acceptance-criterion ids: minted by kata (`AC-1`, `AC-2`, …) and referenced by the matrix, the verdicts and findings.
 * Strict on purpose — they are kata's own numbering, and a typo has to be catchable.
 */
export const acceptanceIdPattern = /^AC-[0-9]+$/;

/**
 * Upstream requirement ids: **quoted from the upstream document**, not minted by kata.
 *
 * This is why the shape is an identifier rather than a fixed prefix: when the requirement ids are `AC-R1`, `GUARD-3` or
 * `SLICE-S2` — the names the design document actually uses — a rule demanding `REQ-<n>` forces the author to invent
 * different ones, and the mapping stops naming the requirement it is about. That is precisely the traceability upstream
 * coverage exists to provide.
 */
export const requirementIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function assertValidTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId)) {
    throw new Error(`Invalid task id: ${taskId}`);
  }
}

/** Acceptance ids arrive from the command line as well as from kata; both go through this. */
export function assertValidAcceptanceId(id: string): void {
  if (!acceptanceIdPattern.test(id)) {
    throw new Error(
      `Invalid acceptance id: ${id}. Acceptance criteria are numbered by kata (AC-1, AC-2, …); `
      + `an upstream requirement id belongs in upstreamCoverage, not here.`,
    );
  }
}
