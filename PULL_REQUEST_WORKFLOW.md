# Pull Request、分支同步与发布流程

本文档是 JobAgent 从 `dev` 进入 `main` 的强制交付流程。用户要求提交、合并、创建 PR 或发布时，coding agent 必须执行本文档，不得跳过检查、用本地合并代替真实 GitHub PR，或在检查失败时进入下一阶段。

> 分支策略（2026-09-10 更新，单人开发）：**日常改动直接在 `dev` 上提交并 push**，不再强制"每件事一个临时分支 + PR"；**`main` 仍然只能经真实 PR 合入，永不直接提交**。临时分支降级为可选项（需要独立 review、长生命周期或实验性改动时才开）。
> 当前状态（2026-09-10）：仓库已配置 GitHub Actions（`.github/workflows/ci.yml`：typecheck/build/test + 依赖审计 + gitleaks），尚无 Release 自动化。故下文"检查成功"= push/PR 上的 Actions 全绿；**push 前仍先跑本地三件套**，不要把明显失败推上去等 CI。

## 长期分支

- `dev`：日常开发集成分支，**日常改动直接在此提交并 push**（`main` 之外的默认作业面）。
- `main`：稳定版本分支，**只能经 `dev → main` 的真实 PR 合入**，禁止直接提交。

日常开发默认在 `dev` 上进行；确需临时分支时用 `feature/*`、`fix/*`、`chore/*`，在合并成功且合并后检查通过后删除本地与远端临时分支。不删除非本流程创建的历史分支；如遇到，在最终报告中列出并请用户决定。

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

### 每个关卡的成功定义

同时满足才算该关卡完成：

1. 本地验证通过（`pnpm -r typecheck`、`pnpm -r build`、相关测试、`bash tools/check-migrations.sh`、`git diff --check`）。
2. 提交已 push 到目标分支，且该分支 Actions 全绿。
3. 需要 PR 的关卡：真实 GitHub PR 已创建、检查全绿、已在 GitHub 合并。
4. 合并后目标分支的检查成功。
5. 本阶段创建的临时分支已在本地和远端删除（未走临时分支则跳过）。

任一检查失败，都要读取失败原因、修复、重新验证并重跑成功；成功前不进入下一关卡。

## 阶段一：在 dev 上作业并推送

1. `git fetch origin` 后在 `dev` 上 `git pull --rebase origin dev`，确认起点是最新 `dev`。
2. 检查完整工作区 diff，确认无误包含秘密文件或无关改动。
3. 执行：

   ```bash
   pnpm -r typecheck
   pnpm -r build
   pnpm -r test
   bash tools/check-migrations.sh
   git diff --check
   ```

4. 按 `git-commit-message.md` 做原子提交。
5. push `dev`，等待 `dev` 的 Actions 全绿；失败则在 `dev` 上修复后重新 push，循环到成功。
6. `dev` 全部成功前，不得创建 `dev → main` PR。

### 可选：走临时分支

需要独立 review / 长生命周期 / 实验性改动时，从最新 `dev` 切 `feature/*`，完成后创建 `feature/* → dev` 真实 PR、等检查全绿、在 GitHub 合并，再删除本地与远端临时分支（**squash 合并后本地删分支需 `git branch -D`**，因为提交未成为 `dev` 的祖先）。

## 阶段二：dev 合并到 main

1. fetch/pull 最新 `dev` 与 `main`，确认 `dev` 的检查已成功且包含所有已验证改动。
2. 创建真实 GitHub PR：`dev → main`。
3. 等待检查全部成功；失败修复必须先经过 `dev` 验证。
4. 通过后在 GitHub 合并。
5. 等待合并后 `main` 检查成功（Release 自动化建立后含版本递增、构建与 GitHub Release）。
6. `main` 出问题时：在 `dev` 上修复并重新走 `dev → main`；确需紧急 hotfix 时基于最新 `main` 切 `fix/*`，修复需同时经过 `dev` 与 `main`，成功后删除临时分支。

> 注意：仓库已接入 `pr-helper-by-bayernjf` 自动化，它会在 `dev` 有新提交后**自动创建并合并 `dev → main` PR**。若希望 `main` 由人工把关，需先停用/调整该 automation。

## 阶段三：仅在 main 存在独立改动时回同步

正常 `dev → main` 合并后，`dev` 已是 `main` 的祖先，**不要**为 merge commit 再建 `main → dev` PR（会制造无差异提交）。仅当 `main` 收到未经 `dev` 的独立改动（如紧急 hotfix）时才执行 `main → dev`：

1. fetch/pull 最新 `main`、`dev`，确认 `main` 确有 `dev` 没有的改动。
2. 创建真实 `main → dev` PR，不直接 force push 共享分支。
3. 等待检查成功并合并；冲突时停止请用户处理。

## 临时分支清理（仅在走了临时分支时执行）

临时分支只在其 PR 已合并、目标分支检查成功后删除：

```bash
git push origin --delete feature/<name>
git branch -d feature/<name>   # squash 合并后用 -D
```

删除前确认：PR 已 merged、提交已包含在目标分支、合并后检查成功、当前不在待删分支上。

## 最终审计与汇报

流程结束后检查并汇报：

- 本地与远端分支列表；`dev`、`main` 的 commit 与 ahead/behind；
- 相关 PR 链接与合并结果；各阶段检查/Actions 链接；
- 原子 commits 及用途；发布版本号（Release 建立后）；
- 失败与修复记录；临时分支是否清理；工作区是否干净。
