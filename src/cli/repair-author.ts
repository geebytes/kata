/**
 * `kata-cli repair-author` — the producer and consumer AC-1's provenance record was missing.
 *
 * The review round that found this said it plainly: `recordRepairAuthor`, `readRepairAuthors` and `hasRecordedAuthor` were
 * called only from a test, and nothing in the tool wrote or read `.kata/tasks/<id>/repair-authors.json`. That is this line's
 * oldest finding — a mechanism with no consumer — and its first real use demonstrated the cost: a repair author was dispatched,
 * investigated for nineteen minutes, wrote nothing, and there was nothing in the tool that could have received a report even if
 * it had written one.
 *
 * So: `record` writes what a repair author returns, `list` reads it back, and both are what a dispatch needs to close the loop.
 */
import { hasRecordedAuthor, readRepairAuthors, recordRepairAuthor } from '../quality/repair-author.js';

function valueAfter(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

export async function runRepairAuthorCommand(argv: string[]): Promise<Record<string, unknown>> {
    const action = argv[0] ?? 'list';
    const change = valueAfter(argv, '--change');
    if (!change) {
        return { command: 'repair-author', success: false, error: 'repair-author needs --change <task-id>.' };
    }
    const root = process.cwd();

    if (action === 'list') {
        const repairs = await readRepairAuthors(root, change);
        return {
            command: 'repair-author',
            taskId: change,
            success: true,
            repairs,
            // The question a reader asks: does every repair say who made it?
            allHaveAuthors: repairs.every((repair) => hasRecordedAuthor(repairs, repair.findingId)),
        };
    }

    if (action === 'record') {
        const findingId = valueAfter(argv, '--finding');
        const session = valueAfter(argv, '--session');
        const handed = valueAfter(argv, '--handed');
        const report = valueAfter(argv, '--report');
        const missing = [['--finding', findingId], ['--session', session], ['--handed', handed], ['--report', report]]
            .filter(([, value]) => !value).map(([flag]) => flag as string);
        if (missing.length > 0) {
            return {
                command: 'repair-author',
                taskId: change,
                success: false,
                error: `recording a repair author needs ${missing.join(', ')}: the session, what it was handed and what it returned are the three facts the record exists to carry.`,
            };
        }
        const entry = await recordRepairAuthor(root, change, {
            findingId: findingId!,
            session: session!,
            handed: handed!,
            report: report!,
        });
        return { command: 'repair-author', taskId: change, success: true, repair: entry };
    }

    return { command: 'repair-author', taskId: change, success: false, error: `Unknown action '${action}'. Use record or list.` };
}
