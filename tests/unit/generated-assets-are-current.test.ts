import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSkill, skillCommands, type Platform } from '../../src/adapters/manifest.js';
import { platformCommandPath, platformSkillPath } from '../../src/adapters/platforms.js';
import { renderPlatformCommand } from '../../src/adapters/ownership.js';

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
/**
 * Every platform whose generated assets this checkout carries.
 *
 * `pi` renders into `.agents/` (`platforms.ts:129`), which is why the guard checks it by name: the first version of the
 * guard listed only `codex` and `opencode`, so `.agents/skills/*` could have drifted unnoticed — and it did.
 */
const PLATFORMS: Platform[] = ['codex', 'opencode', 'pi'];

describe('the committed platform assets match what the renderer produces', () => {
    for (const platform of PLATFORMS) {
        for (const command of skillCommands) {
            it(`${platform}: skill ${command.id}`, async () => {
                await expectCurrent(platformSkillPath(platform, 'project', command.id, process.cwd()), (language) =>
                    renderSkill(command, platform, { language }));
            });

            // OpenCode also ships command files, rendered from the same skill text with a different wrapper. They were
            // drifting for exactly the same reason the skills were, and the first version of this guard missed them:
            // a "generated asset" is not one file, it is whatever `update` writes.
            const commandPath = platformCommandPath(platform, 'project', command.id, process.cwd());
            if (!commandPath) continue;
            it(`${platform}: command ${command.id}`, async () => {
                await expectCurrent(commandPath, (language) => renderPlatformCommand(platform, command, language) ?? '');
            });
        }
    }
});

/**
 * Compare one generated file against a fresh render of it.
 *
 * The language is read from the committed copy so the comparison is like-for-like; a file this checkout does not carry
 * is not drift, it is simply not installed here.
 */
async function expectCurrent(relativePath: string, render: (language: 'en' | 'zh') => string): Promise<void> {
    const committed = await readFile(join(process.cwd(), relativePath), 'utf8').catch(() => null);
    if (committed === null) return;
    expect(
        committed.trimEnd(),
        `${relativePath} is stale. Run \`kata-cli update\` (or re-render the platform assets) and commit the result.`,
    ).toBe(render(detectLanguage(committed)).trimEnd());
}

/** Which language the committed copy was rendered in, so the comparison is like-for-like. */
function detectLanguage(content: string): 'en' | 'zh' {
    return /## Response language[\s\S]{0,200}?[\u4e00-\u9fff]/.test(content) ? 'zh' : 'en';
}
