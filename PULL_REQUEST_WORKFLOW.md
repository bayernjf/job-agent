# Pull Request、分支同步与发布流程

本文档是 JobAgent 从工作分支进入 `dev`、再进入 `main` 的强制交付流程。用户要求提交、合并、创建 PR 或发布时，coding agent 必须执行本文档，不得跳过检查、用本地合并代替真实 GitHub PR，或在检查失败时进入下一阶段。

> 当前状态（2026-09-10）：仓库尚未配置 GitHub Actions，也没有 Release 自动化。CI/Release 建立前，下文"Actions 成功"暂以**本地三件套 `pnpm -r typecheck` + `pnpm -r build` + `pnpm -r test`（及迁移校验）通过**替代；待 `.github/workflows/ci.yml` 落地后恢复以 PR Actions 全绿为准（CI 另含依赖审计与 gitleaks 密钥扫描）。

## 长期分支

长期只保留以下项目分支：

- `dev`：日常开发集成分支
- `main`：稳定版本分支

功能开发使用临时的 `feature/*`、`fix/*`、`chore/*`，在合并成功且合并后检查通过后删除本地与远端临时分支。不删除非本流程创建的历史分支；如遇到，在最终报告中列出并请用户决定。

## 通用规则

### GitHub 内容必须使用英文

所有写入 GitHub 的内容必须用英文：Issue/PR 标题与描述、comments、reviews、commit/merge/tag message、Release 内容、Actions 的 workflow/job/step/artifact 名称。项目内中文文档与面向用户的中文汇报不受限。

### 每次操作分支前必须同步

```bash
git fetch origin
git checkout <branch>
git pull --rebase origin <branch>
```

- 工作区不干净时，先分析并保护现有修改，不得丢弃用户改动。
- fetch/pull/rebase/merge 出现冲突立即停止并列出冲突文件，不自动解决。
- 不对已发布的共享分支（`dev`/`main`）force push。
- 每次 push 前再次确认远端没有新增提交。
- 本机 git 全局代理（127.0.0.1:7897）未开启时，联网命令可临时加 `-c http.proxy= -c https.proxy=` 直连，**不修改全局配置**。

### 每个合并关卡的成功定义

同时满足才算该关卡完成：

1. 本地验证通过（`pnpm -r typecheck`、`pnpm -r build`、相关测试、`bash tools/check-migrations.sh`、`git diff --check`）。
2. 真实 GitHub PR 已创建。
3. PR 上所有必需检查成功（CI 建立前 = 本地验证；建立后 = Actions 全绿）。
4. PR 已在 GitHub 合并。
5. 合并后目标分支的检查（CI 建立后含 CI/Release）成功。
6. 本阶段创建的临时分支已在本地和远端删除。

任一检查失败，都要读取失败原因、修复、重新验证并重跑成功；成功前不进入下一关卡。

## 阶段一：整理工作分支

1. fetch 并 pull 最新 `dev`，从最新 `dev` 切出/更新 `feature/*`。
2. 检查完整工作区 diff，确认无误包含秘密文件或无关改动。
3. 执行：

   ```bash
   pnpm -r typecheck
   pnpm -r build
   pnpm -r test
   bash tools/check-migrations.sh
   git diff --check
   ```

   （脚手架未就绪前，以当前可运行的等价检查替代，并在汇报中说明。）
4. 按 `git-commit-message.md` 做原子提交。
5. push 当前工作分支。

## 阶段二：工作分支合并到 dev

1. 创建真实 GitHub PR：`feature/* → dev`。
2. 等待 PR 检查全部成功；失败时基于最新 `dev` 修复并 push，循环到成功。
3. 检查通过后在 GitHub 合并 PR。
4. 等待合并后 `dev` 的检查成功（CI 建立后含 CI 与 dev 预览发布）。
5. `dev` 全部成功前，不得创建 `dev → main` PR。
6. 不要仅因 merge commit 把 `dev` 反向同步回工作分支。

## 阶段三：dev 合并到 main

1. fetch/pull 最新 `dev` 与 `main`，确认 `dev` 包含所有已验证改动。
2. 创建真实 GitHub PR：`dev → main`。
3. 等待检查全部成功；失败修复必须先经过 `dev` 验证。
4. 通过后在 GitHub 合并。
5. 等待合并后 `main` 检查成功（Release 自动化建立后含版本递增、构建与 GitHub Release）。
6. `main` 出问题时：基于最新 `main` 切 `fix/*`，修复重新经过 `dev` 与 `main` 的真实 PR 流程，成功后删除临时分支。

## 阶段四：仅在 main 存在独立改动时回同步

正常 `dev → main` 合并后，`dev` 已是 `main` 的祖先，**不要**为 merge commit 再建 `main → dev` PR（会制造无差异提交）。仅当 `main` 收到未经 `dev` 的独立改动（如紧急 hotfix）时才执行 `main → dev`：

1. fetch/pull 最新 `main`、`dev`，确认 `main` 确有 `dev` 没有的改动。
2. 创建真实 `main → dev` PR，不直接 force push 共享分支。
3. 等待检查成功并合并；冲突时停止请用户处理。

## 临时分支清理

临时分支只在其 PR 已合并、目标分支检查成功后删除：

```bash
git push origin --delete feature/<name>
git branch -d feature/<name>
```

删除前确认：PR 已 merged、提交已包含在目标分支、合并后检查成功、当前不在待删分支上。

## 最终审计与汇报

流程结束后检查并汇报：

- 本地与远端分支列表；`dev`、`main` 的 commit 与 ahead/behind；
- 相关 PR 链接与合并结果；各阶段检查/Actions 链接（CI 建立后）；
- 原子 commits 及用途；发布版本号（Release 建立后）；
- 失败与修复记录；临时分支是否清理；工作区是否干净。
