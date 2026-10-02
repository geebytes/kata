/**
 * Shared invocation parsing.
 *
 * The command families extracted out of `cli.ts` each need to find the change id, the root and an option's value in raw
 * argv, so the readers live in one place rather than being copied per family. `parseChangeArg` is the transitional
 * positional guesser the architecture review calls out (L0-02): it keeps a list of flags that consume the next token, so
 * a new option means updating this list too. Each family that grows its own typed parser can stop using it.
 */

/**
 * **One rule for every flag reader, and this is where it lives.** §12.4 claimed `--flag=value` was resolved "once, for
 * every flag", but the rule went into `argValue` alone: `parseRootArg`/`parseChangeArg` and the repeated-value readers
 * still saw only the spaced form, so `kata-cli --root=/ws …` fell back to workspace discovery and quietly used the wrong
 * root — the fail-open direction of a spelling gap. Every reader below asks this one predicate.
 */
export function flagPresent(argv: string[], flag: string): boolean {
    return readFlag(argv, flag).present;
}

/**
 * Whether a boolean switch was given, in either spelling.
 *
 * A switch carries no value, but it is still a flag: `--seal=1` and `--seal` are the same switch, and two spellings of
 * "is it present" is the same divergence the value readers had — an independent review found `argv.includes('--seal')`
 * and `flagPresent(argv, '--seal')` answering `false` and `true` for one input. This is the name every switch read uses.
 */
export function switchPresent(argv: string[], flag: string): boolean {
    return readFlag(argv, flag).present;
}

export function readFlag(argv: string[], flag: string): { present: boolean; value: string | undefined } {
    // **The one entry point for a CLI value read.** Rounds 9–12 each found the same shape: the rule below reached the
    // readers that had been named and not the adjacent hand-rolled ones, so `--root --dry-run` set a *directory* named
    // `--dry-run` and `update --platform=pi` silently updated every platform. Two facts are returned together because the
    // callers need both and deriving either one separately is what let them diverge:
    //
    //   `present` — the flag was given in either spelling, even with an empty value (so a caller can refuse it by name);
    //   `value`   — the value, or `undefined` when there is none (empty, missing, or the next token is another flag).
    //
    // A flag never takes the next token when that token is itself a flag: measured, `installer --root --dry-run` wrote
    // 14 files outside the intended root because the guard lived in `argValue` and not in the loop that called it.
    // **Position decides, not spelling.** Scanning all inline tokens first made `readFlag(['--root', '/ws', '--root=/other'])`
    // answer `/other`: an inline occurrence *later* in the argument list outranked the token next to the flag. The first
    // occurrence in order is the one the operator wrote first, so the tokens are walked in order and the first match wins —
    // measured slip: `paradeArgValue(['--owned-path', 'a', '--owned-path=b'])` returned `['b','b']`.
    //
    // **The first occurrence wins, complete or not** (T6-5, operator-visible): `readFlag(['--root=', '--root', '/ws'])` is
    // `{present: true, value: undefined}` — the earlier, malformed occurrence is not skipped in favour of the later valid
    // one. That is deliberate: silently preferring a later flag over an earlier malformed one is how "I named a root and it
    // used another" happens. The caller refuses it by name; a repeated flag is a mistake to report, not to arbitrate.
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] ?? '';
        if (token.startsWith(`${flag}=`)) {
            const value = token.slice(flag.length + 1);
            return { present: true, value: value.trim() === '' ? undefined : value };
        }
        if (token !== flag) continue;
        const next = argv[index + 1];
        return { present: true, value: next === undefined || next.startsWith('--') ? undefined : next };
    }
    return { present: false, value: undefined };
}

/** Every occurrence of a repeated value flag, either spelling. `--owned-path a --owned-path=b` is two declarations. */
export function paradeArgValue(argv: string[], flag: string): string[] {
    // R12-F8: this used to carry its own copy of "both spellings + skip the neighbour + drop an empty inline value" —
    // the same rule in two places. The neighbour guard now comes from `readFlag` (one rule, one place); the loop only
    // walks positions.
    const values: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        const { flag: name, inline } = splitFlag(argv[index] ?? '');
        if (name !== flag) continue;
        if (inline !== undefined) {
            if (inline.trim() !== '') values.push(inline);
            continue;
        }
        const spaced = readFlag(argv.slice(index), flag).value;
        if (spaced !== undefined) {
            values.push(spaced);
            index += 1;
        }
    }
    return values;
}

export function inlineValue(argv: string[], flag: string): string | undefined {
    return readFlag(argv, flag).value;
}

/**
 * The flags that take a value, so the positional guesser does not mistake a value for a change id.
 *
 * **This list was incomplete twice, and each time a flag's value took the change-id slot.** First `--review-evidence`
 * (`review --review-evidence hello --change t1` operated on a task named `hello`), then seven more an independent review
 * found: `--branch feature/x` read `feature/x` as the change id, and `--base main` became a branch named `kata/main`.
 *
 * **It is a hand-kept list that a test checks, not a derived table — and the comment used to claim otherwise.** Measured
 * twice: first three shapes were scanned and a flag read as `arg === '--x'` was invisible, then
 * `tests/unit/cli-flag-vocabulary.test.ts` was extended to that shape as well. What remains invisible is a flag reached
 * through a variable, a template-built flag name, or a reader outside `src/cli/`: the honest description is a strong
 * approximation with a named blind spot, caught by a case rather than by construction, so a reader that introduces a new
 * shape extends the scan.
 */
export const VALUE_FLAGS: readonly string[] = [
    '--add', '--c0', '--actor', '--adapter', '--assurance', '--base', '--bootstrap-file', '--boundary', '--branch', '--by',
    '--candidate', '--change', '--choice', '--claim', '--command', '--covers', '--decision', '--depends-on',
    '--development', '--development-mode', '--diversity', '--endpoint', '--evidence', '--excludes', '--failure-count',
    '--failures', '--fails-on', '--field', '--file', '--findings-carried-to', '--for-task', '--from', '--home', '--id',
    '--instrument', '--isolation', '--isolation-mode', '--judgement', '--kind', '--language', '--mode', '--observed',
    '--out', '--owned-path', '--path', '--paths', '--per-claim', '--persist', '--platform', '--probe', '--producer',
    '--q', '--query', '--reason', '--record', '--remove', '--requirements-file', '--result-file', '--results-dir',
    '--review', '--review-evidence', '--review-mode', '--reviewed-path', '--risk-class', '--role', '--root',
    '--routing-mode', '--run-id', '--scope', '--seed', '--set-file', '--severity', '--since', '--statement', '--task',
    '--task-kind', '--tier', '--title', '--to', '--type', '--version', '--waivers-file', '--wiki', '--wiki-from',
];

export function parseRootArg(argv: string[]): string | undefined {
    // R12-F8: the inlined copy of the spaced-form fallback lived here too. `readFlag` answers both spellings and refuses
    // to take the next flag as a value, so this is one line rather than a second implementation of the same rule.
    return readFlag(argv, '--root').value;
}

export function parseChangeArg(argv: string[]): string | undefined {
    const inline = inlineValue(argv, '--change');
    if (inline !== undefined) return inline;
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === '--change') {
            const next = argv[index + 1];
            return next === undefined || next.startsWith('--') ? undefined : next;
        }
        if (VALUE_FLAGS.some((flag) => value === flag || value.startsWith(`${flag}=`))) {
            // A spaced form consumes the next token; an `=` form carries its own value and consumes nothing.
            if (!value.includes('=')) index += 1;
            continue;
        }
        if (value?.startsWith('--')) continue;
        // **The first bare token is the change id only when it is not already spoken for.** A subcommand such as the
        // `review` in `review --review-evidence hello --change t1` is positional, not the id: the flag vocabulary above
        // decides which tokens are values, and a bare token that precedes a `--change` is the command word.
        // The shared reader answers this in either spelling, and the scan no longer has to recognise a predicate walk with
        // a slice in the middle of it — the shape that survived the previous round's own "coverage equals the claim".
        if (readFlag(argv.slice(index + 1), '--change').present) continue;
        // **A path is not a task id.** `worktree remove <path>` is the documented spelling, and the path arrives as the
        // first bare token — so this reader returned it as the change id, the caller then compared it with the derived
        // owner, and the mismatch branch refused *every* worktree, clean or not. Measured: the positional form threw while
        // `remove --path <p>` worked, which made the broken spelling the documented one.
        //
        // This recognises the shape rather than the caller: a token that names a filesystem location (it contains a
        // separator, or starts at the root) is a path, and an id is a bare name. The caller-side rule — remove your
        // positional tokens before asking — is the fix in `worktree remove`; this is the belt that keeps the next verb
        // with a positional path from repeating it.
        if (value !== undefined && looksLikeAPath(value)) continue;
        return value;
    }
    return undefined;
}

/** True when a token names a filesystem location rather than an identifier. */
export function looksLikeAPath(value: string): boolean {
    return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.includes('/');
}

/**
 * Split a hand-written literal-flag comparison into the flag and, when present, its inline value.
 *
 * **The `=` spelling has to resolve for hand-written parsers too, not only for the shared readers.** Measured by an
 * independent review: `relations add --from=task:a --to=task:b` was refused with `Unknown relations option: --from=task:a`,
 * and `install --platform=pi` likewise, because those loops compare whole tokens. Both spellings are the same flag on a
 * command line, so the comparison is done on the name and the inline value is returned alongside it.
 */
export function splitFlag(token: string): { flag: string; inline?: string } {
    if (!token.startsWith('--')) return { flag: token };
    const equals = token.indexOf('=');
    if (equals === -1) return { flag: token };
    return { flag: token.slice(0, equals), inline: token.slice(equals + 1) };
}

/**
 * The value after a flag, or `undefined` when the next token is itself a flag.
 *
 * **The guard is the point, and there used to be three of these.** Three copies of this helper existed — `ops.ts`,
 * `scope.ts` and `workflow.ts` — and they disagreed: `scope.ts` refused a value that starts with `--`, the other two
 * returned it. So `open --title --isolation git_flow` set the task's title to `"--isolation"` on one path and was refused
 * on another, and which behaviour you got depended on which copy your command happened to use. Found while giving
 * `--title` its first reader.
 *
 * The rule the codebase already used in `parseChangeArg` is the one kept: **a token starting with `--` is a flag, not a
 * value.** The alternative — accepting any token — cannot tell `--title --isolation` from `--title --some-title`, and a
 * flag silently swallowing the next flag is how a required option goes missing.
 */
/**
 * The value a flag was given, in either spelling.
 *
 * `--flag value` and `--flag=value` are the same flag on a command line, and this reader used to see only the first, so
 * every caller inherited the gap: `ledger run --out=tmp/x.json` was recognised as "given" by one check and read as "not
 * given" by this one, producing a refusal that asked for the path it had just been handed. Both spellings resolve here,
 * once, for every flag — rather than per-flag in whichever module happened to notice.
 */
export function argValue(argv: string[], flag: string): string | undefined {
    // R12-F10: this was a character-for-character second copy of the `=` scan. It is now the same reader, so the next
    // change to the rule cannot reach one and miss the other — the shape this file has produced most often.
    return readFlag(argv, flag).value;
}
