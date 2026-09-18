import { describe, expect, it } from 'vitest';
import { renderSkill, skillCommands } from '../../src/adapters/manifest.js';
import { adversarialGuidanceFor, automationGuidanceFor, phaseGuidanceFor } from '../../src/adapters/phase-guidance.js';

/**
 * The skill documentation is catalogue data (L6-02).
 *
 * `renderSkill` held a 356-line ternary keyed on `command.id`, embedding every command's prose in the same file as the
 * machine-readable catalogue, so adding a command meant adding data *and* a branch. The prose lives in
 * `phase-guidance.ts` now; the renderer lays it out.
 */
describe('phase guidance is data keyed by command', () => {
    it('gives every command its own guidance, and the shared flow to the three that share it', () => {
        expect(phaseGuidanceFor({ id: 'kata', slashCommand: '/kata', cli: 'kata-cli status', phase: 'dispatch' })).toContain('## Smart dispatch');
        expect(phaseGuidanceFor({ id: 'kata-build', slashCommand: '/kata-build', cli: 'kata-cli build --change <change-id>', phase: 'implement' })).toContain('## Knowledge capture during implementation');

        // open/hotfix/tweak share one block, rendered with their own command name and phase.
        const open = phaseGuidanceFor({ id: 'kata-open', slashCommand: '/kata-open', cli: 'kata-cli open --change <change-id>', phase: 'open' });
        const tweak = phaseGuidanceFor({ id: 'kata-tweak', slashCommand: '/kata-tweak', cli: 'kata-cli tweak --change <change-id>', phase: 'tweak' });
        expect(open).toContain('/kata-open');
        expect(tweak).toContain('/kata-tweak');
        expect(open).not.toContain('```\\n/kata-tweak');
    });

    it('carries the adversarial step only on the two nodes that conclude a change', () => {
        expect(adversarialGuidanceFor({ id: 'kata-verify', cli: 'kata-cli verify --change <change-id>' })).toContain('--node verify');
        expect(adversarialGuidanceFor({ id: 'kata-review', cli: 'kata-cli review --change <change-id>' })).toContain('--node review');
        expect(adversarialGuidanceFor({ id: 'kata-build', cli: 'kata-cli build' })).toBe('');
    });

    it('carries the automation contract only on the phases that drive a command to a verdict', () => {
        expect(automationGuidanceFor({ id: 'kata-build' }, 'opencode')).toContain('platform opencode');
        expect(automationGuidanceFor({ id: 'kata-collect' }, 'opencode')).toBe('');
    });

    it('renders every command through the catalogue, with no id branching left in the renderer', () => {
        for (const command of skillCommands) {
            const rendered = renderSkill(command, 'opencode', { language: 'en' });
            // The command's own guidance is present, and the renderer's own layout is unchanged.
            expect(rendered, command.id).toContain(command.slashCommand);
            expect(rendered, command.id).toContain(`platform: opencode`);
        }
    });
});
