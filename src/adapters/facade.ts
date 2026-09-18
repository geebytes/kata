import { platformCapabilities, renderSkill as renderNormalizedSkill, skillCommands } from './manifest.js';
import type { Platform, SkillCommand } from './manifest.js';

/**
 * The one place a platform name becomes a renderer.
 *
 * Five per-platform files (`pi.ts`, `codex.ts`, `claude-code.ts`, `opencode.ts`, `generic.ts`) used to each export a
 * six-line `renderSkill(command, platform = '<its own platform>')` re-export. Nothing in production imported them — the
 * installer, the command files and the agents contract all call `renderSkill` from `manifest.js` directly — so they read
 * as a supported adapter surface that was not one, and the only thing that differed between them was a **default
 * argument**. Worse, their signature was narrower than production's: no `options.language`, which is how the package
 * ships Chinese skill text.
 *
 * This module is that surface made real, in one file:
 *
 *   - `renderSkillFor(platform, command, options)` — the entry point production uses (`ownership.ts` writes every skill
 *     file through it), so the tests and the installer are exercising the same function.
 *   - `platformDefaults(platform)` — the capabilities a platform gets, from `manifest.ts`, so a caller does not have to
 *     know which module holds them.
 *
 * The per-platform modules stay, as thin named wrappers over this, so an external consumer that imported
 * `adapters/opencode.js` keeps working — they now delegate here rather than each re-implementing the default.
 */
export function renderSkillFor(
    platform: Platform,
    command: SkillCommand,
    options: { language?: 'en' | 'zh' } = {},
): string {
    return renderNormalizedSkill(command, platform, options);
}

export function platformDefaults(platform: Platform): (typeof platformCapabilities)[Platform] {
    return platformCapabilities[platform];
}

/** Every command this build ships, for consumers that render a whole platform's skill set. */
export function commandsForPlatform(): readonly SkillCommand[] {
    return skillCommands;
}
