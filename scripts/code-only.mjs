#!/usr/bin/env node
/**
 * Print a source file with its comments blanked, keeping line and column structure.
 *
 * **Why this exists.** A counterexample run through the ledger is a shell command, and three times in one session such a
 * command measured a *comment* instead of code: a grep for `maxWallMs` matched the sentence saying the adapter no longer
 * arms a timer; a grep for `changedPaths: []` matched a doc comment describing the defect the fix removed. Each produced
 * an open challenge against a defect that was not there, and the ledger was right to block on it — the measurement was
 * the wrong thing. Rather than hand-rolling comment stripping in every command (and getting it half wrong: `//` only,
 * never `/* … *​/`), commands strip with this, so a counterexample that greps source greps code.
 *
 * Usage: node scripts/code-only.mjs <file> [<file>…]
 *
 * The in-test twin is `codeOnly()` in `tests/unit/kernel-is-pure-and-platform-neutral.test.ts`: same rule, applied to the
 * kernel's own sources where no shell is involved.
 */
import { readFileSync } from 'node:fs';

const blank = (match) => match.replace(/[^\n]/gu, ' ');

export function codeOnly(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, blank)
        .replace(/\/\/[^\n]*/gu, blank);
}

const files = process.argv.slice(2);
if (files.length === 0) {
    process.stderr.write('usage: node scripts/code-only.mjs <file> [<file>…]\n');
    process.exit(2);
}

for (const file of files) {
    try {
        process.stdout.write(codeOnly(readFileSync(file, 'utf8')));
    } catch (error) {
        // A path that cannot be read is not an empty file: say so and fail, so a filter downstream cannot read silence
        // as "nothing matched".
        process.stderr.write(`cannot read ${file}: ${error.message}\n`);
        process.exit(1);
    }
}
