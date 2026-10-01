/**
 * @jobagent/mcp 对外导出：供测试/嵌入复用，禁止 import @jobagent/storage
 * （模块图由 no-storage-import.test.ts 守护）。
 */
export { createMcpServer, type CreateMcpOptions } from './server-factory.js';
export {
  loadMcpConfig,
  hashIp,
  isApiKeyValid,
  MCP_ERROR_CODES,
  type McpConfig,
} from './config.js';
export { FixedWindowRateLimiter } from './rate-limiter.js';
export {
  getProfile,
  lookupProfileBySubject,
  searchJobs,
  matchProfileToJob,
  McpToolError,
} from './tools.js';
