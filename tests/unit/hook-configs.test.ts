import { describe, expect, it } from 'vitest';
import { hookConfigForPlatform, mergeHookConfig, removeManagedHookConfig } from '../../src/adapters/hook-configs.js';

/**
 * The platform hook-config dialects.
 *
 * Four dialects used to live inside the installer module. They are one descriptor each now, and this file pins what each
 * one *is*: the file it configures, the shape it writes, and what merging and removal leave behind. The installer's own
 * tests still cover the wiring end to end (a file appears, is updated in place, is removed on uninstall).
 */
describe('platform hook-config dialects', () => {
    const command = 'node /repo/.kata/hooks/kata-hook-guard.mjs --project-root /repo';

    it('names each dialect’s configuration file', () => {
        expect(hookConfigForPlatform('claude-code', 'project', '/repo')?.relativePath).toContain('settings.local.json');
        expect(hookConfigForPlatform('gemini', 'project', '/repo')?.relativePath).toContain('settings.json');
        expect(hookConfigForPlatform('windsurf', 'project', '/repo')?.relativePath).toContain('hooks.json');
        expect(hookConfigForPlatform('github-copilot', 'project', '/repo')?.relativePath).toContain('kata-guard.json');
        // A platform without a hook dialect has no configuration file at all.
        expect(hookConfigForPlatform('opencode', 'project', '/repo')).toBeNull();
    });

    it('writes the shape each platform reads', () => {
        // Claude Code and Gemini group by matcher; Windsurf keeps a flat array; Copilot's file is kata's alone.
        expect(JSON.parse(hookConfigForPlatform('claude-code', 'project', '/repo')!.render(command))).toMatchObject({
            hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command }] }] },
        });
        expect(JSON.parse(hookConfigForPlatform('gemini', 'project', '/repo')!.render(command))).toMatchObject({
            hooks: { BeforeTool: [{ matcher: 'write_file|edit_file', hooks: [{ command }] }] },
        });
        expect(JSON.parse(hookConfigForPlatform('windsurf', 'project', '/repo')!.render(command))).toMatchObject({
            hooks: { pre_write_code: [{ command, show_output: true }] },
        });
        expect(JSON.parse(hookConfigForPlatform('github-copilot', 'project', '/repo')!.render(command))).toMatchObject({ hooks: expect.anything() });
    });

    it('merges into an existing file without dropping what was there', () => {
        const block = hookConfigForPlatform('claude-code', 'project', '/repo')!.render(command);
        const existing = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep-me' }] }] } });
        const merged = JSON.parse(mergeHookConfig(existing, block, 'claude-code')) as { hooks: { PreToolUse: Array<{ matcher: string }> } };

        expect(merged.hooks.PreToolUse.map((entry) => entry.matcher)).toEqual(expect.arrayContaining(['Bash', 'Write|Edit']));
        // An unparseable existing file is replaced by the block rather than silently kept broken.
        expect(mergeHookConfig('not json', block, 'claude-code')).toBe(block);
    });

    it('removes only what kata manages, and leaves the rest', () => {
        const block = hookConfigForPlatform('windsurf', 'project', '/repo')!.render(command);
        const merged = mergeHookConfig(JSON.stringify({ hooks: { pre_write_code: [{ command: 'other-tool' }] } }), block, 'windsurf');
        const removed = JSON.parse(removeManagedHookConfig(merged, 'hook-config:windsurf')) as { hooks: { pre_write_code: Array<{ command: string }> } };

        expect(removed.hooks.pre_write_code.map((entry) => entry.command)).toEqual(['other-tool']);
        // Copilot's file is kata's alone, so removal empties it.
        expect(removeManagedHookConfig(JSON.stringify({ hooks: {} }), 'hook-config:copilot')).toBe('');
        // An unparseable file is returned untouched rather than truncated.
        expect(removeManagedHookConfig('not json', 'hook-config:claude-code')).toBe('not json');
    });

    it('merges generically for a dialect it does not recognise', () => {
        // An unknown format keeps the block wholesale, which is what the previous implementation did.
        expect(mergeHookConfig('{"hooks":{}}', '{"hooks":{"x":[]}}', 'unknown-format')).toBe('{"hooks":{"x":[]}}');
    });
});
