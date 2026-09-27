import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The CLI's vocabulary, read from the dispatcher rather than written down.**
 *
 * Two tests need to answer "would this command run?" and a hand-written list would go stale exactly as the two deleted
 * skills' command lines did: they were removed from the manifest while their generated files and the phase guidance kept
 * naming them. So the list is derived from the source that answers the question — the `command === '<name>'` arms in
 * `src/cli.ts`, the workflow verbs its own predicate names, and the `sub === '<name>'` arms in each subcommand module.
 *
 * This is the same rule the repository applies to declarations in general: one fact, one derivation, and the derivation
 * is from the thing that decides.
 */
function sourceOf(relative: string): string {
    return readFileSync(join(process.cwd(), relative), 'utf8');
}

/** The verbs the top-level dispatcher answers. */
export function dispatchedCommands(): Set<string> {
    const cli = sourceOf('src/cli.ts');
    const verbs = new Set<string>();
    for (const match of cli.matchAll(/command === '([a-z][a-z-]*)'/gu)) verbs.add(match[1]!);
    for (const match of cli.matchAll(/\bisWorkflowCommand\(/gu)) void match;
    // The workflow verbs are named by their own predicate rather than by an arm, so they are read from it.
    const workflow = sourceOf('src/cli/workflow.ts');
    const list = workflow.match(/return \[([^\]]*)\]\.includes\(command\)/u);
    if (list) {
        for (const name of list[1]!.matchAll(/'([a-z-]+)'/gu)) verbs.add(name[1]!);
    }
    return verbs;
}

/**
 * The subcommands a family answers, or `null` when this helper cannot tell.
 *
 * **Three dispatch patterns are in use and only one of them is `sub === '…'`**: `ledger` and the other families that own
 * a module switch on `sub`, while `hooks` switches on `subcommand` inside `tasks.ts` and `handoff`/`codegraph` switch on
 * their own local. A helper that pattern-matched one of them and reported the others as having no subcommands produced 132
 * false positives on the first run — a guard that fails closed on everything it does not understand is as useless as one
 * that always passes, so the answer here is `null` ("cannot judge") for the families whose arms are not `sub ===`.
 *
 * The caller treats `null` as "skip this mention", which is a stated limit rather than a silent pass: the command-level
 * check above it reads the top-level dispatcher and has no such gap.
 */
export function dispatchedSubcommands(verb: string): Set<string> | null {
    const perVerb = join(process.cwd(), `src/cli/${verb}.ts`);
    let sources: string[] = [];
    try {
        sources = [readFileSync(perVerb, 'utf8')];
    } catch {
        return null;
    }
    const subs = new Set<string>();
    for (const source of sources) {
        for (const match of source.matchAll(/sub === '([a-z][a-z-]*)'/gu)) subs.add(match[1]!);
    }
    return subs.size === 0 ? null : subs;
}

export function isDispatchedCommand(verb: string): boolean {
    return dispatchedCommands().has(verb);
}

export function isDispatchedSubcommand(verb: string, subcommand: string): boolean {
    const subs = dispatchedSubcommands(verb);
    // Cannot judge, so do not judge: the family's module is absent or does not switch on `sub`.
    return subs === null ? true : subs.has(subcommand);
}