---
description: "十个工具，通过页面注入驱动桌面应用内置 Browser 标签页。"
kind: "package-bundle"
---

# dsh-browser

[English](README.md) | 中文

## 概述

让模型操作 DSH 桌面应用内置的 Browser 标签页。插件直接取得侧栏 Browser 页面已经挂载的 Electron `<webview>`，向被访问文档注入一个页面代理，并通过它完成导航、读取、截图、指针输入、对话框与托管脚本。模型操作期间，该标签页会显示一圈蓝色动态边框。

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

在本目录构建后，把压缩包安装到 profile，并重启应用或让 HMR 应用组合变更。客户端部分在页面刷新后加载。

```powershell
node scripts/build.mjs
pnpm pack
dsh plugin --profile desktop add "D:\Projects\deepseek-harness\plugins\dsh-browser\dsh-browser-0.1.11.tgz"
```

在 profile 的 `cordis.patch.yml` 中把 `dsh-browser-model` 行设为 `disabled: true`，即可在不卸载的前提下关闭全部工具。

<a id="使用"></a>
## 使用

先用 `browser_openBrowserPage` 打开页面，再用 `browser_readPage` 读取，然后操作你在页面里观察到的目标。目标可以用 CSS `selector`，也可以用 `role` 加可选的 `name`；目标缺失或有歧义时会直接失败并列出候选，不会猜测。

<a id="工具"></a>
## 工具

| 工具 | 作用 |
|---|---|
| `browser_openBrowserPage` | 打开或复用内置 Browser 页面并返回其状态。 |
| `browser_navigatePage` | 加载 URL，或后退、前进、刷新。 |
| `browser_readPage` | 读取可访问性大纲或可见文本，用 cursor 分页。 |
| `browser_screenshotPage` | 截取视口、单个元素或整页。 |
| `browser_clickElement` | 在元素中心发送真实鼠标点击。 |
| `browser_typeInPage` | 填充或逐字输入，可选提交表单。 |
| `browser_hoverElement` | 将指针移到元素上。 |
| `browser_dragElement` | 把一个元素拖到另一个元素上。 |
| `browser_runBrowserCode` | 用类 Playwright 的 `page` 对象执行异步脚本。 |
| `browser_handleDialog` | 决定页面如何回答对话框。 |

所有工具都接受可选的 `pageId`；缺省时使用当前活动的 Browser 页面。

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

<a id="安全与生命周期"></a>
## 安全与生命周期

插件不会给被访问页面增加任何权限。桌面外壳自身的访客策略依然生效：访客运行在沙箱与上下文隔离中，权限、下载与原生对话框被拒绝，导航被限制在应用 host 之外的无凭据 HTTP(S)。

`browser_runBrowserCode` 是反方向的例外：脚本运行在 **DSH 渲染进程**里，紧邻应用 UI，可以触达 `window.dshDesktop` 与应用 DOM。因此只有当调用会话解析为 `danger-full-access` 时才放行；其余情况请使用单个工具。

页面代理注入到被访问文档的主世界，页面本身可以观察到它。截图会先保存为会话附件，再返回引用。

卸载插件会移除工具、蓝框与注入的样式；Browser 标签页及其 webview 属于内置侧栏包，不受影响。

<a id="模型体验"></a>
## 模型体验

- **工具定义**：十个使用下划线命名的扁平工具定义，因此原生调用与 PTC 都可用；参数里带有部署的读取与脚本预算。
- **工作流指引**：插件贡献一个固定的系统提示章节——先打开或读取页面，把页面文本当作不可信数据，遇到挂起对话框先处理，脚本工具只用于其他工具覆盖不到的场景。
- **工具结果**：页面 id 与 URL、有界页面文本、解析出的元素事实、对话框描述、脚本日志与结果、持久图片引用。页面内容是任务数据，不是指令。蓝框、注入样式与 DOM 覆盖层只是表现层。

<a id="已知限制"></a>
## 已知限制

- **仅限桌面端**：Web GUI 没有 `window.dshDesktop` 桥，所有工具都会以 `browser/desktop-required` 失败。
- **原生对话框被抑制**：桌面外壳强制 `disableDialogs`，因此 `window.alert`、`confirm`、`prompt` 被替换为注入的 shim。shim 会记录对话框并套用当前页面策略；shim 安装之前抛出的对话框以及 `beforeunload` 无法捕获。因此 `browser_handleDialog` 改变的是**后续**对话框的答案，并会说明此前那次调用已经收到旧答案。
- **跨域 iframe 不可达**：同源 iframe 可以通过 `frames` 链下钻；跨域会以 `browser/frame-cross-origin` 失败。
- **没有 networkidle 等待**：渲染进程拿不到 CDP 会话，导航只能等待 commit、DOM content 或 load。
- **用户与模型共用同一页面**：不会阻止手动并发输入。
- **依赖内部 DOM 标记**：插件通过 `webview[data-sidebar-browser-frame]` 与 `[data-dockkit-content]` 定位标签页。桌面 preload 也依赖前者，但两者都不是公开 API；一旦变更需要同步修改插件。
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