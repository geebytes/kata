import { renderSkill as renderNormalizedSkill } from './manifest.js';
import type { Platform, SkillCommand } from './manifest.js';

export function renderSkill(command: SkillCommand, platform: Platform = 'codex'): string {
  return renderNormalizedSkill(command, platform);
}
