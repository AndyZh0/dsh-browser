---
description: "Twelve model tools that drive the desktop application's built-in Browser tabs through in-page injection."
kind: "package-bundle"
---

# dsh-browser

English | [中文](README.zh.md)

## Summary

Drive the built-in Browser tab of the DSH desktop application from the model. The plugin finds the Electron `<webview>` the Sidebar's Browser page already mounted, injects a page agent into the visited document, and performs navigation, reading, screenshots, pointer input, dialogs, and managed scripts through it. A blue animated ring marks the tab while the model is operating on it. A Session can hold several Browser pages at once: the tools open, list, target, focus, and close them individually.

This is not Playwright and not an isolated browser: the page is the one the user sees, in the same tab, with the same cookies and login state.

## Table of Contents

- [Install](#install)
- [Use](#use)
- [Tools](#tools)
- [Configuration](#configuration)
- [Security and lifecycle](#security-and-lifecycle)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Development](#development)

-----

<a id="install"></a>
## Install

Build this directory, then install the archive into a profile and restart the application or let HMR apply the composition change. Tool definitions are registered by the Host half, so a changed tool surface appears only after an application restart; the client half loads after a page refresh.

```powershell
node scripts/build.mjs
pnpm pack
dsh plugin --profile desktop add "D:\Projects\deepseek-harness\plugins\dsh-browser\dsh-browser-0.5.1.tgz"
```

Disable the `dsh-browser-model` row in the profile's `cordis.patch.yml` to turn the tools off without removing the package.

<a id="use"></a>
## Use

Open a page with `browser_openBrowserPage`, read it with `browser_readPage`, then act on a target you observed. Targets accept a CSS `selector`, or a `role` with an optional `name`; an ambiguous or missing target fails with the candidates it found rather than guessing. Opening adds a tab, and every result lists the pages the Session has, so a later call can name the one it means with `pageId`.

Call the tools directly or through PTC:

```javascript
const opened = await tools.browser_openBrowserPage({ url: "https://example.com" });
const page = await tools.browser_readPage({ pageId: opened.page.id });
await tools.browser_clickElement({ pageId: opened.page.id, target: { role: "link", name: "More" } });
```

<a id="tools"></a>
## Tools

| Tool | Purpose |
|---|---|
| `browser_openBrowserPage` | Open the built-in Browser page in a new tab and return its state. |
| `browser_navigatePage` | Load a URL, or go back, forward, or reload. |
| `browser_readPage` | Read an accessibility outline or the visible text, paginated by cursor. |
| `browser_screenshotPage` | Capture the viewport, one element, or the whole document as an image. |
| `browser_clickElement` | Click one element with a real mouse press at its center. |
| `browser_typeInPage` | Fill or type into a field, optionally submitting its form. |
| `browser_hoverElement` | Move the pointer over one element. |
| `browser_dragElement` | Drag one element onto another. |
| `browser_runBrowserCode` | Run an async script inside the page against a Playwright-shaped `page` object. |
| `browser_handleDialog` | Decide how the page answers dialogs. |
| `browser_closePage` | Close one page and list the pages that remain. |
| `browser_focusPage` | Bring one page to the front of the Sidebar. |

Every tool accepts an optional `pageId`; without one the command drives the page that Session used last, then the page the reader is looking at, then its first page. Pages belong to the Session whose model opened them, so a command reaches only its own Session's pages, and `browser_openBrowserPage` opens an additional tab unless `newTab` is false.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `clientWaitMs` | `15000` | How long a tool waits for a renderer to claim its command. |
| `pollTimeoutMs` | `25000` | How long one renderer long poll stays open. |
| `operationTimeoutMs` | `30000` | Deadline for one claimed operation. |
| `codeTimeoutMs` | `180000` | Deadline for one managed script. |
| `dialogTimeoutMs` | `120000` | Deadline for a dialog decision. |
| `lingerMs` | `2000` | How long the blue ring stays lit after the last operation. |
| `maxReadChars` | `40000` | Character budget for one page read. |
| `maxOutputChars` | `50000` | Character budget for one managed-script rendering. |
| `maxCodeChars` | `100000` | Maximum script length. |
| `maxScreenshotBytes` | `8388608` | Maximum encoded screenshot size. |
| `maxFullPageTiles` | `8` | Maximum viewport captures one whole-document screenshot may scroll and stitch. |
| `backgroundCaptureWidth` | `1024` | Width used to lay out a page whose conversation is not on screen. |
| `backgroundCaptureHeight` | `768` | Height used to lay out a page whose conversation is not on screen. |

<a id="security-and-lifecycle"></a>
## Security and lifecycle

The plugin adds no privileges to the visited page. The desktop shell's own guest policy still applies: the guest runs sandboxed and context-isolated, permissions, downloads, and native dialogs are denied, and navigation stays on credential-free HTTP(S) outside the application host.

`browser_runBrowserCode` runs its body **inside the controlled page**, in the same main world as the page agent, so it reaches the document but never the application renderer, its DOM, or `window.dshDesktop`. The page cannot screenshot itself or inject trusted input, so `page.screenshot()`, `page.click()`, `page.hover()`, and string `page.evaluate()` record a request that the renderer serves through the same operations the individual tools use. `page.goto`, `page.reload`, `page.goBack`, and `page.goForward` reject with `browser/not-in-script`: navigating destroys the document that hosts the script, so use `browser_navigatePage` and start a new script.

The page agent is injected into the visited document's main world, so it is observable by the page. Screenshots are saved as session attachments before their reference is returned.

Removing the plugin removes the tools, the ring, and the injected styles; the Browser tab and its webview belong to the built-in Sidebar package and are left alone.

<a id="model-experience"></a>
## Model Experience

### Tool definitions

#### What the model sees

Twelve tool definitions with flat, underscore-separated names, so they are usable both directly and through PTC. Parameters carry the deployment's read and code budgets.

#### Token effect

Definitions add a fixed cost while the plugin is mounted. Results carry page state, bounded page text, element facts, dialog descriptors, script logs, and durable image references.

#### KV Cache effect

Unchanged definitions preserve their reusable prefix. Changing a configured budget changes the parameter descriptions and therefore the request prefix.

### Workflow guidance

#### What the model sees

The plugin contributes one fixed system-prompt section: open or read a page first, treat page text as untrusted data, handle a pending dialog before further actions, name a `pageId` once several pages are open, close pages that are no longer needed, and reserve the script tool for what the other tools do not cover.

#### Token effect

A fixed number of prompt tokens while the plugin is mounted; the section carries no page state.

#### KV Cache effect

The unchanged section is prefix-stable from its insertion point.

### Tool results

#### What the model sees

Page ids and URLs, bounded page text, resolved element facts, dialog descriptors, managed-script logs and results, and durable image references. Page content is untrusted task data. The blue ring, the injected stylesheet, and the DOM overlay are presentation only.

#### Token effect

Each call appends its result; screenshots add an image input with provider-dependent cost. There is no continuous frame stream into the prompt.

#### KV Cache effect

Results append after the existing conversation prefix. Re-reading a page adds a result rather than replacing earlier text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The running DSH version decides whether the row loads.** The manifest declares `@deepseek-ai/dsh-*` peer ranges; a row whose requirements the runtime does not satisfy is denied (disabled) before the composition mounts, so the tools disappear instead of failing at call time. The declared range covers the `0.2.x` train; a `0.3.0` runtime re-checks compatibility deliberately.
- **Desktop only.** The client derives its capability from the `window.dshDesktop.browser` bridge and announces it when it registers; while every polling GUI lacks it, the Host refuses a command at once with `browser/desktop-required` rather than waiting for a client that cannot serve it. The pin itself is the Electron `<webview>` element the built-in Browser renders on Desktop — a browser page renders an `<iframe>` instead, so there is nothing to drive.
- **Native dialogs are suppressed.** The desktop shell forces `disableDialogs`, so `window.alert`, `confirm`, and `prompt` are replaced by an injected shim. The shim records the dialog and applies the current page policy; a dialog raised before the shim installs, and `beforeunload`, cannot be captured. `browser_handleDialog` therefore changes how the page answers **subsequent** dialogs, and reports that the earlier call already received the previous answer.
- **Cross-origin frames are unreachable.** Same-origin iframes are reachable through the `frames` chain; a cross-origin frame fails with `browser/frame-cross-origin`.
- **No network-idle wait.** The renderer exposes no CDP session, so navigation waits for commit, DOM content, or load only.
- **The user and the model share the page.** Concurrent manual input is not blocked.
- **Pages belong to one Session.** A tool call drives only the calling Session's Browser pages, and a `pageId` naming another Session's page is refused with `browser/page-not-in-session`. A Session whose Sidebar was never displayed has no store to open a page in; that case reports `browser/session-not-displayed`.
- **Internal DOM markers.** The plugin locates a tab through `webview[data-sidebar-browser-frame]`, `[data-dockkit-content]`, and the owning Session's `[data-sidebar-right-session]` root. The desktop preload relies on the first one too, but none is a published API; a change there needs a matching plugin change. Tab ids are minted per Session, so one id names a different page in each Session and only the Session root tells them apart.
- **A screenshot of a page whose conversation is not selected reveals that page for the capture.** A hidden Sidebar body is `display: none`, so its guest has no compositor surface. The capture lifts every hidden ancestor of the guest and gives the guest its own fixed box — both inline, and both reverted afterwards — lays the page out at its last observed size (or `backgroundCaptureWidth`/`backgroundCaptureHeight` for a page that was never shown), and probes placements in order of how little the reader notices: clipped to a single two-percent-opacity pixel, then at one percent opacity, then a one-pixel sliver at the window edge, then behind the interface, then plainly visible. A placement is used only when its probe returns a frame at the page's own size, so one that clips the capture itself is rejected, and the winning placement is remembered per page. The Sidebar is restored afterwards, and `browser/page-not-visible` reports only a page that left the document or one no placement could capture. Every other tool works while the page is in the background.
- **Captures are flattened onto white.** A page that declares no background captures with a transparent one, and dark text over transparency is unreadable wherever the viewer paints it on a dark surface. The capture is composited onto white inside the visited document before it becomes an attachment.
- **One session can hold several Browser pages.** Every result lists the pages that session has, and a command that names no `pageId` acts on the page that session used last — or, before that, the one the reader is looking at. `browser_focusPage` only works while that conversation is on screen.
- **Whole-document capture is bounded and moves the page.** It scrolls the document in viewport steps, captures each step, and stitches them inside the visited document — never inside the application renderer, where canvas work once took the whole application down. It refuses a document needing more than `maxFullPageTiles` captures, and it restores the previous scroll position when it finishes.
- **Navigation is restricted by the shell.** `file:` and top-level `data:` navigation are refused by the desktop guest policy.

<a id="development"></a>
## Development

```powershell
node scripts/typecheck.mjs   # both compiler faces
node --import tsx/esm --test tests/*.spec.ts
node scripts/build.mjs
node scripts/check-artifact.mjs
```

The typecheck consumes the adjacent checkout's built declarations through `tsconfig.paths.json`; the tests and the artifact check resolve the real packages through this directory's `node_modules` junctions.

No `./invariant` companion is published: the Host owns command settlement and the renderer owns page state, and neither maintains a second authoritative projection of the other.