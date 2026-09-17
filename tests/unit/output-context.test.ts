import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutputContext, currentOutput, main } from '../../src/cli.js';

/**
 * An invocation supplies its own output context.
 *
 * Output behaviour used to be two mutable module booleans plus direct `process.stdout` writes, so rendering mixed JSON
 * with update-specific human text and nothing could capture an in-process invocation without monkey-patching
 * `process.stdout`. The context is created at the boundary now, and a caller may pass its own streams.
 */
describe('output context', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
        vi.restoreAllMocks();
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-output-'));
        roots.push(root);
        return root;
    }

    function sink(): { write(text: string): void; text(): string } {
        const chunks: string[] = [];
        return { write: (text: string) => { chunks.push(text); }, text: () => chunks.join('') };
    }

    it('derives format, quiet and TTY from argv, and lets a caller override the streams', () => {
        expect(createOutputContext([])).toMatchObject({ format: 'human', quiet: false });
        expect(createOutputContext(['--json'])).toMatchObject({ format: 'json' });
        expect(createOutputContext(['--quiet'])).toMatchObject({ quiet: true });
        expect(createOutputContext(['uninstall'])).toMatchObject({ quiet: true });

        const stdout = sink();
        const context = createOutputContext(['--json'], { stdout, stderr: stdout, isTTY: false });
        expect(context.stdout).toBe(stdout);
        expect(context.isTTY).toBe(false);
    });

    it('writes an in-process invocation to the streams it was given', async () => {
        const root = await tempRoot();
        const stdout = sink();
        const stderr = sink();
        // Nothing should reach the process streams: the whole point of supplying a context.
        const processStdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const processStderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await main(['discover', '--json', '--root', root], { stdout, stderr });

        expect(stdout.text().trim().length).toBeGreaterThan(0);
        expect(() => JSON.parse(stdout.text().trim())).not.toThrow();
        expect(processStdout).not.toHaveBeenCalled();
        expect(processStderr).not.toHaveBeenCalled();
    });

    it('stays silent under --quiet and renders human output otherwise', async () => {
        const root = await tempRoot();

        const quiet = sink();
        await main(['discover', '--json', '--quiet', '--root', root], { stdout: quiet, stderr: quiet });
        expect(quiet.text()).toBe('');

        const json = sink();
        await main(['discover', '--json', '--root', root], { stdout: json, stderr: json });
        expect(json.text().trim().startsWith('{')).toBe(true);
    });

    it('restores the previous context after an invocation, including a failed one', async () => {
        const before = currentOutput();
        const stdout = sink();

        await expect(main(['not-a-command', '--json'], { stdout, stderr: stdout })).rejects.toThrow();

        expect(currentOutput()).toBe(before);
    });
});
