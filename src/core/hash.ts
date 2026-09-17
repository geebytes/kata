import { createHash, type Hash } from 'node:crypto';

/**
 * The one sha256 primitive.
 *
 * The revision manifest, the Wiki records, the handoff packets and the generated skill files all record content hashes,
 * and they must agree: a hash is only an identity if exactly one function produces it. This also keeps the algorithm
 * name in one place.
 */

/** The hash of a value, hex-encoded. Strings are hashed as UTF-8. */
export function hashContent(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

/** An incremental hasher, for callers that hash a tree or a record part by part. */
export function createContentHasher(): Hash {
    return createHash('sha256');
}
