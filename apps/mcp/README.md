# @jobagent/mcp — JobAgent MCP 接入面（stdio）

只读的 [Model Context Protocol](https://modelcontextprotocol.io/) server，让别的 agent / IDE / CLI 通过标准 MCP 读取 JobAgent 的**公开画像投影**与**岗位池**。

决策 #19（2026-10-01 拍板并落地）。设计与边界见 [../../docs/design-mcp-surface-20260928.md](../../docs/design-mcp-surface-20260928.md)。

## 三条硬边界

1. **薄壳，不直读数据库**：进程内复用 `@jobagent/api` 的 `createApp()` 自调，绝不 import `@jobagent/storage`（有模块图测试守护）。
2. **服务账号不是人**：给了密钥也只返回 `exportable` 投影——**不含证据外链、信号 detail、面试题、interview-kit**；这些只有人在登录后的网页报告里看得到。
3. **只读，绝不触发分析**：不暴露 `/analyze`、`/resumes/build`、任何写操作；不扣 demo 配额、不占 Worker 并发。

## 四个工具

| 工具 | 需要 key | 映射端点 | 说明 |
| --- | --- | --- | --- |
| `search_jobs` | 否（仍限流） | `GET /job-postings` | 检索岗位池（keyword/remote/sources/company/salary/分页） |
| `get_profile` | 是 | `GET /profiles/:id/exportable` | 画像投影：主体、headline、技能+置信度、真实性、analyzerVersion |
| `lookup_profile_by_subject` | 是 | `GET /profiles/by-subject/:platform/:login` | 按 github/gitee 登录名解析最新 complete/partial 画像 id |
| `match_profile_to_job` | 是 | `GET /profiles/:id/job-recommendations` | 画像技能↔岗位匹配分、逐技能命中理由、字段分解（不生成简历） |

## 配置（服务端环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MCP_API_KEY` | 空 | 服务到服务密钥。**fail-closed**：未配置时三个画像类工具返回 `MCP_KEY_REQUIRED`，仅 `search_jobs` 可用；`NODE_ENV=production` 下缺 key **启动即失败**。生成：`openssl rand -hex 32` |
| `MCP_RATE_WINDOW_MS` | `60000` | 固定限流窗口毫秒 |
| `MCP_RATE_LIMIT_PER_WINDOW` | `60` | 每窗口每 key+IP 最大请求数；画像桶与岗位桶分开计 |
| `DEMO_IP_SALT` | 进程内随机 | 源 IP 加盐哈希用盐（stdio 本地通常无 IP，按 key 单桶限流） |

另沿用 API 的 `DB_DRIVER`/`DB_PATH`/`DATABASE_URL` 等（见根 [.env.example](../../.env.example) 与 [../../docs/API.md](../../docs/API.md)）。

## 在 MCP 客户端里配置

先构建：`pnpm --filter @jobagent/mcp build`（或全仓 `pnpm -r build`）。

stdio 启动命令（在仓库根）：

```bash
MCP_API_KEY=openssl-hex-key DB_PATH=data/job-agent.db node apps/mcp/dist/server.js
```

客户端 JSON 配置示例：

```json
{
  "mcpServers": {
    "jobagent": {
      "command": "node",
      "args": ["/绝对路径/job-agent/apps/mcp/dist/server.js"],
      "env": {
        "MCP_API_KEY": "你的-openssl-rand-hex-32-密钥",
        "DB_PATH": "/绝对路径/job-agent/data/job-agent.db"
      }
    }
  }
}
```

调用画像类工具时在 arguments 里带同一个 key：

```jsonc
{ "name": "get_profile", "arguments": { "profileId": "<id>", "apiKey": "<MCP_API_KEY>" } }
```

`search_jobs` 不需要 key。

## 错误码

- `MCP_KEY_REQUIRED`（HTTP 401）：未配 key / key 错 / 未传 key。
- `MCP_RATE_LIMITED`（429）：超出固定窗口限额。
- `PROFILE_NOT_FOUND`（404）：画像 id 或主体不存在。
- `INVALID_SUBJECT`（400）：platform/login 非法。

## 开发与验证

```bash
pnpm --filter @jobagent/mcp test       # 24 个：契约 / fail-closed / 负向可见性 / 限流 / 模块图
pnpm --filter @jobagent/mcp typecheck
pnpm --filter @jobagent/mcp build
```

v0 只做 **stdio**；远程 HTTP/SSE transport、证据外链、B 端检索面、简历/分析触发均为明确非目标，见设计文档 §6。
