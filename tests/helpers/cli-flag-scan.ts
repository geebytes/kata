/**
 * The scan that enforces "one reader for CLI value flags", extracted so it can be exercised on samples that **must** be
 * caught.
 *
 * The previous version was dead code and its own case could not tell: it blanked quoted literals first and then looked for
 * a pattern beginning `'--`, so the two rules that were supposed to forbid `argv.indexOf('--x')` could never match a
 * single line — an independent review measured 21 live occurrences the guard called clean. A guard is only a rule once it
 * reddens on something, so the samples below are part of the mechanism rather than a comment about it.
 */

/** Comments blanked (newlines kept); quoted literals are kept, because the flag *names* live in them. */
export function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/gu, (match, prefix: string) => prefix + ' '.repeat(match.length - prefix.length));
}

export type Offence = { line: number; text: string; why: string };

/**
 * Hand-rolled lookups in `text`, in the five shapes this scan can recognise.
 *
 * **What it covers.** `argv.indexOf('--x')` / `argv.includes('--x')`; a flag literal compared inside a direct
 * predicate walk (`argv.some|find|filter|every|findIndex((t) => t === '--x')`); `argv[i + 1]` with neither a
 * `readFlag(...).value`/`paradeArgValue(...)` read nor a `startsWith('--')` guard in the next two lines; a flag name
 * bound to a `const`; `argv.slice(...)` followed by an index.
 *
 * **What it does not cover, measured rather than assumed.** Round 7 injected each of these into `src/cli/scope.ts` and
 * the scan stayed green while the code silently skipped the neighbour guard: `argv.at(i + 1)`, `argv.reduce`,
 * `[...argv]` under an alias, `for (const [i, t] of argv.entries())`, `argv.join().includes('--x')`, a flag taken from
 * `VALUE_FLAGS[0]`, `argv.flatMap`, an alias of `process.argv`, a `` `--${name}` `` template, `argv` and `.indexOf`
 * on **different lines**, `argv\n.some(\n… === '--x')` across lines, **`argv.slice(...)` before the predicate walk**
 * (the shape that survived round 6's "coverage equals the claim" and was found live in `invocation.ts` by round 7), a
 * predicate walk whose flag is a **template** (`` t => t === `${flag}=` ``), and `rest.includes('--all')` on an array
 * held in a local. It also does not scan outside `src/cli.ts` + `src/cli/**` (`src/policy/guard-script.ts` carries the
 * same shape).
 *
 * So this is a **strong approximation over a named surface**, not a rule that closes the class. The claim is written to
 * the coverage on purpose: three rounds running, the docblock promised "every hand-rolled lookup" while the shape beside
 * it was missed, and the missed shape is what the next round found. A scan cannot enumerate spellings; the class needs a
 * type that makes the hand-rolled read unexpressible, which is a design, not a repair.
 */
export function scanHandRolledFlagLookups(text: string): Offence[] {
    const code = stripComments(text);
    const offences: Offence[] = [];
    for (const [index, line] of code.split('\n').entries()) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        if (/argv\s*\.\s*indexOf\(\s*(?:'--|`--|"--)/u.test(line)) {
            offences.push({ line: index + 1, text: trimmed, why: 'whole-token flag lookup' });
            continue;
        }
        if (/argv\s*\.\s*includes\(\s*(?:'--|`--|"--)/u.test(line)) {
            offences.push({ line: index + 1, text: trimmed, why: 'whole-token flag presence check' });
            continue;
        }
        // A predicate walk comparing a token against a flag literal is the same whole-token lookup, written longer —
        // `argv.some((t) => t === '--x')`, `argv.find((t) => t === '--x')`, `argv.filter`/`argv.every` likewise.
        if (/argv\s*\.\s*(?:some|find|filter|every|findIndex)\s*\(/u.test(line)
            && /(?:===|!==|==|!=)\s*['"`]--/u.test(line)) {
            offences.push({ line: index + 1, text: trimmed, why: 'predicate walk over a flag literal' });
            continue;
        }
        // A flag name bound to an identifier, then used as a template — the lookup is real but the text scan cannot see
        // which flag it is, so it cannot check the guard either. It is refused rather than waved through.
        if (/(?:const|let|var)\s+\w+\s*=\s*['"`]--[\w-]*['"`]/u.test(line)) {
            offences.push({ line: index + 1, text: trimmed, why: 'flag name held in a variable' });
            continue;
        }
        if (/argv\s*\.\s*slice\([^)]*\)\s*\[/u.test(line)) {
            offences.push({ line: index + 1, text: trimmed, why: 'lookup hidden behind a slice' });
            continue;
        }
        const nextToken = /argv\s*\[\s*[A-Za-z_$][\w$.]*\s*\+\s*1\s*\]/u.test(line);
        if (nextToken) {
            // **The guard must be visible in a window, not necessarily on this line.** Assigning the neighbour first
            // (`const neighbour = argv[index + 1];` then `startsWith('--')` two lines down) is the readable form of the
            // right thing; requiring it inline pushed the code toward one long unreadable expression, which is the wrong
            // direction for a rule about being explicit. The window is small on purpose: enough for an assignment plus
            // its guard, not enough to wander.
            const window = code.split('\n').slice(index, index + 3).join('\n');
            // A `readFlag(...)` on the *same line as the neighbour read* is not an exemption: reading `present` from one
            // call and taking `argv[index + 1]` anyway is exactly the unguarded shape. Only a full `readFlag(...).value`
            // read, or a guarded neighbour, counts.
            const readerCall = /readFlag\([^)]*\)\.value|paradeArgValue\(/u.test(line);
            const guarded = /startsWith\(\s*'--'\s*\)/u.test(window);
            if (!readerCall && !guarded) {
                offences.push({ line: index + 1, text: trimmed, why: 'next-token read without the flag-is-not-a-value guard' });
            }
        }
    }
    return offences;
}
