/**
 * 规则化面试题（F5，P0 不依赖 LLM）：基于真实仓库/PR/Issue 生成"为什么这样设计"
 * 类问题；basisEvidenceRef 指向具体证据。证据不足时返回空数组，不编造问题。
 */

import type { AbilityProfile } from '@jobagent/shared';
import type { AnalyzerInput } from './input.js';

export function generateInterviewQuestions(
  input: AnalyzerInput,
): AbilityProfile['interviewQuestions'] {
  const questions: AbilityProfile['interviewQuestions'] = [];
  const known = new Set(input.evidence.map((e) => e.evidenceId));

  // 按 commit 数找最活跃的自建仓库
  const commitByRepo = new Map<string, number>();
  for (const c of input.commits) {
    commitByRepo.set(c.repoName, (commitByRepo.get(c.repoName) ?? 0) + 1);
  }
  const topRepo = input.repos
    .filter((r) => (commitByRepo.get(r.name) ?? 0) > 0)
    .toSorted((a, b) => (commitByRepo.get(b.name) ?? 0) - (commitByRepo.get(a.name) ?? 0))[0];

  if (topRepo && known.has(`repo:${topRepo.name}`)) {
    questions.push({
      question: `Describe your main contribution to ${topRepo.name} and the key design decisions behind it.`,
      intent: 'Assess depth of ownership and engineering judgment on real work',
      basisEvidenceRef: `repo:${topRepo.name}`,
    });
  }

  // 最新一条被他人项目 merge 的 PR
  const mergedExternal = input.pullRequests
    .filter((p) => !p.repoOwnerIsSelf && p.state === 'MERGED')
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (mergedExternal && known.has(`pr:${mergedExternal.repoNameWithOwner}:${mergedExternal.number}`)) {
    questions.push({
      question: `Walk us through PR "${mergedExternal.title}" in ${mergedExternal.repoNameWithOwner}: what problem did it solve, and what trade-offs did you make?`,
      intent: 'Assess collaboration skills and engineering judgment in external codebases',
      basisEvidenceRef: `pr:${mergedExternal.repoNameWithOwner}:${mergedExternal.number}`,
    });
  }

  // 最高 star 的自建仓库
  const topStarRepo = input.repos
    .filter((r) => r.stargazerCount >= 20)
    .toSorted((a, b) => b.stargazerCount - a.stargazerCount)[0];
  if (topStarRepo && known.has(`repo:${topStarRepo.name}`)) {
    questions.push({
      question: `${topStarRepo.name} has ${topStarRepo.stargazerCount} stars. What is its core design, and what did you learn building it?`,
      intent: 'Assess system design and community impact',
      basisEvidenceRef: `repo:${topStarRepo.name}`,
    });
  }

  // 主要语言深度
  const primaryLanguage = input.repos[0]?.primaryLanguage;
  if (primaryLanguage) {
    const langRepo = input.repos.find((r) => r.primaryLanguage === primaryLanguage);
    if (langRepo && known.has(`repo:${langRepo.name}`)) {
      questions.push({
        question: `What is the most complex thing you have built with ${primaryLanguage}?`,
        intent: 'Assess language depth beyond syntax familiarity',
        basisEvidenceRef: `repo:${langRepo.name}`,
      });
    }
  }

  // Issue 最多的仓库（问题诊断能力）
  const issueByRepo = new Map<string, number>();
  for (const i of input.issues) {
    issueByRepo.set(i.repoNameWithOwner, (issueByRepo.get(i.repoNameWithOwner) ?? 0) + 1);
  }
  const topIssue = [...issueByRepo.entries()]
    .filter(([, count]) => count >= 2)
    .toSorted((a, b) => b[1] - a[1])[0];
  if (topIssue) {
    const issue = input.issues.find((i) => i.repoNameWithOwner === topIssue[0]);
    if (issue && known.has(`issue:${issue.repoNameWithOwner}:${issue.number}`)) {
      questions.push({
        question: `You have engaged with ${topIssue[1]} issues in ${topIssue[0]}. Which one was the hardest to diagnose, and why?`,
        intent: 'Assess debugging and problem-analysis ability',
        basisEvidenceRef: `issue:${issue.repoNameWithOwner}:${issue.number}`,
      });
    }
  }

  return questions.slice(0, 5);
}
