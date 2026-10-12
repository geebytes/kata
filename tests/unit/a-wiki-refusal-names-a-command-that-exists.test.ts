import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runWikiCommand } from '../../src/cli/wiki.js';
import { wikiClosureRemedy, type WikiClosureFailureReason } from '../../src/wiki/closure.js';

/**
 * **A remedy is a road, and the only honest test of a road is to drive it.**
 *
 * The closure gate refused with `candidate_missing` and printed: *"List them with `kata-cli wiki list` and re-record the
 * closure with an id that exists."* There is **no `wiki list`** — the command is `wiki candidate` — so the reader who
 * followed the sentence landed on a parser error, while the road that actually resolves the state (`wiki revalidate
 * --record <id>` re-derives a record whose page moved, and re-deriving is what makes it acceptable to the gate again) was
 * not named at all. Measured, on this repository: the printed road failed, and the real one worked.
 *
 * So this case takes the commands the remedies print, hands each to the CLI entry the tool itself uses, and asserts the reply
 * is never a **usage**-class refusal. A domain refusal is expected and is not the subject — `--task <id>` in a fixture names
 * no task, and that is a domain answer. The vocabulary is the parser's own, taken from the messages it stringifies.
 */
const USAGE_REFUSAL = /unknown wiki command|unknown wiki option|unknown subcommand|is not a known|^usage:|Usage: kata-cli/i;
const REASONS: WikiClosureFailureReason[] = ['missing', 'deferred', 'reason_required', 'candidate_required', 'candidate_missing', 'unevaluatable_records'];

const roots: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiki-roads-'));
    roots.push(root);
    await initLayout(root);
    return root;
}

/**
 * Every `kata-cli wiki …` command the sentence prints, split respecting quotes, with the arguments the *operator* has to
 * choose filled in.
 *
 * A remedy may legitimately say `--decision <captured|not_applicable|deferred>`: the tool does not hold that value, the
 * reader picks one, so driving the literal placeholder would fail for a reason that is not the subject. The subject is the
 * verb and its flags, so a choice list becomes its first alternative and any other placeholder becomes a token — and a verb
 * or flag the parser does not know still fails, which is what this case is for.
 */
function commandsIn(remedy: string): string[][] {
    const found: string[][] = [];
    for (const match of remedy.matchAll(/kata-cli wiki ([^`]*)/g)) {
        const argv = match[1]!
            .match(/"[^"]*"|'[^']*'|\S+/g)!
            .map((token) => token.replace(/^["']|["']$/g, ''))
            .filter((token) => token !== '|')
            .map((token) => {
                const choice = /^<([^>]*)>$/.exec(token);
                if (!choice) return token;
                return choice[1]!.split('|')[0]!.replace(/[^A-Za-z0-9._-]/g, '') || 'x';
            });
        found.push(argv);
    }
    return found;
}

/** Run the command the way the CLI does, and report whatever it answers as text. */
async function reply(root: string, argv: string[]): Promise<string> {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        const result = await runWikiCommand([...argv, '--root', root]);
        return `${chunks.join('')}${JSON.stringify(result)}`;
    } catch (error) {
        return `${chunks.join('')}${error instanceof Error ? error.message : String(error)}`;
    } finally {
        vi.restoreAllMocks();
    }
}

describe('every road a Wiki closure refusal prints is a road the CLI accepts', () => {
    it('names the commands the parser really has', async () => {
        // `wiki list` is what this case was opened for: a printed road that does not exist.
        for (const reason of REASONS) {
            expect(wikiClosureRemedy(reason, 'some-task'), `${reason} must not print a command that does not exist`).not.toMatch(/wiki list\b/);
        }
    });

    it('runs each printed command through the CLI entry, and none of them is a usage refusal', async () => {
        const root = await fixture();
        let checked = 0;
        for (const reason of REASONS) {
            const remedy = wikiClosureRemedy(reason, 'some-task');
            const commands = commandsIn(remedy);
            expect(commands.length, `${reason} must print at least one road`).toBeGreaterThan(0);
            for (const argv of commands) {
                const answer = await reply(root, argv);
                expect(answer, `${reason}: \`kata-cli wiki ${argv.join(' ')}\` was not accepted by the parser`).not.toMatch(USAGE_REFUSAL);
                checked += 1;
            }
        }
        expect(checked).toBeGreaterThanOrEqual(REASONS.length);
    });

    it('lists every verb the dispatcher accepts, so a reader enumerating commands is not told a road does not exist', async () => {
        // **This one is outside AC-4's wording, and it is why the change exists.** I enumerated the verbs from
        // `wiki --help`, saw no `revalidate`, and concluded that nothing could move a record out of `stale` — while the
        // dispatcher had accepted the verb all along. AC-4 is about the commands a *refusal* prints; the help text is the
        // other reader-facing surface of the same fact, so it is asserted here rather than left as the trap that produced
        // the wrong conclusion. The dispatcher's verbs are read from its own source, so the check is a comparison of two
        // live surfaces rather than of two hand-kept lists.
        const source = await readFile(join(process.cwd(), 'src/cli/wiki.ts'), 'utf8');
        const dispatched = [...new Set([...source.matchAll(/subcommand === '([a-z][a-z-]*)'/g)].map((match) => match[1]!))]
            .filter((verb) => verb !== 'help');
        const help = (await runWikiCommand([])) as { commands: string[]; withheld?: Record<string, string>; aliases?: Record<string, string> };
        const displayed = new Set(help.commands.map((entry) => entry.split(' ')[0]!));
        // A verb may be withheld from the list **with a reason** (`rebuild` removes the whole store), which is a different
        // fact from being absent: the first tells a reader the road exists and why it is not offered, the second made this
        // very list lie about two verbs.
        const withheld = new Set(Object.keys(help.withheld ?? {}));
        // …and an alias is the third way a verb is reachable. This was a name exemption (`verb !== 'propose'`) until an
        // independent round pointed out that the guard then kept its own exception list in the one place where the surfaces
        // are derived: emptying `help.aliases` left the check green while a reader lost the road.
        const aliases = new Set(Object.keys(help.aliases ?? {}));

        // **A scan that finds less than it should must not read as a clean scan.** The dispatcher's verbs come from its own
        // source text, so a behaviour-preserving rename of the local (`const cmd = subcommand`) would shrink the set and make
        // the comparison below pass for a help list that lost the missing verbs. The floor is not a hand-picked number — it is
        // the set the reply itself offers (displayed ∪ withheld ∪ aliases, plus `propose` reached through its alias): if the
        // scan cannot even see everything the help list shows, it has stopped seeing the dispatcher and the case fails instead
        // of passing. A rename that keeps the count is beyond any static scan; that is written down as the boundary of this
        // check rather than claimed away.
        const offered = new Set([...displayed, ...withheld, ...aliases, 'propose']);
        expect(
            dispatched.filter((verb) => offered.has(verb)).length,
            'the verb scan must see every verb the help list offers, not a subset of them',
        ).toBe(offered.size);

        const missing = dispatched.filter((verb) => !displayed.has(verb) && !withheld.has(verb) && !aliases.has(verb));
        expect(missing, 'the help list must offer every verb the dispatcher accepts, name it as withheld, or alias it').toEqual([]);
    });

    it('names the road that actually resolves a stale record', async () => {
        // The road the reader needed and the sentence did not name: re-deriving the record is what makes the gate accept it
        // again. Asserted as text on purpose — the behaviour of the road itself is pinned by its own selectors.
        expect(wikiClosureRemedy('candidate_missing', 'some-task')).toContain('wiki revalidate');
    });
});
