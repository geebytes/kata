import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undeclaredChanges } from '../../src/quality/undeclared-changes.js';

/**
 * **"Is this declaration a directory" is asked of the filesystem, never of the spelling.**
 *
 * The coverage rule was `!path.includes('.') || path.endsWith('/**')`, so a *dotted* directory — `.agents/skills`,
 * `.github/workflows`, `src/v1.0` — read as a file: every path under it then read as undeclared, and the seal refused
 * content the declaration already names. That is the same defect the tier resolver had (the spelling deciding a gate),
 * measured by an independent round (R6-F2) and latent here because this repository has never declared a directory — 0 of
 * 881 recorded `ownedPaths` entries name one, so the route in is `scope change --add <dir>`.
 *
 * The control matters as much as the case: the fix must not degenerate into "everything is covered". A file that is
 * neither declared nor under a declared directory is still named.
 */
let root: string;

function git(...args: string[]): void {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' } });
}

async function repo(declared: string[], previousPathDigests?: string[]): Promise<string[]> {
    const result = await undeclaredChanges({
        root,
        declaredPaths: declared,
        ...(previousPathDigests ? { previousPathDigests } : {}),
    });
    return result.paths.sort();
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-declared-dir-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 1;\n');
    await writeFile(join(root, '.gitignore'), '.kata/\ntmp/\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('a declared directory covers what is under it, whatever the directory is called', () => {
    it('covers a file under a declared directory whose name contains a dot', async () => {
        await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\non: push\n');
        expect(await repo(['.github/workflows'])).toEqual([]);
    });

    it('covers a file under a declared dotless directory too', async () => {
        await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 2;\n');
        expect(await repo(['src'])).toEqual([]);
    });

    it('reads a glob declaration the way every other reader does — as a name that covers nothing', async () => {
        // **One fact, one answer.** A previous version of this repair read a trailing `/**` as a subtree prefix, so a
        // declaration `src/**` covered every path under `src` *here* while `declaredContentPaths` answered `{paths: [],
        // unreadable: ['src/**']}` and the tier resolver published `strict`, `matched: []` — the permissive reading on the
        // seal's undeclared gate, the strict one on the tier (measured by an independent round, R7-F1). Coverage is the
        // walk's answer; a glob names something the walk cannot find, and the seal refuses such a declaration by name
        // (`declaration_covers_no_content`) instead of silently reading it as a subtree. This case is the agreement the
        // divergence broke: the undeclared reading and the walk must give the same answer for the same declaration.
        const { declaredContentPaths } = await import('../../src/core/repository-identity.js');
        const walk = await declaredContentPaths(root, ['src/**']);
        expect(walk.paths).toEqual([]);
        expect(walk.unreadable).toEqual(['src/**']);
        await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 9;\n');
        expect(await repo(['src/**'])).toEqual(['src/declared.ts']);
    });

    it('still names a changed file that neither the declaration nor a declared directory covers', async () => {
        // The control: a fix that widened coverage into "everything is declared" would pass the two cases above.
        await writeFile(join(root, 'src', 'undeclared.ts'), 'export const undeclared = 1;\n');
        expect(await repo(['.github/workflows'])).toEqual(['src/undeclared.ts']);
    });

    it('covers a file deleted from a declared directory that is still there', async () => {
        // **This is the case that makes the filesystem half load-bearing.** The walk's expansion (`coveredSet`) holds the files
        // that exist *now*, so a deletion inside a live directory is covered only by the directory-prefix rule — and that rule
        // has to know the directory IS a directory without consulting the name. With the old spelling heuristic in place
        // (`.github/workflows` contains a dot ⇒ read as a file) this case is the one that fails.
        await rm(join(root, '.github', 'workflows', 'ci.yml'));
        expect(await repo(['.github/workflows'])).toEqual([]);
    });

    it('covers a file under a declared directory that is gone from the working tree, from what it carried', async () => {
        // A deletion: the declaration still names the directory, the directory is gone, so the question "was it a
        // directory" is answered from the previous revision's hashed paths rather than from a guess about its name.
        await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 2;\n');
        await rm(join(root, 'src'), { recursive: true, force: true });
        expect(await repo(['src'], ['src/declared.ts'])).toEqual([]);
    });
});
