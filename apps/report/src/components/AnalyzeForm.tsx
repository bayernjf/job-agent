/**
 * AnalyzeForm——客户端 React island。
 * 职责：输入用户名 → POST /analyze 创建任务 → 轮询 GET /jobs/:id → 跳转报告页。
 * 所有用户可见文案由 Astro 服务端通过 props 传入（i18n 在服务端完成，组件不硬编码文案）。
 */

import { useState, useCallback, useRef, type FormEvent } from 'react';

interface AnalyzeFormProps {
  locale: string;
  apiBase: string;
  placeholder: string;
  analyzeLabel: string;
  analyzingLabel: string;
  invalidLabel: string;
  queuedLabel: string;
  runningLabel: string;
  failedLabel: string;
  stageL0Label: string;
  stageL1Label: string;
  pollingLabel: string;
  retryLabel: string;
  attemptsLabel: string;
  platformGithubLabel: string;
  platformGiteeLabel: string;
}

type Phase = 'idle' | 'creating' | 'polling' | 'done' | 'error';
type Platform = 'github' | 'gitee';

// GitHub username 规则（与 API Zod 校验一致）；Gitee 额外允许下划线
const USERNAME_RES: Record<Platform, RegExp> = {
  github: /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/,
  gitee: /^[a-zA-Z0-9](?:[a-zA-Z0-9]|[-_](?=[a-zA-Z0-9])){0,38}$/,
};

const POLL_INTERVAL_MS = 2000;

export default function AnalyzeForm(props: AnalyzeFormProps) {
  const {
    locale,
    apiBase,
    placeholder,
    analyzeLabel,
    analyzingLabel,
    invalidLabel,
    queuedLabel,
    runningLabel,
    failedLabel,
    stageL0Label,
    stageL1Label,
    pollingLabel,
    retryLabel,
    attemptsLabel,
    platformGithubLabel,
    platformGiteeLabel,
  } = props;

  const [username, setUsername] = useState('');
  const [platform, setPlatform] = useState<Platform>('github');
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollJob = useCallback(
    (jobId: string) => {
      const timer = setTimeout(async () => {
        try {
          const res = await fetch(`${apiBase}/jobs/${jobId}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const job = (await res.json()) as {
            status: string;
            stage?: string | null;
            profileId?: string | null;
            errorMessage?: string | null;
            attempts?: number;
          };

          if (job.status === 'succeeded' && job.profileId) {
            setPhase('done');
            window.location.href = `/${locale}/report/${job.profileId}`;
            return;
          }

          if (job.status === 'failed') {
            setPhase('error');
            setErrorText(job.errorMessage ?? failedLabel);
            return;
          }

          // queued / running：更新状态文本，继续轮询
          const stageText =
            job.stage === 'L0'
              ? stageL0Label
              : job.stage === 'L1'
                ? stageL1Label
                : job.status === 'queued'
                  ? queuedLabel
                  : runningLabel;
          const attemptsText =
            job.attempts && job.attempts > 1
              ? `（${attemptsLabel.replace('{current}', String(job.attempts)).replace('{max}', '3')}）`
              : '';
          setStatusText(`${pollingLabel} ${stageText}${attemptsText}`);
          pollJob(jobId);
        } catch (err) {
          setPhase('error');
          setErrorText(err instanceof Error ? err.message : String(err));
        }
      }, POLL_INTERVAL_MS);
      pollTimerRef.current = timer;
    },
    [apiBase, locale, pollingLabel, queuedLabel, runningLabel, stageL0Label, stageL1Label, attemptsLabel, failedLabel],
  );

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      stopPolling();
      setErrorText('');

      const trimmed = username.trim();
      if (!USERNAME_RES[platform].test(trimmed)) {
        setPhase('error');
        setErrorText(invalidLabel);
        return;
      }

      setPhase('creating');
      setStatusText(pollingLabel);

      try {
        const res = await fetch(`${apiBase}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: trimmed, platform }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { jobId: string };
        setPhase('polling');
        pollJob(data.jobId);
      } catch (err) {
        setPhase('error');
        setErrorText(err instanceof Error ? err.message : String(err));
      }
    },
    [username, apiBase, invalidLabel, pollingLabel, pollJob, stopPolling],
  );

  const handleReset = useCallback(() => {
    stopPolling();
    setPhase('idle');
    setErrorText('');
    setStatusText('');
  }, [stopPolling]);

  const isBusy = phase === 'creating' || phase === 'polling';

  return (
    <form onSubmit={handleSubmit} className="analyze-form">
      <div className="platform-switch" role="group" aria-label="Platform">
        <button
          type="button"
          className={`platform-btn ${platform === 'github' ? 'platform-btn--active' : ''}`}
          onClick={() => setPlatform('github')}
          disabled={isBusy}
        >
          {platformGithubLabel}
        </button>
        <button
          type="button"
          className={`platform-btn ${platform === 'gitee' ? 'platform-btn--active' : ''}`}
          onClick={() => setPlatform('gitee')}
          disabled={isBusy}
        >
          {platformGiteeLabel}
        </button>
      </div>
      <div className="input-row">
        <input
          type="text"
          className="ja-input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={placeholder}
          disabled={isBusy}
          autoComplete="off"
          spellCheck={false}
          aria-label="username"
        />
        <button type="submit" className="ja-btn" disabled={isBusy || username.trim().length === 0}>
          {isBusy ? analyzingLabel : analyzeLabel}
        </button>
      </div>

      {isBusy && statusText && (
        <p className="status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          {statusText}
        </p>
      )}

      {phase === 'error' && (
        <div className="error-box" role="alert">
          <span>{errorText}</span>
          <button type="button" className="retry-btn" onClick={handleReset}>
            {retryLabel}
          </button>
        </div>
      )}
    </form>
  );
}
