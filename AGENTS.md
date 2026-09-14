# AGENTS.md

本文件适用于 ChatGPT、Codex、Copilot 及其他自动化开发助手。

## 开始工作前

1. 阅读 `PROJECT_STATE.md`；
2. 阅读与任务相关的 Issue；
3. 确认当前分支不是 `main`；
4. 检查工作范围是否触及受保护文件；
5. 先复现，再修改。

## 强制规则

- 不得直接在 `main` 上修改；
- 一次只处理一个独立问题；
- 不得无理由重写整个模块；
- 不得把本地镜像成功当作真实网页成功；
- 未经用户明确批准，不得修改 646 人严格求解器和题库；
- 不得将私钥、卡密、Token、`.env`、Cookie、房间密码或用户身份数据提交到仓库；
- 不得提交 `.codex/`、`.playwright-mcp/`、`__pycache__/`、临时日志或浏览器运行时快照；
- 不得在生成物目录中手改后忘记同步源码；
- 不得声称已实测未实际运行的流程。

## 受保护范围

默认只读：

- `solver.js`
- `extension/solver.js`
- `data/players.game-646.json`
- `extension/data/game-players-646.json`
- `tests/run-full-pool-contract-audit.*`

修改这些文件必须使用独立 Issue/分支，并运行全量契约审计。

## 修改要求

每个修复至少包含：

1. 问题描述；
2. 根因；
3. 最小代码修改；
4. 回归测试；
5. 用户现场验证步骤；
6. 已验证与未验证边界。

## Git 约定

分支示例：

- `fix/round-reset`
- `fix/cd-submit-once`
- `fix/live-dom-feedback`
- `feature/offline-license`
- `chore/repository-hygiene`

提交信息示例：

- `fix: reset state when guess counter returns to zero`
- `test: cover queued submit after page cooldown`
- `chore: remove runtime snapshots from repository`

## PR 验收

PR 不应合并，除非：

- CI 通过；
- 无敏感信息；
- 没有无关重构；
- 受保护文件未被意外修改；
- 真实页面相关改动附有人工验证结果；
- `PROJECT_STATE.md` 或 `CHANGELOG.md` 已在必要时更新。
