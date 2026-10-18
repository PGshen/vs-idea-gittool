# IdeaGitTool

[English](README.md) | 简体中文

一个 VS Code 插件，复刻了 [Rebased](https://github.com/detachhead/rebased)——基于 IntelliJ 平台的独立 Git 客户端。
它保留了 IntelliJ 的 Git 工作流、菜单文案、快捷键、图标和 New UI 的界面布局。

> 插件界面沿用 IntelliJ 的英文文案，下文提到的菜单、按钮名称都按界面上的原文写出。

## 功能

**Git 日志**（和 Rebased 一样在编辑器区域打开；设置 `ideagittool.log.showInEditor` 可改为放在底部面板）
- 提交图：IntelliJ 的分支线配色、分支/标签标记、当前分支高亮，滚动时按需加载。
- 过滤栏：*Text or hash*（支持正则、区分大小写），Branch、User、Date、Paths 过滤；Graph Options（By Commit Date / Topologically、First Parent、No Merges）；View Options；Go to Hash/Branch/Tag；可开多个日志标签页（Alt+G）。
- 分支面板：HEAD / Local / Remote / Tags，收藏、领先/落后计数、按目录分组，完整的分支右键菜单。
- 所选提交的变更文件列表，以及提交详情面板（"In N branches … Show all"）。
- 提交右键菜单：Copy Revision Number、Create Patch、Cherry-Pick、Checkout、Show Repository at Revision、Compare、Reset Current Branch to Here、Revert、Undo Commit、Edit Commit Message、Fixup、Squash Into、Drop、Squash Commits、Interactively Rebase from Here、Push All up to Here、New Branch、New Tag、Go to Child/Parent。
- 文件历史（File History）、Show History for Selection、Annotate with Git Blame、与指定版本 / 分支或标签比较。
- 长连线折叠、GPG 签名列、diff 预览（并排 / 合并视图）、折叠 / 展开线性分支、Not Cherry-Picked Commits、Show My Branches。
- 多仓库合并日志（按仓库着色）、按仓库分组；在提交的文件列表里直接丢弃或拆分部分改动（Drop / Extract Selected Changes）、Add Commits to Remote Branch。

**Commit 工具窗口**（活动栏）
- Commit / Shelf / Stash 三个标签页。支持 changelist、未跟踪文件、合并冲突分组、复选框、Group By、快速搜索、拖放。
- Amend（也能修改更早的提交）、提交信息历史、Commit / Commit and Push…，提交选项（Author、Sign-off、为文件移动额外生成一个提交）。和 IntelliJ 一样不经过暂存区，只提交勾选的文件。
- Shelve / Unshelve（未跟踪文件也能搁置）、Stash / Unstash 对话框、Rollback、Add to VCS、Add to .gitignore。
- 冲突对话框采用 IntelliJ 的迭代模式（Rebased 的默认设置）：
  - Unresolved / Resolved 两组，每个文件带 `已解决/总数` 徽标，行内 Accept 按钮。
  - 右键菜单有 Accept ‘Yours’ / ‘Theirs’ 和 Revert Conflict Resolution；Resolve All Simple Conflicts 会显示处理结果；可按目录分组。
  - 底部按钮为 Close / Accept and Finish / Resolve Manually（全部看过后显示 Review Changes）。
  - 合并窗口的 *Save and Close* 会保存处理到一半的文件，重新打开时从上次的进度继续；点 *Accept and Finish* 才会在 git 里标记为已解决。
- IntelliJ 风格的三栏合并窗口：
  - 左栏是 Yours（镜像布局，操作栏靠近分隔条），中间是可编辑的 Result，右栏是 Theirs。
  - 栏与栏之间用曲线色块连接（解决后变为虚线），同步滚动，按词高亮。
  - 行号旁有 » / « / × / 魔棒操作（Ctrl+点击一次解决整个冲突，第二侧变为"追加"）。
  - 和 IntelliJ 一样跟踪手动编辑：改动范围随输入调整，编辑过的块不再提供自动解决。魔棒算法移植自 IntelliJ 的 MergeResolveUtil。
  - 编辑器右键菜单（Accept / Resolve using / Resolve Automatically / Ignore、Compare with Clipboard、Collapse Unchanged Fragments、Synchronize Scrolling）。
  - 折叠未改动的部分（上下文行数由 `ideagittool.merge.contextLines` 设置）、Apply Non-Conflicting Changes（Left / All / Right）、Resolve Simple Conflicts、Revert Conflict Resolution、Compare Contents、F7 / Shift+F7、撤销。
  - 底部按钮：Accept Left / Accept Right / Save and Close / Apply Changes。保留 CRLF 换行和文件末尾换行。
  - 二进制文件和"一边删除、一边修改"的冲突，改为简单的 Accept Left / Accept Right 选择。
  - 想用 VS Code 自带的合并编辑器，可打开设置 `ideagittool.merge.useVsCodeMergeEditor`。
- 资源管理器和编辑器标签页按 IntelliJ 的颜色显示文件的 Git 状态。
- Rollback File…、Remove from VCS、Revert Resolved、Copy Path/Reference…、Create Patch 对话框。

**Local History（本地历史）**
- 在保存、新建、删除、重命名以及外部改动（包括 git 操作）时自动记录快照，git 操作前会打上 "Before Update" 这类标签。
- Show History、Show History for Selection、Show Project History、Recent Changes（Alt+Shift+C）、Put Label…，可还原、可生成补丁。

**工具栏与 Git 操作**
- 状态栏按 Rebased 的顺序排列：Update Project ↙、Push ↗、分支组件（↓↑ 计数）、merge/rebase 进行中时的 Continue / Abort。
- 分支弹出菜单（Ctrl+Shift+`）：Recent / Local / Remote / Tags 分组，以及每个分支的操作（Checkout、New Branch from、Checkout and Rebase、Compare、Show Diff with Working Tree、Rebase onto、Merge into、Pull using Rebase/Merge、Update、Push、Rename、Delete 等），支持智能签出（Smart Checkout）。
- 对话框：Push（Force Push、推送标签、Run Git hooks）、Push Rejected、Update Project、Pull、Fetch、Merge、Rebase、交互式 Rebase（Rebasing Commits）、Reset HEAD、New Branch、Tag、Remotes、Clone、Edit Commit Message、Create Patch。
- Git 菜单（`IdeaGitTool: Git Menu…`）和 VCS Operations Popup（Alt+`）。
- Update Project 可用 Stash 或 Shelve 先清理工作区；支持 Reset to the Remote Branch 和 Update Force-Pushed Branch（上游被强推后的更新）。
- Worktrees 视图和 New Worktree 对话框；多仓库时可同步执行分支操作。
- 所有 git 命令都会显示在 *IdeaGitTool: Git Console* 输出面板中。

## 设置

- `ideagittool.appearance`：
  - `vscode`（默认）：所有视图和对话框都按 VS Code 原生样式绘制，按钮、输入框、复选框、列表、菜单、悬停提示、滚动条、字体和颜色都取自当前 VS Code 主题，单色图标使用主题的图标颜色。
  - `intellij`：保留 IntelliJ New UI 的外观（IntelliJ 的浅色/深色配色和控件形状）。
  - 两种外观的布局和功能完全相同，`scripts/layout-check.mjs` 会检查元素位置没有变化。
- `ideagittool.log.showInEditor`、`ideagittool.log.openOnStartup`、`ideagittool.commit.gpgSign`、`ideagittool.commit.skipHooks`、`ideagittool.updateMethod`、`ideagittool.push.*`、`ideagittool.annotate.*`、`ideagittool.statusBar.enabled` 等。在设置编辑器里搜索 "ideagittool" 可以看到全部设置。
- `ideagittool.intellijShortcuts`（默认开启）：Ctrl+T 更新项目、Ctrl+Shift+K 推送、Ctrl+Shift+` 分支菜单、Alt+` VCS Operations Popup、Ctrl+Alt+N 新建分支、Alt+9 打开 Git 日志、Ctrl+K 提交（仅在 Commit 视图有焦点时）。这些快捷键会覆盖 VS Code 在同样按键上的默认功能（例如 Ctrl+T 的"转到工作区中的符号"、Ctrl+Shift+` 的"新建终端"）。关闭此设置即可恢复 VS Code 的快捷键。

## 与 Rebased 的差异

VS Code 没有浮动窗口，也不能在行号栏加菜单，因此：
- 对话框以编辑器标签页的形式打开，外观做成 IntelliJ 对话框的样子；分支弹出菜单这类弹窗使用 VS Code 的快速选择框。
- Diff 使用 VS Code 的 diff 编辑器；合并使用基于 CodeMirror 实现的 IntelliJ 风格三栏合并窗口。
- Blame 注解的选项放在悬停提示和行号区的右键菜单里。

其他限制：
- 工作区里有多个仓库时，文件历史和分支比较只显示单个仓库（与 IntelliJ 相同），合并后的日志按日期排序。
- 同步分支操作时，分支子菜单显示的是第一个仓库的当前分支名。
- 不提供 *Linearize Merges*（IntelliJ 只在内部开关打开时才显示这一项）。
- 打开 worktree 总是在新窗口中打开。

## 开发

```
npm install
npm run build        # 把 contrib/*.json 合并进 package.json，并打包到 dist/
npm test             # node:test，包括在临时仓库上执行真实的 git 操作
npm run typecheck
npm run package      # 生成 ideagittool-<version>.vsix
node scripts/preview.mjs <bundle> test/fixtures/<x>.mjs out.png [--light | --vscode=dark|light]   # 用模拟的宿主渲染某个 webview 并截图
node scripts/layout-check.mjs [--base=<ref>]                                # 对比 <ref>，检查元素位置和尺寸没有变化
sh scripts/preview-vscode.sh <dir> dark|light                              # 截取 VS Code 外观下主要界面的截图
xvfb-run -a node scripts/e2e.mjs test/e2e-log.mjs                          # 在真实 VS Code 中运行一个测试场景
```

代码结构见 ARCHITECTURE.md。

## 许可证

Apache 2.0。界面图标来自 IntelliJ Platform，详见 NOTICE 文件；插件 logo 为原创。
