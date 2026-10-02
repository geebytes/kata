import { describe, expect, it } from 'vitest';
import { parseChangeArg, parseRootArg } from '../../src/cli/invocation.js';

/**
 * AC-7 — a value-taking flag is read wherever it appears, and a positional argument is never consumed as its value.
 *
 * The measured defects (reading 1, F2 and F3, major):
 *
 *   parseChangeArg(['remove', <path>, '--root', P, '--change', 'aaa']) === 'aaa'
 *     — the positional path was read as the change id and the explicit flag was **silently discarded**.
 *   ['worktree', 'remove', <abs path>, '--root', P]        → no output
 *   ['worktree', 'remove', '--root', P, <abs path>]        → threw
 *     — the documented spelling worked only when `--root` happened to be last.
 *
 * The previous repair recognised the *shape* of a path (`looksLikeAPath`) and was therefore order-dependent: the flag
 * reader still scanned left to right and stopped at the first bare token. The rule this criterion pins is about order,
 * not shape: a positional argument is a token the command did not claim, and claiming happens wherever the flag sits.
 */
describe('flags are read whatever their order', () => {
    it('reads an explicit --change even when a positional argument precedes it', () => {
        expect(parseChangeArg(['.kata/worktrees/T', '--root', '/ws', '--change', 'a-task'])).toBe('a-task');
        expect(parseChangeArg(['--change', 'a-task', '.kata/worktrees/T'])).toBe('a-task');
        expect(parseChangeArg(['--change=a-task', '.kata/worktrees/T'])).toBe('a-task');
    });

    it('does not read a positional argument as the change id', () => {
        expect(parseChangeArg(['.kata/worktrees/T', '--root', '/ws'])).toBeUndefined();
        expect(parseChangeArg(['/tmp/somewhere'])).toBeUndefined();
    });

    it('reads --root wherever it appears', () => {
        expect(parseRootArg(['.kata/worktrees/T', '--root', '/ws'])).toBe('/ws');
        expect(parseRootArg(['--root', '/ws', '.kata/worktrees/T'])).toBe('/ws');
        expect(parseRootArg(['--root=/ws', '.kata/worktrees/T'])).toBe('/ws');
    });

    it('does not take the following flag as a value', () => {
        expect(parseRootArg(['--root', '--change', 'a-task'])).toBeUndefined();
        expect(parseChangeArg(['--change', '--root', '/ws'])).toBeUndefined();
    });
});
