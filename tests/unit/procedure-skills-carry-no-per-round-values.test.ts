import { describe, expect, it } from 'vitest';
import { renderSkill, skillCommands, type Platform } from '../../src/adapters/manifest.js';

/**
 * **The two skills whose subject is a procedure, not kata's lifecycle.**
 *
 * `kata-host-adapter` is the operator's half of the round protocol and `kata-review-round` is the reviewer's; both were added because the
 * parties they instruct have no other channel from kata. That is also the reason for the rule this file tests: **a skill may carry an
 * instruction, never a per-round value.** A body that repeats the record's fields or the gate's conditions becomes a second channel for a
 * rule the brief already renders, and the measured cost of exactly that on this repository is 28 of 62 review rounds producing no record
 * while a hand-written dispatch prompt carried a missing requirement.
 */
const PROCEDURE_SKILLS = ['kata-review-round', 'kata-host-adapter'] as const;

/** The JSON keys the brief prescribes for a record. A body that names them is restating the brief. */
const BRIEF_PRESCRIBED_KEYS = ['readTests', 'wroteTests', 'classInstances', 'targets', 'hypotheses', 'briefSha256', 'revisionId', 'falsifier', 'impact', 'severity', 'observations'];

describe('a procedure skill carries an instruction, not a per-round value', () => {
    it('exists for each half of a round, and renders for every platform', () => {
        for (const id of PROCEDURE_SKILLS) {
            const command = skillCommands.find((entry) => entry.id === id);
            expect(command, `${id} is shipped as a skill`).toBeTruthy();
            // The union's members each carry their own literal shape, so `body` is read through the declared type for the ones that have it.
            expect((command as { body?: string } | undefined)?.body, `${id} renders its own body rather than the workflow-entrypoint text`).toBeTruthy();
            for (const platform of ['pi', 'codex', 'opencode', 'generic'] as Platform[]) {
                const rendered = renderSkill(command!, platform);
                expect(rendered).toContain(`name: ${id}`);
                expect(rendered).toContain(`platform: ${platform}`);
                // And it is not the generic body, which would describe resolving a task and reading its packet.
                expect(rendered).not.toContain('Use this skill to inspect the Kata');
            }
        }
    });

    it('does not restate the record the brief prescribes', () => {
        for (const id of PROCEDURE_SKILLS) {
            const body = (skillCommands.find((entry) => entry.id === id) as { body?: string } | undefined)?.body ?? '';
            for (const key of BRIEF_PRESCRIBED_KEYS) {
                expect(body, `${id} names the brief-prescribed key \`${key}\`, so a second channel now carries the same rule`).not.toContain(key);
            }
        }
    });

    it('says what its own half of the round is, in the sentence that decides it', () => {
        const reviewer = (skillCommands.find((entry) => entry.id === 'kata-review-round') as { body?: string } | undefined)?.body ?? '';
        // The reviewer's deciding fact: the brief is authoritative and this skill does not restate it.
        expect(reviewer).toContain('The brief is the whole instruction set');
        expect(reviewer).toContain('28 of 62');

        const host = (skillCommands.find((entry) => entry.id === 'kata-host-adapter') as { body?: string } | undefined)?.body ?? '';
        // The host's deciding fact: it launches and describes, and it does not write the receipt.
        expect(host).toContain('The host launches and describes');
        expect(host).toContain('it does not write a receipt');
        expect(host).toContain('$KATA_REVIEW_PACKET');
    });

    it('has no workflow phase, and the manifest does not invent one', async () => {
        const { commandManifest } = await import('../../src/adapters/manifest.js');
        for (const id of PROCEDURE_SKILLS) {
            expect(commandManifest.find((entry) => entry.id === id)).not.toHaveProperty('phase');
        }
        // The other direction, so this case is not satisfiable by dropping the field from everything.
        expect(commandManifest.find((entry) => entry.id === 'kata-build')).toHaveProperty('phase', 'implement');
    });
});
