import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USAGE } from '../../src/cli/usage.js';
import { CLOSING_DISPOSITIONS, DISPOSITIONS, isOpenFinding } from '../../src/quality/review-ladder.js';

/**
 * AC-4 — the disposition vocabulary has one derivation, and the schema names no mechanism that is not there.
 *
 * The measured hole (I-35): `schemas/review-finding.schema.json` allows `open | fixed | deferred | accepted | routed` and
 * says the value is "set by a disposition command (`findings defer|accept|rout`) or by the closure rule marking a finding
 * fixed" — while `kata-cli findings` is `Unknown command`, `grep -rn "disposition:" src/` finds no writer of `fixed`, and
 * the ladder closes a finding on `fixed` alone. So the vocabulary lived in two artefacts that had never been compared, and
 * one of them described a command nobody can run.
 *
 * The criterion is the agreement, not the sentence: the schema's enum and the ladder's vocabulary are the same set, every
 * value the schema allows has a defined reading in the predicate, and the schema names no command the CLI does not have.
 */
const schema = JSON.parse(readFileSync(join(process.cwd(), 'schemas', 'review-finding.schema.json'), 'utf8')) as {
    properties: { disposition: { enum: string[]; description?: string } };
};

describe('a disposition has one vocabulary', () => {
    it('lists the same values in the schema and in the predicate, so neither can drift', () => {
        const inSchema = [...schema.properties.disposition.enum].sort();
        expect(inSchema).toEqual([...DISPOSITIONS].sort());
        // And the closing value is one of them, not a value the schema cannot express.
        for (const value of CLOSING_DISPOSITIONS) expect(inSchema).toContain(value);
    });

    it('gives every value the schema allows a defined reading, and closes only on the closing ones', () => {
        // A value the schema allows and the predicate does not know is a finding that can never be closed — or one that
        // closes by accident, which is the weaker direction of the same defect.
        for (const value of schema.properties.disposition.enum) {
            const open = isOpenFinding({ disposition: value });
            expect(open, `disposition=${value}`).toBe(!CLOSING_DISPOSITIONS.includes(value));
        }
        // Absent means open, which the schema states and the predicate must agree with.
        expect(isOpenFinding({})).toBe(true);
    });

    it('names no command the CLI does not have', () => {
        // The description named `findings defer|accept|rout`; the dispatcher has no such command, so the sentence told a
        // reader that a mechanism exists. Any backticked command-shaped phrase is checked against the vocabulary of
        // mechanisms this change knows, and the schema states the mechanism that actually writes the field instead.
        const description = schema.properties.disposition.description ?? '';
        // **Every backticked span, not only the ones that look like a single verb.** The first version of this line matched
        // only phrases made of letters and dashes, so `` `findings defer|accept|rout` `` slipped through it and the case was
        // green while the sentence it exists to remove was still there — an instrument that cannot redden.
        const named = [...description.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
        // **Command-shaped, not a denylist of one retired family.** The filter was `/^findings\b/`, so it caught the sentence
        // this change removed and nothing else: round 3's F8 replaced it with `nope defer` and the case stayed green while the
        // claim — "the schema names no command the CLI does not have" — was still false. A span with more than one token is a
        // command-shaped phrase, and its verb is checked against the CLI's own vocabulary; a single token is a name.
        // **Stated boundary, not a silent one** (round 4's F5(b), round 5's F4): a span of one token is treated as a *name*
        // (`fixed`, `disposition`) rather than a command-shaped phrase, so an invented single verb inside backticks would pass
        // this case. Deciding it would flag the schema's own vocabulary; the gap is stated here and in the design document.
        const verbOf = (value: string): string => {
            const tokens = value.trim().split(/\s+/u);
            return tokens[0] === 'kata-cli' ? (tokens[1] ?? '') : (tokens[0] ?? '');
        };
        const unknown = named.filter((value) => value.trim().split(/\s+/u).length > 1)
            .filter((value) => !Object.hasOwn(USAGE, verbOf(value)));
        expect(unknown, `the schema names a command the CLI does not have: ${unknown.join(' | ')}`).toEqual([]);
        expect(description).toMatch(/disposition/iu);
    });
});
