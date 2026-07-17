import { renderSkill as renderNormalizedSkill } from './manifest.js';
import type { Platform, SkillCommand } from './manifest.js';

export function renderSkill(command: SkillCommand, platform: Platform = 'generic'): string {
  return renderNormalizedSkill(command, platform);
}
