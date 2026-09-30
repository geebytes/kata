import { describe, expect, it } from 'vitest';
import { manifestWithContracts, nodeContractFor, skillCommands, type Platform, renderSkill } from '../../src/adapters/manifest.js';
import { isDispatchedCommand, isDispatchedSubcommand } from '../helpers/dispatcher-vocabulary.js';

/**
 * **A node that does not say what it consumes and produces cannot be connected to anything.**
 *
 * Measured before this: the review node was given whatever the operator happened to write. On a real change the author
 * hand-wrote a task brief instead of handing over the deterministic output of the previous node (`kata-cli ledger run`),
 * so the node's input existed as prose in one session rather than as an artefact the next node could be pointed at. A
 * node contract fixes the three things that kept being improvised: where the input comes from, what the output is, and
 * what the node asks the operator when it stops.
 */

describe('every workflow node declares its input, output and interaction', () => {
    it('declares all three for every node that owns a phase', () => {
        const missing: string[] = [];
        for (const command of skillCommands) {
            if (!('phase' in command) || !command.phase) continue;
            const contract = nodeContractFor(command.id);
            if (contract === null) {
                missing.push(`${command.id}: no contract`);
                continue;
            }
            for (const field of ['inputs', 'outputs'] as const) {
                if (contract[field].length === 0) missing.push(`${command.id}: ${field} is empty`);
            }
            // An empty `interaction` is a declaration, not a gap: `kata-build` and `kata` stop for nothing, and saying
            // so is what keeps a node that *should* stop from quietly inheriting someone else's pause.
        }
        expect(missing).toEqual([]);
    });

    it('names an upstream node for every input that has one, and only real nodes', () => {
        const ids = new Set(skillCommands.map((command) => command.id));
        const offenders: string[] = [];
        for (const command of skillCommands) {
            const contract = nodeContractFor(command.id);
            if (contract === null) continue;
            for (const input of contract.inputs) {
                if (input.from !== null && !ids.has(input.from)) {
                    offenders.push(`${command.id}: input from "${input.from}", which is not a node`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('asks only choices the CLI accepts', () => {
        // A gate answer that the CLI does not know is an interaction the operator cannot complete: the declared options
        // and the accepted values have to be the same set, and the CLI is where that set lives.
        const accepted = new Set(['continue_current', 'switched', 'delegated']);
        const offenders: string[] = [];
        for (const command of skillCommands) {
            const contract = nodeContractFor(command.id);
            if (contract === null) continue;
            for (const question of contract.interaction) {
                for (const choice of question.choices) {
                    if (!accepted.has(choice)) offenders.push(`${command.id}: choice "${choice}" is not one the CLI accepts`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('renders the contract into every platform copy, and names only dispatched commands', () => {
        const offenders: string[] = [];
        for (const command of skillCommands) {
            if (!('phase' in command) || !command.phase) continue;
            for (const platform of ['codex', 'opencode', 'pi'] as Platform[]) {
                const text = renderSkill(command, platform, { language: 'en' });
                if (!text.includes('## Node contract')) {
                    offenders.push(`${command.id}/${platform}: no rendered contract`);
                    continue;
                }
                for (const line of text.split('\n')) {
                    for (const match of line.matchAll(/\bkata-cli ([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/gu)) {
                        const [, verb, sub] = match;
                        if (!isDispatchedCommand(verb!) || (sub !== undefined && !isDispatchedSubcommand(verb!, sub))) {
                            offenders.push(`${command.id}/${platform}: kata-cli ${verb} ${sub ?? ''}`.trim());
                        }
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('exposes the contract in the machine-readable manifest', () => {
        const withContract = manifestWithContracts.filter((entry) => entry.contract != null);
        expect(withContract.length).toBeGreaterThanOrEqual(5);
        expect(withContract.map((entry) => entry.id)).toContain('kata-review');
    });
});
