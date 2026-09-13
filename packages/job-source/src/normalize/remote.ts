/**
 * 是否远程岗位的推断：
 * 1. 显式布尔（适配器已根据 workplaceType 等确定）优先；
 * 2. 否则在标题/地点/类型文本里匹配 remote / anywhere / worldwide。
 */

const REMOTE_PATTERN = /\bremote\b|\banywhere\b|worldwide|work\s+from\s+(?:home|anywhere)|远程/i;

/** Lever workplaceType 等显式枚举 → 布尔；hybrid/onsite 视为非全远程。 */
export function workplaceTypeToRemote(type: unknown): boolean | undefined {
  if (typeof type !== 'string') return undefined;
  const t = type.trim().toLowerCase();
  if (t === 'remote') return true;
  if (t === 'onsite' || t === 'hybrid' || t === 'on-site') return false;
  return undefined;
}

export function inferRemote(explicit: boolean | undefined, ...texts: Array<unknown>): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return texts.some((t) => typeof t === 'string' && REMOTE_PATTERN.test(t));
}
