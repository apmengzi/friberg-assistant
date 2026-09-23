# 弗一把助手 · Friberg Assistant

> ⚠️ **维护状态：本插件最后维护时间为 2026 年 8 月初，现已不可用于线上环境。**
> 目标站点此后的页面改版与规则变动未再跟进——上游选择器、赛事数据与应答逻辑均已过期。
> 仓库保留作为**工程样本**：约束求解算法、渐进式 DOM 识别、双形态分发与 full-matrix 契约审计方法仍具参考价值，可作为同类项目的实现参考阅读。

> 面向「弗一把」CS Major 猜选手游戏的辅助浏览器插件：646 人职业选手题库 + 严格约束求解器 + Edge/Chrome 扩展 + ScriptCat 用户脚本 + 本地全自动测试镜像。

![version](https://img.shields.io/badge/version-1.1.0-blue) ![platform](https://img.shields.io/badge/platform-Edge%20%7C%20Chrome%20%7C%20ScriptCat-green) ![license](https://img.shields.io/badge/license-MIT-orange)

「弗一把」是一款 Wordle 式的 CS Major 猜选手游戏：每次猜测后，页面对国家/赛区、年龄、Major 冠军数、Major 次数、位置、战队、昵称七个字段给出颜色与箭头反馈。本插件把「人眼看颜色」升级为「机器读结构化反馈 + 严格约束求解」，实时收敛候选池并推荐下一猜，支持从单局辅助到整场 BO3 托管的全谱系自动化。

## 功能特性

- **严格约束求解器**：每次猜测转换为精确逻辑条件（逻辑 AND，非相似度打分），违反任意一格反馈的选手不会出现，正确答案永不被错误排除
- **渐进式 DOM 识别**：静态资源审计 → 表头语义 → 结构布局 → 手动绑定，四层降级策略，不因站点微调而整体失效
- **全谱系自动化**：随机首猜并填入 / 填入下一猜 / 提交当前猜测 / 填入并提交 / 单人本局全自动 / 连续自动开新局 / 多人匹配通知与自动准备 / 多人 BO3 全程托管（竞速与稳健两套策略）
- **双形态分发**：Edge/Chrome 扩展（Manifest V3）+ ScriptCat 用户脚本，共享同一份 646 人题库、求解器与 DOM 适配器
- **工程化护栏**：提交冷却（CD）感知、BO3 换局状态隔离、0 候选即暂停并导出诊断 JSON、诊断记录器与产品组件物理隔离

## 工作原理

```
页面 Adapter（渐进式 DOM 识别）
  → VisibleReactions（只读自己可见的反馈行：颜色/箭头/数字）
  → GuessFeedback（结构化：7 字段 + 3 数字箭头）
  → Constraint Solver（646 人题库严格求解 + 最佳探针）
  → 受控交互（受控输入事件 → 下拉候选按 playerId 唯一选中 → CD 感知提交）
```

关键设计原则：**只读取页面上自己可见的信息，不接触服务器隐藏状态**。所有自动化动作受来源策略、页面数据合约（`data-friberg-*`）与状态机三重限制；未知反馈一律暂停而不是猜颜色。

## 快速开始

### 浏览器扩展（Edge / Chrome）

1. 克隆本仓库，扩展源码位于 `extension/`（根目录直接包含 `manifest.json`）
2. Edge 打开 `edge://extensions` → 开发者模式 → 「加载已解压的扩展程序」
3. 打开 `https://shnlfriberg.online/multi`，悬浮窗出现「等待对局」即就绪

详细安装与真实页面操作指引见 [docs/INSTALL_EDGE.md](docs/INSTALL_EDGE.md)、[docs/INSTALL_SCRIPTCAT.md](docs/INSTALL_SCRIPTCAT.md)、[docs/USAGE_REAL_SITE.md](docs/USAGE_REAL_SITE.md)。

### ScriptCat 用户脚本

`userscript/` 提供脚本猫版本，与扩展共享同一套适配器、题库与求解器。

### 本地测试镜像

仓库自带本地镜像测试环境（`start.bat` / `start.ps1` 启动，`http://127.0.0.1:4173/mirror/`）：带「测试答案选择器 + 授权勾选 + 全自动测试」流程，可在不触碰真实对局的前提下回归验证求解器与状态机。扩展在本地镜像中可开启半自动/全自动，在公开站点上仅响应明确点击。

## 严格求解规则

- 国家黄色 = 国家不同但游戏赛区相同；国家灰色 = 赛区不同——不是简单的「国家不等」
- 年龄黄色为相差 1–3；Major 冠军数黄色为相差 1；灰色表示超出范围；数字箭头同时约束更高/更低
- 战队、位置、状态没有黄色反馈；读到黄色会阻止应用并要求人工校正
- 「七项属性全绿」不必然等于猜中：题库可能存在同属性不同昵称的选手，此时排除已猜昵称并保留其余同属性候选

完整反馈映射见 [docs/game-rules.md](docs/game-rules.md)。

## 题库与验证

- `data/players.game-646.json` 为当前游戏 646 人答案池；加载失败或不足 600 人时停止推荐，绝不回退旧种子库
- 刷新题库：`powershell -ExecutionPolicy Bypass -File .\tools\refresh_player_database.ps1`（先验证不少于 600 人，失败保留原库）

```powershell
# 回归测试：题库/赛区语义/数字范围/箭头 + 真实历史截图回放
node .\tests\run-regression.js

# 全题库契约审计：穷举 646 × 646 = 417,316 个「猜测—答案」组合，
# 每种反馈对应的候选集与独立规则 oracle（官方公开 gameService.ts）逐一比对
powershell -ExecutionPolicy Bypass -File .\tests\run-full-pool-contract-audit.ps1

# 自动化核心单测 + 固定种子 1,000 局本地模拟
node .\tests\run-automation-core.js
node .\tests\run-automation-simulation.js
```

当前题库共验证 **84,175 个反馈分区全部通过**，并专项验证「七项全绿但昵称未中」场景；规则 oracle 采用官方公开后端的 [gameService.ts](https://github.com/shnlfriberg/csgofriberg/blob/main/server/src/services/gameService.ts)，而非复用求解器自身判定。

## 合规与边界

- 只读取玩家自己可见的反馈，**不读取、不推断服务器隐藏答案**
- 公开站点上所有提交动作只响应明确授权；全自动能力默认仅在本地镜像或授权私人测试页启用
- 非官方插件，与弗一把官方无隶属关系；站点结构变更可能导致功能失效

## 项目管理（AI 协作友好）

本仓库以成文的 AI 协作纪律开发迭代：

- [AGENTS.md](AGENTS.md)：面向 Codex / Claude Code 等自动化助手的工作规则（禁止直改 main、先复现再修改、受保护文件清单）
- [PROJECT_STATE.md](PROJECT_STATE.md)：基准提交、分支策略与项目状态的外置账本
- 分支纪律：功能分支独立审查后集成；诊断记录器（Evidence）与产品（Product）组件物理隔离，互不加载

## 免责声明

本项目仅供学习与技术交流，请遵守游戏平台服务条款与当地法律法规；使用本插件产生的一切后果由使用者自行承担。

## License

[MIT](LICENSE)
