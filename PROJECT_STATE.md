# Friberg Assistant 项目状态

最后更新：2026-07-31
当前基准提交：`e7bf841`（0.9.3 Personal，ChatGPT + GitHub 开发基线已合并）
默认分支：`main`
当前清理分支：`chore/repository-hygiene`

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
- `dist/friberg-assistant-commercial/`：离线 Ed25519 授权候选版；
- GitHub Actions：语法、题库、回归、扩展契约、商业契约、安全扫描和个人版打包；
- `PROJECT_STATE.md` / `AGENTS.md`：跨对话持续交接与开发约束。

## 已确认的真实页面问题

### Issue #4：BO3 跨小局随机首猜未可靠重置

用户实测：第一小局不使用时，第二小局可以使用；第二小局使用后，第三小局不再开放。初步判断是旧棋盘仍留在 DOM 中但已隐藏，插件只检查 `document.contains(activeBoard)`，没有确认它仍是当前可见的自己的棋盘。

### Issue #5：匹配成功通知与受控准备辅助

优先实现浏览器/Windows 桌面通知。自动准备必须默认关闭，只允许用户为当前匹配显式武装，并且只点击一次唯一可确认的准备按钮。完整自动猜测与提交保持独立任务。

## 当前需要现场验证

1. Issue #4 修复后的 BO3 三小局连续重置；
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

打包脚本会把这些文件复制进 `extension/`，再构建到 `dist/`。因此：

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

1. 完成 Issue #3 仓库清理；
2. 修复 Issue #4 BO3 跨小局重置；
3. 实现 Issue #5 第一阶段匹配成功通知；
4. 继续验证 CD 排队提交和真实网页 DOM；
5. 再评估受控自动准备与更高自动化模式。

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
