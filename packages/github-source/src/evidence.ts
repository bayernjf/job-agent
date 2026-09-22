/**
 * 证据生成：把采集到的结构化对象映射为 EvidenceItem。
 * evidenceId 即 evidenceRefs 的索引键，analyzer-core 的每条结论必须指向这里。
 */

import type { AnalyzerInput } from '@jobagent/analyzer-core';
import type { EvidenceItem } from '@jobagent/shared';

export function buildSubjectEvidence(
  subject: AnalyzerInput['subject'],
  window: AnalyzerInput['dataWindow'],
): EvidenceItem {
  return {
    evidenceId: `user:${subject.login}`,
    sourcePlatform: 'github',
    sourceType: 'contribution',
    url: subject.profileUrl,
    occurredAt: window.since,
    layer: 'L0',
    claim: `GitHub account ${subject.login}: created ${window.since.slice(0, 10)}, ${subject.followers} followers, ${subject.publicRepos} public repositories`,
    rawRef: subject.login,
  };
}

export function buildRepoEvidence(repo: AnalyzerInput['repos'][number]): EvidenceItem {
  return {
    evidenceId: `repo:${repo.ownerLogin}/${repo.name}`,
    sourcePlatform: 'github',
    sourceType: 'repo',
    url: repo.url,
    occurredAt: repo.pushedAt ?? undefined,
    layer: 'L0',
    claim: `Repository ${repo.ownerLogin}/${repo.name}${repo.primaryLanguage ? ` (${repo.primaryLanguage})` : ''}: ${repo.stargazerCount} stars / ${repo.forkCount} forks, last pushed ${repo.pushedAt ? repo.pushedAt.slice(0, 10) : 'never'}`,
    rawRef: `${repo.ownerLogin}/${repo.name}`,
  };
}

export function buildCommitEvidence(commit: AnalyzerInput['commits'][number]): EvidenceItem {
  return {
    evidenceId: `commit:${commit.repoName}:${commit.oid}`,
    sourcePlatform: 'github',
    sourceType: 'commit',
    url: `https://github.com/${commit.repoName}/commit/${commit.oid}`,
    occurredAt: commit.committedAt,
    layer: 'L1',
    claim: commit.messageHeadline || `Commit ${commit.oid.slice(0, 7)} (${commit.repoName})`,
    rawRef: `${commit.repoName}#${commit.oid}`,
  };
}

export function buildPullRequestEvidence(pr: AnalyzerInput['pullRequests'][number]): EvidenceItem {
  return {
    evidenceId: `pr:${pr.repoNameWithOwner}:${pr.number}`,
    sourcePlatform: 'github',
    sourceType: 'pr',
    url: pr.url,
    occurredAt: pr.createdAt,
    layer: 'L1',
    claim: `PR "${pr.title}" (${pr.repoNameWithOwner}#${pr.number})`,
    rawRef: `${pr.repoNameWithOwner}#${pr.number}`,
  };
}

export function buildIssueEvidence(issue: AnalyzerInput['issues'][number]): EvidenceItem {
  return {
    evidenceId: `issue:${issue.repoNameWithOwner}:${issue.number}`,
    sourcePlatform: 'github',
    sourceType: 'issue',
    url: issue.url,
    occurredAt: issue.createdAt,
    layer: 'L1',
    claim: `Issue "${issue.title}" (${issue.repoNameWithOwner}#${issue.number})`,
    rawRef: `${issue.repoNameWithOwner}#${issue.number}`,
  };
}
