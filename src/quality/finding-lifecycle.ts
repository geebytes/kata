/**
 * The severity classes the platform treats as terminal (I1 of the finding-lifecycle design).
 *
 * `blocking` and `major` are the two severities that stop a gate, and they are the two that may never be dispositioned:
 * a finding that must be repaired cannot be talked out of the way, and the disposition commands refuse it rather than
 * recording a decision the workflow does not honour. The rule lives in one place because it is stated in three: the
 * navigation ladder, the adversarial gate and the distillation gate all count exactly these two.
 */
const TERMINAL_SEVERITIES = ['blocking', 'major'] as const;

export function isTerminalSeverity(severity: string): boolean {
    return (TERMINAL_SEVERITIES as readonly string[]).includes(severity);
}
