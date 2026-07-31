# 本地自动化状态机与边界

`automation-core.js` 把所有推荐和页面动作分开。反馈永远先经过严格约束过滤，再选择下一猜；不存在“相似度兜底”。

| 状态 | 含义 | 可达的关键下一步 |
| --- | --- | --- |
| `IDLE` | 尚未建立回合 | `WAITING_FOR_ROUND` |
| `WAITING_FOR_ROUND` | 本地回合已开始 | `CHOOSING_GUESS` |
| `CHOOSING_GUESS` | 已有严格推荐 | `FILLING_INPUT` 或等待人工反馈 |
| `FILLING_INPUT` → `WAITING_FOR_DROPDOWN` → `SUBMITTING` | 仅授权页面的受控操作链 | `WAITING_FOR_FEEDBACK` |
| `WAITING_FOR_FEEDBACK` | 已提交，尚未观察到新行 | `SOLVING`、`WON`、`LOST` |
| `SOLVING` | 将可见颜色/箭头转为约束并重新筛选 | `CHOOSING_GUESS`、`WON`、`LOST` |
| `PAUSED` / `ERROR` | 用户暂停或合约不满足 | 需重新同步可见棋盘或开新局 |

人工提交的可见反馈使用 `recordObservedVisibleFeedback()` 进入同一条求解链，因此不会把手动一猜当作“昵称精确”。昵称本身不在反馈字段中；只有页面明确报告胜利才会结束回合。

页面操作必须同时满足：

- 来源是 `localhost`、`127.0.0.1` 或精确登记的私人 origin；
- 模式是半自动或全自动；
- 页面存在 `data-friberg-app="mirror" data-friberg-automation="authorized"`，并有输入框、唯一 `playerId` 下拉项、提交按钮和结构化反馈行；
- 用户勾选本地测试授权；
- 当前回合仍在进行、状态机未暂停、推荐未过期。

公开 `shnlfriberg.online` 在策略中优先判定为 `public`，即使被误写进私人列表也只允许推荐，`canAct` 始终为 false。私人域名的 Chrome 权限按 host 授予（Chrome 匹配模式不支持端口），但内容脚本会再次检查保存的**精确 origin**与授权 data 合约，其他端口不会获得操作能力。
