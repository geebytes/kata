import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEDGER_VERBS } from '../../src/cli/ledger.js';

/**
 * **The refusal's verb list is the dispatcher's verb list.**
 *
 * Measured: the message named nine of the nineteen verbs, so an operator who mistyped `ledger run` was told the verb
 * does not exist — while `ledger run` is exactly what the review node's own contract hands them. A hand-kept subset of
 * a dispatch table is a list that cannot be wrong loudly, only quietly.
 */
describe('the ledger verb list names what the dispatcher handles', () => {
    it('matches the handlers in the source, in both directions', () => {
        const source = readFileSync(join(process.cwd(), 'src', 'cli', 'ledger.ts'), 'utf8');
        const handled = new Set([...source.matchAll(/if \(sub === '([a-z-]+)'\)/gu)].map((match) => match[1]!));
        const declared = new Set<string>(LEDGER_VERBS);
        expect([...declared].filter((verb) => !handled.has(verb))).toEqual([]);
        expect([...handled].filter((verb) => !declared.has(verb))).toEqual([]);
    });
});
