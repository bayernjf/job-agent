/**
 * 证据生成：把 Gitee 采集的结构化对象映射为 EvidenceItem。
 * evidenceId 前缀与 github-source 保持一致（user:/repo:/commit:/pr:/issue:），
 * id 内已含 owner/name；单次 AnalyzerInput 只来自单一源，因此跨源不碰撞。
 */

import type { AnalyzerInput } from '@jobagent/analyzer-core';
import type { EvidenceItem } from '@jobagent/shared';

const PLATFORM = 'gitee';

export function buildGiteeSubjectEvidence(
  subject: AnalyzerInput['subject'],
  window: AnalyzerInput['dataWindow'],
): EvidenceItem {
  return {
    evidenceId: `user:${subject.login}`,
    sourcePlatform: PLATFORM,
    sourceType: 'contribution',
    url: subject.profileUrl,
    occurredAt: window.since,
    layer: 'L0',
    claim: `Gitee 账号 ${subject.login}：创建于 ${window.since.slice(0, 10)}，${subject.followers} 关注者，${subject.publicRepos} 个公开仓库`,
    rawRef: subject.login,
  };
}

export function buildGiteeRepoEvidence(repo: AnalyzerInput['repos'][number]): EvidenceItem {
  return {
    evidenceId: `repo:${repo.ownerLogin}/${repo.name}`,
    sourcePlatform: PLATFORM,
    sourceType: 'repo',
    url: repo.url,
    occurredAt: repo.pushedAt ?? undefined,
    layer: 'L0',
    claim: `仓库 ${repo.ownerLogin}/${repo.name}${repo.primaryLanguage ? `（${repo.primaryLanguage}）` : ''}：${repo.stargazerCount} star / ${repo.forkCount} fork，最近推送 ${repo.pushedAt ? repo.pushedAt.slice(0, 10) : '无'}`,
    rawRef: `${repo.ownerLogin}/${repo.name}`,
  };
}

export function buildGiteeCommitEvidence(commit: AnalyzerInput['commits'][number]): EvidenceItem {
  return {
    evidenceId: `commit:${commit.repoName}:${commit.oid}`,
    sourcePlatform: PLATFORM,
    sourceType: 'commit',
    url: `https://gitee.com/${commit.repoName}/commit/${commit.oid}`,
    occurredAt: commit.committedAt,
    layer: 'L1',
    claim: commit.messageHeadline || `提交 ${commit.oid.slice(0, 7)}（${commit.repoName}）`,
    rawRef: `${commit.repoName}#${commit.oid}`,
  };
}

export function buildGiteePullRequestEvidence(pr: AnalyzerInput['pullRequests'][number]): EvidenceItem {
  return {
    evidenceId: `pr:${pr.repoNameWithOwner}:${pr.number}`,
    sourcePlatform: PLATFORM,
    sourceType: 'pr',
    url: pr.url,
    occurredAt: pr.createdAt,
    layer: 'L1',
    claim: `PR「${pr.title}」（${pr.repoNameWithOwner}#${pr.number}）`,
    rawRef: `${pr.repoNameWithOwner}#${pr.number}`,
  };
}

export function buildGiteeIssueEvidence(issue: AnalyzerInput['issues'][number]): EvidenceItem {
  return {
    evidenceId: `issue:${issue.repoNameWithOwner}:${issue.number}`,
    sourcePlatform: PLATFORM,
    sourceType: 'issue',
    url: issue.url,
    occurredAt: issue.createdAt,
    layer: 'L1',
    claim: `Issue「${issue.title}」（${issue.repoNameWithOwner}#${issue.number}）`,
    rawRef: `${issue.repoNameWithOwner}#${issue.number}`,
  };
}
