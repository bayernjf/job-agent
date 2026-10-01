/**
 * stdio MCP server 入口（v0 只做 stdio，不做远程 HTTP/SSE；见设计 §6 非目标）。
 *
 * 用法（在支持 MCP 的 agent / IDE 里配置）：
 *   MCP_API_KEY=xxx node apps/mcp/dist/server.js
 * 未配置 MCP_API_KEY 时 server 仍启动，但画像类工具 fail-closed（仅 search_jobs 可用）。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server-factory.js';

async function main(): Promise<void> {
  const { server } = await createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // 生产缺 key 的启动闸等错误直接退出，不静默降级。
  console.error(`[mcp] failed to start: ${(err as Error).message}`);
  process.exit(1);
});
