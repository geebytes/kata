import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateWikiClosure } from '../wiki/closure.js';
import { readObligations } from '../quality/repair-obligations.js';
export async function readUpstreamSummary(root, taskId) {
    const evidenceFiles = await listEvidenceFiles(root, taskId);
    const evidence = await Promise.all(evidenceFiles.map((file) => readJsonFile(join(root, '.kata/evidence', file))));
    const revisionIds = [...new Set(evidence.map((item) => item?.revisionId).filter((id) => Boolean(id)))];
    const mixedRevision = revisionIds.length > 1;
    const currentRevisionId = revisionIds.length === 1 ? revisionIds[0] : undefined;
    const review = currentRevisionId && !mixedRevision
        ? onlyCurrentRevision(await readJsonFile(join(root, '.kata/tasks', taskId, 'review.json')), currentRevisionId)
        : !mixedRevision ? await readJsonFile(join(root, '.kata/tasks', taskId, 'review.json')) : null;
    const findings = review?.findings ?? [];
    const judge = currentRevisionId && !mixedRevision
        ? onlyCurrentRevision(await readJsonFile(join(root, '.kata/tasks', taskId, 'judge.json')), currentRevisionId)
        : !mixedRevision ? await readJsonFile(join(root, '.kata/tasks', taskId, 'judge.json')) : null;
    const failedAcceptance = judge?.acceptance?.filter((item) => item.result === 'FAIL') ?? [];
    const verify = currentRevisionId && !mixedRevision
        ? onlyCurrentRevision(await readJsonFile(join(root, '.kata/tasks', taskId, 'verify.json')), currentRevisionId)
        : !mixedRevision ? await readJsonFile(join(root, '.kata/tasks', taskId, 'verify.json')) : null;
    const failedVerifyAcceptance = verify?.acceptance?.filter((item) => item.result === 'FAIL') ?? [];
    const wikiClosure = await evaluateWikiClosure(root, taskId);
    const obligations = await readObligations(root, taskId);
    const unresolvedObligations = obligations.filter((o) => !o.resolvedAt);
    const task = await readJsonFile(join(root, '.kata/tasks', taskId, 'task.json'));
    const reviewMode = task?.workflowProfile?.reviewMode;
    return {
        ...(currentRevisionId ? { currentRevisionId } : {}),
        reviewFindings: findings.length,
        blockingFindings: findings.filter((finding) => finding.severity === 'blocking').length,
        majorFindings: findings.filter((finding) => finding.severity === 'major').length,
        ...(reviewMode ? { reviewMode } : {}),
        ...(judge?.result ? { judgeResult: judge.result } : {}),
        ...(verify?.result ? { verifyResult: verify.result } : {}),
        failedAcceptance: failedAcceptance.length,
        failedVerifyAcceptance: failedVerifyAcceptance.length,
        repairScopes: failedAcceptance.map((item) => item.repairScope).filter((scope) => Boolean(scope)),
        verifyRepairScopes: failedVerifyAcceptance.map((item) => item.repairScope).filter((scope) => Boolean(scope)),
        wikiClosureValid: wikiClosure.valid,
        ...(!wikiClosure.valid ? { wikiClosureReason: wikiClosure.reason } : {}),
        evidenceFiles,
        failingEvidence: evidence.filter((item) => item && typeof item.exitCode === 'number' && item.exitCode !== 0).length,
        unresolvedObligations: unresolvedObligations.length,
        unresolvedObligationAcIds: [...new Set(unresolvedObligations.map((o) => o.acceptanceId).filter((id) => Boolean(id)))],
        ...(task && !task.acceptanceMatrix ? { missingAcceptanceMatrix: true } : {}),
        ...(mixedRevision ? { mixedRevisionEvidence: true } : {}),
    };
}
function revisionIdForEvidence(evidence) {
    const revisionIds = [...new Set(evidence.map((item) => item?.revisionId).filter((id) => Boolean(id)))];
    return revisionIds.length === 1 ? revisionIds[0] : undefined;
}
function onlyCurrentRevision(artifact, currentRevisionId) {
    return artifact?.revisionId === currentRevisionId ? artifact : null;
}
export function suggestCandidateAction(phase, upstream) {
    if (phase === 'archive') {
        return { nextSkill: '/kata', role: 'dispatcher', reason: 'archived_task', priority: 0 };
    }
    if (upstream.mixedRevisionEvidence) {
        return {
            nextSkill: '/kata-build',
            role: 'implementer',
            reason: 'repair_mixed_revision_evidence',
            priority: 2100,
        };
    }
    if (upstream.unresolvedObligations > 0) {
        if (upstream.missingAcceptanceMatrix) {
            return {
                nextSkill: '/kata-design',
                role: 'designer',
                reason: 'migrate_legacy_acceptance_matrix',
                priority: 2050 + upstream.unresolvedObligations,
                acceptanceIds: upstream.unresolvedObligationAcIds,
            };
        }
        return {
            nextSkill: '/kata-build',
            role: 'implementer',
            reason: 'repair_unresolved_obligations',
            priority: 2000 + upstream.unresolvedObligations,
        };
    }
    if (phase === 'review' && upstream.blockingFindings > 0) {
        return {
            nextSkill: '/kata-build',
            role: 'implementer',
            reason: 'repair_blocking_review_findings',
            priority: 1000 + upstream.blockingFindings,
        };
    }
    if (phase === 'review' && upstream.reviewMode === 'strict' && upstream.majorFindings > 0) {
        return {
            nextSkill: '/kata-build',
            role: 'implementer',
            reason: 'repair_strict_major_findings',
            priority: 980 + upstream.majorFindings,
        };
    }
    if (phase === 'judge' && upstream.judgeResult === 'FAIL') {
        return {
            nextSkill: '/kata-build',
            role: 'implementer',
            reason: 'repair_failed_judge',
            priority: 900 + upstream.failedAcceptance,
        };
    }
    if (upstream.failingEvidence > 0) {
        return {
            nextSkill: '/kata-build',
            role: 'implementer',
            reason: 'repair_failing_evidence',
            priority: 800 + upstream.failingEvidence,
        };
    }
    if (phase === 'hardVerify' && upstream.verifyResult === 'FAIL' && upstream.wikiClosureValid === false && upstream.failedVerifyAcceptance === 0) {
        return {
            nextSkill: '/kata-wiki-enrich',
            role: 'implementer',
            reason: 'resolve_wiki_closure',
            priority: 770,
        };
    }
    if (phase === 'hardVerify' && upstream.verifyResult === 'FAIL') {
        if (upstream.verifyRepairScopes.length > 0 && upstream.verifyRepairScopes.every((scope) => scope === 'stale_evidence')) {
            return {
                nextSkill: '/kata-build',
                role: 'implementer',
                reason: 'rebuild_stale_evidence',
                priority: 760 + upstream.failedVerifyAcceptance,
            };
        }
        return {
            nextSkill: '/kata-build',
            role: 'implementer',
            reason: 'repair_failed_verify',
            priority: 750 + upstream.failedVerifyAcceptance,
        };
    }
    if (phase === 'hardVerify' && upstream.verifyResult === 'PASS') {
        return { nextSkill: '/kata-review', role: 'reviewer', reason: 'review_fresh_implementation', priority: 740 };
    }
    if (phase === 'hardVerify') {
        return { nextSkill: '/kata-verify', role: 'reviewer', reason: 'verify_fresh_implementation', priority: 700 };
    }
    if (phase === 'review') {
        return { nextSkill: '/kata-judge', role: 'judge', reason: 'judge_reviewed_change', priority: 600 };
    }
    if (phase === 'judge' || phase === 'distill') {
        return { nextSkill: '/kata-archive', role: 'distiller', reason: 'archive_judged_change', priority: 500 };
    }
    if (phase === 'plan') {
        return { nextSkill: '/kata-build', role: 'implementer', reason: 'choose_execution_mode', priority: 400 };
    }
    if (phase === 'implement') {
        return { nextSkill: '/kata-build', role: 'implementer', reason: 'continue_implementation', priority: 400 };
    }
    if (phase === 'intake') {
        return { nextSkill: '/kata-design', role: 'designer', reason: 'design_intake_task', priority: 300 };
    }
    return { nextSkill: '/kata', role: 'dispatcher', reason: 'inspect_task', priority: 0 };
}
export function nextSkillForPhase(phase) {
    switch (phase) {
        case 'intake':
            return '/kata-design';
        case 'plan':
        case 'implement':
            return '/kata-build';
        case 'hardVerify':
            return '/kata-verify';
        case 'review':
            return '/kata-judge';
        case 'judge':
        case 'distill':
            return '/kata-archive';
        case 'archive':
            return '/kata';
    }
}
export function nextActionForTask(taskId, nextSkill, role, reason) {
    const cliVerb = skillToCliVerb(nextSkill);
    const gate = trustBoundaryForReason(reason);
    const seal = reason === 'rebuild_stale_evidence' ? ' --seal' : '';
    const wikiClosure = reason === 'resolve_wiki_closure';
    return {
        taskId,
        nextSkill,
        slashCommand: `${nextSkill} ${taskId}${seal}`,
        cliCommand: wikiClosure
            ? `kata wiki closure --task ${taskId} --decision <captured|not_applicable> --reason <reason>`
            : cliVerb ? `kata ${cliVerb} --change ${taskId}${seal}` : `kata status --change ${taskId}`,
        role,
        reason,
        requiresUserConfirmation: gate !== null || wikiClosure,
        modelOrPlatformSwitchAllowed: gate !== null,
        ...(gate ? { trustBoundary: gate } : {}),
        ...(gate ? { pauseInstruction: pauseInstructionForBoundary(gate) } : {}),
        ...(wikiClosure ? { pauseInstruction: '实现验证已通过；请决定本任务的知识闭环是 captured 还是 not_applicable，再重新执行 /kata-verify。' } : {}),
    };
}
export function statusActionPrompts(suggestion) {
    if (suggestion.reason === 'choose_execution_mode') {
        return [
            '设计已完成，实施前请确认执行方式：留在当前平台继续，或在任意已识别平台接手自动生成的平台无关交接包。Kata 不会自动切换平台或模型。',
        ];
    }
    if (suggestion.reason === 'continue_implementation') {
        return ['当前处于实施阶段：先写聚焦的失败测试（RED），再最小实现并运行 GREEN；完成后使用 /kata-build <task> --seal 封存证据。'];
    }
    if (suggestion.reason === 'rebuild_stale_evidence') {
        return ['代码在上次证据封存后发生变化；无需重做已完成实现，先执行 /kata-build <task> --seal 重新运行检查并封存新证据。'];
    }
    if (suggestion.reason === 'resolve_wiki_closure') {
        return ['实现验收和证据均已通过；当前仅 Wiki closure 待决。请决定知识是否应 captured 或 not_applicable，记录 closure 后执行 /kata-verify，不要回退到 /kata-build。'];
    }
    if (suggestion.reason === 'repair_blocking_review_findings') {
        return ['检测到 blocking review findings；建议先执行 /kata-build 修复，而不是继续 Judge PASS。'];
    }
    if (suggestion.reason === 'repair_strict_major_findings') {
        return ['检测到 strict 模式的 major review finding；strict 任务必须修复方可进入 Judge，请执行 /kata-build。'];
    }
    if (suggestion.reason === 'repair_failed_judge') {
        return ['检测到 Judge FAIL；建议先执行 /kata-build 修复 failed acceptance。'];
    }
    if (suggestion.reason === 'repair_failing_evidence') {
        return ['检测到失败 evidence；建议先执行 /kata-build 修复并刷新证据。'];
    }
    if (suggestion.reason === 'repair_failed_verify') {
        return ['检测到 Verify FAIL；建议先执行 /kata-build 修复 failed verification。'];
    }
    if (suggestion.reason === 'repair_unresolved_obligations') {
        return ['检测到未解决的修复义务（repair obligations）；仅创建新 revision 不会关闭，必须用矩阵关联的新鲜通过证据解析。'];
    }
    if (suggestion.reason === 'migrate_legacy_acceptance_matrix') {
        const acceptance = suggestion.acceptanceIds?.length ? `（${suggestion.acceptanceIds.join('、')}）` : '';
        return [`检测到未解决的修复义务${acceptance}，但任务缺少 acceptanceMatrix。0 个当前 findings 不是完成；请先通过 /kata-design 补齐稳定 AC、实现/测试路径和矩阵证据，再修复义务并封存。`];
    }
    if (suggestion.reason === 'repair_mixed_revision_evidence') {
        return ['检测到混合 revision 证据；请执行 /kata-build <task> --seal 重新封存，清除旧 revision 残留证据。'];
    }
    if (suggestion.reason === 'verify_fresh_implementation') {
        return ['实现和项目质检已完成；下一步执行 /kata-verify 校验证据新鲜度、验收覆盖和 blocking findings。'];
    }
    if (suggestion.reason === 'review_fresh_implementation') {
        return ['实现与硬验证已完成；请暂停并让用户选择 Reviewer 使用当前平台/模型、切换平台/模型，或委托给其他 agent。'];
    }
    if (suggestion.reason === 'judge_reviewed_change') {
        return ['Review 已完成；请暂停并让用户选择 Judge 使用当前平台/模型、切换到高阶模型/平台，或委托给其他 agent。'];
    }
    if (suggestion.reason === 'archive_judged_change') {
        return ['Judge 已完成；请暂停并让用户确认是否归档，以及是否先补充 Wiki/发布证据。'];
    }
    if (suggestion.reason === 'archived_task') {
        return ['归档已完成。建议使用 git 提交本轮工作流涉及的所有更改，并推送到远端。'];
    }
    return [`建议执行 ${suggestion.nextSkill}，角色 ${suggestion.role}。`];
}
function trustBoundaryForReason(reason) {
    if (reason === 'choose_execution_mode')
        return 'implementation_gate';
    if (reason === 'review_fresh_implementation')
        return 'review_gate';
    if (reason === 'judge_reviewed_change')
        return 'judge_gate';
    if (reason === 'archive_judged_change')
        return 'archive_gate';
    return null;
}
function pauseInstructionForBoundary(boundary) {
    if (boundary === 'implementation_gate') {
        return '暂停：设计已完成。Kata 已生成平台无关交接包；可在当前或任意已识别平台接手。Kata 不会自动切换或记录宿主平台模型。';
    }
    if (boundary === 'review_gate') {
        return '暂停：Kata 不能切换宿主平台模型，也不得写入已切换的路由记录。展示推荐平台/模型；请用户先在宿主平台设置中完成切换，再恢复会话并确认实际平台/模型。仅此后才可用 --confirm-host-model 写入审计记录并进入 Review。';
    }
    if (boundary === 'judge_gate') {
        return '暂停：Kata 不能切换宿主平台模型，也不得写入已切换的路由记录。展示 Judge 推荐的平台/模型；请用户先在宿主平台设置中完成切换，再恢复会话并确认实际平台/模型。仅此后才可用 --confirm-host-model 写入审计记录并进入 Judge。';
    }
    return 'Stop after Judge. Ask the user whether to archive now, enrich Wiki first, or collect more release evidence.';
}
function skillToCliVerb(nextSkill) {
    const normalized = nextSkill.startsWith('/kata-') ? nextSkill.slice('/kata-'.length) : nextSkill === '/kata' ? 'status' : '';
    if (!normalized)
        return null;
    if (normalized === 'status')
        return 'status';
    return normalized;
}
async function readJsonFile(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return null;
    }
}
async function listEvidenceFiles(root, taskId) {
    try {
        const files = await readdir(join(root, '.kata/evidence'));
        return files.filter((file) => file.startsWith(`${taskId}-`) && file.endsWith('.json')).sort();
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=navigation.js.map