import { readFile } from 'node:fs/promises';
import { reviewPath as layoutReviewPath } from '../core/layout.js';
import type { ReviewFinding } from '../quality/reviewer.js';

/**
 * The recorded review artefact: status, revision binding, the approval's evidence summary and the findings. It lives
 * here rather than in the orchestrator because the adversarial brief and the gate also read it, and a quality module
 * importing the workflow orchestrator would invert the layering.
 */
export async function readReview(root: string, taskId: string): Promise<{ revisionId?: string; status?: string; reviewEvidence?: string; findings: ReviewFinding[] }> {
    try {
        const reviewRaw = await readFile(layoutReviewPath(root, taskId), 'utf8');
        const reviewParsed = JSON.parse(reviewRaw) as { revisionId?: string; status?: string; reviewEvidence?: string; findings?: ReviewFinding[] };
        return { revisionId: reviewParsed.revisionId, status: reviewParsed.status, reviewEvidence: reviewParsed.reviewEvidence, findings: reviewParsed.findings ?? [] };
    } catch {
        return { findings: [] };
    }
}
