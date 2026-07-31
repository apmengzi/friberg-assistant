# Edge 安装（未压缩扩展）

本次交付应选择这个文件夹，而不是选择 ZIP 内的某个文件：

`C:\Users\30369\Documents\Codex\2026-07-27\https-chatgpt-com-share-6a6635c6-2c34\dist\friberg-assistant-extension`

该文件夹最外层已经直接包含 `manifest.json`。

1. 在 Edge 地址栏打开 `edge://extensions/`。
2. 打开“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择上面的 `friberg-assistant-extension` 文件夹。
5. 如需固定入口，可在扩展菜单中把“Friberg Assistant”固定到工具栏。
6. 打开 `https://shnlfriberg.online/multi` 或进入匹配后的 `/multi/room`；页面右侧应出现“弗一把助手”悬浮窗。

无需关闭 Edge 安全机制、SmartScreen 或任何浏览器防护。

如果你只想保留 ZIP，请先解压 [friberg-assistant-extension.zip](../dist/friberg-assistant-extension.zip)，然后仍然选择解压后的、直接含有 `manifest.json` 的文件夹。

若悬浮窗未出现：先在 `edge://extensions/` 点击扩展的“重新加载”，再刷新游戏页面；仍未出现时，进入页面后用“采集诊断”导出 JSON。

下一步请看 [真实对局使用方法](USAGE_REAL_SITE.md)。
