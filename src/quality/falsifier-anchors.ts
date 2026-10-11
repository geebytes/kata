/**
 * **Where a declared falsifier's anchor sits in its file, and whether it can mean what it claims.**
 *
 * A falsifier reddens a check by editing one place in the source: `find` is the anchor, `replace` is the defect. Both of the
 * ways that can go wrong are silent when the edit is done with `String.replace`:
 *
 * - **Absent** — `String.replace` returns the input unchanged, so the "mutated" run is the unmutated one. If the check passes
 *   it reads as "the check does not redden under its own defect" (a verdict about the *check*), and if it fails it reads as
 *   `supported` while nothing was mutated at all. Measured in this repository: an anchor silently stopped matching after a
 *   repair moved the site, and a green guard was concluded from a no-op.
 * - **Ambiguous** — only the first match is replaced, so the defect lands at a site the falsifier never named. It can then
 *   redden for a reason unrelated to the property (one declared falsifier reddened because its `replace` string was a syntax
 *   error) or not redden at all.
 *
 * Neither is a reading about the change, so neither may produce a verdict about it. This is the mutation-adequacy half of
 * "an instrument must be able to fail": a mutation that does not apply proves nothing, which is a different fact from a check
 * that does not fail.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AnchorLocation =
    | { kind: 'unique' }
    | { kind: 'absent' }
    | { kind: 'ambiguous'; count: number };

export function locateAnchor(source: string, find: string): AnchorLocation {
    const occurrences = countOccurrences(source, find);
    if (occurrences === 1) return { kind: 'unique' };
    if (occurrences === 0) return { kind: 'absent' };
    return { kind: 'ambiguous', count: occurrences };
}

/**
 * The refusal a falsifier's anchor earns, in the words the operator needs — or `undefined` when the anchor is usable.
 *
 * `file` and the anchor itself are quoted, because the reader's next act is to go and look at that line: a message that only
 * says "the mutation did not apply" leaves them to search for it.
 */
export function anchorRefusal(location: AnchorLocation, file: string, find: string): string | undefined {
    if (location.kind === 'unique') return undefined;
    const anchor = find.length > 80 ? `${find.slice(0, 77)}…` : find;
    if (location.kind === 'absent') {
        return `the mutation anchor matches 0 times in ${file}, so this falsifier would run against unmutated code and its `
            + `verdict would be about nothing: re-aim it at the line the property lives on (anchor: ${JSON.stringify(anchor)})`;
    }
    return `the mutation anchor matches ${location.count} times in ${file}, so the defect would be injected at whichever site `
        + `comes first rather than the one this falsifier names: make the anchor unique (anchor: ${JSON.stringify(anchor)})`;
}

/** How many times `needle` occurs in `haystack` — counted without regex, so an anchor is matched literally. */
function countOccurrences(haystack: string, needle: string): number {
    if (needle === '') return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

/** One declared falsifier whose anchor no longer names a place in the file it points at. */
export interface AnchorProblem {
    evidenceId: string;
    file: string;
    message: string;
}

/**
 * **Every declared falsifier's anchor, checked read-only — the check the seal was missing.**
 *
 * The anchors were only ever checked when a reading was written (`ledger evidence verify` runs the mutation, so it fails by
 * name when the anchor does not apply). A repair moves code, so an anchor that was unique when its verdict was written can
 * stop matching afterwards — and the verdict on disk keeps saying `supported`, because a reading is a fact about the revision
 * it was taken against. Measured in this repository: eleven anchors across ten review rounds of one change stopped matching,
 * every one of them found by hand, and the ledger could have been asked "is this still aimed at something" at any point.
 *
 * The division of labour is deliberate and stated in the design document: **the seal asks whether the anchor still points at
 * something** (necessary, and cheap — a string match, no tests, no ledger dependency beyond reading the declaration), while
 * **`ledger evidence verify` asks whether it still reddens** (sufficient, and expensive). Neither replaces the other, and a
 * seal that could not seal without a readable ledger would make the ledger a gate on the change rather than a record of it.
 */
export async function declaredAnchorProblems(
    root: string,
    taskId: string,
): Promise<{ problems: AnchorProblem[]; unreadable?: string }> {
    const path = join(root, '.kata', 'tasks', taskId, 'review', 'evidence.json');
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        // **Absent and unreadable are different facts.** No ledger means nothing was declared here to check, which is not a
        // problem; a declaration that cannot be read means the check could not run, and reporting that as "nothing to check"
        // would be the corrupt-reads-as-absent shape the readers in this repository are built to refuse.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { problems: [] };
        return { problems: [], unreadable: `the declared falsifiers could not be read (${(error as Error).message})` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch (error) {
        return { problems: [], unreadable: `the declared falsifiers are not readable JSON (${(error as Error).message})` };
    }
    const items = Array.isArray(parsed) ? parsed : (parsed as { evidence?: unknown } | null)?.evidence;
    if (!Array.isArray(items)) return { problems: [], unreadable: 'the declared falsifiers are not a list of declarations' };

    const problems: AnchorProblem[] = [];
    for (const item of items) {
        const record = item as { id?: unknown; type?: unknown; mutation?: { file?: unknown; find?: unknown } };
        if (record?.type !== 'executable_falsifier' || record.mutation === undefined) continue;
        const evidenceId = typeof record.id === 'string' ? record.id : '(unnamed falsifier)';
        const file = typeof record.mutation.file === 'string' ? record.mutation.file : undefined;
        const find = typeof record.mutation.find === 'string' ? record.mutation.find : undefined;
        if (file === undefined || find === undefined) {
            problems.push({ evidenceId, file: file ?? '(no file)', message: 'this falsifier declares no file and anchor for its mutation, so it could never be re-aimed or run' });
            continue;
        }
        let source: string;
        try {
            source = await readFile(join(root, file), 'utf8');
        } catch {
            problems.push({ evidenceId, file, message: `the file this falsifier mutates does not exist (${file}), so its anchor names no place and the mutation can never apply` });
            continue;
        }
        const refusal = anchorRefusal(locateAnchor(source, find), file, find);
        if (refusal !== undefined) problems.push({ evidenceId, file, message: refusal });
    }
    return { problems };
}
