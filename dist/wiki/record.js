import { createHash } from 'node:crypto';
import { validate } from '../core/schema.js';
export function computeFileHash(content) {
    return createHash('sha256').update(content).digest('hex');
}
export function validateWikiRecord(value) {
    return validate('wiki-record', value);
}
//# sourceMappingURL=record.js.map