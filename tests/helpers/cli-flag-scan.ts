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

/** The blanked view used only to decide *where* a comment is; flag scanning reads `stripComments` instead. */
export function blankLiterals(text: string): string {
    return text
        .replace(/'(?:[^'\\\n]|\\.)*'/gu, (literal) => `'${' '.repeat(Math.max(0, literal.length - 2))}'`)
        .replace(/`(?:[^`\\]|\\.)*`/gu, (literal) => `\`${' '.repeat(Math.max(0, literal.length - 2))}\``);
}

export type Offence = { line: number; text: string; why: string };

/**
 * Every hand-rolled lookup in `text`.
 *
 * Four shapes are forbidden, because each of them is how a value flag's spelling or its neighbour guard gets lost:
 *   - `argv.indexOf('--x')` / `argv.includes('--x')` — the flag is looked up by whole-token comparison;
 *   - `argv[i + 1]` with no guard, unless the same statement also takes the inline value from `splitFlag`;
 *   - a flag name held in a variable, which the text scan cannot follow;
 *   - `argv.slice(...)` followed by an index, which hides the lookup from the patterns above.
 */
export function scanHandRolledFlagLookups(text: string, options: { allowReader?: boolean } = {}): Offence[] {
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
