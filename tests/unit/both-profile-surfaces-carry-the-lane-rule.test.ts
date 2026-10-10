import { describe, expect, it } from 'vitest';
import { renderSkill, skillCommands, type Platform } from '../../src/adapters/manifest.js';

/**
 * **Every surface that resolves the profile carries the lane rule.**
 *
 * One copy drifts — this repository has measured that repeatedly, most expensively when the copy that drifted was the
 * operating manual a fresh session reads. The profile is resolved in more than one place (`/kata-open` starts a change,
 * `/kata-design` re-decides before the plan), so a rule written into one of them is a rule whose absence the other surface
 * cannot notice. This case asks both, and it asks for the *sentence*, not for a word that happens to appear in both.
 */
const PLATFORM: Platform = 'codex';

/**
 * The **property**, not the headline: the sentence that forbids a lane under the classification. Two surfaces say it in their
 * own words — the entry points own the rule, and design is where the classification first becomes readable — and a guard that
 * demanded one exact phrase would be policing marketing copy rather than the constraint.
 */
const FLOOR_CLAUSE = /(Do not open a change below its own classification|may not be below the classification)/i;

function rendered(id: string): string {
    const command = skillCommands.find((entry) => entry.id === id);
    expect(command, `${id} is a generated surface`).toBeDefined();
    return renderSkill(command!, PLATFORM, { language: 'en' });
}

describe('both profile-resolving skills carry the lane rule', () => {
    it.each(['kata-open', 'kata-design'])('%s states it', (id) => {
        const text = rendered(id);
        expect(text, `${id} resolves the profile, so it must state the rule`).toMatch(FLOOR_CLAUSE);
        // The rule is more than its prohibition: the surface it reads travels with it, so a session can act on it.
        expect(text, `${id} must name where the classification is readable`).toMatch(/kata-cli ledger plan/);
        expect(text).toMatch(/tier/i);
    });

    it('states it in the profile-decision block rather than somewhere else in the file', () => {
        // Proximity is the property: the rule has to sit where the three choices are made, or the session that is choosing
        // a mode is reading a different paragraph when it decides.
        const text = rendered('kata-open');
        const decision = text.indexOf('Skill-level workflow profile decision');
        const rule = text.indexOf('lane is a floor, not a preference');
        const reviewMode = text.indexOf('3. Review mode');
        expect(decision, 'the decision block is present').toBeGreaterThanOrEqual(0);
        expect(rule).toBeGreaterThan(decision);
        // Within the review-mode item: the rule cannot be further than one item away from the choice it constrains.
        expect(rule - reviewMode, 'the rule belongs to the review-mode item').toBeLessThan(900);
    });
});
