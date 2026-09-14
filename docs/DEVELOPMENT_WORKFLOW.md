# ChatGPT + GitHub 开发流程

## 角色分工

### ChatGPT / GitHub

- 阅读仓库与 `PROJECT_STATE.md`；
- 创建 Issue、分支和 Draft PR；
- 修改代码与回归测试；
- 检查 GitHub Actions；
- 生成可下载的扩展 Artifact；
- 根据诊断证据继续修复。

### 用户本机

- 拉取或下载构建；
- 在 Edge 中重新加载扩展；
- 用两台设备进入真实房间；
- 验证自己的棋盘、颜色、箭头、候选和提交；
- 导出诊断 JSON 与证据包。

## 一次修复的标准流程

1. 创建 Issue，记录复现条件和验收标准；
2. 从 `main` 创建分支；
3. 修改最少的相关文件；
4. 增加自动回归测试；
5. 创建 Draft PR；
6. 等待 CI；
7. 下载 PR/commit 对应的扩展 Artifact；
8. 本机真实页面测试；
9. 把结果评论到 Issue/PR；
10. 通过后合并。

## 分支命名

- `fix/round-reset`
- `fix/cd-submit-once`
- `fix/live-dom-adapter`
- `feature/offline-license`
- `chore/repository-hygiene`

## 本地最短更新流程

在项目根目录双击：

```text
tools\UPDATE_BUILD_TEST.cmd
```

它会：

- 显示当前分支；
- 尝试 fast-forward 拉取；
- 运行快速回归；
- 运行安全审计；
- 重新构建 `dist/friberg-assistant-extension/` 与 ZIP。

然后打开：

```text
edge://extensions/
```

找到插件并点击“重新加载”，再刷新弗一把页面。

## 现场证据

发生问题后：

1. 在插件中导出诊断 JSON；
2. 将它保存为 `diagnostics/latest.json`；
3. 双击 `tools\COLLECT_TEST_EVIDENCE.cmd`；
4. 上传生成的 `evidence/friberg-evidence.zip`。

证据包包含：

- Git 提交与分支；
- 工作区状态；
- 扩展版本；
- 快速测试输出；
- 安全审计结果；
- 可选的最新诊断 JSON。

## GitHub Actions

### Friberg Assistant CI

每次 PR/Push 自动执行：

- JavaScript 语法检查；
- Manifest 解析；
- 646 人题库数量检查；
- 严格求解器回归；
- 扩展、ScriptCat、自动化和商业离线授权契约；
- 敏感信息扫描；
- 个人扩展打包；
- ZIP 结构验证；
- Artifact 上传。

### Full Solver Audit

手动触发，用于：

- 646×646 全量反馈契约；
- 1000 局模拟；
- 生成完整审计证据。

普通 UI/DOM 修复不必每次运行全量审计；触及求解器或题库时必须运行。

## 真实网页验证模板

```text
版本/Commit：
浏览器：Edge/Chrome + 版本
URL：/multi 或 /multi/room
缩放：100%/125%/150%

1. 插件出现：是/否
2. 自己棋盘识别：是/否
3. 对手棋盘误读：是/否
4. 颜色读取：正确/错误
5. 三类箭头：正确/错误
6. 历史累计：正确/错误
7. 新局重置：正确/错误
8. CD 后提交：正确/错误
9. 重复提交：有/无
10. 候选归零：有/无

附件：截图、diagnostic.json、evidence.zip
```
