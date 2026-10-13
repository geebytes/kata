import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anchorRefusal, locateAnchor } from '../../src/quality/falsifier-anchors.js';

/**
 * AC-2 — the seal's anchor refusal names the command that re-aims **that one item**.
 *
 * The measured harm: the refusal printed `kata-cli ledger evidence replace --change <id> --file <your evidence submission>`
 * — the *wide* form, which replaces the whole set with what the author re-types. Re-aiming a single anchor therefore meant
 * submitting every other item again, and this repository lost evidence to that twice (2026-10-12/13). A refusal must not
 * prescribe a road that costs something the road is not about.
 *
 * The assertion is the property (the printed remedy names the narrow form and not the wide one), not the sentence, and the
 * refusal text is read from the module that prints it rather than restated here — so the two cannot drift.
 */
const preflight = readFileSync(join(process.cwd(), 'src', 'workflow', 'seal-preflight.ts'), 'utf8');

describe('the seal refusal names the narrow re-aim', () => {
    it('prints --id and does not require the whole set', () => {
        const branch = preflight.slice(preflight.indexOf('falsifierAnchorUnusable'));
        const upToReturn = branch.slice(0, branch.indexOf('return { blockers'));
        expect(upToReturn).toMatch(/--id \$\{problem\.evidenceId\}/u);
        // The wide form must not be the printed road: `--file <your evidence submission>` was the sentence that cost items.
        expect(upToReturn).not.toMatch(/--file <your evidence submission>/u);
        // And the structured field carries the same narrow command, so a machine reader is not sent to the wide one either.
        const structured = upToReturn.slice(upToReturn.indexOf('reaimCommand'));
        expect(structured).toMatch(/--id/u);
    });

    it('is reachable only for an anchor that cannot mean what it claims', () => {
        // The refusal is earned by the location, and the two unusable kinds are the ones measured in this repository: an
        // anchor that stopped matching after a repair, and one that matches more than once so the defect lands elsewhere.
        expect(anchorRefusal(locateAnchor('const a = 1;\n', 'const b = 2;'), 'src/a.ts', 'const b = 2;')).toMatch(/matches 0 times/u);
        expect(anchorRefusal(locateAnchor('x\nx\n', 'x'), 'src/a.ts', 'x')).toMatch(/matches 2 times/u);
        expect(anchorRefusal(locateAnchor('const a = 1;\n', 'const a = 1;'), 'src/a.ts', 'const a = 1;')).toBeUndefined();
    });

    it('keeps the wide form available for the case it is for', () => {
        // The wide form is not removed: replacing a set is the door for an item recorded under a shape this build no longer
        // accepts (five such items were measured once). The criterion is that the *refusal* does not prescribe it, and that
        // the command still says which form is which.
        const ledgerCli = readFileSync(join(process.cwd(), 'src', 'cli', 'ledger.ts'), 'utf8');
        expect(ledgerCli).toMatch(/the wide form/u);
        expect(ledgerCli).toMatch(/the narrow form/u);
    });
});
