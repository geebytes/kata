import { describe, expect, it } from 'vitest';
import { buildCometProjectInitInvocation } from '../../src/comet/install.js';
import { loadCometCompatibility } from '../../src/comet/compat.js';

describe('comet init platform passthrough (bundled manifest)', () => {
    const compat = loadCometCompatibility();

    it('forwards each wizard-selected platform as its own --platform <id>', () => {
        const perPlatform = ['codex', 'opencode', 'gemini', 'github-copilot'].map((p) =>
            buildCometProjectInitInvocation({
                root: '/app',
                scope: 'global',
                language: 'zh',
                extras: { platform: p, workflow: 'native' },
                compat,
                cometVersion: '0.4.0-beta.14',
            }).args,
        );
        for (const [i, platform] of ['codex', 'opencode', 'gemini', 'github-copilot'].entries()) {
            expect(perPlatform[i]).toContain('--platform');
            expect(perPlatform[i]).toContain(platform);
        }
    });

    it('never emits the list-form --platforms (preview flag for 0.5.0+)', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/app',
            scope: 'global',
            extras: { platforms: ['codex', 'opencode'], workflow: 'native' },
            compat,
            cometVersion: '0.4.0-beta.14',
        });
        expect(args).not.toContain('--platforms');
    });

    it('drops --platform when the comet version predates 0.4.0', () => {
        const { args } = buildCometProjectInitInvocation({
            root: '/app',
            scope: 'global',
            extras: { platform: 'codex', workflow: 'native' },
            compat,
            cometVersion: '0.3.9',
        });
        expect(args).not.toContain('--platform');
    });
});
