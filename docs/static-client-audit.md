# 公开客户端静态审计

审计时间：2026-07-29（UTC+8）。

本次只下载并离线检查 `https://shnlfriberg.online/multi/` 在 HTML 中公开引用的客户端资源；没有登录、没有加入房间、没有读取浏览器存储、没有拦截请求或 WebSocket。

资源已保存到 [artifacts/live-site-assets](../artifacts/live-site-assets)，可用 `node tools/audit-live-assets.js` 重新生成关键词报告。

## 已确认的公开结构线索

| 范畴 | 静态证据 | 适配器使用方式 |
| --- | --- | --- |
| 应用与路由 | 入口是 React `#root`；主 bundle 中出现 `/multi` 和 `/multi/room`，并在匹配流程中导航到房间路由。 | 在两个路径注入，监听 SPA 路由变化后重新扫描。 |
| 多人等待态 | bundle 的 i18n 文案包含“多人联机”“正在获取房间状态...”“我的猜测”。 | 没有棋盘时明确显示“等待对局”，不会因为等待态停止悬浮窗。 |
| 字段顺序 | i18n 字段顺序为昵称、队伍、国家或地区、年龄、位置、Major 冠军数、Major 次数、状态；角色包含步枪手/狙击手/教练。 | 用作表头和八格行的第二层匹配；昵称格不读反馈颜色。 |
| 猜测控件 | i18n 有“输入选手昵称...”及“提交猜测”；CSS 有 `.input-bar .input`、`.input-bar .btn`、`.guess-input-feedback`、`.player-search-content`。 | 搜索框与提交控件只作为候选，不在未验证时擅自提交。 |
| 反馈颜色 | CSS 明确出现 `.game-table td.correct`、`.game-table td.close`、`.game-table td.wrong`，以及 `.game-table td .dir`。主题变量定义 `--correct`、`--close`、`--wrong`。 | 优先读取 `correct / close / wrong` 类名和文字箭头；绝不凭 RGB 推测未知状态。 |
| 多人布局 | CSS 有 `.room-waiting-card`、`.room-player-row`，并有 `.game-table`。 | 用作候选棋盘/等待态的结构评分，不把它们当作唯一选择器。 |
| 实时线索 | realtime bundle 是 Socket.IO 客户端；主 bundle 的静态字符串包含 `match:start`、`match:found`、`room:sync`。 | 仅记录为路由/状态背景证据；插件不会订阅、拦截或发送这些事件。 |

## Source map

所有已下载 JS/CSS 都没有 `sourceMappingURL` 注释。未继续猜测或枚举隐藏 source map 路径。

## 明确不能从静态代码断言的内容

- 真实对局中哪一个棋盘属于当前用户；
- 每个反馈单元格在运行时的完整 DOM 树；
- 下拉候选项的稳定 `playerId` 标记；
- 数字箭头是否始终使用 `.dir` 和文字箭头；
- 真实匹配后的状态切换时序。

因此插件按渐进式定位工作：先用上述真实 class/文案，再用八列表头/布局，最后让用户点击自己的棋盘。颜色或箭头若未出现已知 class/符号，严格求解会暂停并提示导出脱敏诊断，而不是猜测。
