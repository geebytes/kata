import { renderSkillFor } from './facade.js';
import type { Platform, SkillCommand } from './manifest.js';

/** `codex` with its own platform default, over the shared facade (`facade.ts`). */
export function renderSkill(command: SkillCommand, platform: Platform = 'codex', options: { language?: 'en' | 'zh' } = {}): string {
    return renderSkillFor(platform, command, options);
}
