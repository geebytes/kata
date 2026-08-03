import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptCometOptions } from '../../src/init-wizard.js';
import { parseCompatYaml } from '../../src/comet/compat.js';

const MANIFEST = `
version: 2
comet:
  minVersion: 0.4.0
  maxVersion: 2.0.0
  capabilities:
    init:
      minSince: "0.4.0"
  flags:
    init:
      platform:
        type: enum
        choices: [codex, claude-code, opencode]
        minSince: "0.4.0"
      platforms:
        type: list
        itemType: enum
        itemChoices: [codex, opencode]
        minSince: "0.5.0"
        preview: true
      workflow:
        type: enum
        choices: [native, classic]
        default: native
        minSince: "0.4.0"
`;

describe('promptCometOptions skips platform (wizard already collected it)', () => {
    it('never prompts for platform/platforms and still collects other flags', async () => {
        const compat = parseCompatYaml(MANIFEST, 'runtime');
        const output = new PassThrough();
        const result = await promptCometOptions({
            compat,
            scope: 'global',
            language: 'zh',
            cometVersion: '0.4.0',
            io: { input: undefined, output },
        });
        // The wizard's own platform checkbox already collected the target
        // platforms; comet's --platform is forwarded from that selection in
        // cli.ts, so it must never be prompted again here.
        expect(result.platform).toBeUndefined();
        expect(result.platforms).toBeUndefined();
        // workflow has a manifest default and no prompt messages: the generic
        // boolean/enum path would prompt, but with no prompt text it still
        // returns the default on non-TTY. Assert it is present so the skip
        // logic above is what removed platform, not blanket filtering.
        expect(result.workflow).toBe('native');
    });
});
