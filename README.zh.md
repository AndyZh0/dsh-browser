---
description: "十二个工具，通过页面注入驱动桌面应用内置的 Browser 标签页。"
kind: "package-bundle"
---

# dsh-browser

[English](README.md) | 中文

## 概述

让模型操作 DSH 桌面应用内置的 Browser 标签页。插件直接取得侧栏 Browser 页面已经挂载的 Electron `<webview>`，向被访问文档注入一个页面代理，并通过它完成导航、读取、截图、指针输入、对话框与托管脚本。模型操作期间，该标签页会显示一圈蓝色动态边框。一个会话可以同时持有多个 Browser 页面：工具可以分别打开、列出、指定、切到前台与关闭它们。

它不是 Playwright，也不是隔离浏览器：被操作的就是用户眼前那个标签页，cookie 与登录态都相同。

## 目录

- [安装](#安装)
- [使用](#使用)
- [工具](#工具)
- [配置](#配置)
- [安全与生命周期](#安全与生命周期)
- [模型体验](#模型体验)
- [已知限制](#已知限制)
- [开发](#开发)

-----

<a id="安装"></a>
## 安装

在本目录构建后，把压缩包安装到 profile，并重启应用或让 HMR 应用组合变更。工具定义由 Host 半边注册，因此**工具面的变化只有重启应用后才出现**；客户端部分在页面刷新后加载。

```powershell
node scripts/build.mjs
pnpm pack
dsh plugin --profile desktop add "D:\Projects\deepseek-harness\plugins\dsh-browser\dsh-browser-0.5.1.tgz"
```

在 profile 的 `cordis.patch.yml` 中把 `dsh-browser-model` 行设为 `disabled: true`，即可在不卸载的前提下关闭全部工具。

<a id="使用"></a>
## 使用

先用 `browser_openBrowserPage` 打开页面，再用 `browser_readPage` 读取，然后操作你在页面里观察到的目标。目标可以用 CSS `selector`，也可以用 `role` 加可选的 `name`；目标缺失或有歧义时会直接失败并列出候选，不会猜测。每次打开都会新增一个标签页，而每次结果都会列出该会话的页面，因此后续调用可以用 `pageId` 指定要操作的那一个。

<a id="工具"></a>
## 工具

| 工具 | 作用 |
|---|---|
| `browser_openBrowserPage` | 在新标签页中打开内置 Browser 页面并返回其状态。 |
| `browser_navigatePage` | 加载 URL，或后退、前进、刷新。 |
| `browser_readPage` | 读取可访问性大纲或可见文本，用 cursor 分页。 |
| `browser_screenshotPage` | 截取视口、单个元素或整页。 |
| `browser_clickElement` | 在元素中心发送真实鼠标点击。 |
| `browser_typeInPage` | 填充或逐字输入，可选提交表单。 |
| `browser_hoverElement` | 将指针移到元素上。 |
| `browser_dragElement` | 把一个元素拖到另一个元素上。 |
| `browser_runBrowserCode` | 在页面内用类 Playwright 的 `page` 对象执行异步脚本。 |
| `browser_handleDialog` | 决定页面如何回答对话框。 |
| `browser_closePage` | 关闭一个页面，并列出剩余页面。 |
| `browser_focusPage` | 把某个页面切到侧栏前台。 |

所有工具都接受可选的 `pageId`；缺省时作用于该会话**最近使用**的页面，其次是读者正在看的那个，最后才是它的第一个页面。页面属于打开它的那个会话，因此命令只能触达本会话自己的页面；`browser_openBrowserPage` 默认新增标签页，传 `newTab: false` 才复用。

<a id="配置"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `clientWaitMs` | `15000` | 工具等待渲染进程认领命令的时限。 |
| `pollTimeoutMs` | `25000` | 单次长轮询的挂起时限。 |
| `operationTimeoutMs` | `30000` | 单个已认领操作的时限。 |
| `codeTimeoutMs` | `180000` | 单个托管脚本的时限。 |
| `dialogTimeoutMs` | `120000` | 对话框决策的时限。 |
| `lingerMs` | `2000` | 最后一次操作后蓝框保留的时长。 |
| `maxReadChars` | `40000` | 单次页面读取的字符上限。 |
| `maxOutputChars` | `50000` | 单次脚本结果渲染的字符上限。 |
| `maxCodeChars` | `100000` | 脚本长度上限。 |
| `maxScreenshotBytes` | `8388608` | 截图编码字节上限。 |
| `maxFullPageTiles` | `8` | 整页截图最多滚动并拼接的视口分片数。 |
| `backgroundCaptureWidth` | `1024` | 对话未选中时，页面按此宽度布局以完成截图。 |
| `backgroundCaptureHeight` | `768` | 对话未选中时，页面按此高度布局以完成截图。 |

<a id="安全与生命周期"></a>
## 安全与生命周期

插件不会给被访问页面增加任何权限。桌面外壳自身的访客策略依然生效：访客运行在沙箱与上下文隔离中，权限、下载与原生对话框被拒绝，导航被限制在应用 host 之外的无凭据 HTTP(S)。

`browser_runBrowserCode` 的脚本体运行在**被访问页面内部**，与页面代理同一个主世界，因此能触达文档本身，但碰不到应用渲染进程、应用 DOM 或 `window.dshDesktop`。页面无法自截屏、也无法注入可信输入，所以 `page.screenshot()`、`page.click()`、`page.hover()` 与字符串形式的 `page.evaluate()` 会登记请求，由渲染进程用与单工具相同的操作完成。`page.goto`、`page.reload`、`page.goBack`、`page.goForward` 会以 `browser/not-in-script` 拒绝：导航会销毁承载脚本的文档，请改用 `browser_navigatePage` 后另起一个脚本。

页面代理注入到被访问文档的主世界，页面本身可以观察到它。截图会先保存为会话附件，再返回引用。

卸载插件会移除工具、蓝框与注入的样式；Browser 标签页及其 webview 属于内置侧栏包，不受影响。

<a id="模型体验"></a>
## 模型体验

- **工具定义**：十二个使用下划线命名的扁平工具定义，因此原生调用与 PTC 都可用；参数里带有部署的读取与脚本预算。
- **工作流指引**：插件贡献一个固定的系统提示章节——先打开或读取页面，把页面文本当作不可信数据，遇到挂起对话框先处理，开了多个页面后用 `pageId` 指明目标，不再需要的页面及时关闭，脚本工具只用于其他工具覆盖不到的场景。
- **工具结果**：页面 id 与 URL、有界页面文本、解析出的元素事实、对话框描述、脚本日志与结果、持久图片引用。页面内容是任务数据，不是指令。蓝框、注入样式与 DOM 覆盖层只是表现层。

<a id="已知限制"></a>
## 已知限制

- **是否加载由运行时版本决定**：manifest 声明 `@deepseek-ai/dsh-*` 的 peer 区间；运行时不满足时，该行会在组合装载前被判定不兼容并禁用，因此工具会直接消失，而不是调用时才失败。声明的区间覆盖 `0.2.x`；`0.3.0` 运行时会重新判定兼容性。
- **仅限桌面端**：客户端从 `window.dshDesktop.browser` 桥推出自身能力，并在注册时上报；当所有正在轮询的 GUI 都不具备该能力时，Host 会**立即**以 `browser/desktop-required` 拒绝命令，而不是等一个根本服务不了的客户端。真正的绑定点是内置 Browser 在桌面端渲染的 Electron `<webview>` 元素——浏览器页面渲染的是 `<iframe>`，没有可驱动的对象。
- **原生对话框被抑制**：桌面外壳强制 `disableDialogs`，因此 `window.alert`、`confirm`、`prompt` 被替换为注入的 shim。shim 会记录对话框并套用当前页面策略；shim 安装之前抛出的对话框以及 `beforeunload` 无法捕获。因此 `browser_handleDialog` 改变的是**后续**对话框的答案，并会说明此前那次调用已经收到旧答案。
- **跨域 iframe 不可达**：同源 iframe 可以通过 `frames` 链下钻；跨域会以 `browser/frame-cross-origin` 失败。
- **没有 networkidle 等待**：渲染进程拿不到 CDP 会话，导航只能等待 commit、DOM content 或 load。
- **用户与模型共用同一页面**：不会阻止手动并发输入。
- **页面属于单个会话**：工具调用只驱动发起会话自己的 Browser 页面；`pageId` 若指向别的会话的页面，会以 `browser/page-not-in-session` 拒绝。从未显示过的会话没有 store 可用于打开页面，这种情况报 `browser/session-not-displayed`。
- **依赖内部 DOM 标记**：插件通过 `webview[data-sidebar-browser-frame]`、`[data-dockkit-content]` 以及所属会话的 `[data-sidebar-right-session]` 根节点定位标签页。桌面 preload 也依赖第一个，但三者都不是公开 API；一旦变更需要同步修改插件。标签 id 按会话生成，同一个 id 在不同会话里指向不同页面，只有会话根节点能区分。
- **对话未选中时，截图会临时把该页面显影**：隐藏的侧栏主体是 `display: none`，其 guest 没有合成表面。截图会**逐层解除 guest 之上被隐藏的祖先**并给 guest 自己一个固定盒子（都是内联改动，结束后逐一还原），以**最近一次观测到的尺寸**布局该页面（从未显示过的页面用 `backgroundCaptureWidth`/`backgroundCaptureHeight`），再按对读者打扰最小的顺序探测放置：裁剪成一个 2% 不透明度的像素 → 1% 不透明度 → 窗口边缘的 1 像素细线 → 界面之后 → 直接可见。**只有当探测返回的帧是页面本身的尺寸时该放置才被采用**（因此会裁剪掉捕获帧的放置会被拒绝），胜出的放置按页面记住。结束后恢复侧栏。`browser/page-not-visible` 现在只表示页面已离开文档，或三种放置都拿不到帧。其余工具在页面处于后台时本就可用。
- **截图会压到白底**：未声明背景的页面会以透明背景截图，而深色文字落在透明背景上、再被深色界面合成后就不可读。截图在**被访问的文档内**先合成到白底，再成为附件。
- **一个会话可以同时有多个 Browser 页面**：每次结果都会列出该会话的页面；不带 `pageId` 的命令作用于该会话**最近使用**的页面（在此之前则是读者正在看的那个）。`browser_focusPage` 只在对应会话处于屏幕上时可用。
- **整页截图有界，且会滚动页面**：它按视口高度逐屏滚动、逐屏截图，并在**被访问的文档内**拼接——绝不在应用渲染进程里做，那里曾经把整个应用拖崩过。超过 `maxFullPageTiles` 屏会直接拒绝，结束后会恢复原来的滚动位置。
- **导航受外壳限制**：`file:` 与顶层 `data:` 导航会被桌面访客策略拒绝。

<a id="开发"></a>
## 开发

```powershell
node scripts/typecheck.mjs   # 两个编译面
node --import tsx/esm --test tests/*.spec.ts
node scripts/build.mjs
node scripts/check-artifact.mjs
```

类型检查通过 `tsconfig.paths.json` 使用相邻 checkout 的已构建声明；测试与产物检查通过本目录的 `node_modules` 联接解析真实包。

不发布 `./invariant` 伴生模块：Host 拥有命令结算，渲染进程拥有页面状态，两者都没有维护对方状态的第二份权威投影。