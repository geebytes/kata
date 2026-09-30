import { describe, expect, it } from 'vitest';
import { manifestWithContracts, nodeContractFor, skillCommands, type Platform, renderSkill } from '../../src/adapters/manifest.js';
import { isDispatchedCommand, isDispatchedSubcommand } from '../helpers/dispatcher-vocabulary.js';
import { GATE_CREATED_BY, USER_CHOICES } from '../../src/workflow/user-choice-gate.js';

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
            const contract = nodeContractFor(command.id as Parameters<typeof nodeContractFor>[0]);
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
        const ids = new Set<string>(skillCommands.map((command) => command.id));
        const offenders: string[] = [];
        for (const command of skillCommands) {
            const contract = nodeContractFor(command.id as Parameters<typeof nodeContractFor>[0]);
            if (contract === null) continue;
            for (const input of contract.inputs) {
                // An input that names a predecessor which is not a node is prose, not a connection: the id has to name
                // something this repository renders.
                if (input.from !== null && !ids.has(String(input.from))) {
                    offenders.push(`${command.id}: input from "${String(input.from)}", which is not a node`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('asks only choices the CLI accepts', () => {
        // A gate answer that the CLI does not know is an interaction the operator cannot complete. The set is read from
        // the value the gate itself uses rather than restated here: a hand-kept copy is what let this guard look at a
        // vocabulary it had frozen while the CLI's own moved.
        const accepted = new Set<string>(USER_CHOICES);
        const offenders: string[] = [];
        for (const command of skillCommands) {
            const contract = nodeContractFor(command.id as Parameters<typeof nodeContractFor>[0]);
            if (contract === null) continue;
            for (const question of contract.interaction) {
                for (const choice of question.choices) {
                    if (!accepted.has(choice)) offenders.push(`${command.id}: choice "${choice}" is not one the CLI accepts`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('renders every answer the gate accepts into the interaction it declares', () => {
        // The other direction of the same fact: a gate answer the CLI accepts but no rendered contract mentions is an
        // option an operator has to discover. One node is enough to carry the set — they all render the same table.
        const rendered = skillCommands
            .map((command) => nodeContractFor(command.id as Parameters<typeof nodeContractFor>[0]))
            .filter((contract): contract is NonNullable<typeof contract> => contract !== null)
            .flatMap((contract) => contract.interaction.flatMap((question) => question.choices));
        expect([...new Set(rendered)].sort()).toEqual([...USER_CHOICES].sort());
    });

    it('names the boundaries the gate accepts, not a placeholder, in every rendered interaction', () => {
        // Measured by an independent review: the interaction line was rendered as `--boundary <boundary>`, so the text
        // an operator copies contains a placeholder the CLI does not accept. The boundaries come from the table that
        // creates the gates, so a boundary added there appears here and one removed here cannot be offered.
        const offenders: string[] = [];
        for (const command of skillCommands) {
            if (!command.phase) continue;
            const rendered = renderSkill(command, 'pi', { language: 'en' });
            if (!rendered.includes('--boundary')) continue;
            for (const boundary of Object.keys(GATE_CREATED_BY)) {
                if (!rendered.includes(boundary)) offenders.push(`${command.id}: does not name boundary ${boundary}`);
            }
            if (rendered.includes('--boundary <boundary>')) offenders.push(`${command.id}: renders the placeholder --boundary <boundary>`);
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

    it('hands the ReviewRequest only to a subagent and forbids an independent Pi-process fallback', () => {
        const review = nodeContractFor('kata-review');
        expect(review?.inputs).toEqual([
            {
                what: 'the review request: each claim, its reading set, the evidence its tier requires, the deadline and the probes',
                from: 'kata-verify',
                source: 'kata-cli ledger run --change <id> --out <path>',
            },
        ]);
        expect(review?.outputs).toContainEqual({
            what: 'the structured review result returned by the subagent and recorded by the invoking Skill',
            artefact: 'kata-cli review --change <id> --result-file <path> → .kata/tasks/<id>/review.json',
        });

        for (const platform of ['codex', 'opencode', 'pi'] as Platform[]) {
            const rendered = renderSkill(skillCommands.find((command) => command.id === 'kata-review')!, platform, { language: 'en' });
            expect(rendered).toContain('Dispatch exactly one subagent with the ReviewRequest as its only payload.');
            expect(rendered).toContain('kata-cli review --change <task-id> --result-file result.json');
            expect(rendered).not.toMatch(/\bpi\s+-p\b|--no-session|\bnohup\b|\bsetsid\b/u);
            expect(rendered).not.toContain('where the platform can launch one');
        }
    });
});
