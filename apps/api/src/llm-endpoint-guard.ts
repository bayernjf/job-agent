import { isIP } from 'node:net';

/**
 * BYOK `baseUrl` 的 SSRF 守卫（审查 P0-3 / 决策 #26）。
 *
 * 只封**云元数据服务与 link-local 地址**；localhost 与 RFC1918 私网**刻意放行**——
 * 自建 LLM 网关（Ollama / LM Studio / vLLM）通常就落在 loopback 或内网，封私网等于
 * 把 BYOK 的主要用例砍掉（见 packages/llm 的 OpenAICompatibleConfig.baseUrl 文档）。
 *
 * 检查在三个入口执行：保存配置、测试连接、以及每次 BYOK 实际调用前的解析。
 * 已知残余风险：攻击者可用自有域名解析到元数据 IP（DNS rebinding），本函数不解析 DNS，
 * 因为把网络查询塞进单测会破坏「不打真实网络」的确定性；真正封死需要在建立连接时
 * 校验目标 IP（或固定解析结果），留作后续硬化项。
 */

export type LlmEndpointBlockReason =
  | 'unsupported_scheme'
  | 'metadata'
  | 'link_local';

export type LlmEndpointVerdict =
  | { ok: true }
  | { ok: false; reason: LlmEndpointBlockReason };

/** 已知云厂商元数据主机名（100.100.100.200 等 IP 也各自在上面/下面覆盖）。 */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata.tencentyun.com',
  'instance-data',
  'instance-data.ec2.internal',
]);

/** 元数据服务常用地址（AWS/GCP/Azure/OpenStack 169.254.169.254；阿里云 100.100.100.200；AWS IPv6）。 */
const METADATA_ADDRESSES = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function stripBrackets(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/**
 * 把一个 IP 字面量归类。返回 null 表示放行（含 loopback / 私网 / 公网）。
 * IPv4-mapped IPv6 先还原成点分 IPv4，避免 `::ffff:169.254.169.254` 绕过。
 */
export function classifyLlmEndpointAddress(address: string): 'metadata' | 'link_local' | null {
  let ip = stripBrackets(address);

  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mappedDotted?.[1]) {
    ip = mappedDotted[1];
  } else {
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (mappedHex?.[1] && mappedHex[2]) {
      const hi = Number.parseInt(mappedHex[1], 16);
      const lo = Number.parseInt(mappedHex[2], 16);
      ip = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
  }

  if (METADATA_ADDRESSES.has(ip)) return 'metadata';
  // IPv4 link-local 169.254.0.0/16
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(ip)) return 'link_local';
  // IPv6 link-local fe80::/10（fe80–febf）
  if (/^fe[89ab][0-9a-f]{0,2}:/.test(ip)) return 'link_local';
  return null;
}

/** 校验用户提供的 LLM baseUrl 是否允许服务端发起请求。 */
export function checkLlmEndpoint(rawUrl: string): LlmEndpointVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  const host = stripBrackets(url.hostname);
  if (METADATA_HOSTNAMES.has(host)) return { ok: false, reason: 'metadata' };
  if (isIP(host) !== 0) {
    const blocked = classifyLlmEndpointAddress(host);
    if (blocked) return { ok: false, reason: blocked };
  }
  return { ok: true };
}
