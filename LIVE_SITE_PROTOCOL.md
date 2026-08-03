# 弗一把生产网页协议与实机验证规范

版本：2026-08-04 source-audit draft  
适用分支：`codex/friberg-rebuild-v2`  
状态：官方源码协议已整理；生产浏览器实机证据待采集。

## 1. 目的

本文定义插件在真实弗一把网页上允许依赖的状态、事件、DOM 判据、提交路径、去重方式、性能时间线和 E2E 测试流程。

本文不是对旧实现的说明，而是新实现的协议合同。任何代码只有同时满足以下条件才能进入候选版本：

1. 走正常客户端可见输入和提交路径；
2. 不读取隐藏答案；
3. 不绕过服务端冷却或限流；
4. 不调用未经授权的私有/管理接口；
5. 由页面状态和官方响应驱动；
6. 可以导出完整动作时间线；
7. 单人和多人使用独立 adapter；
8. 恰好一个模块拥有写 DOM/提交权限。

## 2. 证据标记

- **SOURCE-CONFIRMED**：当前官方 `shnlfriberg/csgofriberg` 源码明确支持。
- **LIVE-CONFIRMED**：已在生产网页通过浏览器和 DevTools 实测并保存证据。
- **PENDING-LIVE**：源码可以推断，但仍需要生产实测确认具体 DOM/时序。
- **FORBIDDEN**：产品明确禁止依赖。

当前本文没有任何伪造的 LIVE-CONFIRMED 结论。本轮执行环境不能运行生产站点 JavaScript 或创建两个真实浏览器上下文，因此所有实机项目保持 PENDING-LIVE。

## 3. 通用动作模型

### 3.1 唯一动作键

每个建议、填入或提交动作必须绑定：

```text
actionKey = routeKind + roomOrGameId + roundId + guessCount + normalizedNickname
```

用户要求的最小去重三元组为：

```text
roundId + guessCount + nickname
```

实现中应额外加入 route 和 game/room 身份，避免刷新、重连或跨模式碰撞。

### 3.2 状态版本

控制器每次观察到以下任一变化，都必须废弃旧计划：

- route 变化；
- gameId / roomId 变化；
- roundId 变化；
- guessCount 与计划不一致；
- 输入框内容被人工改变；
- 当前高亮候选变化；
- 棋盘卸载/重挂载；
- round over / match over / single finished；
- reconnect 后 room snapshot 的 `stateVersion` 跳变；
- 服务端返回 `STALE_ROUND`、`NO_ACTIVE_ROUND`、`ROOM_BUSY` 或类似拒绝。

### 3.3 多读单写

允许：

- DOM observer；
- WebSocket/Network observer；
- adapter 读取；
- solver 计算；
- UI 展示；
- 日志记录。

只有 `submission-queue` 可以：

- 写入官方 input；
- 触发表单提交；
- 点击准备/再来一局等受控动作。

任何 overlay、UI、adapter、hotfix 都不得直接提交。

## 4. GuessInputBar 协议

官方来源：`client/src/components/GuessInputBar.tsx`、`client/src/api/playerList.ts`。

### 4.1 状态定义（SOURCE-CONFIRMED）

```text
text         React controlled input 文本
items        当前查询结果，最多 10 条
active       当前高亮候选索引
open         候选列表是否显示
submitting   onPick Promise 是否仍在执行
disabled     上层页面是否禁止猜测
```

官方组件没有独立的 `selectedPlayer` state。所谓“选中”本质是 `items[active]`。

### 4.2 搜索排序（SOURCE-CONFIRMED）

从高到低：

1. 完全相等；
2. 等长 leet 等价；
3. 普通前缀；
4. leet 前缀；
5. 普通包含；
6. leet 包含；
7. 同分按 nickname 排序；
8. 最多保留 10 条。

`1` 与 `i`/`l` 可互相匹配，其他数字也存在 leet 映射。

### 4.3 提交按钮启用条件（SOURCE-CONFIRMED）

```text
!disabled && !submitting && items.length > 0
```

因此以下说法错误：

- “按钮 enabled 就代表输入框里是唯一精确昵称”；
- “按钮 enabled 就代表 React 已保存一个独立 player 对象”；
- “输入文字等于昵称就一定会提交该昵称”。

真实提交对象是提交时的 `items[active]`。

### 4.4 输入方法（SOURCE-CONFIRMED + PENDING-LIVE）

React controlled input 不能只使用：

```text
input.value = nickname
```

候选实现：

1. 使用 `HTMLInputElement.prototype.value` 原生 setter；
2. 派发 bubbling `input` 事件；
3. 等待 React 更新 `items`、`active` 和按钮；
4. 验证当前候选中的精确 nickname；
5. 只触发一次官方 form submit。

实机必须比较：

- 原生 setter + `InputEvent`；
- 真实键盘输入；
- Playwright `fill()`；
- 是否还需要 `change`；
- 中文输入法/composition 状态；
- Edge 与 Chrome 是否一致。

### 4.5 候选项点击的危险（SOURCE-CONFIRMED）

候选 `<li>` 的 `onMouseDown` 会直接调用 `pick(item)`，即提交，不是“只选择”。

新 adapter 不应通过点击 `<li>` 来完成预填。预填应保持在 input/候选状态，提交由唯一 submission queue 触发。

### 4.6 Enter、Tab 和按钮（SOURCE-CONFIRMED）

- `Tab`：将当前候选 nickname 补全到文本，并可循环候选；不直接提交。
- `Enter`：表单提交当前高亮候选。
- 按钮：表单提交当前高亮候选。
- `form.requestSubmit(button)`：应进入相同 React `onSubmit` 路径，需实机确认浏览器差异。

### 4.7 精确候选验证

提交前必须同时满足：

```text
normalize(input.value) == normalize(plannedNickname)
items.length > 0
normalize(items[active].nickname) == normalize(plannedNickname)
button.disabled == false
surface 仍属于当前 route/round
```

由于 extension 无法直接读取 React state，实机 adapter 必须找到可观测等价物。优先方案：

- 候选列表可见时读取 `[role=option][aria-selected=true]`；
- 列表未显示时，使用受控的 Tab 补全流程并再次打开/验证；
- 不允许只凭按钮 enabled 提交；
- 任何歧义都停止并记录 `ambiguous-active-suggestion`。

该判据必须在生产页面通过 exact、prefix、contains、leet、同名相近昵称测试。

## 5. 单人模式状态机

官方来源：`client/src/pages/SingleGame.tsx` 和服务端 game route。

### 5.1 状态

```text
BOOTING
  -> PLAYING
  -> START_ERROR

PLAYING
  -> SUBMITTING
  -> WON
  -> LOST
  -> RESTART_CONFIRM
  -> LEAVING

WON/LOST
  -> RESULT_OVERLAY_OPEN
  -> RESULT_OVERLAY_CLOSED
  -> RESTARTING
  -> LEAVING
```

### 5.2 新局（SOURCE-CONFIRMED）

- 页面进入有效难度 route 后调用 `POST /game/start`；
- 成功后得到 `gameId`、已有 `guesses`、`maxGuesses`；
- 默认最大猜测数 8；
- 开始失败时显示重试 UI。

### 5.3 提交（SOURCE-CONFIRMED）

正常客户端路径：

```text
GuessInputBar pick(player)
  -> onPick(player)
  -> POST /game/:gameId/guess { playerId }
  -> success response
  -> setGuesses([...feedback])
  -> setStatus(won/lost/playing)
  -> optional setAnswer + showOverlay
  -> onPick resolves
  -> GuessInputBar clears text/items/open
```

网络错误或服务端拒绝时 `onPick` 返回 `false`，输入不会被组件清空。

### 5.4 单人可靠接受判据

优先级：

1. **Primary**：对应 `POST /game/:gameId/guess` 收到成功 HTTP 响应；
2. **Secondary**：官方 input 在同一 actionKey 下由组件清空；
3. **Secondary**：`.guess-progress` 已用 dot 数从 N 变为 N+1；
4. **Secondary**：自己棋盘新增一行完整反馈；
5. **Terminal**：状态/overlay 表明 won 或 lost。

只有 DOM 权限时，必须至少满足“输入清空 + 进度增加或反馈完整”中的两项，不能只凭点击成功。

### 5.5 源码预期顺序与实机采集

源码调用顺序是：HTTP 成功后安排 React state 更新，再从 `onPick` 返回，GuessInputBar 随后安排清空输入。React batching 可能改变实际 DOM 可见顺序。

必须实测记录：

```text
submitTriggeredAt
httpRequestStartedAt
httpResponseAt
inputClearedAt
progressAdvancedAt
rowInsertedAt
rowFeedbackCompleteAt
overlayOpenedAt
```

不得预设“输入框一定先清空”或“棋盘行一定先出现”。

### 5.6 顶部重新开始与结算再来一局

SOURCE-CONFIRMED：

- 顶部 header 的重新开始按钮在活跃局中一直存在；点击会弹确认并退出当前 gameId；
- 游戏结束后的 dock 会用“再来一局/返回”替换 GuessInputBar；
- AnswerOverlay 内也有“再来一局/查看棋盘”；
- 这些按钮最终都可能调用相同 `restart()`，但操作语境不同。

自动连续模式只允许：

1. 当前状态已确认 finished；
2. 当前输入栏已经消失；
3. 点击真实 result overlay 或 finished dock 内的“再来一局”；
4. 禁止按页面全文搜索后点击顶部永久 restart；
5. 点击后等待新 gameId/0 猜/新 input surface，再重新武装。

### 5.7 单人限流

当前官方服务端：每身份 60 秒最多 30 次单人 guess 请求。

连续测试规则：

- 不并发提交；
- 不通过重试绕过 429；
- 记录 429、响应头和可用 Retry-After；
- 触发限流时暂停测试并归类为 `server-rate-limit`，不是解析失败；
- 100 局或 30 分钟测试以正常人类/客户端允许节奏执行。

## 6. 多人模式状态机

官方来源：`client/src/pages/MultiRoom.tsx`、`server/src/socket/index.ts`。

### 6.1 房间状态（SOURCE-CONFIRMED）

```text
WAITING
STARTING
PLAYING
ROUND_OVER
FINISHED
```

附加身份状态：

```text
player / spectator
host / guest
connected / disconnected
ready / not ready
skipped / active
```

### 6.2 私人房间准备流程

```text
Context A: room:create
Context B: room:join
Guest: room:ready
Host: game:start (仅两人都 ready)
Server: round:start
```

私人房间和匹配房间的按钮语义不同：

- 匹配房间双方通过 `room:ready`；
- 私人房间 guest 准备，host 在条件满足时点击开始；
- 自动准备必须识别当前 room 类型和自己的 host/guest 身份；
- 不得用“页面上唯一绿色按钮”作为唯一判据。

### 6.3 匹配准备

关键事件：

```text
match:start
match:found
room:ready
match:ready-ended
```

`match:ready-ended` 原因至少包括：

- `timeout`
- `opponent_left`

离开匹配 ready room 可能产生匹配冷却。测试不得反复制造公共匹配惩罚；自动化 E2E 优先使用私人房间。

### 6.4 小局开始（SOURCE-CONFIRMED）

服务端 `startRound()`：

```text
room.round += 1
room.status = playing
new target selected
roundEndsAt = now + 120000
eventResults = {}
roundResult = null
matchResult = null
for each player:
  guesses = []
  guessTimes = []
  lastGuessAt = null
  skipped = false
emit round:start
```

客户端收到 `round:start` 后：

```text
guessCooldownUntil = 0
roundOver = null
match overlay/replay reset
roundExpired = false
apply room snapshot
```

新插件小局身份必须优先使用：

```text
roomId + roundId + selfBoard mount identity
```

不能仅使用“第 N 局”文本。

### 6.5 自己与对手棋盘（SOURCE-CONFIRMED）

- 自己：`.player-board-self`
- 对手：`.player-board-opponent`
- 每块棋盘标题显示 `guessCount/maxGuesses`
- 当前 React key 包含 player key 和 `room.roundId`
- 对手收到的是隐藏属性反馈，自己收到可见完整反馈

adapter 只解析 `.player-board-self`。禁止从对手隐藏对象或内部 room target 读取答案。

### 6.6 多人提交路径（SOURCE-CONFIRMED）

客户端正常路径：

```text
GuessInputBar pick(player)
  -> submitGuess(player.id)
  -> verify room.status == playing
  -> verify !roundExpired
  -> verify local cooldown <= 0
  -> socket.emit('game:guess', {
       playerId,
       roundId,
       eventId: crypto.randomUUID()
     }, ack)
```

ack 分支：

- `GUESS_COOLDOWN`：带 `retryAfterMs`，返回 false；
- `NO_ACTIVE_ROUND` / `STALE_ROUND` / `ROOM_BUSY`：触发 room sync，返回 false；
- 其他 error：toast，返回 false；
- success：设置本地 cooldown，返回 true。

### 6.7 当前冷却（SOURCE-CONFIRMED）

```text
MULTI_GUESS_INTERVAL_MS = 1500
```

客户端和服务端一致。

服务端另有 10 秒 12 次请求保护，但正常 1500 ms 间隔更严格。

### 6.8 CD 内是否可预填

SOURCE-CONFIRMED：可以。

理由：GuessInputBar 的 `disabled` 只由 round expired、skipped、guessCount 达上限等条件决定，未把 `guessCooldownUntil` 传入 disabled。CD 内用户仍可输入和产生候选。

CD 内点击提交时，`submitGuess()` 会返回 false，组件保留输入。页面本身不会在 CD 结束时自动提交。

新 submission queue：

1. 反馈完整后立即计算；
2. CD 内只预填并验证精确候选；
3. 不在 CD 内反复调用 submit；
4. 使用服务端 ack 给出的 cooldown/retryAfter 作为权威边界；
5. 到点后的首个可用任务周期只提交一次；
6. 若收到 `GUESS_COOLDOWN`，按 `retryAfterMs` 更新边界；
7. 不以 10–12 ms 高频 requestSubmit 重试轰炸组件；
8. 提交后等待 ack / applied / board advance，再决定是否重试。

### 6.9 多人可靠接受判据

优先级：

1. **Primary**：`game:guess` ack 无 error；
2. **Primary**：自己的 `game:guess:applied`，且 roomId/roundId/key/action 对应；
3. **Secondary**：GuessInputBar input 由组件清空；
4. **Secondary**：自己棋盘 guessCount 从 N 变 N+1；
5. **Secondary**：自己棋盘新增完整反馈行；
6. **Terminal**：随后发生 round:over 或 match:over。

官方服务端当前代码先调用成功 ack，再发送 `game:guess:applied` 或 round/match over。实际浏览器事件和 React DOM 可见顺序仍须实测。

### 6.10 eventId 与插件去重

服务端会缓存 eventId 结果。重复 eventId 可返回成功并重新发 applied 给发送者。

新插件仍必须本地去重：

- 每个 actionKey 只生成一个 eventId；
- 网络未知状态下可用同一个 eventId 做有限恢复，而不是生成新 eventId 重复猜；
- 一旦 ack、applied、输入清空或棋盘增长任一可信接受信号出现，停止提交；
- roundId/guessCount 改变后，旧任务立即作废。

浏览器扩展无法直接控制页面内部生成的 eventId 时，应避免高速重复触发表单，依靠 DOM/ack 观测确认。

### 6.11 小局结束和下一局

```text
round:over
  -> status round_over
  -> nextRoundAt = now + 6000
  -> overlay 显示答案/倒计时
  -> server timer startRound
  -> round:start
```

每次 `round:start` 必须：

- 取消旧 pending action；
- 清空预填的旧 nickname；
- 重建 solver session；
- 将 guessCount 置 0；
- 重新执行本小局首猜策略；
- 不能复用上一小局的 cooldown 或 actionKey。

### 6.12 整场结束

结束原因包括：

- 比分达到 wins needed；
- 对手离开；
- 断线超时；
- 双方断线；
- 其他服务端 reason。

收到 `match:over` 或 room.status `finished` 后：

- 自动提交立即停止；
- pending action 清除；
- 导出本场时间线；
- 私人房间可测试 rematch；
- 公共匹配不得自动发报告或自动反复匹配。

## 7. 页面事件驱动

### 7.1 主要驱动

- MutationObserver：input surface、按钮 disabled、棋盘行、progress、overlay、board mount；
- `input`/`change`/focus 事件：用户与自动化输入变化；
- Performance/Network：单人 HTTP 请求与响应；
- WebSocket/Socket.IO：多人 ack、applied、round、match、room patch/sync；
- route/history：SPA 导航；
- visibility/pageshow/connect：恢复后强制同步。

### 7.2 轮询兜底

轮询仅用于：

- observer 丢失后的低频自检；
- 页面从后台恢复；
- 长时间没有事件时确认 route/round 是否仍有效。

建议兜底频率 250–1000 ms，不得用 12/16 ms 永久轮询驱动整个插件。

## 8. 性能时间线

### 8.1 每猜必记字段

```json
{
  "sessionId": "...",
  "mode": "single|multi",
  "roomOrGameId": "...",
  "roundId": "...",
  "guessCountBefore": 1,
  "nickname": "...",
  "actionKey": "...",
  "feedbackAppearedAt": 0,
  "feedbackCompleteAt": 0,
  "parsedAt": 0,
  "recommendedAt": 0,
  "inputStartedAt": 0,
  "inputCompletedAt": 0,
  "exactCandidateConfirmedAt": 0,
  "buttonEnabledAt": 0,
  "cooldownReadyAt": 0,
  "submitTriggeredAt": 0,
  "requestOrEmitAt": 0,
  "serverAckAt": 0,
  "serverAcceptedAt": 0,
  "inputClearedAt": 0,
  "boardAdvancedAt": 0,
  "rowCompleteAt": 0,
  "terminalEventAt": 0,
  "result": "accepted|rejected|stale|timeout|cancelled",
  "errorCode": ""
}
```

所有时间使用同一页面的 `performance.now()` 单调时钟；跨上下文汇总时另外记录 `Date.now()` 和时钟锚点。

### 8.2 派生延迟

```text
parseLatency = parsedAt - feedbackCompleteAt
recommendLatency = recommendedAt - parsedAt
fillLatency = inputCompletedAt - inputStartedAt
reactEnableLatency = buttonEnabledAt - inputCompletedAt
cooldownSubmitLag = submitTriggeredAt - cooldownReadyAt
networkAckLatency = serverAckAt - requestOrEmitAt
acceptToBoardLatency = boardAdvancedAt - serverAcceptedAt
feedbackToSubmit = submitTriggeredAt - feedbackCompleteAt
feedbackToAccept = serverAcceptedAt - feedbackCompleteAt
```

### 8.3 报告

对每种模式、策略和猜测序号分别报告：

- 样本数；
- p50；
- p95；
- 最大值；
- 失败/拒绝/超时数量；
- 重复提交次数；
- 陈旧任务取消次数；
- CD 内预填成功率；
- CD 后 0–50 / 50–100 / 100–250 / >250 ms 提交分布。

禁止只写“感觉更快”。

## 9. DevTools / 浏览器自动化采集方案

### 9.1 浏览器上下文

```text
Context A: host
Context B: guest
```

要求：

- 独立 cookie/localStorage/sessionStorage；
- 同一浏览器版本；
- 两个上下文均开启 Console、Network、WebSocket 帧保存；
- 只使用私人房间；
- 不读取服务器未展示的数据；
- 每场保存 HAR、console JSONL、DOM timeline、扩展诊断日志。

### 9.2 页面注入观察器

允许的观察：

- `.input-bar`、`input[role=combobox]`、button disabled；
- `.autocomplete-list [role=option]` 与 `aria-selected`；
- `.player-board-self` / `.player-board-opponent`；
- `.guess-progress`；
- `[aria-modal=true]`；
- table row/class/text；
- route、可见文本、组件挂载/卸载。

观察器只记录公开 DOM，不访问 React 私有 fiber、答案变量或服务端内部对象。

### 9.3 Network

单人记录：

- `/game/start`
- `/game/:id/guess`
- `/game/:id/exit`
- status、duration、response code、rate-limit headers

多人记录 Socket.IO 帧：

- event 名；
- payload 中非敏感、客户端本来可见的 roomId/roundId/stateVersion；
- ack 时间和 code；
- 不把 cookie、token、身份密钥、房间密码写入仓库。

### 9.4 Console

每条日志必须包含：

```text
isoTime / perfTime / context / route / room / round / count / actionKey / event / detail
```

敏感字段在写文件前脱敏。

## 10. 双上下文私人 BO3 测试

每个用例至少执行到 BO3 正常结束，累计至少 20 场。

### 10.1 基础流程

1. A 创建私人 BO3 房间；
2. B 正常加入；
3. B 准备；
4. A 开始；
5. 两边确认 `round:start` 与 0/8；
6. A 插件托管，B 使用受控人工/脚本输入；
7. 完成第 1 小局；
8. 记录 round:over -> 6 秒 -> round:start；
9. 确认第 2/3 小局重新首猜、无旧输入、无旧 cooldown；
10. 确认 match:over 后停止。

### 10.2 必测矩阵

| 用例 | 预期 |
|---|---|
| CD 内预填 | 输入和精确候选可以准备，服务端不提前收到 guess。 |
| CD 到点提交 | 只发送一次正常提交，记录与边界的延迟。 |
| CD 内误提交 | 客户端返回 false/或服务端 GUESS_COOLDOWN，输入保留，按 retryAfter 重排。 |
| 双击插件按钮 | 同 actionKey 不产生两个不同猜测。 |
| 人工先提交 | 插件观察进度后取消旧动作并继续同步。 |
| 人工修改输入 | pending 计划取消，不覆盖用户新输入。 |
| 切小局时残留输入 | round:start 后清除旧计划和旧文本。 |
| 旧回调迟到 | roundId 不匹配时丢弃。 |
| A 断网后恢复 | room:sync 后恢复当前 round/count，不重复提交。 |
| A 主动离开 | match over / opponent_left，插件停止。 |
| B 主动离开 | A 收到 match over，插件停止。 |
| 双方断线 | 按服务端结果结束，不继续提交。 |
| 跳过小局 | `skipped` 后 input disabled，插件停止本局动作。 |
| 小局超时 | round:over timeout，等待下一局重置。 |
| 对手先猜中 | 本局立刻停止，旧提交不得越过 round over。 |
| 8 猜耗尽 | 不再提交，等待结算。 |
| rematch | 新 match 身份、score、round、动作队列全部重置。 |

## 11. 单人 E2E 测试

### 11.1 本局全自动

至少连续 30 局：

- 首猜正确填入和提交；
- 每条反馈完整后再推荐；
- 每次 actionKey 唯一；
- 8 猜内结束；
- 结算后本局模式停止；
- 不点击顶部 restart。

### 11.2 连续循环

至少 100 局或 30 分钟，以先达到者之外继续满足用户要求时可分批进行，但每批必须保留同一报告格式。

验证：

- 只点击 result overlay/finished dock 的再来一局；
- 新 gameId 后才重新首猜；
- 不跨刷新永久恢复无限托管；
- 遵守 30/60s 单人猜测限流；
- 429/网络异常可诊断并安全暂停；
- 记录每局真实耗时和答案是否存在于本地数据快照。

## 12. 题库漂移与 `/search` 遍历

### 12.1 第一层：公开 nickname 列表

通过正常客户端已使用的 `/players/list`：

- 记录 `version`；
- 记录总人数；
- 保存 id/nickname 快照；
- 与 bundled snapshot 比较新增、删除、改名；
- 不把该列表解释为答案顺序或隐藏概率。

### 12.2 第二层：正常 UI 属性采集

在 `/search` 页面：

1. 使用 UI 输入 nickname；
2. 选择页面公开显示的精确结果；
3. 读取公开属性；
4. 每位选手保存 source URL、采集时间、页面版本、字段完整性；
5. 低速、可暂停、可恢复；
6. 遇到限流或验证码停止，不规避；
7. 不调用管理 API；
8. 不通过答案接口补全属性。

### 12.3 第三层：正常对局可见反馈

- 从自己的公开反馈行学习当前属性；
- 只在该行字段可见且解析完整时写入候选 snapshot；
- 记录来源为 `visible-feedback-row`；
- 与 UI 搜索冲突时进入 discrepancy report，不静默覆盖。

### 12.4 合并门槛

新/变更选手进入 solver 数据前必须：

- 字段完整；
- nickname 唯一；
- region 可根据官方规则确定；
- feedback matrix 可生成；
- 全量策略模拟通过；
- 所有答案 8 猜内；
- 快照版本固定；
- 旧版本可回滚。

## 13. 热门选手优先协议

### 13.1 目标

当多个合法选择在求解质量相同或接近时，优先推荐普通玩家更可能想到的知名选手，减少“脚本总先猜小众名字”的违和感。

### 13.2 不变量

- popularity 不能改变合法候选集合；
- 不能提交与反馈矛盾的选手；
- 不能为了知名度牺牲明确更优的信息分割；
- 不能绕过未识别反馈保护；
- 同输入必须产生确定性结果。

### 13.3 决策层级

```text
1. direct answer when one candidate
2. strict quality metric
3. answer-first preference where configured
4. near-optimal quality window
5. popularity score
6. stable nickname/id tie-break
```

### 13.4 玩家化细节

除“知名选手优先”外，可加入但必须可配置/可测试：

- 已经显示为精确答案候选时优先直接猜候选，而不是继续用小众探针；
- 2–3 个候选时不再选择候选集合外的探针；
- 避免连续两次猜极相似冷门昵称造成机器感；
- 首猜可以保持算法最优固定 opener，不用随机伪装；
- 推荐理由显示“直接命中概率/信息分割/知名度 tie-break”；
- 手动辅助模式允许用户在前 3 个近优选手中选择；
- 自动模式使用确定性第一名，避免随机导致复现困难；
- 人工修改或提交后自动重新同步，而不是判定用户“破坏托管”。

## 14. 算法验证合同

比较：

- Minimax
- Expected Remaining
- Entropy
- Answer-first
- Hybrid
- Hybrid + Popularity tie-break

每种策略对当前固定快照全部答案模拟：

- 一猜命中率；
- 二猜内命中率；
- 三猜内命中率；
- 平均猜测数；
- P90；
- P95；
- 最坏猜测数；
- 每步 p50/p95/max 计算耗时；
- 反馈矩阵大小；
- 策略查找表大小；
- popularity 改变选择的节点数量；
- popularity 导致质量指标变化的最大幅度。

硬门槛：全部官方答案 8 猜内完成。

单人循环只用于：

- E2E 稳定性；
- 真实页面耗时；
- DOM/协议漂移；
- 题库版本漂移；
- 性能时间线。

不得称为神经网络训练或预测随机下一题。

## 15. 诊断与导出

面板必须显示：

- route / mode；
- gameId/roomId（显示时脱敏）；
- roundId；
- guessCount；
- 当前 board 身份；
- 当前 feedback 行完整性；
- 候选数；
- 推荐 nickname；
- 策略、质量分、popularity 分；
- input 状态；
- exact suggestion 状态；
- cooldown 剩余；
- pending actionKey；
- 最近 ack/applied/HTTP 状态；
- 最近错误；
- p50/p95 采样摘要。

导出包：

```text
manifest.json
session-summary.json
event-timeline.jsonl
dom-snapshots/
network-summary.json
websocket-summary.json
errors.json
player-pool-version.json
```

不得导出：

- cookie；
- auth token；
- 账号密码；
- 私人房间码（除非用户明确选择且默认脱敏）；
- 服务端隐藏答案；
- 对手未公开属性；
- 浏览器个人资料。

## 16. 生产实机验收表

| 项目 | 状态 | 证据文件 |
|---|---|---|
| GuessInputBar exact/prefix/leet 提交目标 | PENDING-LIVE | — |
| React 输入 setter/event 组合 | PENDING-LIVE | — |
| 单人 HTTP 成功到 input/row/progress 顺序 | PENDING-LIVE | — |
| 单人顶部 restart 与 result again 区分 | PENDING-LIVE | — |
| 单人连续 30 局 | PENDING-LIVE | — |
| 单人循环 100 局或 30 分钟 | PENDING-LIVE | — |
| `/players/list` 生产 version/count | PENDING-LIVE | — |
| `/search` UI 遍历 | PENDING-LIVE | — |
| 私人房间创建/加入/准备/开始 | PENDING-LIVE | — |
| 多人 1500 ms CD 实测 | PENDING-LIVE | — |
| CD 内预填 | PENDING-LIVE | — |
| ack/applied/input/board 顺序 | PENDING-LIVE | — |
| BO3 每小局重置 | PENDING-LIVE | — |
| 20 场 BO3 | PENDING-LIVE | — |
| 重复提交/陈旧输入 | PENDING-LIVE | — |
| 断线/离开/跳过/超时 | PENDING-LIVE | — |
| 整场结束停止 | PENDING-LIVE | — |

该表未全部完成前，不得把新控制器标记为稳定版。
