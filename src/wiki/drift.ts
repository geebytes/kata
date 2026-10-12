import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  carriesDecision,
  computeFileHash,
  isWikiPageRef,
  sourceHalvesAgreement,
  sourceHalvesDisagreement,
  wikiRecordFileName,
  type WikiRecord,
  type WikiStatus,
} from './record.js';
import { statementForPage } from './llmwiki.js';
import { normalizeId, readWikiRecords, readWikiRecordsWithIssues, updateWikiRecord } from './store.js';
import type { WikiStatus as WikiRecordStatus } from './record.js';
import { llmwikiDirName } from '../core/repository-identity.js';

export interface DriftEntry {
  id: string;
  /**
   * Why the record is no longer consistent with its sources — the *cause*, in four words because there are four.
   *
   * Three of them are about files: a file's content moved, a file is gone, a file's content is there but the record's other
   * half never said what it should hash to. The fourth is its mirror: the record's hash map lists a path its refs do not
   * declare, which is the same defect seen from the other side. Both of those mean **the record cannot be re-derived** — which
   * digest belongs to which declaration is not knowable — so naming them `source_changed` sent the operator to `revalidate`,
   * a road `revalidateWikiRecord` closes by name for exactly that record (measured by two independent rounds, one direction
   * each). A cause that names something that did not happen is the same defect wearing the enum's clothes.
   *
   * **What these two words do not claim:** they say nothing about whether the file is there. A source can be unrecorded *and*
   * absent (the first version's sentence claimed "it is there", which a reachable record contradicts — measured by an
   * independent round); the file facts travel in `changedSources` and `missing`.
   */
  reason: 'source_changed' | 'source_missing' | 'source_unrecorded' | 'source_undeclared';
  changedSources: string[];
  /**
   * Whether the walk took an approval away with it, which is a second fact about the same record.
   *
   * **Its own field, not a new value of `reason`.** The cause of the drift is a file moving — the same cause a candidate
   * record has — and folding "an approval was withdrawn" into that vocabulary would have made every reader of `reason`
   * learn a value that answers a different question (it did: one consumer's union and one case had to move for it). Here the
   * cause stays the cause, and the consequence is additive: a reader that only cares why the sources stopped matching is
   * unaffected, and one that cares about authority reads this field.
   */
  approvalWithdrawn?: boolean;
}

export interface DriftReport {
  checked: number;
  intact: string[];
  stale: DriftEntry[];
  missing: string[];
}

export async function verifySources(root: string): Promise<DriftReport> {
  const records = await readWikiRecords(root);
  const intact: string[] = [];
  const stale: DriftEntry[] = [];
  const missingSources = new Set<string>();

  for (const record of records) {
    if (record.status === 'rejected') {
      intact.push(record.id);
      continue;
    }

    const changedSources: string[] = [];
    // **The walk looks at every source the record names, not only the ones it has a hash for.** Iterating `sourceHashes` alone
    // meant a path declared in `sourceRefs` with no recorded hash was never examined — while the re-derivation path refuses
    // exactly that shape, so the two answers to "what are this record's sources" disagreed on a record reachable from the CLI
    // (measured by an independent round). The union is iterated, and a declared ref with no hash is reported as changed.
    const declaredSources = [...new Set([...Object.keys(record.sourceHashes), ...record.sourceRefs])];
    const sourceHashEntries = declaredSources.map((path) => [path, record.sourceHashes[path] ?? ''] as const);
    // **The record's own completeness is asked of one predicate, in both directions.** Which command may act on the record
    // differs for a record whose halves disagree (the record has to be corrected, not re-derived), so it is named as its own
    // cause — and the mirror direction is the same question, answered by the same function (an independent round measured the
    // first repair closing one direction only).
    const agreement = sourceHalvesAgreement(record);

    for (const [sourcePath, expectedHash] of sourceHashEntries) {
      try {
        const absolutePath = join(root, sourcePath);
        const content = await readFile(absolutePath, 'utf8');
        const currentHash = computeFileHash(content);
        if (currentHash !== expectedHash) {
          changedSources.push(sourcePath);
        }
      } catch {
        changedSources.push(sourcePath);
        missingSources.add(sourcePath);
      }
    }

    if (changedSources.length > 0) {
      // A record whose halves disagree cannot be re-derived whatever the files did, so that cause wins: it is about the
      // record, the others are about the files. The file facts are still reported (`changedSources`, `missing`).
      const reason = agreement === 'declared-not-hashed'
        ? 'source_unrecorded'
        : agreement === 'hashed-not-declared'
          ? 'source_undeclared'
          : changedSources.some((s) => missingSources.has(s))
            ? 'source_missing'
            : 'source_changed';
      stale.push({ id: record.id, reason, changedSources, ...(withdrawingAuthority(record) ? { approvalWithdrawn: true } : {}) });
      await markRecordStale(root, record.id);
    } else {
      intact.push(record.id);
    }
  }

  return {
    checked: records.length,
    intact,
    stale,
    missing: [...missingSources].sort(),
  };
}

/**
 * Mark one record stale, the way the drift walk does it.
 *
 * **The walk used to write this itself, twice**, which is the same write in three places: this function, the missing-source
 * branch and the changed-source branch. A reader asking "what does marking a record stale do" had three answers, and the
 * wiring check reported this one as having no consumer while the two copies were the consumers.
 */
export async function markRecordStale(root: string, id: string): Promise<void> {
  await updateWikiRecord(root, id, { status: 'stale' });
}

/**
 * Whether the drift walk is taking an approval away from this record, or merely restating that a candidate is out of date.
 *
 * Read before the write, because the write is what removes the evidence: after `markRecordStale` the record is `stale` and
 * nobody can tell whether an approval was withdrawn.
 */
function withdrawingAuthority(record: Pick<WikiRecord, 'status' | 'approvalEvent' | 'rejectionEvent'>): boolean {
  // "The walk is taking a decision away" — asked of the same predicate the guards ask, so the store and the re-derivation
  // cannot disagree about what a decided record is.
  return carriesDecision(record) && record.status !== 'rejected';
}

export interface RevalidationResult {
  id: string;
  status: WikiRecordStatus;
  /** The sources whose recorded hash was refreshed (empty = the record was already consistent). */
  refreshed: string[];
  /**
   * Whether the record's `statement` was recomputed, and why not when it was not.
   *
   * **Half the work is a fact a caller has to be able to read.** A statement is recomputed only for a record whose writer
   * composed it out of the page (`llmwiki-register`); for every other record the hash moves and the prose deliberately does
   * not, so "re-derived" must not read as "the whole record follows its sources now".
   */
  statement: { recomputed: boolean; why: string };
}

/**
 * The transition out of `stale`.
 *
 * `verifySources` marks a record stale when its sources change, and nothing could move it back: `register` skips an id
 * that already exists, `promote` requires `candidate`, and `rebuild` clears the whole store. A record for a page that
 * was edited even once was therefore stale **forever** — so the closure gate could keep reading a record whose sources
 * no longer matched, indefinitely.
 *
 * Revalidation returns the record to `candidate`, not to `verified`: refreshing a hash is a mechanical fact about the
 * files, while "verified" is a governance claim that goes through promotion (and its passing validation task) like any
 * other. That keeps the state machine's meaning intact instead of adding a bypass for the case that mattered today.
 */
export async function revalidateWikiRecord(root: string, id: string): Promise<RevalidationResult> {
  const { records, invalid: invalidRecords } = await readWikiRecordsWithIssues(root);
  const record = records.find((entry) => entry.id === normalizeId(id));
  if (!record) {
    // **A suffix test is not an identity test.** `path.endsWith('a.json')` also matches `bca.json`, so an invalid record in a
    // file whose name merely ends the same way was reported as the requested id's damage. The comparison is on the filename
    // the store actually writes, which is derived by one function (`normalizeId`).
    const wanted = wikiRecordFileName(id);
    const invalid = invalidRecords.find((entry) => entry.path.split(/[\\/]/).pop() === wanted);
    throw new Error(
      invalid
        ? `Wiki record ${id} cannot be revalidated because it does not match its schema: ${invalid.message}`
        : `Wiki record ${id} was not found under .kata/wiki/`,
    );
  }

  // **Only the states whose move this function may perform.** Re-derivation is the transition *out of* `stale`; a `verified`
  // record's authority came from promotion (a passing validation task) and a `rejected` record was refused by a person, so
  // neither may be turned into a `candidate` — the status the closure gate accepts — by refreshing a hash. The first version
  // guarded only `verified`, so a `rejected` record was resurrected into an acceptable one (measured by an independent
  // round), and the bulk route reached `verified` records *through* the drift walk, which demotes them before this code runs
  // (see `revalidateStaleRecords`).
  // A record that carries an `approvalEvent` was approved at some point; if it is not `verified` now, that approval was
  // withdrawn (the drift walk demotes a verified record whose sources moved). Refreshing its hashes would hand back a
  // `candidate`, which the closure gate accepts — the approval would come back weaker than it went in. The fact lives in
  // the record itself, so this holds on every route and on every later run, not only in the run that noticed the drift.
  if (carriesDecision(record)) {
    const why =
      record.status === 'verified' || record.status === 'rejected'
        ? `is ${record.status}`
        : 'carries an approval that was withdrawn when its sources moved';
    throw new Error(
      `Wiki record ${id} ${why}, and re-derivation never turns an approved or retired record into a candidate: it is the transition out of \`stale\` — ${decisionRoads(record)}`,
    );
  }

  // **The record's sources are `sourceRefs`, and its hashes have to be about those and no others.** The drift walk iterates
  // `sourceHashes` while this function iterates `sourceRefs`, so a file named only by the hash map was refused by neither —
  // and the recomputation, which writes the map it built, would have dropped it silently. A record whose two halves disagree
  // is corrupt, so it is refused by name and left exactly as it was rather than repaired into agreement.
  // **A repeated source is its own fact, because the two halves then describe different things.** The schema allows
  // `sourceRefs: ['a','a']` (no `uniqueItems`), so a record can declare one file twice while recording one hash for it — and a
  // set comparison would call that consistent. The first version compared sorted joins, which made the pair a mismatch and
  // then reported it as `declared but not hashed: a`, which is false: `a` is hashed. Naming the repetition is the honest
  // answer, and it is a refusal rather than a repair because which of the two the record meant is not knowable here.
  const repeated = record.sourceRefs.filter((path, index) => record.sourceRefs.indexOf(path) !== index);
  if (repeated.length > 0) {
    throw new Error(
      `Wiki record ${id} cannot be re-derived because it declares the same source more than once (${[...new Set(repeated)].join(', ')}): which declaration the recorded hash belongs to is not knowable, and nothing here can repair it — the road is the record file itself (correct its \`sourceRefs\`) or clearing the store as a whole (\`kata-cli wiki rebuild\`, which removes every page and governed record) and ingesting the source again — \`kata-cli wiki ingest\` is not the road from here because it refuses while the page exists`,
    );
  }

  // **The agreement question is asked of the same function the walk asks**, so a direction cannot be known to one side and
  // unknown to the other (that asymmetry is what an independent round measured in this change's own history).
  const agreement = sourceHalvesAgreement(record);
  if (agreement !== 'agree') {
    const disagreement = sourceHalvesDisagreement(record);
    throw new Error(
      `Wiki record ${id} cannot be re-derived because its recorded hashes do not describe its declared sources: ${
        agreement === 'hashed-not-declared' ? 'hashed but not declared' : 'declared but not hashed'
      }: ${disagreement.join(', ')}`,
    );
  }

  const sourceHashes: Record<string, string> = {};
  const refreshed: string[] = [];
  const summaries: string[] = [];
  for (const sourceRef of record.sourceRefs) {
    let content: string;
    try {
      content = await readFile(join(root, sourceRef), 'utf8');
    } catch {
      // **A record whose source is gone cannot be re-derived, and saying it was is the fail-open direction.** The first
      // version kept the old hashes, pushed the ref into `refreshed` (a field that means "this hash was recomputed"), and
      // returned the record to `candidate` — which the closure gate accepts. So a record describing a page that no longer
      // exists became acceptable while its hashes still named a file that is gone. The ref stays on the record either way,
      // so the drift walk keeps reporting the gap; the status must not move.
      throw new Error(
        `Wiki record ${id} cannot be re-derived because its source ${sourceRef} cannot be read; the record keeps the reference so the drift check keeps reporting the gap`,
      );
    }
    const hash = computeFileHash(content);
    sourceHashes[sourceRef] = hash;
    if (record.sourceHashes[sourceRef] !== hash) refreshed.push(sourceRef);
    summaries.push(statementForPage(content));
  }

  // **The statement is recomputed only where the writer composed it out of the page — and that is `register`, by name.**
  // The first version asked the provenance dimension (`ingested`) and then took `summaries[0]`, which guessed two things:
  // which ref the statement came from, and that the writer used this composition. `wiki ingest` writes
  // `sourceRefs: [raw, page]` with `statement: oneLineSummary(external body)`, so for its records the first element is the
  // raw import, not the page, and the derivation is not this one (measured by an independent round). The question is not
  // "is this record ingested" but "did the writer that produced it compose the statement this way", and the record carries
  // that writer's identity.
  // The eligibility test is the writer **and the shape that writer produces**: one source, and it is a page under the wiki
  // directory (the ref `registerWikiPages` builds, from the same constant it uses). A record carrying the registration id
  // whose single source is some other file — hand-made, or edited later — was previously recomputed from that file, replacing
  // its prose with that file's first line while the reply repeated the id as if that were evidence (measured by an
  // independent round).
  const writerIsRegister = record.validationTaskId === 'llmwiki-register';
  const singleSource = record.sourceRefs.length === 1;
  const sourceIsAPage = isWikiPageRef(record.sourceRefs[0] ?? '');
  const statementIsThePageSummary = writerIsRegister && singleSource && sourceIsAPage;
  // The answer names the clause that decided it: the first version said "written by X with 1 source(s), so its statement is
  // not this page's summary", which blamed the count for a decision the source's *location* made — false in exactly the shape
  // the clause was added for (measured by an independent round).
  const ineligible =
    !writerIsRegister
      ? `written by ${record.validationTaskId}, which is not the page-registration writer`
      : !singleSource
        ? `written by ${record.validationTaskId} with ${record.sourceRefs.length} sources, not the single page it registers`
        : `written by ${record.validationTaskId} with one source, but ${record.sourceRefs[0]} is not a page under ${llmwikiDirName}/`;
  const statement = statementIsThePageSummary && summaries.length > 0 ? summaries[0]! : record.statement;

  const updated = await updateWikiRecord(root, record.id, {
    ...(Object.keys(sourceHashes).length > 0 ? { sourceHashes } : {}),
    ...(statement === record.statement ? {} : { statement }),
    status: 'candidate',
  });
  return {
    id: updated.id,
    status: updated.status,
    refreshed: [...new Set(refreshed)].sort(),
    statement: statementIsThePageSummary
      ? {
          recomputed: true,
          why: `written by ${record.validationTaskId} with one source under ${llmwikiDirName}/, which is the shape whose statement is this page's own summary`,
        }
      : {
          recomputed: false,
          why: `${ineligible}, so its statement is not this page's own summary and the recorded prose is left as it is`,
        },
  };
}

/**
 * **The roads out of a record that carries a decision, for the state the record is actually in.**
 *
 * Both refusals below used to spell their roads in prose, and two independent rounds measured the same defect in them: a
 * sentence offering `retire` to a `rejected` record (which `retireWikiRecord` refuses — it is already retired), offering
 * `promote` to a `stale` one (which requires a candidate), or disclaiming `wiki rebuild` for a precondition that holds in a
 * different state than the one it prints in. The roads are a fact about the state, so they are derived from it once and the
 * sentences are built from the result.
 */
function decisionRoads(record: Pick<WikiRecord, 'status' | 'approvalEvent'>): string {
  const closed: string[] = [];
  if (record.status === 'rejected') {
    closed.push('`kata-cli wiki promote` (it requires a candidate) and `kata-cli wiki retire` (the record is already retired)');
  } else {
    closed.push('`kata-cli wiki promote` (it requires a candidate)');
  }
  const road = record.status === 'rejected'
    ? 'there is no road from this state that keeps the store: only clearing it (`kata-cli wiki rebuild`) and ingesting the sources again'
    : `retire it if it does not hold any more (\`kata-cli wiki retire <wiki-id> --by <actor> --role <role> --reason <why>\` works from this state), or clear the store as a whole (\`kata-cli wiki rebuild\` — it removes every page and governed record, so it is the road for a store being replaced rather than for one record)`;
  return `${road}; ${closed.join(' and ')} ${closed.length > 1 ? 'are' : 'is'} refused from here`;
}

/**
 * Revalidates every stale record in the store, reporting what each refresh found.
 *
 * The walk iterates the records whose **status** is `stale`, not the ones the drift check happens to report: the drift check
 * classifies a record by its sources alone, so a record left `stale` by an earlier drift whose source was afterwards restored
 * to its recorded content reads as intact — and was therefore neither revalidated nor refused, silently. A refusal is
 * collected rather than thrown, so one unrecoverable record does not abort the pass after the earlier records were refreshed.
 */
export async function revalidateStaleRecords(root: string): Promise<{
  report: DriftReport;
  revalidated: RevalidationResult[];
  refused: Array<{ id: string; reason: string }>;
}> {
  const report = await verifySources(root);
  const withdrawnThisRun = new Set(report.stale.filter((entry) => entry.approvalWithdrawn).map((entry) => entry.id));
  const revalidated: RevalidationResult[] = [];
  const refused: Array<{ id: string; reason: string }> = [];
  for (const record of (await readWikiRecords(root)).filter((entry) => entry.status === 'stale')) {
    // **A withdrawn approval is not re-derived here.** The drift walk demotes a `verified` record whose sources moved before
    // this loop sees it, so the record reads as an ordinary `stale` one — and re-deriving it would hand back a `candidate`,
    // which the closure gate accepts. That is the approval silently downgraded through the bulk door. The carrier of the
    // decision is the record itself (`carriesDecision`), so this holds on later runs too, not only in the run that noticed.
    if (carriesDecision(record)) {
      refused.push({
        id: record.id,
        reason: `Wiki record ${record.id} carries a decision that re-derivation does not overturn${
          withdrawnThisRun.has(record.id) ? ' — this run withdrew its approval because its sources moved' : ''
        }: ${decisionRoads(record)}`,
      });
      continue;
    }
    try {
      revalidated.push(await revalidateWikiRecord(root, record.id));
    } catch (error) {
      refused.push({ id: record.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { report, revalidated, refused };
}
