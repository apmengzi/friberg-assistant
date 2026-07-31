# Friberg Assistant 项目状态

最后更新：2026-07-31
当前基准提交：`bf226cb`（0.9.3 Personal）
默认分支：`main`
当前开发流程分支：`chore/chat-github-dev-loop`

## 项目目标

维护“弗一把”CS Major 猜选手辅助插件，包括：

- 646 人游戏题库；
- 严格约束求解器；
- 真实网页 DOM 适配器；
- Edge/Chrome 扩展；
- 本地镜像与自动化回归；
- 个人版与离线授权商业候选版。

## 当前确认完成

- `data/players.game-646.json`：646 条游戏题库；
- `solver.js`：严格求解核心；
- `automation-core.js`：候选/探针与自动化核心；
- `live-dom-adapter.js`：真实页面 DOM 适配层；
- `extension/`：0.9.3 浏览器扩展源码；
- `mirror/`：本地测试镜像；
- `tests/run-regression.js`：题库与规则回归；
- `tests/run-full-pool-contract-audit.*`：646×646 全量反馈契约审计；
- `tests/run-automation-simulation.js`：1000 局本地模拟；
- `dist/friberg-assistant-commercial/`：离线 Ed25519 授权候选版。

## 当前需要现场验证

1. 真实网页连续多局时的新局重置；
2. 网页提交 CD 期间的排队与只提交一次；
3. `/multi` 与 `/multi/room` 的长期 DOM 兼容性；
4. Edge 之外的 Chrome 兼容性；
5. 商业候选版在全新浏览器配置中的激活与升级保留。

## 源码与生成物边界

当前打包脚本表明以下根目录文件是核心来源：

- `solver.js`
- `automation-core.js`
- `live-dom-adapter.js`
- `data/players.game-646.json`

`tools/package-personal-extension.ps1` 会把这些文件复制进 `extension/`，再构建到 `dist/`。因此：

- 不应直接把 `dist/` 当作唯一源码；
- 修改核心后必须重新运行契约测试与打包；
- `extension/` 与根目录核心文件必须保持摘要一致。

## 受保护文件

除非用户明确批准独立任务，否则不得修改：

- `solver.js`
- `extension/solver.js`
- `data/players.game-646.json`
- `extension/data/game-players-646.json`
- 任何用于验证 646 人严格规则的 oracle/fixture

若确需修改，必须：

1. 单独 Issue；
2. 单独分支；
3. 说明规则依据；
4. 运行 646×646 全量契约审计；
5. 在 PR 中展示改动前后差异。

## 当前优先级

1. 建立安全、可回滚的 ChatGPT + GitHub 开发流程；
2. 清理仓库中的运行时快照和本地配置；
3. 建立 CI、敏感信息扫描和自动打包；
4. 为跨局重置与 CD 提交建立回归测试；
5. 再进行真实网页修复。

## 标准开发循环

1. 用户提供问题、截图或诊断 JSON；
2. 创建 GitHub Issue；
3. 从 `main` 创建一个独立分支；
4. 一次只处理一个问题；
5. 添加/更新回归测试；
6. 创建 Draft PR；
7. GitHub Actions 通过；
8. 用户在本机 Edge 真实页面验证；
9. 将验证结果写入 PR/Issue；
10. 验证通过后再合并到 `main`。
