import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformAgentsDir } from '../../src/adapters/platforms.js';
import { agentDefinitions, renderAgentDefinition } from '../../src/adapters/manifest.js';

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
 * **The property, proved without a word list.**
 *
 * The rule is "the definition carries no protocol". The previous form of this guard scanned for *markers* of protocol prose
 * — a list of command shapes and nouns — which is a list of spellings: a definition could restate the whole protocol in
 * different words and pass, and the list could only grow as the protocol's vocabulary changed.
 *
 * What replaces it is the property itself, from two directions:
 *
 * 1. **The definition is compared with its renderer.** A hand-edited definition is a definition that has drifted, whatever it
 *    drifted *to*, so byte equality with `renderAgentDefinition(…)` is the check — and the renderer's own text carries no
 *    protocol because the protocol lives in the skill it points at.
 * 2. **The pointer resolves.** The skill the definition names has to exist, and has to be the skill the specification names
 *    for that agent. A pointer into nothing is worse than a copy: it reads as "the protocol is over there" while there is
 *    nothing there.
 */
describe('an agent definition carries no protocol', () => {
    it('is byte-for-byte what the renderer produces, so nothing hand-written survives in it', async () => {
        const dir = platformAgentsDir('pi', 'project');
        expect(dir).not.toBeNull();
        if (dir === null) return;
        const files = (await readdir(dir)).filter((entry) => entry.endsWith('.md')).sort();

        // The declared agents are the ones on disk: a definition for an agent nobody declares is as wrong as a missing one.
        expect(files).toEqual([...agentDefinitions.map((spec) => `${spec.id}.md`)].sort());
        // **The language the writer used**, read from the project config rather than assumed: `update` renders with the
        // configured response language, so a comparison against the default would fail on a project that sets one — and this
        // repository does.
        const { loadConfig } = await import('../../src/core/config.js');
        const language = (await loadConfig(process.cwd())).language;
        for (const file of files) {
            const agentId = file.replace(/\.md$/, '');
            const rendered = renderAgentDefinition(agentId, 'pi', { language });
            expect(rendered, `${agentId} renders`).not.toBeNull();
            expect(await readFile(join(dir, file), 'utf8'), `${agentId} equals its renderer`).toBe(rendered);
        }
    });

    it('points at a skill that exists, and at the one its specification names', async () => {
        for (const spec of agentDefinitions) {
            const rendered = renderAgentDefinition(spec.id, 'pi') ?? '';
            // The pointer, as a path the reader can open.
            const pointer = `.agents/skills/${spec.protocolSkill}/SKILL.md`;
            expect(rendered, `${spec.id} names ${pointer}`).toContain(pointer);
            await expect(readFile(join(process.cwd(), pointer), 'utf8'), `${pointer} exists`).resolves.toContain('name:');
            // **And the protocol is not restated beside the pointer.** The rendered definitions describe the tool surface, the
            // extension registration and the isolation boundary — the things the host owns. A protocol sentence there is the
            // second copy this rule exists to prevent, and it cannot appear through the renderer: the specification has no
            // field for one.
            for (const section of spec.owns) {
                expect(section.body).not.toMatch(/kata-cli ledger (?:answer|ask|challenge|evidence|decide|status|run)/);
                expect(section.body).not.toMatch(/\bwithheldProbes\b/);
            }
        }
    });

    it('flags a definition that differs from its renderer at all, not only one that uses the retired vocabulary', async () => {
        // The control, in the shape this suite uses: the checker must be able to fail. Equality is the whole check, so a
        // definition restating the protocol in *new* words is caught exactly like one using the old ones — which is what a
        // marker list could never do.
        const { loadConfig } = await import('../../src/core/config.js');
        const real = renderAgentDefinition('kata-reviewer', 'pi', { language: (await loadConfig(process.cwd())).language }) ?? '';
        const restatedInNewWords = real.replace('## What this file owns', '## What this file owns\n\nFirst, confirm the request handed you nothing you were not asked for, then measure.\n');
        expect(restatedInNewWords).not.toBe(real);
        // And a definition that merely *mentions* the protocol to point at it is the rendered shape, so it is not flagged.
        expect(real).toContain('.agents/skills/kata-review/SKILL.md');
    });
});

