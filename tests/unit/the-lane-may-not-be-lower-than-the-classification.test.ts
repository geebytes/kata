import { describe, expect, it } from 'vitest';
import { renderSkill, skillCommands, type Platform } from '../../src/adapters/manifest.js';

/**
 * **The lane is a floor, not a preference.**
 *
 * The repository already classifies a change from the paths it touches (`riskFloors` → a floor → a tier) and already
 * reports that classification — measured: `kata-cli ledger plan` carries `plan.risk` with `tier`, `floor`, `matched`
 * (pattern, path) and `riskClasses`. What no surface said until now is what the *operator* is supposed to do with it: the
 * profile's review mode and that classification were two statements about one decision, printed in different places, and a
 * change could be opened below its own floor with nothing pointing it out.
 *
 * This case holds the sentence where the decision is actually made (the profile-decision block every profile-resolving
 * skill carries), because a rule that lives only in a document is read by nobody at the moment it matters.
 */
const PLATFORM: Platform = 'codex';

function openGuidance(): string {
    const open = skillCommands.find((command) => command.id === 'kata-open');
    expect(open, 'the open skill is a generated surface').toBeDefined();
    return renderSkill(open!, PLATFORM, { language: 'en' });
}

describe('the guidance that chooses the review mode names the floor it may not go below', () => {
    it('says the lane follows the classification the paths produce', () => {
        const text = openGuidance();
        expect(text).toMatch(/lane is a floor, not a preference/i);
        expect(text).toMatch(/paths\s+the change touches|paths the change touches/i);
        // The classification's **readable** surface, so the rule is actionable rather than aspirational.
        expect(text, 'the rule must name where the classification can be read').toMatch(/kata-cli ledger plan/);
        expect(text).toMatch(/`risk`/);
        for (const field of ['tier', 'floor', 'matched', 'riskClasses']) {
            expect(text, `the rule names the ${field} field it is about`).toContain(field);
        }
    });

    it('forbids a lane below the classification and explains the cost of one above it', () => {
        const text = openGuidance();
        expect(text).toMatch(/at or above that\s+classification|at or above/i);
        expect(text).toMatch(/Do not open a change below its own classification/i);
        // A higher lane is allowed, and the reason is recorded in the conversation — the one sentence that stands in for
        // the audit trail the mechanism does not keep yet.
        expect(text).toMatch(/say why in one sentence/i);
        // And the criterion that raises it, stated in terms of what the change *reaches* rather than its size.
        expect(text).toMatch(/gate's meaning|identity|schema|enforced invariant/i);
        expect(text).toMatch(/whatever its size/i);
    });
});
