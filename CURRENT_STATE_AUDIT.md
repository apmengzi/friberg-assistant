# Friberg Assistant 当前状态审计

审计日期：2026-08-04  
新开发分支：`codex/friberg-rebuild-v2`  
基线：`main` @ `26a7691d619a36f9595cf28b565547882e85d919`  
本阶段范围：只读调查与文档，不修改功能代码，不修改 `dist/`，不合并任何现有 PR。

## 1. 审计结论

当前仓库不能继续以“在 0.9.8 上追加脚本”的方式开发。

- `feature/autoplay-097` 是最后一个曾被用户报告为“基本可用”的完整功能基础，但运行时同时加载 `overlay.js`、`live-qol.js`、`content-script.js`、`autoplay.js`、`autoplay-hotfix.js` 等多层逻辑。它适合做行为参考和回滚证据，不适合作为新架构基线。
- `feature/friberg-ultimate-110` 的打包结构明显更接近“单控制器”，但其多人冷却常量仍写死为 2000 ms，而当前官方客户端和服务端源码均为 1500 ms；它还依赖页面文本构造小局标识，未完成真实网页验证。因此只能迁移局部思路，不能直接继续。
- `experiment/race-lite-100`、PR #36、`feature/solver-speed-099` 和 PR #35 已经被真实多人测试否定，禁止复活或合并。
- PR #38 和 `feature/human-priority-production-sync-v2` 已经尝试“知名选手优先”和生产题库同步，但实现仍叠加在旧 0.9.8 脚本栈上，并通过运行时 monkey patch 修改求解器会话、全局替换 `fetch`、逐个查询生产 API。该实现可作为需求原型，不应进入最终架构。
- `main` 当前仍是 0.9.4 级别的旧稳定线，`PROJECT_STATE.md` 停留在 2026-07-31 的 0.9.3/0.9.4 语境，已经不能代表仓库全貌。

因此，新分支从 `main` 建立，只先提交审计和协议文档。后续功能应在新架构中显式迁移，而不是继承任一旧自动化控制器。

## 2. 证据层级与验证标签

事实优先级：

1. 真实生产网页运行结果；
2. 官方仓库 `shnlfriberg/csgofriberg`；
3. 本仓库代码、分支、PR、Issue、Actions；
4. 历史交接对话。

本文使用以下标签：

- **源码确认**：已在当前官方 `main` 源码中定位到明确实现。
- **仓库确认**：已从本仓库当前分支、PR、Issue 或 Actions 读取。
- **历史报告**：来自用户实测或历史交接，但本轮未复测。
- **实机待验证**：必须在生产网页通过浏览器、Network、WebSocket、Console 和两个独立上下文补齐。

### 本轮工具边界

本轮能够访问 GitHub 仓库和生产站点的静态入口，但当前执行环境没有可交互的 Chromium/Edge 会话。生产 `/single`、`/multi` 和 `/search` 入口只返回“需要启用 JavaScript”的应用壳，无法在本轮执行 React、抓取 DevTools Network/WebSocket 帧或创建双上下文私人房间。

因此：

- 本文没有把任何源码推断写成“已实机验证”；
- `LIVE_SITE_PROTOCOL.md` 给出了可直接执行的实机采集流程、判据和日志字段；
- 第一阶段的源码/仓库审计已完成；生产实机协议验证仍是进入功能编码前的硬门槛。

## 3. 仓库与权限

- 仓库：`apmengzi/friberg-assistant`
- 可见性：private
- 默认分支：`main`
- 当前账号权限：admin / maintain / push
- `main` 当前 HEAD：`26a7691d619a36f9595cf28b565547882e85d919`
- 新分支：`codex/friberg-rebuild-v2`
- 本轮未修改 `main`
- 本轮未修改 `dist/`
- 本轮未合并任何 PR

## 4. 分支清单

| 分支 | 分类 | 审计判断 |
|---|---|---|
| `main` | 当前默认基线 | 0.9.4 级旧稳定线；适合作为干净重建起点，不代表完整功能。 |
| `feature/autoplay-097` | 历史完整功能基线 | 0.9.8；用户曾报告基本可用；多层脚本叠加，只读参考。 |
| `fix/live-qol-096-clean` | 历史中间基线 | 0.9.6；通知、准备、每小局控制的前置实现。 |
| `feature/live-qol-095` | 废弃早期实现 | 0.9.5；被 0.9.6 替代。 |
| `feature/friberg-ultimate-110` | 未充分验证的重构 | 打包层次较干净，但协议常量过时且无充分实机证据。 |
| `feature/solver-speed-099` | 已否定实验 | 0.9.9–0.9.10；多控制器/直接控制器实验均被实测否定。 |
| `experiment/race-lite-100` | 已废弃实验 | PR #36 已关闭、未合并；功能砍得过多且实机失败。 |
| `feature/human-priority-production-sync` | 新需求原型 | PR #38；知名选手优先和题库同步概念可参考，架构不可继承。 |
| `feature/human-priority-production-sync-v2` | 未挂 PR 的后续原型 | 比 PR #38 分支多 1 个提交，只修改知名度策略；仍依赖旧栈。 |
| `fix/rollback-stable-0911` | 回滚/历史 | 需要保留为历史证据，不作为新开发基线。 |
| `fix/bo3-round-reset` | 旧修复线 | 曾包含临时维护流程；不得继续开发。 |
| `fix/feedback-nickname-parser` | 旧修复线 | 与已合并昵称解析修复相关。 |
| `bugfix-feedback-nickname-parser` | 已合并修复来源 | PR #11 已合并。 |
| `chore/chat-github-dev-loop` | 已合并基础设施来源 | PR #2 已合并。 |
| `chore/repository-hygiene` | 已合并清理来源 | PR #6 已合并。 |
| `chore/enable-maintenance-patcher` | 已结束临时工具 | PR #7 已合并后移除；不得复用自修改工作流。 |
| `chore/reduce-ci-email-noise` | 已合并 CI 修复来源 | PR #10 已合并。 |

## 5. PR 清单与状态

| PR | 状态 | 结论 |
|---|---|---|
| #38 `feat: add human-priority guesses and resumable production player sync` | Draft、open、未合并 | Actions run #85 成功；静态/模拟通过不等于生产可用。不要合并。 |
| #37 `feat: rebuild full Friberg Ultimate Assistant 1.1` | Draft、open、未合并 | Actions run #82 成功；协议常量过时，缺真实网页验证。不要合并。 |
| #36 Race Lite 1.0.1 | closed、未合并 | 明确废弃。 |
| #35 0.9.9–0.9.10 experiment | closed、未合并 | 真实多人测试失败，明确拒绝。 |
| #33 0.9.8 autoplay | open、未合并 | 最后一个用户报告“基本可用”的回滚证据，不直接合并。 |
| #31 0.9.6 clean QoL | open、未合并 | 历史中间层，只读参考。 |
| #30 0.9.5 QoL | closed、未合并 | 已由 #31 替代。 |
| #11 nickname parser | merged | 当前 `main` 的 0.9.4 修复。 |
| #10 CI email noise | merged | 当前 CI 只在 `main`、面向 `main` 的 PR 和手动触发运行。 |
| #7 temporary BO3 patch workflow | merged 后移除 | 仅历史，不可恢复。 |
| #6 repository hygiene | merged | 清理基线。 |
| #2 development baseline | merged | 建立 AGENTS/CI/安全规则。 |

## 6. Issue 审计

### 仍具有产品意义

- #4：BO3 小局切换后旧棋盘/状态残留。
- #5：匹配通知与受控自动准备。
- #8：反馈行昵称被整行文本污染；对应修复已进入 `main`。
- #12：首猜和填入/提交组合操作。
- #13 / #17：题库来源与同步策略；其中“646 人与上游一致”只代表 2026-07-31 当时状态，不能覆盖当前生产题库。
- #14：当前匹配托管的安全边界。
- #20：0.9.5 验证清单，可转化为新 E2E 用例。
- #32：单人本局与连续模式。
- #34：竞速策略、题库监测和遥测；Issue 正文仍描述后来被否定的 0.9.10，不能当作成功状态。

### 已解决或历史运维

- #1、#3、#9、#15、#18、#19。

### 无产品价值的误创建 Issue

- #21–#29 中多项为工具调用或占位误创建。新开发不得继续制造元 Issue；状态应集中在新 Draft PR 与文档中。

## 7. 当前运行时架构审计

### 7.1 `feature/autoplay-097`

`extension/manifest.json` 同时加载：

1. `solver.js`
2. `automation-core.js`
3. `live-dom-adapter.js`
4. `feedback-parser-patch.js`
5. `overlay.js`
6. `live-qol.js`
7. `content-script.js`
8. `autoplay.js`
9. `autoplay-hotfix.js`

问题：

- 多个模块可以观察、填入或提交；
- 状态分散在 overlay、QoL、autoplay、hotfix；
- fast path 与旧内部缓存曾分裂；
- 换局、人工提交、输入残留和冷却重试容易互相污染；
- 任何新增需求继续叠加都会增加不可证明状态。

结论：保留为行为回滚样本，不迁移其控制流。

### 7.2 `feature/friberg-ultimate-110`

Manifest 只加载：

- `solver.js`
- `automation-core.js`
- `ultimate-policy.js`
- `ultimate-dom.js`
- `ultimate-ui.js`
- `ultimate-controller.js`

优点：

- 单一顶层控制器；
- DOM、策略、UI 初步分开；
- 单人/多人模式统一入口；
- 不加载旧 overlay/hotfix。

阻断问题：

- `ultimate-controller.js` 写死 `MULTI_COOLDOWN_MS = 2000`，当前官方值为 1500；
- 驱动间隔 12 ms、最多 180 次提交尝试，可能制造不必要的 UI 重复提交压力；
- `roundToken()` 在多人主要依赖“第 N 局”文本或 URL，没有直接使用官方 `roundId`；
- 将输入框清空当作主要接受判据，但没有同时保留 WebSocket ack / `game:guess:applied` 的可观测证据；
- `terminalMulti()` 依赖页面文本；
- 未完成双上下文 BO3、断线、超时、投降和结算实机验证。

结论：迁移分层思路，不迁移控制器实现。

### 7.3 PR #38 / human-priority v2

可取思路：

- 只在合法候选中选择；
- 候选很少时优先普通玩家更可能想到的知名选手；
- 候选较多时只在接近最优的信息分割中应用知名度偏好；
- 使用确定性而非随机排序。

不可取实现：

- monkey patch `AssistantSession.prototype.recommend`；
- 在旧 0.9.8 多脚本栈中插入额外策略层；
- 全局替换 `fetch` 来改写本地题库响应；
- 在普通游戏页面后台逐个调用搜索 API；
- 生产数据与算法、DOM 学习、存储和 UI 同文件耦合；
- 新增完整选手时仅靠局部字段拼接，缺少版本快照和全量契约验证。

结论：需求保留，代码不迁移。

## 8. 官方源码确认的当前协议

官方参考：`shnlfriberg/csgofriberg` 当前 `main` @ `38a82fa304406134b88bcf31a4005af1f5f99039`。

### 8.1 GuessInputBar

官方 `client/src/components/GuessInputBar.tsx` 表明：

- 输入框是 React controlled input，`value={text}`；仅改 DOM property 不足以更新 React 状态。
- 候选来自当前 `items`，没有独立的“已选中 player 对象”状态。
- 当前高亮候选由 `active` 索引决定。
- 提交按钮启用条件是：页面未禁用、未提交中、`items.length > 0`。
- 按钮启用并不代表输入文字与当前高亮候选完全相等。
- 表单提交会提交 `items[active]`。
- 点击候选项的 `mousedown` 会直接调用 `pick()`，即直接尝试提交，不只是“选择”。
- `Tab` 才会把当前候选昵称补全进输入框；`Enter`/按钮/`requestSubmit` 会提交当前高亮项。
- `onPick` 返回 `false` 或提交期间输入被改动时，组件不清空输入；其余成功路径会清空输入、候选和列表。

架构含义：

- “文字已填入”与“将要提交的 playerId 已确定”必须分开记录；
- 自动填入后必须验证精确候选排序，不能仅等按钮变为 enabled；
- 可靠实现应优先精确匹配并验证当前高亮候选，再走官方 form submit；
- React 输入必须通过原生 setter + `input` 事件或真实键盘交互更新。

### 8.2 单人模式

官方 `client/src/pages/SingleGame.tsx` 表明：

- 新局：`POST /game/start`；
- 猜测：`POST /game/:gameId/guess`；
- 主动重开活跃局会先确认并调用 `/game/:gameId/exit`，再开始新局；
- 成功响应后先向 React state 追加反馈、更新状态；有答案时再显示结算 overlay；
- 猜测进度以 `.guess-progress i.used` 表示，不依赖 `x/8` 文本；
- 游戏结束后 dock 中的 GuessInputBar 被“再来一局/返回”按钮替换；
- 顶部“重新开始”按钮始终存在，活跃局点击会触发确认；
- overlay 内也有“再来一局”和“查看棋盘”；
- 最多 8 猜。

当前官方服务端单人猜测接口限流为每身份 60 秒 30 次。单人连续测试必须按照该限制设计，不能把触发 429 当作插件随机失败。

### 8.3 多人模式

官方客户端和服务端均定义：

- 每次猜测最小间隔：1500 ms；
- 每小局时间：120000 ms；
- 小局间隔：6000 ms；
- 最大 8 猜；
- 本地/服务端猜测速率保护：10 秒内 12 次；正常 1500 ms 冷却更严格。

官方提交负载：

```text
{
  playerId,
  roundId,
  eventId: crypto.randomUUID()
}
```

关键事件：

- `match:found`
- `room:ready`
- `round:start`
- `game:guess`
- `game:guess:applied`
- `round:over`
- `match:over`
- `match:ready-ended`
- `player:offline`
- `match:rematch:update`
- `room:patch`
- `room:sync`

客户端提交逻辑：

- 若本地 `guessCooldownUntil` 尚未到，`submitGuess()` 立即返回 `false`，不会发送 WebSocket 猜测；
- GuessInputBar 本身在 CD 内并没有被 disabled，因此可以正常输入并保留候选；
- 页面不会在 CD 结束时自动提交，需要控制器在边界后主动触发一次正常表单提交；
- `GUESS_COOLDOWN` ack 带 `retryAfterMs`；
- 成功 ack 带 `cooldownMs`；
- `game:guess:applied` 带 `roomId`、`roundId`、`key`、`stateVersion`、`feedback`；
- 旧 `roundId`、旧 `stateVersion` 或无活跃小局会被拒绝/同步。

服务端小局重置：

- `room.round += 1`；
- 两名玩家的 `guesses=[]`、`guessTimes=[]`、`lastGuessAt=null`、`skipped=false`；
- 发出 `round:start`；
- 客户端将 cooldown 归零并清理小局 overlay/replay 状态。

自己的棋盘与对手棋盘：

- 自己：`.player-board-self`
- 对手：`.player-board-opponent`
- React key 包含玩家 key 和当前 `room.roundId`，换小局会重新挂载棋盘。

## 9. 旧结论中已经过时的部分

| 旧结论 | 当前结论 |
|---|---|
| 多人冷却约 2000 ms | 当前官方客户端和服务端均为 1500 ms。 |
| 按钮启用意味着已精确选择玩家 | 按钮只要求候选非空；提交的是当前高亮候选。 |
| 点击下拉项可以作为“只选择不提交” | 官方 `mousedown` 直接调用 `pick()`，会尝试提交。 |
| 单人连续模式可无节制高速循环 | 单人猜测接口当前有 30/60s 限流，测试调度必须遵守。 |
| 646 人题库已与生产一致 | 只在 2026-07-31 被确认；用户近期实测已出现找不到选手，必须重新取生产版本证据。 |
| CI 全绿可证明自动化成功 | #35/#36 历史已经证明不成立。 |

## 10. 题库漂移审计

当前本仓库以 `data/players.game-646.json` 和打包副本为静态题库。Issue #13 只证明 2026-07-31 时本地文件与当时公开上游一致。

当前官方客户端已经改为：

- 从公开正常客户端路径 `/players/list` 获取 `{version, players:[id,nickname]}`；
- 缓存在 `localStorage`；
- 使用版本和 ETag 每 30 秒后台校验；
- 搜索结果最多 10 个。

这说明生产题库已经具备独立版本，而静态 646 文件不能再被假定为唯一真相。

### 后续允许的数据采集

- 正常读取客户端本来就会调用的 `/players/list`，记录版本、数量、id、nickname；
- 在 `/search` 页面通过正常 UI 查询并记录公开展示属性；
- 在单人/多人正常猜测中从自己可见的反馈行补全公开属性；
- 对版本变化保留不可变快照、来源、采集时间和字段完整性；
- 新增/变更记录先进入候选数据层，不直接覆盖已发布策略矩阵。

### 禁止

- 读取目标答案或服务器内部 `targetPlayerId`；
- 调用只为管理端/内部使用的接口；
- 绕过客户端和服务端限流；
- 通过高频逐人请求轰炸生产站点；
- 在没有全量反馈规则验证时把不完整记录直接加入求解矩阵。

## 11. “热门选手优先”的正确落点

该需求应实现为策略中的显式、可测试 tie-break，而不是修改候选合法性。

建议顺序：

1. 严格反馈过滤，得到合法答案集合；
2. 计算每个可选猜测的 worst-case、expected remaining、entropy、是否为答案；
3. 只在质量完全相同或落在明确、可报告的近优阈值内比较 popularity；
4. 候选数很少时优先合法答案中的知名选手；
5. 不允许知名度把明显更差的信息分割提升为首选；
6. 每次推荐日志同时记录算法质量分和 popularity 分，便于解释。

知名度数据不应只靠一份手写名单。建议组合：

- 可版本化的人工知名度先验；
- Major 冠军/参赛次数；
- 当前或历史高知名度队伍；
- 官方难度标签；
- 在用户自己的正常对局日志中，选手被猜测/答案出现频率的本地统计；
- 手动可编辑的覆盖表。

必须比较启用和禁用 popularity 时的二猜率、平均猜数、P90/P95、最坏猜数和策略表大小，避免“更像人”损害基础求解能力。

## 12. 新架构硬约束

```text
solver/
  normalize.js
  feedback.js
  matrix.js
  strategies.js
  popularity.js
  policy-table.js

data/
  bundled-snapshot.json
  production-snapshots/
  reconcile.js

adapters/
  single-adapter.js
  multiplayer-adapter.js

automation/
  controller.js
  state-machine.js
  submission-queue.js
  event-timeline.js

ui/
  panel.js
  panel.css

background.js
manifest.json
```

规则：

- 恰好一个顶层 controller；
- 单人和多人 adapter 独立；
- solver 不读写 DOM；
- adapter 不决定下一猜；
- submission queue 不解析反馈；
- UI 不执行游戏动作；
- 所有动作以 `roundId + guessCount + normalizedNickname` 去重；
- 多人优先采用官方 `roundId`/棋盘重挂载/进度，而不是模糊文本；
- MutationObserver、输入事件、WebSocket/Network 结果为主，轮询仅做低频兜底；
- 人工提交后重新从页面同步，不自动停止，也不延续陈旧计划；
- 旧 controller、hotfix、overlay 不得进入最终 manifest；
- `dist/` 只由构建脚本生成。

## 13. 风险登记

| 风险 | 严重度 | 当前状态 | 进入编码前要求 |
|---|---:|---|---|
| 生产部署与官方 `main` 不完全一致 | 高 | 未实机确认 | 抓取构建版本、DOM、Network、WS 并与源码对照。 |
| 题库人数/属性已更新 | 高 | 用户近期实测提示漂移 | 记录 `/players/list` 版本与 UI 搜索遍历结果。 |
| GuessInputBar 精确候选判断错误 | 高 | 源码已说明按钮并非精确选择证据 | 实机验证 exact/leet/prefix/contains 排序和提交目标。 |
| 多人 CD 边界和服务器接受顺序 | 高 | 源码为 1500 ms | 双上下文记录 ack、applied、DOM 行的时间线。 |
| 旧脚本重复执行 | 高 | 多条分支存在 | 新 manifest 合同测试必须断言唯一 controller。 |
| BO3 换局污染 | 高 | 历史发生过 | 20 场 BO3，逐小局验证 roundId、0/8、首猜和旧任务取消。 |
| 单人连续触发限流 | 高 | 官方限流 30/60s | 测试调度遵守 Retry-After/429，报告而不绕过。 |
| 人气策略降低求解质量 | 中 | 原型未做完整对照 | 全答案 A/B 模拟和指标门槛。 |
| CI 与生产脱节 | 高 | 历史已证实 | CI 之外必须附真实浏览器证据包。 |

## 14. 阶段门槛

### Phase 1A：仓库/源码审计

- [x] 分支、PR、Issue、近期提交清单
- [x] 旧 manifest 与控制器加载关系
- [x] 官方 GuessInputBar、SingleGame、MultiRoom、server socket 协议
- [x] 新分支创建
- [x] 审计文档

### Phase 1B：生产实机协议

- [ ] 可执行浏览器上下文
- [ ] 单人完整提交时间线
- [ ] 单人结算与连续开局
- [ ] 两上下文私人 BO3
- [ ] CD 内预填与 CD 后提交
- [ ] ready、round over、match over、断线、投降、超时
- [ ] 生产 `/players/list` 版本和数量
- [ ] `/search` 正常 UI 题库遍历证据

在 Phase 1B 完成前，不进入功能编码。

## 15. 下一阶段建议提交顺序

1. `docs: audit repository and official protocol`
2. `test: add captured live-site fixtures and timeline schema`
3. `refactor: introduce isolated solver and adapters`
4. `feat: implement single adapter and guarded submission queue`
5. `feat: implement multiplayer state machine and BO3 handling`
6. `feat: add popularity-aware near-optimal strategy`
7. `feat: add versioned production player snapshots`
8. `test: add full-answer simulation and browser E2E`
9. `build: package loadable extension and zip`

每个提交只包含一个可验证层，不把协议调查、架构重写、算法和 UI 混在同一提交中。
