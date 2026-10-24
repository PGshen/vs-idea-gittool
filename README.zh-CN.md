# IdeaGitTool

[English](README.md) | 简体中文

一个 VS Code 插件，复刻了 [Rebased](https://github.com/detachhead/rebased)——基于 IntelliJ 平台的独立 Git 客户端。
它保留了 IntelliJ 的 Git 工作流、菜单文案、快捷键、图标和 New UI 的界面布局。

> 插件界面沿用 IntelliJ 的英文文案，下文提到的菜单、按钮名称都按界面上的原文写出。

## 安装

**环境要求：** VS Code 1.90 或更高版本；Git 2.25 或更高版本，并已加入 `PATH`（也可以在设置 `ideagittool.gitPath` 里指定 git 路径）。Log 里不动工作区直接改提交的操作（Drop / Extract Selected Changes、Add Commits to Remote Branch）需要 Git 2.40 或更高版本；Rebase 的 `--update-refs` 选项需要 Git 2.38 或更高版本。

### 用 .vsix 安装包安装（推荐）

1. 从本仓库的 `releases/` 目录下载 [`ideagittool-0.4.2.vsix`](https://github.com/PGshen/vs-idea-gittool/raw/master/releases/ideagittool-0.4.2.vsix)。
2. 任选一种方式安装：
   - 在 VS Code 里打开扩展视图（Ctrl+Shift+X / Cmd+Shift+X），点顶部的 `⋯` 菜单，选 **Install from VSIX…**（从 VSIX 安装），再选中下载的文件。
   - 或者在终端里运行：
     ```
     code --install-extension ideagittool-0.4.2.vsix
     ```
3. 如果 VS Code 提示重新加载窗口，点确定即可。

升级时用同样的方式安装新版本的 .vsix。卸载时在扩展视图里找到 **IdeaGitTool**，选择 **卸载**。

### 从源码构建安装

```
git clone https://github.com/PGshen/vs-idea-gittool.git
cd vs-idea-gittool
npm install
npm run package                                  # 生成 ideagittool-<version>.vsix
code --install-extension ideagittool-*.vsix
```

### 开始使用

- 打开一个包含 Git 仓库的文件夹。Git 日志会在底部的 **Git** 面板中自动打开，活动栏里会出现 **IdeaGitTool** 图标（Commit / Shelf / Stash / Branches）。
- **Branches** 标签页（Ctrl+Shift+`）就是 IntelliJ 的分支弹出菜单：Update Project…、Commit…、Push…、New Branch…，以及所有本地、远程分支和标签及其操作。
- IdeaGitTool 可以和 VS Code 自带的 Git 扩展同时使用，不需要禁用任何东西。
- IntelliJ 快捷键默认开启，会覆盖部分 VS Code 快捷键（例如 Ctrl+T）。想保留 VS Code 的快捷键，关闭设置 `ideagittool.intellijShortcuts` 即可（见"设置"一节）。

## 功能

**Git 日志**（默认在底部的 **Git** 面板中；设置 `ideagittool.log.showInEditor` 可改为像 Rebased 一样在编辑器区域打开）
- 提交图：IntelliJ 的分支线配色、分支/标签标记、当前分支高亮，滚动时按需加载。
- 过滤栏：*Text or hash*（支持正则、区分大小写），Branch、User、Date、Paths 过滤；Graph Options（By Commit Date / Topologically、First Parent、No Merges）；View Options；Go to Hash/Branch/Tag；可开多个日志标签页（Alt+G）。
- 分支面板：HEAD / Local / Remote / Tags，收藏、领先/落后计数、按目录分组，完整的分支右键菜单。
- 所选提交的变更文件列表，以及提交详情面板（"In N branches … Show all"）。
- 提交右键菜单：Copy Revision Number、Create Patch、Cherry-Pick、Checkout、Show Repository at Revision、Compare、Reset Current Branch to Here、Revert、Undo Commit、Edit Commit Message、Fixup、Squash Into、Drop、Squash Commits、Interactively Rebase from Here、Push All up to Here、New Branch、New Tag、Go to Child/Parent。
- 文件历史（File History）、Show History for Selection、Annotate with Git Blame、与指定版本 / 分支或标签比较。
- 行内提交信息（Inline blame）：在光标所在行的行尾，用浅色斜体显示"提交者, 日期, 时间 • 提交描述"，鼠标悬停可跳到日志或查看 diff（设置 `ideagittool.inlineBlame.enabled`，命令 *Toggle Inline Git Blame*）。
- 长连线折叠、GPG 签名列、diff 预览（并排 / 合并视图）、折叠 / 展开线性分支、Not Cherry-Picked Commits、Show My Branches。
- 多仓库合并日志（按仓库着色）、按仓库分组；在提交的文件列表里直接丢弃或拆分部分改动（Drop / Extract Selected Changes）、Add Commits to Remote Branch。

**Commit 工具窗口**（活动栏）
- Commit / Shelf / Stash / Branches 四个标签页。支持 changelist、未跟踪文件、合并冲突分组、复选框、Group By、快速搜索、拖放。
- Amend（也能修改更早的提交）、提交信息历史、Commit / Commit and Push…，提交选项（Author、Sign-off、为文件移动额外生成一个提交）。和 IntelliJ 一样不经过暂存区，只提交勾选的文件。
- Shelve / Unshelve（未跟踪文件也能搁置）、Stash / Unstash 对话框、Rollback、Add to VCS、Add to .gitignore。
- 冲突对话框采用 IntelliJ 的迭代模式（Rebased 的默认设置）：
  - Unresolved / Resolved 两组，每个文件带 `已解决/总数` 徽标，行内 Accept 按钮。
  - 右键菜单有 Accept ‘Yours’ / ‘Theirs’ 和 Revert Conflict Resolution；Resolve All Simple Conflicts 会显示处理结果；可按目录分组。
  - 底部按钮为 Close / Accept and Finish / Resolve Manually（全部看过后显示 Review Changes）。
  - 合并窗口的 *Save and Close* 会保存处理到一半的文件，重新打开时从上次的进度继续；点 *Accept and Finish* 才会在 git 里标记为已解决。
- 冲突出现的时机和 IntelliJ 一致：合并、变基、cherry-pick、revert、pull、更新项目、检出、Unstash 或 Unshelve 出现冲突时，直接弹出冲突对话框；只有在还有未解决的冲突时关闭对话框，才会在右下角提示。
  - Smart Merge / Smart Checkout / 更新项目在恢复暂存（stash 或 shelf）的本地改动时出现冲突，对话框显示 "Uncommitted changes that were saved before merge have conflicts with files from feature"，合并窗口左右两栏标题为 "Uncommitted changes from the stash" / "Changes from feature"。和 IntelliJ 一样，解决后 stash（shelf）会保留，确认不再需要后自行删除。
  - 合并或变基的冲突全部解决后，会自动提交合并、继续变基。
  - 在编辑器里打开有冲突的文件时，编辑器标题栏和第一个冲突标记上方会出现 *Resolve Conflicts… (IdeaGitTool)*，点击后打开冲突对话框和该文件的合并窗口。
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
- Commit 工具窗口的 **Branches** 标签页（Ctrl+Shift+`），布局与 IntelliJ 的分支弹出菜单一致：顶部是搜索框（"Search for branches and actions"，匹配的字符高亮），右侧有 Fetch 和设置（Group by Directory、Show Recent Branches、Show Tags 等）；下面是 Update Project…、Commit…、Push…，merge / rebase 进行中时的 Abort / Continue，New Branch…、Checkout Tag or Revision…；再往下是按目录分组的 Recent / Local / Remote / Tags，显示当前分支、收藏（点星标切换）、待拉取/待推送计数，行末的 `›` 打开分支操作（Checkout、New Branch from、Checkout and Rebase、Compare、Show Diff with Working Tree、Rebase onto、Merge into、Pull using Rebase/Merge、Update、Push、Rename、Delete 等）。双击分支即签出；有本地改动挡路时支持智能签出（Smart Checkout）。
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
- `ideagittool.log.showInEditor`、`ideagittool.log.openOnStartup`、`ideagittool.commit.gpgSign`、`ideagittool.commit.skipHooks`、`ideagittool.updateMethod`、`ideagittool.push.*`、`ideagittool.annotate.*`、`ideagittool.branches.*` 等。在设置编辑器里搜索 "ideagittool" 可以看到全部设置。
- `ideagittool.inlineBlame.enabled`（默认开启）：在光标所在行的行尾显示该行最后一次提交的信息。打开 *Annotate with Git Blame* 时会自动隐藏。
- `ideagittool.merge.handleConflicts`（默认 `ask`）：工作区里第一次出现冲突时询问一次，是否由 IdeaGitTool 代替 VS Code 自带的冲突界面处理冲突。同意（或设为 `always`）后，会在用户设置里关闭 `merge-conflict.codeLens.enabled`、`merge-conflict.decorators.enabled`，以及你手动打开过的 `git.mergeEditor`。设为 `never` 则不改动 VS Code 的设置；未经你同意绝不修改。命令 *Restore VS Code's Built-in Merge Conflict UI* 可恢复原来的值。git 扩展自带的 *Resolve in Merge Editor* 按钮没有对应的设置，无法隐藏。
- `ideagittool.dialogs.openInNewWindow`（默认关闭）：对话框和合并窗口改为在独立窗口中打开，像 IntelliJ 的浮动对话框一样，而不是编辑器标签页。对话框关闭时窗口也随之关闭。
- `ideagittool.intellijShortcuts`（默认开启）：Ctrl+T 更新项目、Ctrl+Shift+K 推送、Ctrl+Shift+` 分支菜单、Alt+` VCS Operations Popup、Ctrl+Alt+N 新建分支、Alt+9 打开 Git 日志、Ctrl+K 提交（仅在 Commit 视图有焦点时）。这些快捷键会覆盖 VS Code 在同样按键上的默认功能（例如 Ctrl+T 的"转到工作区中的符号"、Ctrl+Shift+` 的"新建终端"）。关闭此设置即可恢复 VS Code 的快捷键。

## 与 Rebased 的差异

插件没法在 VS Code 工作台上方画悬浮的弹出层，也不能在行号栏加菜单，因此：
- 对话框以编辑器标签页的形式打开，外观做成 IntelliJ 对话框的样子。打开设置 `ideagittool.dialogs.openInNewWindow` 后会改为在独立窗口里打开（窗口大小和位置由 VS Code 决定，且不是模态窗口）。分支弹出菜单做成了 Commit 工具窗口里的 Branches 标签页，原本在工具栏上的操作（Update Project、Push、分支组件）也都放在这里，不再放在状态栏。
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

### 打包

需要 Node.js 20 或更高版本（`@vscode/vsce` 的要求）和 npm。

```
npm install                 # 首次执行，安装构建工具（esbuild、TypeScript、vsce）
npm test                    # 可选：打包前跑一遍单元测试
npm run package             # 在仓库根目录生成 ideagittool-<version>.vsix
```

`npm run package` 会依次：把 `contrib/*.json` 合并进 `package.json`，把 `src/` 压缩打包到 `dist/`，再执行 `vsce package`。
文件名里的版本号取自 `package.json` 的 `"version"` 字段。

发布新版本的步骤：

1. 修改 `package.json` 里的 `"version"`，并在 `CHANGELOG.md` 里补充这一版的改动。
2. 运行 `npm run package`。
3. 把生成的安装包复制到 `releases/` 目录（仓库只在这个目录下提交 `.vsix` 文件）：
   ```
   cp ideagittool-<version>.vsix releases/
   ```
4. 提交代码，然后打版本标签：`git tag -a v<version> -m "IdeaGitTool <version>"`，再 `git push origin v<version>`。

安装方法：`code --install-extension ideagittool-<version>.vsix`（详见"安装"一节）。

代码结构见 ARCHITECTURE.md。

## 许可证

Apache 2.0。界面图标来自 IntelliJ Platform，详见 NOTICE 文件；插件 logo 为原创。
