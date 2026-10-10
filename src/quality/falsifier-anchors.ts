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
