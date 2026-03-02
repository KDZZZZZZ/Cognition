# Cognition 用户功能手册（中文）

本文按零基础用户写法整理。默认你第一次打开这个系统，不假设你知道任何内部概念。

## 0. 先说人话：这个系统是干什么的

Cognition 是一个把“文件管理、Markdown 编辑、PDF 阅读、AI 会话、版本对比”放在同一个界面里的工作台。

你可以把它理解成 4 个东西拼在一起：

1. 文件区：存笔记、PDF、会话。
2. 工作区：打开文件、分屏、切换标签。
3. AI 会话区：给 AI 发指令，并控制它能看哪些文件。
4. Diff/时间线：查看 AI 或人类改了什么，决定接不接受。

如果你只记一件事，就记这个最短使用路径：

1. 在左侧新建或上传文件。
2. 打开一个 `Session`。
3. 把需要给 AI 看的文件权限调成 `Read` 或 `Write`。
4. 在会话输入框里发消息。
5. 如果 AI 产生改动，到 `Diff` 里审阅，再决定 `Accept` 还是 `Reject`。

## 1. 界面总览

![界面总览](../output/playwright/user-manual-zh/01-home-overview.png)

图 1：左侧是资源区和时间线，右侧是主工作区。没有打开任何内容时，中间会显示 `Empty Pane`。

你先把这几个位置认清：

| 区域 | 你会在这里做什么 | 触发后的效果 |
| --- | --- | --- |
| 左上路径条 | 看当前焦点路径，点 `+` 打开新建菜单 | 可以新建文件、会话、文件夹、上传文件 |
| `EXPLORER` | 找文件、右键操作文件、拖动文件 | 打开文件、移动文件、打开右键菜单 |
| 中间 Pane | 看文档、看 PDF、看 Session、看 Diff | 根据标签类型显示不同内容 |
| 顶部 Tab 行 | 切换文件、关闭标签、分屏、新建标签 | 改变当前工作区布局 |
| 左下 `TIMELINE` | 看当前文件的版本历史 | 点某一条版本后进入 Diff 对比 |

## 2. 完整功能清单

下面这张表是“用户看得到”的完整功能总表。

| 功能域 | 入口 | 你要做什么 | 系统会发生什么 |
| --- | --- | --- | --- |
| 新建资源 | 左上 `+` | 新建文件 / 会话 / 文件夹 / 上传文件 | 资源会出现在左侧文件树 |
| 文件右键菜单 | 文件树里右键文件或文件夹 | 新建、重命名、复制、粘贴、下载、删除、在新 Pane 打开 | 对应资源状态立即变化 |
| 文件拖拽移动 | 在文件树里拖动文件 | 拖到文件夹内，或拖到目标前后 | 文件层级改变 |
| 文件拖到 Pane 打开 | 从文件树把文件拖到右侧窗格 | 把文件丢进目标窗格 | 文件会在该 Pane 打开 |
| Tab 管理 | Pane 顶部标签栏 | 切换、关闭、拖动标签 | 当前视图改变，或标签移动到别的 Pane |
| 分屏 | Pane 顶部 `Split Pane` | 连续点一次或多次 | 会新增空窗格 |
| 新标签 | Pane 顶部 `New Tab` | 新建 Markdown 或新建 Chat | 当前 Pane 新增标签 |
| Markdown 编辑 | 打开 `.md` 文件 | 直接输入、修改内容 | 文件内容更新，后续会进入版本历史 |
| 选区菜单 | 在编辑器里选中文本后右键 | 复制 Markdown、剪切 Markdown、导入引用、打开临时对话框 | 会出现上下文菜单 |
| Temporary Dialog | 选区菜单里打开 | 选择目标会话，点 `Check` 或 `Fix` | 选中内容被发送到指定 Session |
| Session 会话 | 打开 `Session` 标签 | 发消息、调权限、看引用、看任务 | AI 根据可见上下文回答或执行任务 |
| Context Files 权限 | Session 顶部文件胶囊右侧按钮 | 在 `Read / Write / Hidden` 间切换 | AI 对该文件的可见性和写权限改变 |
| Session References | Session 顶部 `Session References` | 查看已导入片段，删除引用 | 后续回答会优先使用这些片段 |
| Task Board | Session 中部任务条 | 展开、查看状态、继续、取消、重试 | 看到 AI 任务执行进度 |
| Agent Tool Records | AI 回复气泡上方 | 展开 Calls / Results | 看到 AI 实际调用了哪些工具 |
| PDF 阅读 | 打开 PDF 标签 | 翻页、跳页、缩放、旋转 | 当前阅读位置改变 |
| Pending Diff 审阅 | 文档进入 pending diff 状态时 | 单行审阅或 `Accept All / Reject All` | 改动被接受或丢弃 |
| Timeline 版本历史 | 左下时间线 | 展开时间线，点一条版本 | 进入版本 Diff 对比 |
| 版本 Diff 对比 | 时间线点某个版本后 | 切换 `Split / Inline`，退出 Diff | 对比历史版本和当前内容 |

## 3. 文件区怎么用

### 3.1 新建文件、会话、文件夹、上传文件

![新建菜单](../output/playwright/user-manual-zh/02-root-add-menu.png)

图 2：点击左上角路径条右侧的 `+`，会弹出新建菜单。

你就按下面做：

1. 点左上角路径条右侧的 `+`。
2. 选 `New File`、`New Session`、`New Folder` 或 `Upload File`。
3. 如果是创建类操作，输入名字后点 `Create`。

![新建文件对话框](../output/playwright/user-manual-zh/03-new-file-dialog.png)

图 3：新建文件时会弹出输入框。

这里有两个容易忽略的点：

1. 文件名可以直接写路径，比如 `project/notes/todo.md`，系统会按路径创建。
2. `Session` 不是普通文件。它是“和 AI 聊天的容器”。你要和 AI 说话，必须打开一个 Session。

### 3.2 文件右键菜单

![文件右键菜单](../output/playwright/user-manual-zh/04-file-context-menu.png)

图 4：在文件树里右键，会看到完整上下文菜单。

右键菜单各项的真实作用如下：

| 菜单项 | 你在做什么 | 会发生什么 |
| --- | --- | --- |
| `New File` | 在当前位置创建新 Markdown 文件 | 左侧树里出现新文件 |
| `New Session` | 在当前位置创建新会话 | 左侧树里出现新 Session |
| `New Folder` | 在当前位置创建新文件夹 | 左侧树里出现新文件夹 |
| `Open in New Pane` | 不在当前窗格打开，另开一个窗格 | 右侧会多一个 Pane，文件在新 Pane 打开 |
| `Rename` | 重命名 | 文件树里的名字立即变化 |
| `Copy` | 复制一个资源定义 | 后续可以 `Paste` 出一个副本 |
| `Paste` | 粘贴复制内容 | 会创建一个带 `(copy)` 后缀的副本 |
| `Download` | 下载当前文件 | 文件会被浏览器下载到本地 |
| `Delete` | 删除当前资源 | 资源从树里消失 |

补充说明：

1. 文件夹支持拖拽移动文件。
2. 文件也可以直接拖到右边 Pane 里打开。
3. 文件夹右侧悬浮的 `+` 是“在这个文件夹里继续新增”。

## 4. Markdown 笔记怎么用

![Markdown 编辑区](../output/playwright/user-manual-zh/05-markdown-editor.png)

图 5：打开 `.md` 文件后，你就在这个区域写内容。

你在这里能做的事很直接：

1. 直接输入标题、正文、列表、公式、代码块。
2. 修改内容后，系统会保存文件，并把改动放进版本历史。
3. 这个编辑区也是后面 Diff 审阅和版本对比的基础。

你实际会看到的效果：

1. 左侧时间线会逐渐出现 `Content updated` 之类的版本记录。
2. 如果 AI 对文档提出改动，你会直接进入 pending diff 审阅态。

## 5. 选区右键菜单和 Temporary Dialog

### 5.1 选中文本后右键

![选区右键菜单](../output/playwright/user-manual-zh/06-selection-context-menu.png)

图 6：先选中文本，再右键，才会出现这个菜单。

这个菜单不是装饰，功能很实用：

| 菜单项 | 用途 | 结果 |
| --- | --- | --- |
| `Copy Selection as Markdown` | 按 Markdown 语义复制 | 粘贴出去时尽量保留 Markdown 结构 |
| `Cut Selection as Markdown` | 剪切当前选区 | 选区内容被移除，并进入剪贴板 |
| `Import As Reference` | 把选区导入当前会话引用区 | Session References 会出现一条引用 |
| `Open Temporary Dialog (Fix / Check)` | 把当前选区作为一次临时任务发给某个会话 | 弹出临时对话框 |

### 5.2 Temporary Dialog 怎么用

![Temporary Dialog](../output/playwright/user-manual-zh/07-temp-dialog.png)

图 7：Temporary Dialog 会把“当前选区”和“目标会话”绑在一起。

你就按下面做：

1. 先打开一个 Session。
2. 回到 Markdown 文件，选中文本并右键。
3. 点 `Open Temporary Dialog (Fix / Check)`。
4. 在 `Target Session` 里选会话。
5. 点 `Check Selection` 或 `Fix Selection`。

两个按钮的区别：

1. `Check Selection`：更像“帮我检查这段内容有没有问题”。
2. `Fix Selection`：更像“直接帮我修这段内容”。

如果你没先打开任何 Session，这里会没有可选目标。这不是 bug，是你步骤错了。

## 6. 分屏、多 Pane、Tab

![多窗格布局](../output/playwright/user-manual-zh/08-multi-pane-layout.png)

图 8：点 `Split Pane` 后，会在右侧新增空窗格。

你在 Pane 顶部能做 4 件核心事情：

1. 点标签切换当前内容。
2. 点标签右侧 `x` 关闭标签。
3. 点 `Split Pane` 新增窗格。
4. 点 `New Tab` 新建 `New Markdown` 或 `New Chat`。

这部分的使用原则非常简单：

1. 你想并排看内容，就分屏。
2. 你想在同一个窗格里开多个内容，就加 Tab。
3. 你想把一个文件扔到另一个窗格，就拖标签或从文件树拖文件过去。

## 7. Session 会话区怎么用

![Session 会话区](../output/playwright/user-manual-zh/09-session-chat-and-permissions.png)

图 9：这是你和 AI 真正交互的地方。

你先看懂这块的结构：

1. 顶部 `Context Files`：决定 AI 能看哪些文件，以及能不能写。
2. `Session References`：存放你主动导入给 AI 的片段。
3. `Task Board`：看任务数量、状态、暂停与恢复。
4. 消息区：显示用户消息、AI 回复、Agent Action、Agent Tool Records。
5. 底部输入框：输入你的问题，按回车发送。

### 7.1 Context Files 三种权限是什么意思

| 权限状态 | 图标含义 | AI 能做什么 |
| --- | --- | --- |
| `Read permission` | 眼睛 | 只能读，不能改 |
| `Write permission` | 铅笔 | 可以读，也可以提出或执行改动 |
| `Hidden from AI` | 斜眼睛 | AI 当这个文件不存在 |

这部分你必须理解清楚：

1. 你不给权限，AI 就不应该碰这个文件。
2. 你给 `Write`，AI 才有机会进入改写、Diff、版本流程。
3. 你把文件设成 `Hidden`，它不会进入上下文。

### 7.2 发送消息后会发生什么

图 9 里你已经能看到一次完整响应链路：

1. 右侧黑色气泡是用户消息。
2. 中间白色气泡是 AI 回复。
3. `Agent Action` 表示 AI 内部任务开始了。
4. `Agent Tool Records` 展示 AI 实际调用了哪些工具，以及工具返回了什么。

这点非常重要：

1. 不要只看 AI 最后的自然语言。
2. 真正有价值的是它到底读了什么、查了什么、写了什么。
3. `Calls` 和 `Results` 就是给你做核对的。

## 8. PDF 阅读器怎么用

![PDF 阅读器](../output/playwright/user-manual-zh/10-pdf-viewer.png)

图 10：打开 PDF 后，会进入专门的 PDF 阅读器。

PDF 工具栏能做这些事：

| 控件 | 用途 | 效果 |
| --- | --- | --- |
| 上一页 / 下一页 | 翻页 | 页码变化 |
| 页码输入框 | 直接跳页 | 跳到指定页 |
| `Zoom in / Zoom out` | 缩放 | 页面比例变化 |
| `Rotate` | 旋转 | PDF 旋转 90 度 |

对用户最有用的一点是：

1. 你读 PDF 时，系统会记录当前阅读位置。
2. 之后如果你在 Session 里问 AI，它可以把“当前看到的页”当成上下文线索之一。

## 9. Pending Diff 审阅怎么用

![Pending Diff](../output/playwright/user-manual-zh/11-pending-diff.png)

图 11：当 AI 提出改动但还没正式写入时，文档会进入 pending diff 模式。

你在这里看到的颜色含义：

1. 红色：准备删除的旧内容。
2. 绿色：准备新增的内容。
3. 顶部 `Prev / Next`：在待处理行之间跳转。
4. 顶部 `Accept All / Reject All`：一次性决定整批改动。

这一步的正确理解是：

1. AI 并不是一改就直接落盘。
2. 你先看差异，再决定收不收。
3. 这就是一个“人工兜底”的安全阀。

## 10. Timeline 时间线怎么用

![时间线](../output/playwright/user-manual-zh/12-timeline.png)

图 12：左下角 `TIMELINE` 会列出当前文件的历史版本。

你要怎么用：

1. 先点开某个文件。
2. 再展开左下 `TIMELINE`。
3. 看每一条版本记录的摘要、时间、作者。
4. 点其中一条记录，进入版本 Diff 对比。

你能从这里确认三件事：

1. 这份文件到底被改过几次。
2. 哪次改动是你手动改的，哪次是 AI 或其他流程触发的。
3. 某次改动的摘要到底是什么。

## 11. 版本 Diff 对比怎么用

![版本 Diff 对比](../output/playwright/user-manual-zh/13-version-diff.png)

图 13：点击时间线中的一条版本后，会进入版本对比视图。

你在这里能做的事：

1. 看 `ORIGINAL` 和 `MODIFIED` 的并排差异。
2. 在 `Split` 和 `Inline` 之间切换显示方式。
3. 点 `Exit Diff` 退出对比，回到正常编辑视图。
4. 如果这是一次可接收的对比，还可以用右下角 `Accept All / Reject All`。

这个视图和 pending diff 的区别是：

1. `Pending Diff` 是“还没最终确认的改动”。
2. `Version Diff` 是“从历史版本回看一次已记录的改动”。

## 12. 你最容易搞混的 8 件事

1. `Session` 不是文档，它是 AI 对话容器。
2. 你不打开 Session，就没法和 AI 进行完整交互。
3. `Read` 和 `Write` 不一样。想让 AI 改文档，必须给 `Write`。
4. `Hidden from AI` 不是删除文件，只是不让 AI 看。
5. 选区右键菜单只会在“你先选中文本”之后出现。
6. `Temporary Dialog` 如果没有目标会话可选，说明你还没先打开 Session。
7. `Pending Diff` 不是已经改完了，它是等你审批。
8. `Timeline` 不是聊天历史，它是文件版本历史。

## 13. 系统背后还有哪些能力

这些能力不是让你直接点的，但你能在界面里看到效果：

| 系统能力 | 你在界面里会看到什么 |
| --- | --- |
| Agent 读取类工具 | `Agent Tool Records` 里出现读取文档、提取大纲、检索片段的调用记录 |
| Agent 写入类工具 | 文档进入 pending diff 或产生版本记录 |
| 任务与暂停控制 | `Task Board` 和暂停提示区显示状态、继续、取消、重试 |
| 阅读位置跟踪 | 你切 PDF 页码后，AI 更容易围绕当前页回答 |
| WebSocket 连接状态 | Session 头部显示 `Connected / Reconnecting / Connecting...` |
| 版本一致性 | `TIMELINE` 和版本 Diff 可以回溯改动 |

## 14. 测试视角下的完整功能域

下面这部分是按当前测试 catalog 整理的“完整功能域”，比普通用户会看到的范围更全。

| 功能域 ID | 中文说明 | 是否直接面向普通用户 |
| --- | --- | --- |
| `file.lifecycle` | 文件上传 / 新建 / 移动 / 删除 | 是 |
| `pane.layout_and_tabs` | 分屏与 Tab 拖拽 | 是 |
| `session.context_permissions` | Session 权限与上下文过滤 | 是 |
| `agent.tools.read` | Agent 读取类工具 | 间接可见 |
| `agent.tools.write` | Agent 写入类工具 | 间接可见 |
| `agent.tools.task_control` | 任务、暂停、恢复 | 是 |
| `diff.pending_review` | Pending Diff 审阅 | 是 |
| `version.history_consistency` | 历史版本与回溯一致性 | 是 |
| `viewport.context_tracking` | 阅读位置上下文注入 | 间接可见 |
| `stability.runtime_observability` | 控制台 / 网络 / WS 可观测 | 主要给测试和排障 |
| `editor.inline_math_enter` | 行内公式换行稳定性 | 是 |
| `editor.block_math_render` | 块级公式即时渲染 | 是 |
| `editor.copy_markdown` | 复制 Markdown 语义保持 | 是 |
| `editor.reference_contextmenu` | 选区引用与临时对话流 | 是 |
| `pdf.last_page_scroll` | PDF 末页翻页稳定性 | 是 |
| `theme.newspaper_baseline` | 视觉主题基线 | 是 |
| `coverage.unmapped.routes` | 未映射 API 路由覆盖兜底 | 否 |
| `coverage.unmapped.ui` | 未映射 UI 节点覆盖兜底 | 否 |

## 15. 给第一次使用的人一个最稳的上手流程

如果你只想把系统跑顺，照这个顺序来：

1. 在左侧新建一个 Markdown 文件。
2. 在左侧新建一个 Session。
3. 打开 Markdown 文件和 Session。
4. 在 Session 顶部把 Markdown 文件权限切到 `Write`。
5. 在输入框里告诉 AI：你要它读、查、改、还是总结。
6. 如果 AI 提出改动，进 `Pending Diff` 审阅。
7. 如果你想回头看历史，打开 `TIMELINE`。
8. 如果你想并排对照多个内容，点 `Split Pane`。

这就是 Cognition 最核心的使用方法。
