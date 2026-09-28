#!/usr/bin/env node
/**
 * **Mutation kill: can every decision rule be switched off, and does the suite notice?**
 *
 * The acceptance item "gate mutation kill = 100%" had no instrument. K2 enforces the *per-check* half structurally — a
 * command-backed evidence item without a mutation is refused by name — and that half is real: disabling
 * `uncovered_risk_class` reddens 11 tests across 5 files. What was missing is the aggregate: for each refusal reason the
 * kernel can produce, does a mutation that removes that rule turn at least one test red?
 *
 * **The mutations are derived, not hand-written.** A hand-written table rots the moment a rule moves; instead this reads
 * the reason codes from `src/kernel/types.ts` and finds each code's producing statement in `src/kernel/decide.ts`. A code
 * with no findable statement is reported as `no-site` rather than skipped, because a rule whose removal this harness cannot
 * express is a rule whose removal nothing would notice.
 *
 * Two guards against counting a spurious red:
 *
 * - **A syntax gate.** If commenting out the statement leaves the file unparseable, every test fails and every code looks
 *   killed. `esbuild` parses the mutated file first (`tsc` would work too and costs ten times as much).
 * - **A restore in a `finally`.** A harness that leaves the tree mutated is worse than no harness; the original text is
 *   held in memory and written back on every path, including a thrown error.
 *
 * Usage: `node scripts/mutation-kill.mjs [--json] [--only <code>]`
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DECIDE = 'src/kernel/decide.ts';
const TYPES = 'src/kernel/types.ts';

/** The files that must notice a decision rule being disabled. Chosen because each one asserts a decision outcome. */
const WATCHERS = [
    'tests/unit/ledger-corpus-is-the-referee.test.ts',
    'tests/unit/ledger-cli-end-to-end.test.ts',
    'tests/unit/kernel-decision-cannot-pass-a-spent-budget.test.ts',
    'tests/unit/review-seed-corpus.test.ts',
    'tests/unit/eval-metrics.test.ts',
];

/**
 * The reason codes, read from the union the kernel declares rather than from a list kept here.
 *
 * **Two ways this can lie, and both were live in the first version.** The declaration is named `ReasonCode`, so a search
 * for `export type Reason` matched it by prefix; and the slice ran a fixed 4000 characters past the match, so it caught
 * members of the *next* unions — the run reported 21 codes including `fail`, `insufficient` and `verifier`, none of which
 * is a refusal reason, and it reported `verifier` as the one survivor. The declaration is bounded now, and the count is
 * asserted against the message catalogue so a silent under- or over-read fails loudly.
 */
async function reasonCodes() {
    const source = await readFile(TYPES, 'utf8');
    const start = source.indexOf('export type ReasonCode');
    const end = source.indexOf(';', start);
    if (start === -1 || end === -1) throw new Error('the reason codes are not declared where this harness looks for them');
    const union = source.slice(start, end);
    const codes = [...new Set([...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((match) => match[1]))];
    // **A second derivation, from a different file, used only to check the first.** The decision schema carries the same
    // vocabulary as an enum, and it is written for a different purpose by a different reader — so if the two disagree, one
    // of them is stale, and the harness says which rather than silently testing the wrong set. (The message catalogue would
    // be the natural cross-check, but the script is plain node and cannot import a TypeScript module.)
    const schema = JSON.parse(await readFile('schemas/review-decision.schema.json', 'utf8'));
    const declared = [...findEnumContaining(schema, 'budget_exhausted')];
    const missing = codes.filter((code) => !declared.includes(code));
    const extra = declared.filter((code) => !codes.includes(code));
    if (missing.length > 0 || extra.length > 0) {
        throw new Error(`the reason union and review-decision.schema.json disagree: union-only ${missing.join(', ') || 'none'}; schema-only ${extra.join(', ') || 'none'}`);
    }
    return codes;
}

/** The first enum array anywhere in a JSON document that holds the given member. Depth-first, because the path may move. */
function findEnumContaining(node, member) {
    if (Array.isArray(node)) {
        if (node.includes(member)) return node;
        for (const item of node) {
            const found = findEnumContaining(item, member);
            if (found.length > 0) return found;
        }
        return [];
    }
    if (node !== null && typeof node === 'object') {
        for (const value of Object.values(node)) {
            const found = findEnumContaining(value, member);
            if (found.length > 0) return found;
        }
    }
    return [];
}

/** Whether a code's refusal is pushed from a statement in `decide.ts`, and the line span of that statement. */
function siteFor(lines, code) {
    const needle = `'${code}'`;
    const hit = lines.findIndex((line) => line.includes(needle));
    if (hit === -1) return null;
    // The statement that produces it: walk back to the push, then forward over balanced parentheses to its semicolon.
    let start = hit;
    while (start > 0 && !/reasons\.push\(/.test(lines[start] ?? '')) start -= 1;
    if (!/reasons\.push\(/.test(lines[start] ?? '')) return null;
    let depth = 0;
    let end = start;
    for (; end < lines.length; end += 1) {
        for (const character of lines[end] ?? '') {
            if (character === '(') depth += 1;
            else if (character === ')') depth -= 1;
        }
        if (depth === 0 && /;\s*$/.test(lines[end] ?? '')) break;
    }
    if (end >= lines.length || depth !== 0) return null;
    return { start, end };
}

async function main() {
    const argv = process.argv.slice(2);
    const json = argv.includes('--json');
    const only = argv.indexOf('--only') === -1 ? null : argv[argv.indexOf('--only') + 1];

    const original = await readFile(DECIDE, 'utf8');
    const lines = original.split('\n');
    const codes = (await reasonCodes()).filter((code) => only === null || code === only);
    const results = [];

    try {
        for (const code of codes) {
            const site = siteFor(lines, code);
            if (site === null) {
                results.push({ code, site: null, killed: false, why: 'no-site: no statement in decide.ts produces this code' });
                continue;
            }
            // Comment out the producing statement. The `if` that guarded it stays, which is the point: the rule is gone and
            // the branch is empty, so the refusal can no longer be produced.
            const mutated = [...lines];
            for (let index = site.start; index <= site.end; index += 1) mutated[index] = `// MUTATION-KILL ${mutated[index]}`;
            await writeFile(DECIDE, mutated.join('\n'), 'utf8');

            // The syntax gate: a broken file makes every test fail, which would look like a kill.
            try {
                await run('npx', ['esbuild', DECIDE, '--outfile=/dev/null'], { maxBuffer: 10_000_000 });
            } catch (error) {
                results.push({ code, site, killed: false, why: `mutation did not parse: ${String(error).slice(0, 160)}` });
                await writeFile(DECIDE, original, 'utf8');
                continue;
            }

            let killed = false;
            let detail = '';
            try {
                await run('npx', ['vitest', 'run', ...WATCHERS], { maxBuffer: 60_000_000 });
            } catch {
                killed = true;
            }
            if (!killed) detail = 'no watcher failed';
            await writeFile(DECIDE, original, 'utf8');
            results.push({ code, site, killed, ...(detail === '' ? {} : { why: detail }) });
            if (!json) process.stderr.write(`${killed ? 'killed  ' : 'SURVIVED'} ${code}\n`);
        }
    } finally {
        // Every path, including a throw: the tree must be exactly as it was found.
        await writeFile(DECIDE, original, 'utf8');
    }

    const killed = results.filter((entry) => entry.killed).length;
    const summary = {
        codes: codes.length,
        killed,
        killRate: codes.length === 0 ? null : killed / codes.length,
        survivors: results.filter((entry) => !entry.killed).map((entry) => ({ code: entry.code, why: entry.why ?? 'survived' })),
        results,
        measures:
            'whether removing a decision rule turns a test red — not whether the rule is correct, and not the mutation score of '
            + 'any code outside the kernel decision: the watchers are five files chosen because they assert decision outcomes.',
    };
    if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else process.stdout.write(`\n${killed}/${codes.length} rules killed (rate ${summary.killRate === null ? 'n/a' : summary.killRate.toFixed(3)})\n`);
    process.exitCode = killed === codes.length ? 0 : 1;
}

await main();
