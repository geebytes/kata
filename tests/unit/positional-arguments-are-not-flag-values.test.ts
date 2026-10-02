import { describe, expect, it } from 'vitest';
import { parseChangeArg } from '../../src/cli/invocation.js';

/**
 * AC-3 — a positional argument is never read as the value of a value-taking flag.
 *
 * The measured defect (reading 2, blocking): `kata-cli worktree remove <path>` — the documented spelling, in the
 * command's own usage text and in `docs/operations.md` — had its first bare token read as the change id, because
 * `parseChangeArg` answers "the first bare token that is not already spoken for". The path was returned as `--change`,
 * it differed from the derived owner, and the mismatch branch refused. Only `remove --path <p>` worked, i.e. the broken
 * spelling was the documented one.
 *
 * The general rule this criterion pins: a token the command will read positionally must not also be consumable as a
 * flag's value. The fix is that the caller removes its positional tokens before the change reader sees them, so the two
 * answers come from different tokens by construction rather than by luck.
 */
describe('positional arguments are not flag values', () => {
    it('does not read a leading path as the change id', () => {
        expect(parseChangeArg(['.kata/worktrees/T'])).toBeUndefined();
        expect(parseChangeArg(['/tmp/somewhere'])).toBeUndefined();
    });

    it('still reads an explicit flag in either spelling', () => {
        expect(parseChangeArg(['--change', 'a-task'])).toBe('a-task');
        expect(parseChangeArg(['--change=a-task'])).toBe('a-task');
        expect(parseChangeArg(['--change', 'a-task', '.kata/worktrees/T'])).toBe('a-task');
    });

    it('reads the change id from the tokens the command did not claim', () => {
        // The seam the caller uses: it removes its positional tokens, and the change reader then sees only flags.
        const argv = ['--change', 'a-task', '.kata/worktrees/T'];
        const withoutPositional = argv.filter((argument) => argument !== '.kata/worktrees/T');
        expect(parseChangeArg(withoutPositional)).toBe('a-task');
    });
});
