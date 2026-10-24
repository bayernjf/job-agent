/**
 * 简历语言契约（从 index.ts 拆出）：compose 层与简历装配共用。
 */
import { z } from 'zod';

/** 简历支持的语言（P-R1 用户手选，默认 zh-CN；技能名等事实保持画像原文不翻译） */
export const ResumeLocaleSchema = z.enum(['zh-CN', 'en']);
export type ResumeLocale = z.infer<typeof ResumeLocaleSchema>;
