import type { NextActionReason, TrustBoundary } from './navigation.js';

/**
 * The lifecycle prompts, as data with a language dimension (L2-08).
 *
 * The workflow surface hardcoded Chinese for fifteen reasons and English for others — the trust-boundary instructions
 * were three Chinese strings and one English one — while the rest of the product carries a configured language
 * (`language: 'en' | 'zh'` in the installer and the skill rendering). A user who configured English still got Chinese
 * from `status`, and one function emitted both languages for the same kind of message.
 *
 * One catalogue, keyed by reason, each entry carrying both languages: the prompts now resolve through the same choice the
 * rest of the product uses, and adding a language means adding a column rather than finding every sentence.
 */

export type PromptLanguage = 'en' | 'zh';

/** Reasons that carry a prompt for the status surface. Reasons without one fall back to the generic sentence. */
export const statusPrompts: Partial<Record<NextActionReason, Record<PromptLanguage, string>>> = {
    choose_execution_mode: {
        zh: '设计已完成，实施前请确认执行方式：留在当前平台继续，或在任意已识别平台接手自动生成的平台无关交接包。Kata 不会自动切换平台或模型。',
        en: 'Design is complete. Before implementing, choose how to proceed: continue on the current platform, or pick up the platform-neutral handoff packet on any detected platform. Kata never switches platform or model on its own.',
    },
    continue_implementation: {
        zh: '当前处于实施阶段：先写聚焦的失败测试（RED），再最小实现并运行 GREEN；完成后使用 /kata-build <task> --seal 封存证据。',
        en: 'Implementation is in progress: write a focused failing test (RED), implement the minimum, verify GREEN, then seal the evidence with /kata-build <task> --seal.',
    },
    rebuild_stale_evidence: {
        zh: '代码在上次证据封存后发生变化；无需重做已完成实现，先执行 /kata-build <task> --seal 重新运行检查并封存新证据。',
        en: 'The code changed after the last seal. Nothing needs re-implementing: run /kata-build <task> --seal to re-run the checks and seal fresh evidence.',
    },
    resolve_wiki_closure: {
        zh: '实现验收和证据均已通过；当前仅 Wiki closure 待决。请决定知识是否应 captured 或 not_applicable，记录 closure 后执行 /kata-verify，不要回退到 /kata-build。',
        en: 'Acceptance and evidence pass; only the Wiki closure is open. Decide whether the knowledge is captured or not_applicable, record the closure, then run /kata-verify — do not go back to /kata-build.',
    },
    repair_blocking_review_findings: {
        zh: '检测到 blocking review findings；建议先执行 /kata-build 修复，而不是继续 Judge PASS。',
        en: 'Blocking review findings were recorded. Repair them with /kata-build instead of continuing to a Judge PASS.',
    },
    repair_strict_major_findings: {
        zh: '检测到 strict 模式的 major review finding；strict 任务必须修复方可进入 Judge，请执行 /kata-build。',
        en: 'A major review finding in strict mode. Strict tasks must repair before Judge: run /kata-build.',
    },
    complete_review_conclusion: {
        zh: 'Review 尚未形成绑定当前 revision 的显式结论和审查证据；请完成实际代码审查后，以 /kata-review --approve --review-evidence <summary> 记录结论，或写入 findings。',
        en: 'Review has no explicit conclusion bound to the current revision. Do the review, then record it with /kata-review --approve --review-evidence <summary>, or write findings.',
    },
    invalid_review_approval: {
        zh: '检测到无效 Review approval：缺少绑定当前 revision 的 reviewEvidence。该产物不能进入 Judge；请重新执行 /kata-review 并记录真实审查结论。',
        en: 'The review approval is invalid: it carries no reviewEvidence bound to the current revision. This artefact cannot reach Judge — re-run /kata-review and record a real conclusion.',
    },
    repair_failed_judge: {
        zh: '检测到 Judge FAIL；建议先执行 /kata-build 修复 failed acceptance。',
        en: 'Judge returned FAIL. Repair the failed acceptance criteria with /kata-build.',
    },
    repair_failing_evidence: {
        zh: '检测到失败 evidence；建议先执行 /kata-build 修复并刷新证据。',
        en: 'Failing evidence was recorded. Repair and refresh it with /kata-build.',
    },
    repair_failed_verify: {
        zh: '检测到 Verify FAIL；建议先执行 /kata-build 修复 failed verification。',
        en: 'Verify returned FAIL. Repair the failed verification with /kata-build.',
    },
    repair_unresolved_obligations: {
        zh: '检测到未解决的修复义务（repair obligations）；仅创建新 revision 不会关闭，必须用矩阵关联的新鲜通过证据解析。',
        en: 'Unresolved repair obligations. A new revision alone does not close them: they are resolved by fresh passing evidence matched through the acceptance matrix.',
    },
    repair_mixed_revision_evidence: {
        zh: '检测到混合 revision 证据；请执行 /kata-build <task> --seal 重新封存，清除旧 revision 残留证据。',
        en: 'Evidence from more than one revision. Run /kata-build <task> --seal to re-seal and clear what the older revision left behind.',
    },
    verify_fresh_implementation: {
        zh: '实现和项目质检已完成；下一步执行 /kata-verify 校验证据新鲜度、验收覆盖和 blocking findings。',
        en: 'Implementation and the project checks are done. Next, run /kata-verify to check evidence freshness, acceptance coverage and blocking findings.',
    },
    review_fresh_implementation: {
        zh: '实现与硬验证已完成；请暂停并让用户选择 Reviewer 使用当前平台/模型、切换平台/模型，或委托给其他 agent。',
        en: 'Implementation and hard verification are done. Stop and let the user choose whether the Reviewer uses the current platform/model, switches, or delegates to another agent.',
    },
    judge_reviewed_change: {
        zh: 'Review 已完成；请暂停并让用户选择 Judge 使用当前平台/模型、切换到高阶模型/平台，或委托给其他 agent。',
        en: 'Review is complete. Stop and let the user choose whether the Judge uses the current platform/model, switches to a stronger one, or delegates to another agent.',
    },
    archive_judged_change: {
        zh: 'Judge 已完成；请暂停并让用户确认是否归档，以及是否先补充 Wiki/发布证据。',
        en: 'Judge is complete. Stop and let the user decide whether to archive now, and whether to enrich the Wiki or collect release evidence first.',
    },
    archived_task: {
        zh: '归档已完成。建议使用 git 提交本轮工作流涉及的所有更改，并推送到远端。',
        en: 'The task is archived. Commit everything this workflow touched and push it.',
    },
};

/** The instructions shown when the workflow stops at a trust boundary. */
export const boundaryPrompts: Record<TrustBoundary, Record<PromptLanguage, string>> = {
    implementation_gate: {
        zh: '暂停：设计已完成。Kata 已生成平台无关交接包；可在当前或任意已识别平台接手。Kata 不会自动切换或记录宿主平台模型。',
        en: 'Stop: design is complete. Kata produced a platform-neutral handoff packet; continue here or on any detected platform. Kata never switches or records the host platform model.',
    },
    review_gate: {
        zh: '暂停：Kata 不能切换宿主平台模型，也不得写入已切换的路由记录。展示推荐平台/模型；请用户先在宿主平台设置中完成切换，再恢复会话并确认实际平台/模型。仅此后才可用 --confirm-host-model 写入审计记录并进入 Review。',
        en: 'Stop: Kata cannot switch the host platform model, and will not write a route record for a switch it did not make. Show the recommendation; the user switches in their own platform, then resumes and confirms the actual platform/model. Only then may --confirm-host-model record the audit entry and enter Review.',
    },
    judge_gate: {
        zh: '暂停：Kata 不能切换宿主平台模型，也不得写入已切换的路由记录。展示 Judge 推荐的平台/模型；请用户先在宿主平台设置中完成切换，再恢复会话并确认实际平台/模型。仅此后才可用 --confirm-host-model 写入审计记录并进入 Judge。',
        en: 'Stop: Kata cannot switch the host platform model, and will not write a route record for a switch it did not make. Show the Judge recommendation; the user switches in their own platform, then resumes and confirms the actual platform/model. Only then may --confirm-host-model record the audit entry and enter Judge.',
    },
    archive_gate: {
        zh: '暂停：Judge 已完成。请用户决定现在归档、先补充 Wiki，还是先收集更多发布证据。',
        en: 'Stop after Judge. Ask the user whether to archive now, enrich the Wiki first, or collect more release evidence.',
    },
};

/** The prompt for a reason, in the requested language. */
export function statusPromptFor(
    reason: NextActionReason,
    language: PromptLanguage,
    suggestion: { nextSkill: string; role: string; acceptanceIds?: string[] },
): string {
    const entry = statusPrompts[reason];
    if (entry) return entry[language];
    if (reason === 'migrate_legacy_acceptance_matrix') {
        const acceptance = suggestion.acceptanceIds?.length ? ` (${suggestion.acceptanceIds.join(', ')})` : '';
        return language === 'zh'
            ? `检测到未解决的修复义务${acceptance}，但任务缺少 acceptanceMatrix。0 个当前 findings 不是完成；请先通过 /kata-design 补齐稳定 AC、实现/测试路径和矩阵证据，再修复义务并封存。`
            : `Unresolved repair obligations${acceptance}, but the task has no acceptanceMatrix. Zero current findings is not completion: complete stable acceptance ids, implementation/test paths and matrix evidence through /kata-design, then repair the obligations and seal.`;
    }
    if (reason === 'resolve_wiki_closure') {
        // (covered above, kept for the type checker's benefit)
    }
    return language === 'zh'
        ? `建议执行 ${suggestion.nextSkill}，角色 ${suggestion.role}。`
        : `Recommended: run ${suggestion.nextSkill} as ${suggestion.role}.`;
}

/** The pause instruction for a trust boundary, in the requested language. */
export function boundaryPromptFor(boundary: TrustBoundary, language: PromptLanguage): string {
    return boundaryPrompts[boundary][language];
}

/** The language a caller asked for, from the environment the product already uses. */
export function promptLanguage(explicit?: PromptLanguage): PromptLanguage {
    if (explicit) return explicit;
    const configured = (process.env.KATA_LANGUAGE ?? 'zh').trim().toLowerCase();
    return configured.startsWith('en') ? 'en' : 'zh';
}
