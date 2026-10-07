import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformAgentsDir, platformDefinitions } from '../../src/adapters/platforms.js';
import { platformCapabilities } from '../../src/adapters/manifest.js';

/**
 * **An agent definition must not restate the protocol.**
 *
 * The reviewer's protocol is written once, in `src/adapters/phase-guidance.ts`, and rendered into every platform's skill by
 * `kata-cli update`. The agent definition is a *second* copy of the same instructions — hand-written, in every checkout, and
 * managed by nothing: measured on one machine, **55 copies of `kata-reviewer.md`** (36 inside `.kata/worktrees/*`, plus the
 * global agent directory and every project checkout). When the protocol changed — a probe answer stopped being a reading, and
 * a request began withholding questions bound to another revision — `update` refreshed every rendered skill and left all 55
 * copies saying `2. **Answer the probes.**`. A cold reviewer followed the stale sentence, read `probes.json` behind a request
 * whose `probes` was empty, and filed a blocking finding about its own brief.
 *
 * So the rule is: the definition keeps what the **host** owns — its tool surface, its extension registration — and points at
 * the skill for everything else. A definition that carries protocol prose is a copy that will drift, and this guard is what
 * makes the drift loud instead of silent.
 *
 * **The guard is written to be able to fail**, in the shape the other guards in this suite use: two control cases drive the
 * same checker with a fabricated definition that restates the protocol (it must be flagged) and one that only points (it must
 * not), because a guard that matches nothing proves nothing.
 */

/**
 * The markers of protocol prose: the commands a definition would have to spell out to restate the protocol, and the nouns
 * that only make sense inside it. Deliberately not a phrase list — a re-worded protocol step is the same defect.
 */
const PROTOCOL_MARKERS = [
    /kata-cli ledger (?:answer|ask|challenge|evidence|decide|status|run)/,
    /kata-cli review --change/,
    /kata-cli build --change/,
    /\bprobes?\b/,
    /\bwithheldProbes\b/,
    /executable_falsifier/,
];

/** What a definition must do instead: name the skill that carries the protocol. */
const DEFERS_TO_SKILL = /\.agents\/skills\/kata-[a-z-]+\/SKILL\.md|`\/kata-[a-z-]+`/;

/** The protocol markers a definition contains, as the lines that carry them. */
export function protocolLines(text: string): string[] {
    return text
        .split('\n')
        .filter((line) => PROTOCOL_MARKERS.some((marker) => marker.test(line)));
}

/** One finding per definition: it either defers to the skill and carries no protocol, or it says what is wrong. */
export function inspectDefinition(id: string, text: string): string | null {
    const carriers = protocolLines(text);
    if (carriers.length > 0) {
        return `${id} restates the protocol (${carriers.length} line(s), first: ${carriers[0]?.trim().slice(0, 80)}); it must point at the skill that carries it`;
    }
    if (!DEFERS_TO_SKILL.test(text)) {
        return `${id} neither carries the protocol nor names the skill that does, so a cold reader is given nothing`;
    }
    return null;
}

/**
 * The platforms whose agent definitions this guard covers, and the ones it cannot locate.
 *
 * A platform that declares sub-agent support but no agent directory is **reported** rather than skipped: silence there is how
 * a covered surface shrinks without anyone deciding it should.
 */
const AGENT_PLATFORMS = platformDefinitions.filter((definition) => definition.capabilities.subAgents);
const LOCATABLE = AGENT_PLATFORMS.filter((definition) => definition.agentsDir !== undefined);
const UNLOCATABLE = AGENT_PLATFORMS.filter((definition) => definition.agentsDir === undefined);

/** The definitions that exist on disk for a platform, as `id → text`. */
async function definitionsFor(platform: (typeof AGENT_PLATFORMS)[number]): Promise<Array<{ id: string; text: string }>> {
    const dir = platformAgentsDir(platform.id, 'project');
    if (dir === null) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: Array<{ id: string; text: string }> = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        out.push({ id: `${platform.id}:${entry.name}`, text: await readFile(join(dir, entry.name), 'utf8') });
    }
    return out;
}

describe('an agent definition points at the protocol instead of restating it', () => {
    it('every covered definition defers to the skill and carries no protocol', async () => {
        const found: Array<{ id: string; text: string }> = [];
        for (const platform of LOCATABLE) found.push(...(await definitionsFor(platform)));

        // The surface cannot shrink silently: if pi's definitions stop being found, this fails rather than passing on nothing.
        expect(found.map((entry) => entry.id)).toContain('pi:kata-reviewer.md');
        expect(found.map((entry) => entry.id)).toContain('pi:kata-implementer.md');

        const findings = found.map((entry) => inspectDefinition(entry.id, entry.text)).filter((finding) => finding !== null);
        expect(findings, findings.join('\n')).toEqual([]);
    });

    it('flags a definition that restates the protocol, and not one that only points', () => {
        const restating = [
            '---',
            'name: fabricated-reviewer',
            '---',
            'You are the reviewer.',
            '2. **Answer the probes.** `kata-cli ledger answer --probe <id> --observed "<what it printed>"`.',
        ].join('\n');
        expect(inspectDefinition('fabricated:restating.md', restating)).toContain('restates the protocol');

        const pointing = [
            '---',
            'name: fabricated-reviewer',
            '---',
            'You are the reviewer. Follow `.agents/skills/kata-review/SKILL.md`.',
        ].join('\n');
        expect(inspectDefinition('fabricated:pointing.md', pointing)).toBeNull();

        // A definition that neither restates the protocol nor points anywhere is its own finding: a cold reader gets nothing.
        expect(inspectDefinition('fabricated:silent.md', 'You are the reviewer.')).toContain('names the skill');
    });

    it('reports the platforms that declare sub-agent support but no agent directory', () => {
        // A named list, not silence: adding a platform that claims sub-agents without saying where they live has to be a
        // decision someone makes here, rather than a surface that quietly stops being covered.
        expect(UNLOCATABLE.map((definition) => definition.id)).toEqual([
            'codex',
            'claude-code',
            'opencode',
            'windsurf',
            'gemini',
            'github-copilot',
        ]);
        expect(LOCATABLE.map((definition) => definition.id)).toEqual(['pi']);
    });

    it('reads the same capability from both tables', () => {
        // The declaration exists twice — `platforms.ts`'s definition and `manifest.ts`'s record — and two readers of one fact
        // that disagree is the class this repository keeps meeting. They must agree for every platform.
        for (const definition of platformDefinitions) {
            expect(
                platformCapabilities[definition.id].subAgents,
                `${definition.id}: platforms.ts and manifest.ts disagree about subAgents`,
            ).toBe(definition.capabilities.subAgents);
        }
    });
});
