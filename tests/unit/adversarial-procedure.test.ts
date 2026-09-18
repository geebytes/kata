import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adversarialGuidanceFor, automationGuidanceFor } from '../../src/adapters/phase-guidance.js';
import { renderSkill, skillCommands } from '../../src/adapters/manifest.js';

/**
 * The procedure the skill text states has to be the procedure the commands implement.
 *
 * The finding-lifecycle design's §11 could not answer "what does a narrower re-verification save?" because nothing
 * recorded a pass's duration — and a mechanism nobody is told to use is the same as no mechanism. So this checks the
 * text the agent reads names the flags that make the measurement possible, and that the printed `recordCommand` carries
 * them too (a caller who copies the printed line should do the right thing without reading the guidance).
 */
describe('the adversarial procedure is stated, not implied', () => {
    it('tells the reviewer to report the pass duration, and why', () => {
        const text = adversarialGuidanceFor({ id: 'kata-verify', cli: 'kata-cli verify --change <change-id>' });

        expect(text).toContain('--elapsed-ms');
        expect(text).toContain('deltaSaving');
        // The reason is stated, so the instruction is not arbitrary bookkeeping.
        expect(text).toMatch(/§11|not measurable yet/);
    });

    it('tells the reviewer to name the brief it answered, and that the scope comes from it', () => {
        const text = adversarialGuidanceFor({ id: 'kata-review', cli: 'kata-cli review --change <change-id>' });

        // The binding is the issued brief, so the instruction is about the hash — not about re-passing a flag the
        // command no longer takes, which would be an invitation to disagree with the brief.
        expect(text).toMatch(/brief's hash on the result/);
        expect(text).toMatch(/never pass a \`--since\` and never hand-write \`scope\`/);
        expect(text).toContain('delta_stale');
    });

    it('tells the reviewer that a finding has a disposition, and that blocking/major cannot have one', () => {
        const text = adversarialGuidanceFor({ id: 'kata-verify', cli: 'kata-cli verify --change <change-id>' });

        expect(text).toContain('kata-cli findings defer');
        expect(text).toContain('findingOrigins.causedByPreviousRepair');
        expect(text).toMatch(/must be repaired/);
    });

    it('opens with the case for an independent pass, so the procedure is not bare bookkeeping', () => {
        const text = adversarialGuidanceFor({ id: 'kata-verify', cli: 'kata-cli verify --change <change-id>' });

        expect(text).toContain('Independent adversarial review');
        expect(text).toMatch(/different context than the one that wrote the change/);
    });

    it('renders the procedure into the shipped skill, for both concluding nodes and no others', () => {
        for (const command of skillCommands) {
            const rendered = renderSkill(command, 'opencode', { language: 'en' });
            if (command.id === 'kata-verify' || command.id === 'kata-review') {
                expect(rendered, command.id).toContain('--elapsed-ms');
            } else {
                expect(rendered, command.id).not.toContain('--elapsed-ms');
            }
        }
    });
});
