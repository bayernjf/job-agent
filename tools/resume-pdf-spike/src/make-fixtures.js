/**
 * 生成 5 份中英混排「合成简历」PDF（fixtures/*.pdf）+ 源标注（fixtures/sources.json）。
 *
 * 目的：为 PDF 文本抽取 spike 提供布局/语言变体样本（真实简历待用户提供后再做达标测量）。
 * 变体覆盖：
 *   1. zh-major   中文为主、英文点缀（国内公司中文简历）
 *   2. mixed-half 中英各半（外企中文简历，含项目经历双语）
 *   3. en-major   英文为主、中文点缀（英文简历 + 中文姓名/技能）
 *   4. two-column 双栏布局（左：联系方式+技能；右：经历）
 *   5. table     含结构化表格（教育经历表 / 技能矩阵）
 *
 * 重要：本脚本只产出「样本 PDF + 源文本标注」，是 spike 的输入侧；样本本身是合成的，
 * 不含任何真实个人信息。抽取管线（extract.js）的「原文不留存」守卫由输出侧强制。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURES = join(ROOT, 'fixtures');
const FONT_PATH = join(ROOT, 'fonts', 'NotoSansSC-Regular.ttf');

const cjk = rgb(0.1, 0.1, 0.1);
const gray = rgb(0.4, 0.4, 0.4);
const blue = rgb(0.1, 0.3, 0.6);

/** 一份样本的定义：文件名、变体、源文本（结构化）。 */
const SAMPLES = [
  {
    id: 'zh-major',
    title: '软件工程师中文简历',
    blocks: [
      { kind: 'header', lines: ['张三', '高级软件工程师 | 全栈方向', '电话：138-0000-1234 ｜ 邮箱：zhangsan@example.com ｜ 北京'] },
      { kind: 'section', title: '个人简介' },
      { kind: 'para', text: '8 年全栈开发经验，专注于分布式系统与 AI 应用落地。曾主导多个日活百万级系统的架构升级，擅长把复杂业务拆解为可交付的技术方案。' },
      { kind: 'section', title: '工作经历' },
      { kind: 'para', text: '2021-2026 ｜ 某互联网公司 ｜ 技术专家。负责推荐系统中台建设，将线上召回链路延迟降低 45%；带领 6 人团队完成 Go 微服务迁移。' },
      { kind: 'para', text: '2016-2021 ｜ 某创业公司 ｜ 全栈工程师。独立交付 React + Node.js 的 SaaS 产品，服务 200+ 企业客户，累计营收 3000 万元。' },
      { kind: 'section', title: '技能' },
      { kind: 'para', text: 'Go / TypeScript / React / PostgreSQL / Kubernetes / 机器学习基础' },
      { kind: 'section', title: '教育背景' },
      { kind: 'para', text: '2012-2016 ｜ 北京某大学 ｜ 计算机科学与技术 ｜ 本科' },
    ],
    expectFields: { name: '张三', email: 'zhangsan@example.com', phone: '138-0000-1234' },
  },
  {
    id: 'mixed-half',
    title: 'Product Manager Resume (中英双语)',
    blocks: [
      { kind: 'header', lines: ['李娜 / Li Na', 'Product Manager · B2B SaaS', '+86 139-0000-5678 · lina@example.com · Shanghai'] },
      { kind: 'section', title: 'Summary / 个人总结' },
      { kind: 'para', text: '5 years of B2B product management with a focus on data-driven growth. 擅长从用户调研到商业化的完整闭环，主导过 3 款从 0 到 1 的产品。' },
      { kind: 'section', title: 'Experience / 工作经历' },
      { kind: 'para', text: '2022–2026 ｜ GlobalTech ｜ Senior PM. Owned the analytics product line; grew ARR from $1M to $4M. 推动企业级权限体系上线，支撑 50+ 客户私有化部署。' },
      { kind: 'para', text: '2019–2022 ｜ 某科技公司 ｜ Product Manager. Launched a customer-service chatbot serving 300k users. 把客服人工介入率从 35% 降到 12%。' },
      { kind: 'section', title: 'Skills / 技能' },
      { kind: 'para', text: 'Product Strategy / SQL / A/B Testing / 用户研究 / Figma / 数据分析' },
      { kind: 'section', title: 'Education / 教育背景' },
      { kind: 'para', text: '2015–2019 ｜ 复旦大学 ｜ 信息管理与信息系统 ｜ 本科' },
    ],
    expectFields: { name: '李娜', email: 'lina@example.com', phone: '+86 139-0000-5678' },
  },
  {
    id: 'en-major',
    title: 'Senior Backend Engineer Resume',
    blocks: [
      { kind: 'header', lines: ['Wang Wei (王伟)', 'Senior Backend Engineer', 'wangwei.dev@example.com ｜ +1 (555) 010-2020 ｜ Remote'] },
      { kind: 'section', title: 'Professional Summary' },
      { kind: 'para', text: 'Senior backend engineer with 9 years of experience in high-throughput services and infrastructure. Proficient in Go, Rust and cloud-native stack (Kubernetes, Envoy).' },
      { kind: 'section', title: 'Experience' },
      { kind: 'para', text: '2019–Present ｜ DataStream Inc. ｜ Staff Engineer. Designed the ingestion pipeline processing 2B events/day; reduced infra cost by 30% via tiered storage. 中文团队协作经验丰富，多次承担跨时区技术评审。' },
      { kind: 'para', text: '2015–2019 ｜ CloudWorks ｜ Backend Engineer. Built multi-tenant billing system handling $50M annual revenue.' },
      { kind: 'section', title: 'Skills' },
      { kind: 'para', text: 'Go / Rust / Kubernetes / PostgreSQL / Kafka / 分布式系统设计' },
      { kind: 'section', title: 'Education' },
      { kind: 'para', text: '2011–2015 ｜ Zhejiang University ｜ Computer Science ｜ B.S.' },
    ],
    expectFields: { name: '王伟', email: 'wangwei.dev@example.com', phone: '+1 (555) 010-2020' },
  },
  {
    id: 'two-column',
    title: '前端工程师双栏简历',
    blocks: [
      { kind: 'two-col', leftTitle: '联系方式 / Contact', left: ['陈杰 · chenjie@example.com', 'Tel: 021-5555-8899', 'GitHub: github.com/chenjie', '上海'], rightTitle: '项目经历 / Projects', right: ['低代码平台 ｜ 2024-2026 ｜ 前端负责人：设计组件协议，沉淀 120+ 业务组件，平台月活 4 万。', '可视化编排引擎 ｜ 2022-2024 ｜ 核心开发：基于 React Flow 实现 DAG 编排，支撑 300+ 自动化场景。'] },
      { kind: 'section', title: '工作经历' },
      { kind: 'para', text: '2020-2026 ｜ 某 SaaS 公司 ｜ 高级前端工程师。主导前端工程化改造，构建时间从 8 分钟降到 90 秒。' },
      { kind: 'section', title: '技能' },
      { kind: 'para', text: 'React / TypeScript / Vite / Node.js / WebGL / 性能优化' },
      { kind: 'section', title: '教育背景' },
      { kind: 'para', text: '2016-2020 ｜ 上海某大学 ｜ 软件工程 ｜ 本科' },
    ],
    expectFields: { name: '陈杰', email: 'chenjie@example.com', phone: '021-5555-8899' },
  },
  {
    id: 'table',
    title: '数据分析师简历（含表格）',
    blocks: [
      { kind: 'header', lines: ['赵敏', '数据分析师 · 增长方向', 'zhaomin@example.com · 135-0000-7788 · 深圳'] },
      { kind: 'section', title: '核心技能' },
      { kind: 'table', headers: ['技能', '熟练度', '最近使用'], rows: [['SQL / Python', '熟练', '2026'], ['Tableau / Power BI', '熟练', '2026'], ['A/B 测试', '精通', '2025'], ['Spark / Hive', '进阶', '2024']] },
      { kind: 'section', title: '项目经历' },
      { kind: 'para', text: '增长实验平台 ｜ 2024-2026 ｜ 搭建实验看板，累计支撑 800+ 次 A/B 实验，推动 GMV 提升 12%。' },
      { kind: 'para', text: '用户分层模型 ｜ 2023-2024 ｜ 基于 RFM + 行为序列构建分层，提升触达转化率 18%。' },
      { kind: 'section', title: '教育背景' },
      { kind: 'table', headers: ['时间', '学校', '专业', '学位'], rows: [['2015-2019', '中山大学', '统计学', '本科']] },
    ],
    expectFields: { name: '赵敏', email: 'zhaomin@example.com', phone: '135-0000-7788' },
  },
];

function ensureFont() {
  if (!existsSync(FONT_PATH)) {
    throw new Error(
      `中文字体缺失：${FONT_PATH}\n请先下载 Noto Sans SC（约 16MB）到 fonts/：\n` +
        '  curl -L -o fonts/NotoSansSC-Regular.ttf "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"',
    );
  }
  return readFileSync(FONT_PATH);
}

function drawHeader(page, font, lines) {
  let y = 790;
  const size = lines.length > 1 ? 15 : 20;
  for (const [i, line] of lines.entries()) {
    page.drawText(line, { x: 50, y, size: i === 0 ? size + 4 : size - 4, font, color: i === 0 ? cjk : gray });
    y -= 24;
  }
  return y - 10;
}

function drawSection(page, font, title) {
  page.drawText(title, { x: 50, y: 700, size: 13, font, color: blue });
  page.drawLine({ start: { x: 50, y: 692 }, end: { x: 545, y: 692 }, thickness: 0.8, color: blue });
  return 682;
}

function drawPara(page, font, text) {
  page.drawText(text, { x: 50, y: 660, size: 10.5, font, color: cjk });
  return 642;
}

function drawTable(page, font, headers, rows) {
  let y = 660;
  const colW = 130;
  page.drawText(headers.join('  |  '), { x: 50, y, size: 10, font, color: blue });
  y -= 16;
  for (const row of rows) {
    page.drawText(row.join('  |  '), { x: 50, y, size: 10, font, color: cjk });
    y -= 16;
  }
  return y - 6;
}

async function buildPdf(sample) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit); // 实例方法：嵌入自定义字体（中文）前必须注册
  const fontBytes = ensureFont();
  const cjkFont = await doc.embedFont(fontBytes);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]); // A4

  let y = 790;
  for (const block of sample.blocks) {
    if (block.kind === 'header') {
      y = drawHeader(page, cjkFont, block.lines);
    } else if (block.kind === 'section') {
      y = drawSection(page, cjkFont, block.title);
    } else if (block.kind === 'para') {
      y = drawPara(page, cjkFont, block.text);
    } else if (block.kind === 'two-col') {
      // 双栏：左栏联系方式 + 右栏项目经历（页面分栏）
      let ly = 660;
      page.drawText(block.leftTitle, { x: 50, y: ly, size: 12, font: cjkFont, color: blue });
      ly -= 18;
      for (const line of block.left) {
        page.drawText(line, { x: 50, y: ly, size: 10, font: cjkFont, color: cjk });
        ly -= 16;
      }
      let ry = 660;
      page.drawText(block.rightTitle, { x: 320, y: ry, size: 12, font: cjkFont, color: blue });
      ry -= 18;
      for (const line of block.right) {
        // 右侧文本较长，简单两行换行
        const split = line.length > 26 ? [line.slice(0, 26), line.slice(26)] : [line];
        for (const part of split) {
          page.drawText(part, { x: 320, y: ry, size: 10, font: cjkFont, color: cjk });
          ry -= 15;
        }
      }
      y = Math.min(ly, ry) - 10;
    } else if (block.kind === 'table') {
      y = drawTable(page, cjkFont, block.headers, block.rows);
    }
  }

  const bytes = await doc.save();
  const out = join(FIXTURES, `${sample.id}.pdf`);
  writeFileSync(out, bytes);
  return out;
}

async function main() {
  if (!existsSync(FIXTURES)) mkdirSync(FIXTURES, { recursive: true });
  const sources = [];
  for (const sample of SAMPLES) {
    const out = await buildPdf(sample);
    sources.push({
      id: sample.id,
      title: sample.title,
      expectFields: sample.expectFields,
      // 源文本 = 样本里所有 para/header/two-col/table 行（不含 section 标题），用于抽净率对账
      sourceLines: sample.blocks.flatMap((b) => {
        if (b.kind === 'para') return [b.text];
        if (b.kind === 'header') return b.lines;
        if (b.kind === 'two-col') return [...b.left, ...b.right];
        if (b.kind === 'table') return [...b.rows.map((r) => r.join(' '))];
        return [];
      }),
    });
    console.log(`  ✓ ${sample.id}.pdf  (${sample.title})`);
  }
  writeFileSync(join(FIXTURES, 'sources.json'), JSON.stringify(sources, null, 2));
  console.log(`sources.json 已写出（${sources.length} 份源标注，供抽净率对账）`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
