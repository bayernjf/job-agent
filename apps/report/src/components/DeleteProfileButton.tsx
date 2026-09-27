import { useState } from 'react';

/**
 * DeleteProfileButton：「我的」页画像卡上的删除入口（B2 自助解绑，2026-09-27）。
 * 仅挂在已登录本人视角（my.astro 只对 user 渲染画像列表）；点击后原生确认弹窗，
 * 确认则 DELETE /profiles/:id（仅本人，级联删证据/投递/面试并撤销认领），
 * 成功后移除对应卡片 DOM；列表清空时整页刷新回空态。所有文案由 Astro 经 t() 传入。
 */

interface DeleteProfileButtonProps {
  apiBase: string;
  profileId: string;
  /** 卡片 <li> 的 id，成功后直接移除该节点（列表清空则整页刷新） */
  cardId: string;
  deleteLabel: string;
  confirmTitle: string;
  confirmBody: string;
  cancelLabel: string;
  okLabel: string;
  errorLabel: string;
  hintLabel: string;
}

export default function DeleteProfileButton({
  apiBase,
  profileId,
  cardId,
  deleteLabel,
  confirmTitle,
  confirmBody,
  cancelLabel,
  okLabel,
  errorLabel,
  hintLabel,
}: DeleteProfileButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!window.confirm(`${confirmTitle}\n\n${confirmBody}`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        setError(errorLabel);
        setBusy(false);
        return;
      }
      const card = document.getElementById(cardId);
      if (card) card.remove();
      // 列表删空后回空态（SSR 的空态分支需要重渲染）
      const list = document.querySelector('.my-profile-list');
      if (!list || list.children.length === 0) {
        window.location.reload();
      }
    } catch {
      setError(errorLabel);
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        className="ja-btn ja-btn--danger ja-btn--sm"
        onClick={() => setConfirming(true)}
        title={hintLabel}
        data-testid="delete-profile-button"
      >
        {deleteLabel}
      </button>
    );
  }

  return (
    <span className="delete-profile">
      {error ? (
        <span className="delete-profile__error" role="alert">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        className="ja-btn ja-btn--ghost ja-btn--sm"
        onClick={() => setConfirming(false)}
        disabled={busy}
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        className="ja-btn ja-btn--danger ja-btn--sm"
        onClick={handleDelete}
        disabled={busy}
        data-testid="delete-profile-confirm"
      >
        {busy ? okLabel : okLabel}
      </button>
    </span>
  );
}
