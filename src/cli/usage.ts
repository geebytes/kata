/**
 * One usage line per command family, and the fallback for a family that has not written one.
 *
 * The map exists so `--help` is a *read*: it answers with the command's own surface rather than with the generic line
 * that used to stand in for all of them, and it answers before anything dispatches. A family missing here still gets an
 * answer — the fallback names it — because a missing help text must not become a missing guard.
 */
export const USAGE: Record<string, string> = {
    init: 'kata-cli init --platform <name> --scope <project|global> [--root <path>] [--yes]',
    update: 'kata-cli update --platform <name> [--scope <project|global>] [--refresh]',
    uninstall: 'kata-cli uninstall --platform <name> [--force]',
    discover: 'kata-cli discover',
    comet: 'kata-cli comet <init|status|handoff> [--platform <name>]',
    codegraph: 'kata-cli codegraph <status|sync|index|explore|impact|affected> [--root <path>]',
    status: 'kata-cli status [--change <task-id>] [--with-context] [--json]',
    open: 'kata-cli open --change <task-id> --isolation <mode> --development <mode> --review <mode> [--bootstrap-file <path>] [--title <text>]',
    design: 'kata-cli design --change <task-id>',
    build: 'kata-cli build --change <task-id> [--seal] [--judgement <text>]',
    verify: 'kata-cli verify --change <task-id>',
    review: 'kata-cli review --change <task-id> [--result-file <subagent-result.json> | --approve --review-evidence <text>]',
    judge: 'kata-cli judge --change <task-id> --root <path>',
    archive: 'kata-cli archive --change <task-id>',
    hotfix: 'kata-cli hotfix --change <task-id> [--title <text>]',
    tweak: 'kata-cli tweak --change <task-id> [--title <text>]',
    collect: 'kata-cli collect --change <task-id>',
    next: 'kata-cli next --change <task-id>',
    tasks: 'kata-cli tasks <relate|relations|show> [--change <task-id>]',
    eval: 'kata-cli eval <manifest.json> [--persist <report.json>] [--root <path>]',
    worktree: 'kata-cli worktree <create|list|remove|clean> --change <task-id>',
    revision: 'kata-cli revision digests --change <task-id> [--since <revision-id|manifestHash>]',
    baseline: 'kata-cli baseline [--root <path>]',
    scope: 'kata-cli scope <show|change|apply|declare|boundary> --change <task-id>',
    relations: 'kata-cli relations [--change <task-id>]',
    orient: 'kata-cli orient --change <task-id> --role <designer|implementer|reviewer|judge|distiller> [--platform <name>] [--task-kind <read|implementation|security>]',
    hooks: 'kata-cli hooks <activate|status|deactivate> --change <task-id> --role <role> [--platform <name>]',
    handoff: 'kata-cli handoff <create|show|verify|acknowledge> --task <task-id> [--id <handoff-id>] [--platform <name>] [--role <role>]',
    gate: 'kata-cli gate approve --task <task-id> --boundary <implementation_gate|review_gate|judge_gate|archive_gate> --choice <continue_current|switched|delegated> [--for-task]',
    recover: 'kata-cli recover --change <task-id>',
    doctor: 'kata-cli doctor',
    wiki: 'kata-cli wiki <init|orient|ingest|query|lint|verify|register|task|candidate|closure|audit|refresh|promote|reject|retire|revalidate>',
    // The family with the most verbs gets its own line, since the generic one said nothing about it.
    ledger: 'kata-cli ledger <freeze|claim|evidence|plan|focus|ask|answer|challenge|decide|status|run|request-check|policy|usage|corpus|verifier|detectability|baseline> --change <task-id>',
    'git-flow': 'kata-cli git-flow apply --change <task-id> [--confirm]',
};

export function usageFor(command: string): string {
    return USAGE[command] ?? `kata-cli ${command} [change|--change <task-id>]  (no usage text recorded for this command)`;
}


/**
 * Every command family this build answers, derived from the usage map rather than listed again.
 *
 * Derived on purpose: the map is the thing that has to be complete for `--help` to be safe, so making it the source means
 * a family cannot be reachable without also being described — and `tests/unit/help-never-mutates.test.ts` scans the
 * dispatcher for family literals and fails when one is missing here.
 */
/**
 * Families that answer `--help` themselves, and why each is excepted from the generic answer.
 *
 * The rule the guard enforces is "`--help` must never be *ignored*", not "every family must answer with one line". These
 * families already answered — richer than a usage line can be, listing their own verbs — and the first version of the
 * guard replaced that with the generic line: `wiki --help` lost its verb list, which is a regression dressed as a fix.
 * They are named here rather than inferred, so a family can only leave the exception by deciding to.
 */
export const SELF_HANDLED_HELP: Record<string, string> = {
    wiki: 'its own parser answers with the verb list, which one usage line cannot carry',
};
