import { describe, expect, it } from 'vitest';
import { renderAdversarialBrief } from '../../src/quality/adversarial.js';

/**
 * The brief has to hand the reviewer the class history, not just the open findings.
 *
 * A brief already carries the previous pass's *attempts*, and findings that were dispositioned. What it did not carry was
 * the shape the measured change kept re-discovering by hand: the same **class** of finding, round after round, each round
 * deriving it from zero. Three consecutive rounds landed on the same "the record's counts and pointers are wrong" class,
 * each one paying the full cost to find a class an earlier round had already named and a repair had already addressed —
 * and the round could not tell the difference between a class that was fixed and a class nobody had attacked yet.
 *
 * The fix is cheap and does not weaken falsification: group the findings by class, show each class's count and its
 * disposition, and say plainly which classes were repaired since the last round. A reviewer who still believes a repaired
 * class is open says so as a finding against the decision — the same rule the decisions already follow.
 */
describe('adversarial brief: finding history by class', () => {
    const base = {
        taskId: 'history-task',
        node: 'review' as const,
        revisionId: null,
        acceptance: [],
        evidence: [],
        ownedPaths: ['src/'],
    };

    it('groups prior findings by class with their dispositions, so a repaired class is visible as repaired', () => {
        const text = renderAdversarialBrief({
            ...base,
            findingHistory: [
                { class: 'record-accuracy', severity: 'major', id: 'f1', message: 'the ledger row overstates what shipped', disposition: 'fixed' },
                { class: 'record-accuracy', severity: 'major', id: 'f2', message: 'the count is wrong by one', disposition: 'fixed' },
                { class: 'scope-understatement', severity: 'major', id: 'f3', message: 'the delta omits two changed paths', disposition: 'open' },
                { class: 'doc-drift', severity: 'minor', id: 'f4', message: 'the changelog sentence is stale', disposition: 'deferred' },
            ],
        });

        expect(text).toContain('record-accuracy');
        expect(text).toContain('scope-understatement');
        expect(text).toContain('doc-drift');
        // Counts and dispositions travel with the class, so a reader can tell a repaired class from an unattacked one.
        expect(text).toMatch(/record-accuracy[^\n]*2[^\n]*fixed/i);
        expect(text).toMatch(/scope-understatement[^\n]*1[^\n]*open/i);
    });

    it('says which classes no round has attacked, so a reviewer does not spend the pass on a repaired one', () => {
        const text = renderAdversarialBrief({
            ...base,
            findingHistory: [
                { class: 'record-accuracy', severity: 'major', id: 'f1', message: 'x', disposition: 'fixed' },
            ],
        });
        expect(text).toMatch(/repaired/i);
        expect(text).toContain('record-accuracy');
    });

    it('omits the section entirely when no class history exists, rather than printing an empty table', () => {
        const text = renderAdversarialBrief({ ...base });
        expect(text).not.toMatch(/Findings by class/i);
    });
});
