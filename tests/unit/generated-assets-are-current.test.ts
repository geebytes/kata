import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSkill, skillCommands, type Platform } from '../../src/adapters/manifest.js';
import { platformSkillPath } from '../../src/adapters/platforms.js';

/**
 * The committed platform assets must be what the renderer produces today.
 *
 * This is the guard for a real failure mode found on 2026-09-18: `.codex/`, `.opencode/` and `.agents/` hold rendered
 * copies of every skill, they are tracked in git, and **nothing checked that they were still current**. When the
 * renderer's prose changed — including the same day's `--elapsed-ms` / `deltaSaving` / `findings defer` procedure — the
 * committed copies silently kept the older text. The drift was also carrying a bug forward: the committed
 * `kata-verify` text contained ``--change --change <task-id>``, a doubled flag the renderer had already stopped
 * producing.
 *
 * The lesson generalises: anything the product *generates* and the repository *commits* needs a test that regenerates it
 * and compares, or "the assets are stale" is only ever discovered by accident. `kata-cli update` refreshes them; this
 * fails when it has not been run.
 */
const PLATFORMS: Platform[] = ['codex', 'opencode'];

describe('the committed platform assets match what the renderer produces', () => {
    for (const platform of PLATFORMS) {
        for (const command of skillCommands) {
            it(`${platform}: ${command.id}`, async () => {
                const relativePath = platformSkillPath(platform, 'project', command.id, process.cwd());
                const committed = await readFile(join(process.cwd(), relativePath), 'utf8').catch(() => null);
                if (committed === null) {
                    // A platform whose assets this checkout does not carry is not drift; it is simply not installed here.
                    return;
                }
                const rendered = renderSkill(command, platform, { language: detectLanguage(committed) });
                expect(
                    committed.trimEnd(),
                    `${relativePath} is stale. Run \`kata-cli update\` (or re-render the platform assets) and commit the result.`,
                ).toBe(rendered.trimEnd());
            });
        }
    }
});

/** Which language the committed copy was rendered in, so the comparison is like-for-like. */
function detectLanguage(content: string): 'en' | 'zh' {
    return /## Response language[\s\S]{0,200}?[\u4e00-\u9fff]/.test(content) ? 'zh' : 'en';
}
