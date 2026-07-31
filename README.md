# Scout Console / 弗一把严格截图求解器

这是一个本地运行的猜选手辅助工具。它把弗一把结果表的七个颜色反馈转成严格逻辑条件，并提供一个可全自动验证的本地镜像。公开站点永远不会循环代打或自动提交；“随机首猜并填入”“填入下一猜”和“提交当前猜测”都只响应你的明确点击。

## 启动

双击 [start.bat](start.bat)，或在 PowerShell 运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

保持弹出的窗口运行，然后打开 <http://127.0.0.1:4173/>。不要用 `file://` 直接打开 `index.html`，否则浏览器无法可靠读取本地游戏题库。

如果 4173 被占用，可以在项目目录手动运行：

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

## 授权本地全自动镜像

服务器启动后，打开 <http://127.0.0.1:4173/mirror/>。这个页面不是公开对局的副本登录器，而是为题库、反馈矩阵和状态机准备的本地测试环境。

1. 从“测试答案”选择要验证的选手，点击“开始本地新局”。
2. 手动输入昵称时，必须从下拉菜单中选择带唯一 `playerId` 的项；可用来核验一条普通反馈。
3. 若要做自动化测试，主动勾选“我确认这是授权的本地测试”，再点击“启动全自动测试”。它会依次填写、选择唯一选项、提交、读取本页可见的结构化反馈，直至胜负或 8 次结束。

这里不靠 OCR/RGB 取色：反馈行的颜色和箭头通过稳定 `data-*` 合约传给严格求解器。所有自动操作都被来源策略、页面合约、显式勾选和状态机共同限制在本地镜像或你明确登记的私人测试页。

## Chrome 扩展（可选）

打包文件在 `dist/friberg-assistant-extension.zip`。解压后在 Chrome 的 `chrome://extensions` 打开“开发者模式”，选择“加载已解压的扩展程序”，并选中解压后的根目录（其中直接包含 `manifest.json`）。

- 在 `https://shnlfriberg.online/multi`，扩展只读取自己的可见棋盘、提供诊断和严格候选，不读取隐藏状态。它可以按你的点击随机填入首猜、填入求解器推荐，并在再次校验输入框、唯一选手和原网页按钮后按你的点击提交。
- 在 `127.0.0.1` / `localhost` 的本地镜像，扩展可在页面勾选授权后使用“半自动”或“全自动”。
- 私人测试站需要先在扩展选项页添加**精确 origin**并授予浏览器权限；即使注入成功，也只有页面带授权的 `data-friberg-*` 合约时才会执行操作。

边界、状态机与公开页面审计记录见 [docs/autoplay-state-machine.md](docs/autoplay-state-machine.md) 和 [docs/live-dom-audit.md](docs/live-dom-audit.md)。

## Edge / ScriptCat（真实页面辅助）

Edge 未压缩扩展目录已准备好：[dist/friberg-assistant-extension](dist/friberg-assistant-extension)，ZIP 根目录也直接包含 `manifest.json`。ScriptCat 脚本为 [friberg-assistant.user.js](dist/friberg-assistant.user.js)。两者使用同一份 646 人题库、严格求解器和 DOM 适配器；未知反馈会暂停而不是猜颜色。

第一猜可直接点击“随机首猜并填入”，检查昵称后点击“提交当前猜测”。产生反馈后，“填入下一猜”会改用严格求解器推荐；提交按钮在等待反馈期间会锁定，防止重复点击。

安装见 [docs/INSTALL_EDGE.md](docs/INSTALL_EDGE.md) 与 [docs/INSTALL_SCRIPTCAT.md](docs/INSTALL_SCRIPTCAT.md)，实际操作见 [docs/USAGE_REAL_SITE.md](docs/USAGE_REAL_SITE.md)，代码与真实页面验证边界见 [docs/implementation-validation.md](docs/implementation-validation.md)。

## 三步使用

1. 在弗一把提交一次昵称后，截取包含最近一行的结果表。
2. 回到工具，在“把颜色读成条件”区域按 `Ctrl+V`、拖入或导入截图；从本地题库选择本行猜测的昵称。
3. 检查七个反馈格和数字箭头。点击“应用颜色”后，工具只显示同时满足全部历史反馈的合法候选。点击候选卡即可复制昵称。

昵称列不参与颜色识别：它没有绿/黄/灰反馈。未猜中的昵称会被排除，绝不会被误当成“昵称精确”。七项属性全绿也不必然等于昵称猜中：题库中可能有不同昵称拥有相同七项属性；只要游戏没有结束，工具会排除已猜昵称并保留其余同属性候选。

## 严格规则

- 截图历史使用逻辑 AND，不使用相似度打分。违反任意一格反馈的选手不会出现。
- 国家黄色 = 国家不同但游戏赛区相同；国家灰色 = 游戏赛区不同。它不是简单的“国家不等于”。
- 年龄黄色为相差 1–3，Major 黄色为相差 1；灰色分别表示超过这些范围。数字箭头会同时约束答案更高或更低。
- 战队、位置、状态没有黄色反馈。读到黄色时，页面会阻止应用并要求你手动校正。

完整映射见 [docs/game-rules.md](docs/game-rules.md)。

## 题库与数据边界

`data/players.game-646.json` 是当前弗一把游戏的 646 人答案池，也是截图求解的唯一权威数据。加载失败或导入少于 600 人的文件时，页面会停止推荐；不会回退到旧的 65 人种子库。

“导入游戏题库”只接受兼容的完整游戏题库，避免把随意导出的 HLTV 表格覆盖游戏字段。HLTV 可用于核对年龄、身份、Major 与历史队伍，但游戏公开仓库、HLTV 当前资料和真实对局偶尔会互相不一致，因此 HLTV 只能作为独立审计证据，不能直接覆写求解字段；示例结构在 [data/hltv-extensions.example.json](data/hltv-extensions.example.json)。

如需刷新公开游戏题库：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\refresh_player_database.ps1
```

刷新脚本会先验证下载结果不少于 600 人，验证失败时保留原有题库。

## 验证

运行：

```powershell
node .\tests\run-regression.js
```

它会验证 646 人题库、赛区灰色语义、数字范围和箭头，并回放 supplied frozen → torzsi → woxic → aizy 的真实截图历史；该回放的合法候选固定为 `jee / tiger / z4kr`，不会推荐 aizy。

若要在题库更新后做全题库契约审计，运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\run-full-pool-contract-audit.ps1
```

该脚本按四个固定分片穷举全部 646 × 646 = 417,316 个“猜测—答案”组合，并将每种反馈对应的完整候选集与独立的游戏规则实现逐一比对。当前题库共验证 84,175 个反馈分区，全部通过；也会专门验证“七项属性全绿但昵称仍未猜中”时排除已猜昵称、保留同属性候选的行为。规则 oracle 依据公开游戏后端的 [gameService.ts](https://github.com/shnlfriberg/csgofriberg/blob/main/server/src/services/gameService.ts)，而非复用求解器的判定结果。

自动化核心和本地模拟可另外运行：

```powershell
node .\tests\run-automation-core.js
node .\tests\run-automation-simulation.js
```

第二条会以固定随机种子运行 1,000 局本地模拟，并生成 [logs/simulation-rounds.jsonl](logs/simulation-rounds.jsonl)。当前结果与浏览器验收见 [docs/automation-validation-report.md](docs/automation-validation-report.md)。
