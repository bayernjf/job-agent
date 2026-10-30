/**
 * ProofCard——客户端 React island（design-share-proof-card-20261030 §1.3）。
 * 「能力证明卡」：把报告页已有的公开结论（真实性分级 + 技能标签 + 可复核说明）
 * 重新排版为可下载的分享图（1200×630 PNG），供贴进简历 / 个人站 / GitHub。
 *
 * 硬边界：
 * - 只渲染快照已有结论，不造新事实；不含照片/邮箱/联系方式（防滥用）。
 * - 颜色经 getComputedStyle 读实际渲染元素上的 --ja-* 变量，代码零 hex；
 *   深浅色主题自动跟随（drawProofCard 接收的色值全部来自运行时读取）。
 * - 下载成功后 fire-and-forget 上报 share_clicked 漏斗事件（与 ShareButton
 *   同口径，credentials:'include'，失败静默——分享行为绝不因埋点降级）。
 */

import { useCallback, useRef, useState } from 'react';

/** 画布尺寸：OG/分享图标准 1200×630 */
const CARD_W = 1200;
const CARD_H = 630;
const PAD = 72;
const MAX_TAGS = 6;

export interface ProofCardColors {
  bg: string;
  fg: string;
  fgMuted: string;
  accent: string;
  border: string;
  badgeFg: string;
  badgeBg: string;
}

export interface ProofCardData {
  login: string;
  platform: string;
  authLabel: string;
  confidenceLabel: string;
  tags: string[];
  verifyLine: string;
  generatedOn: string;
  domain: string;
  brandName: string;
}

/** 从页面实际渲染元素读取 token 色值（唯一色值来源，脚本与组件都不写 hex） */
export function readProofCardColors(badgeEl: Element | null): ProofCardColors {
  const root = getComputedStyle(document.documentElement);
  const read = (name: string): string => root.getPropertyValue(name).trim();
  const badge = badgeEl ? getComputedStyle(badgeEl) : null;
  return {
    bg: read('--ja-color-bg'),
    fg: read('--ja-color-fg'),
    fgMuted: read('--ja-color-fg-muted'),
    accent: read('--ja-color-accent'),
    border: read('--ja-color-border'),
    badgeFg: badge?.color ?? read('--ja-color-accent'),
    badgeBg: badge?.backgroundColor ?? 'transparent',
  };
}

const FONT_SANS = "Inter, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 把证明卡画到 canvas（1200×630）。信息层级见设计 §1.4。 */
export function drawProofCard(
  ctx: CanvasRenderingContext2D,
  data: ProofCardData,
  colors: ProofCardColors,
): void {
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  // 品牌顶条
  ctx.fillStyle = colors.accent;
  ctx.fillRect(0, 0, CARD_W, 10);

  // 顶行：品牌名（左）+ 域名（右）
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = colors.accent;
  ctx.font = `700 30px ${FONT_SANS}`;
  ctx.textAlign = 'left';
  ctx.fillText(data.brandName, PAD, PAD + 22);
  ctx.fillStyle = colors.fgMuted;
  ctx.font = `400 24px ${FONT_SANS}`;
  ctx.textAlign = 'right';
  ctx.fillText(data.domain, CARD_W - PAD, PAD + 22);
  ctx.textAlign = 'left';

  // 主体：login
  ctx.fillStyle = colors.fg;
  ctx.font = `700 76px ${FONT_SANS}`;
  ctx.fillText(data.login, PAD, 234);

  // 真实性徽章（色值来自页面真实徽章元素）+ 置信度
  const badgeY = 276;
  ctx.font = `500 30px ${FONT_SANS}`;
  const badgeText = `${data.authLabel} · ${data.confidenceLabel}`;
  const badgeW = ctx.measureText(badgeText).width + 48;
  ctx.fillStyle = colors.badgeBg;
  roundRect(ctx, PAD, badgeY, badgeW, 58, 10);
  ctx.fill();
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = colors.badgeFg;
  ctx.fillText(badgeText, PAD + 24, badgeY + 40);

  // 技能标签（≤6，一行放不下换行，最多两行）
  ctx.font = `500 26px ${FONT_SANS}`;
  const tagH = 50;
  const tagGap = 14;
  let tx = PAD;
  let ty = 404;
  for (const tag of data.tags.slice(0, MAX_TAGS)) {
    const label = ` ${tag} `;
    const tw = ctx.measureText(label).width + 36;
    if (tx + tw > CARD_W - PAD && tx > PAD) {
      tx = PAD;
      ty += tagH + tagGap;
      if (ty > 404 + tagH + tagGap + tagH) break; // 最多两行
    }
    ctx.fillStyle = colors.badgeBg;
    roundRect(ctx, tx, ty, tw, tagH, 10);
    ctx.fill();
    ctx.fillStyle = colors.badgeFg;
    ctx.fillText(label, tx + 18, ty + 34);
    tx += tw + tagGap;
  }

  // 页脚：复核句（左）+ 生成时间（右）
  ctx.textAlign = 'left';
  ctx.fillStyle = colors.accent;
  ctx.font = `600 28px ${FONT_SANS}`;
  ctx.fillText(data.verifyLine, PAD, CARD_H - PAD + 16);
  ctx.fillStyle = colors.fgMuted;
  ctx.font = `400 24px ${FONT_SANS}`;
  ctx.textAlign = 'right';
  ctx.fillText(data.generatedOn, CARD_W - PAD, CARD_H - PAD + 16);
  ctx.textAlign = 'left';
}

interface ProofCardProps {
  apiBase: string;
  /** 报告画像 id（share_clicked 漏斗事件上下文） */
  profileId: string;
  login: string;
  platform: string;
  authLabel: string;
  /** 页面既有徽章类（ja-badge--likely 等），预览卡与取色锚点共用 */
  authClass: string;
  confidenceLabel: string;
  tags: string[];
  verifyLine: string;
  generatedOn: string;
  domain: string;
  brandName: string;
  downloadLabel: string;
  downloadingLabel: string;
  downloadFailedLabel: string;
}

export default function ProofCard(props: ProofCardProps) {
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleDownload = useCallback(() => {
    const data: ProofCardData = {
      login: props.login,
      platform: props.platform,
      authLabel: props.authLabel,
      confidenceLabel: props.confidenceLabel,
      tags: props.tags,
      verifyLine: props.verifyLine,
      generatedOn: props.generatedOn,
      domain: props.domain,
      brandName: props.brandName,
    };
    const canvas = document.createElement('canvas');
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setFailed(true);
      return;
    }
    drawProofCard(ctx, data, readProofCardColors(badgeRef.current));
    setBusy(true);
    setFailed(false);
    canvas.toBlob((blob) => {
      setBusy(false);
      if (!blob) {
        setFailed(true);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jobagent-proof-${props.login}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 漏斗：share_clicked（fire-and-forget；失败静默）。credentials:'include'
      // 必带——端点从 cookie 读 ja_sid 串联会话（credentials-guard 守护）。
      fetch(`${props.apiBase}/funnel/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ event: 'share_clicked', profileId: props.profileId }),
        keepalive: true,
      }).catch(() => {});
    }, 'image/png');
  }, [props]);

  return (
    <section className="proof-card" data-testid="proof-card">
      <div className="proof-card__preview" aria-hidden="true">
        <div className="proof-card__brandrow">
          <strong className="proof-card__brand">{props.brandName}</strong>
          <span className="proof-card__domain">{props.domain}</span>
        </div>
        <p className="proof-card__login">{props.login}</p>
        <p className="proof-card__badgerow">
          {/* 取色锚点：预览徽章与页面报告徽章同 class，运行时色值来自这里 */}
          <span ref={badgeRef} className={`ja-badge ${props.authClass} proof-card__badge`}>
            {props.authLabel}
          </span>
          <span className="proof-card__confidence">{props.confidenceLabel}</span>
        </p>
        {props.tags.length > 0 && (
          <p className="proof-card__tags">
            {props.tags.slice(0, MAX_TAGS).map((tag) => (
              <span key={tag} className="proof-card__tag">
                {tag}
              </span>
            ))}
          </p>
        )}
        <p className="proof-card__footer">
          <span className="proof-card__verify">{props.verifyLine}</span>
          <span className="proof-card__generated">{props.generatedOn}</span>
        </p>
      </div>
      <button
        type="button"
        className="ja-btn ja-btn--ghost proof-card__download"
        onClick={handleDownload}
        disabled={busy}
      >
        {busy ? props.downloadingLabel : failed ? props.downloadFailedLabel : props.downloadLabel}
      </button>
    </section>
  );
}
