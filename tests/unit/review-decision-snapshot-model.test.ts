import { describe, expect, it } from 'vitest';

type RecordState = 'absent' | 'usable' | 'unreadable';
type Binding = 'legacy' | 'foreign' | 'current';
type Movement = 'unchanged' | 'moved';
type Outcome = 'refuse_absent' | 'refuse_unreadable' | 'audit_only' | 'retry_moved' | 'commit_current';

const recordStates: RecordState[] = ['absent', 'usable', 'unreadable'];
const bindings: Binding[] = ['legacy', 'foreign', 'current'];
const movements: Movement[] = ['unchanged', 'moved'];

/**
 * Independent reference model for the review decision family. It intentionally does not import
 * production readers or routing: the table says which outcome is safe before an implementation
 * chooses how to obtain it.
 */
function expectedOutcome(
    sealed: RecordState,
    history: RecordState,
    binding: Binding,
    movement: Movement,
): Outcome {
    if (sealed === 'absent') return 'refuse_absent';
    if (sealed === 'unreadable') return 'refuse_unreadable';
    if (history === 'unreadable') return 'refuse_unreadable';
    if (binding !== 'current') return 'audit_only';
    return movement === 'moved' ? 'retry_moved' : 'commit_current';
}

describe('review decision snapshot reference model', () => {
    it('enumerates all 54 sealed/history/binding/movement states without a stale commit', () => {
        const matrix = recordStates.flatMap((sealed) => recordStates.flatMap((history) =>
            bindings.flatMap((binding) => movements.map((movement) => ({
                sealed,
                history,
                binding,
                movement,
                outcome: expectedOutcome(sealed, history, binding, movement),
            }))),
        ));

        expect(matrix).toHaveLength(54);
        expect(matrix.filter((row) => row.movement === 'moved' && row.outcome === 'commit_current')).toEqual([]);
        expect(matrix.filter((row) => row.binding !== 'current' && row.outcome === 'commit_current')).toEqual([]);
        expect(matrix.filter((row) => row.sealed !== 'usable' && row.outcome === 'commit_current')).toEqual([]);
        expect(matrix.filter((row) => row.history === 'unreadable' && row.outcome === 'commit_current')).toEqual([]);
        expect(matrix.filter((row) => row.outcome === 'commit_current')).toHaveLength(2);
        expect(matrix.filter((row) => row.outcome === 'retry_moved')).toHaveLength(2);
    });
});
