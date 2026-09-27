import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSkill, skillCommands, type Platform } from '../../src/adapters/manifest.js';
import { dispatchedCommands, isDispatchedCommand, isDispatchedSubcommand } from '../helpers/dispatcher-vocabulary.js';

/**
 * **Every command a generated skill tells an operator to run must be one the CLI answers.**
 *
 * This is the general form of a rule that was written for one skill class and should never have been that narrow. The
 * phase guidance these skills carry is the *operating manual* a fresh session reads, and it named a route that had been
 * deleted — `kata-cli adversarial brief`, `kata-cli findings defer`, `kata-cli repair-author record`, `kata-cli
 * adversarial status` — every one of which now exits 1 with "unknown command". The earlier check covered only the
 * procedure skills, so the skills that matter most were unmeasured.
 *
 * Deriving the vocabulary from the dispatcher rather than from a hand-written list is what makes this catch the next
 * rename: a command that stops being dispatched fails here by name, in the file that still tells someone to run it.
 */
const PLATFORM: Platform = 'codex';

/** `kata-cli <verb> [<sub>]` occurrences in generated text, with the line they appear on. */
function mentionedCommands(text: string): Array<{ verb: string; subcommand: string | null; line: string }> {
    const found: Array<{ verb: string; subcommand: string | null; line: string }> = [];
    for (const line of text.split('\n')) {
        for (const match of line.matchAll(/\bkata-cli ([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/gu)) {
            const [verb, subcommand] = [match[1]!, match[2] ?? null];
            // The word after the verb is only a subcommand when what follows it is a flag or the end of the command; a
            // bare noun phrase like `kata-cli status <id>` already names its subcommand argument.
            found.push({ verb, subcommand, line: line.trim() });
        }
    }
    return found;
}

describe('generated skill text names only commands the CLI dispatches', () => {
    it('mentions no command that would exit "unknown command"', () => {
        const offenders: string[] = [];
        for (const command of skillCommands) {
            for (const platform of ['codex', 'opencode', 'pi'] as Platform[]) {
                const text = renderSkill(command, platform, { language: 'en' });
                for (const mention of mentionedCommands(text)) {
                    if (!isDispatchedCommand(mention.verb)) {
                        offenders.push(`${command.id} (${platform}): kata-cli ${mention.verb} — ${mention.line.slice(0, 90)}`);
                    }
                }
            }
        }
        expect(
            [...new Set(offenders)],
            'these generated skills tell an operator to run a command the CLI does not dispatch:',
        ).toEqual([]);
    });

    it('mentions no subcommand the family would refuse', () => {
        const offenders: string[] = [];
        for (const command of skillCommands) {
            const text = renderSkill(command, PLATFORM, { language: 'en' });
            for (const mention of mentionedCommands(text)) {
                if (!isDispatchedCommand(mention.verb) || mention.subcommand === null) continue;
                if (isDispatchedSubcommand(mention.verb, mention.subcommand)) continue;
                // A word that is not a subcommand is usually the next argument (`kata-cli status <task-id>`), so only a
                // word that looks like a flagless token in a position a subcommand would occupy is reported.
                offenders.push(`${command.id}: kata-cli ${mention.verb} ${mention.subcommand} — ${mention.line.slice(0, 90)}`);
            }
        }
        expect([...new Set(offenders)]).toEqual([]);
    });

    /**
     * **The reverse direction, which is why two orphaned skill files sat on disk.** The generator's contract is one-way by
     * default — it renders what the manifest declares — so a declaration that is removed leaves its artefact behind, and
     * an artefact nothing declares is worse than a missing one: it still loads, and it still tells an operator to run the
     * deleted route. Measured: `kata-review-round` and `kata-host-adapter` were deleted from the manifest and their two
     * SKILL.md files stayed.
     */
    it('leaves no generated skill file for a command the manifest no longer declares', () => {
        const declared = new Set<string>(skillCommands.map((command) => command.id));
        const files = readdirSync('.agents/skills', { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => name.startsWith('kata-'));
        expect(
            files.filter((name) => !declared.has(name)),
            'these directories hold a generated skill for a command no longer declared, so something still installs text nobody maintains',
        ).toEqual([]);
    });

    it('derives its vocabulary from the dispatcher, not from a list', () => {
        // A guard on the guard: if `isDeclaredCommand` answered true for everything, the cases above would pass vacuously.
        expect(isDispatchedCommand('definitely-not-a-command')).toBe(false);
        expect(isDispatchedSubcommand('ledger', 'definitely-not-a-subcommand')).toBe(false);
        expect(dispatchedCommands().size).toBeGreaterThan(20);
    });
});
