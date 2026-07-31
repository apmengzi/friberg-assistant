# 2026-07-29 真实房间诊断修复

输入证据：真实 `/multi/room` 脱敏诊断与 BO3 第二局截图。

## 已确认的页面合约

- 自己的容器：`.player-board-self`
- 对方容器：`.player-board-opponent`
- 对方隐藏格：`.masked-cell`
- 棋盘：`table.game-table`
- 反馈色：`.correct`、`.close`、`.wrong`
- 数字箭头：`.dir > svg.lucide-arrow-up` / `.lucide-arrow-down`
- 最新行：`.row-latest`

## 根因

1. 候选扫描曾把 `#root`、整页和同时包含双方棋盘的 `.boards` 当成棋盘，“我的猜测”文字因此泄漏到父级候选。
2. 箭头读取只检查 `.dir` 的文本，没有继续读取内部 SVG；SVG 的 `className` 还是 `SVGAnimatedString`，不能按普通字符串识别。
3. 任意一行解析失败后，`feedbackPaused` 会阻止 MutationObserver 和手动扫描再次解析；手动扫描还会重建会话，丢掉此前历史。
4. ScriptCat 在棋盘尚无行时绑定后没有给棋盘本身安装观察器，第一条反馈可能永远不会进入求解链路。

## 修复后的行为

- 只将独立棋盘结构纳入候选；整页和双棋盘父容器不再进入候选。
- 优先使用真实 self/opponent 类，并拒绝手动绑定对方或 masked 棋盘。
- 直接读取 SVG 的 `class` / `data-lucide`，支持 `lucide-arrow-up/down`。
- 最新一行不完整时保留全部已处理历史，继续监听并自动重试；不再存在必须进入的“反馈校准页面”。
- 手动“扫描页面”只重读未处理行，不重建本局会话。
- 扩展和 ScriptCat 共用同一 `feedbackRows`、`readFeedbackRow` 与 `feedbackRowFingerprint`。

## 回放结果

- 双棋盘候选：2（self 1、opponent 1），自动绑定 self。
- frozen 第一行：59 名候选，显示立即猜。
- 加入 refrezh 第二行：3 名候选，显示立即猜。
- 再点“扫描页面”：仍为 2 条历史、3 名候选。
- 未知 class：进入“最新反馈尚未识别”；class 修复后自动恢复到 59 名候选。
- “填入下一猜”：写入并唯一选择 Djoko；没有点击最终提交。
