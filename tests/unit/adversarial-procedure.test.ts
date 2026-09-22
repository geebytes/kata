import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adversarialGuidanceFor, automationGuidanceFor } from '../../src/adapters/phase-guidance.js';
import { renderSkill, skillCommands } from '../../src/adapters/manifest.js';

import { requiredAdversarialNodes } from '../../src/quality/adversarial.js';
/**
 * The procedure the skill text states has to be the procedure the commands implement.
 *
 * The finding-lifecycle design's §11 could not answer "what does a narrower re-verification save?" because nothing
 * recorded a pass's duration — and a mechanism nobody is told to use is the same as no mechanism. So this checks the
 * text the agent reads names the flags that make the measurement possible, and that the printed `recordCommand` carries
 * them too (a caller who copies the printed line should do the right thing without reading the guidance).
 */
describe('the adversarial procedure is stated, not implied', () => {
    it('tells the reviewer that telemetry is receipt-bound and must not be typed in', () => {
        const text = adversarialGuidanceFor({ id: 'kata-verify', cli: 'kata-cli verify --change <change-id>' });

        // §3.2.2 retired the self-reported flags. The guidance must state the retirement *and* name the replacement,
        // or a reviewer following it will hand-type a duration the platform cannot check.
        expect(text).toContain('--elapsed-ms');
        expect(text).toMatch(/retired/);
        expect(text).toMatch(/receipt/);
        // And it must say what happens when a host cannot produce one: unreported, not an unverifiable number.
        expect(text).toMatch(/unreported|unavailable/);
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
            // The two concluding nodes carry the adversarial procedure; no other skill should.
            if (command.id === 'kata-verify' || command.id === 'kata-review') {
                expect(rendered, command.id).toContain('--elapsed-ms');
            } else {
                expect(rendered, command.id).not.toContain('--elapsed-ms');
            }
        }
    });
    it.each([undefined, 'standard', 'strict', 'security'] as const)('assigns the one formal adversarial certification to Review in %s mode', (reviewMode) => {
        // Verify remains a deterministic evidence gate. Stronger profiles strengthen this one Review request through
        // receipt/budget/benchmark policy; they must not pay for a second unrestricted discovery pass.
        expect(requiredAdversarialNodes(reviewMode ? { reviewMode } : {})).toEqual(['review']);
    });

});
