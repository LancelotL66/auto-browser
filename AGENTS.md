# auto-browser v3 — Agent Reference

Manual for AI agents (OpenCode, Claude Code, Codex, or any weaker model) driving
`auto-browser` from a shell. Read the **Core Loop** and **Element Kinds** sections
first; everything else is lookup material.

Command form: `auto-browser <cmd>` if installed globally, otherwise
`node bin/cli.mjs <cmd>` from the repo root.

---

## 0. TL;DR — the only workflow you need

```bash
auto-browser open <url>              # 1. navigate
auto-browser find "<text>"           # 2. discover: what's on the page, what can I do
auto-browser click @e12              # 3. act on a @ref from step 2
```

Every element you discover reports **what it is** (`kind`) and **what actions it
accepts** (`actions`). You never have to guess whether something is a button, a
dropdown, or a slider.

Chrome auto-launches on any command. You do **not** need to start Chrome yourself,
and you do **not** need `--remote-debugging-port` in your own Chrome.

---

## 1. Core Loop

### Step 1 — Navigate

```bash
auto-browser open https://example.com
```

Uses `domcontentloaded`, so SPAs and sites with long-polling (GitHub, Kaggle,
Nowcoder) don't hang. If content loads late:

```bash
auto-browser wait stable             # DOM stopped changing
auto-browser wait text "加载完成"     # specific text appeared
auto-browser wait selector "#app"    # specific node appeared
```

### Step 2 — Discover

Three commands. Pick based on what you want:

| Goal | Command |
|---|---|
| Find a specific control by its label | `find "登录"` |
| Find all controls of one type | `find --kind=text` |
| Find everything you can type into | `find --action=fill` |
| Grab every URL on the page | `links` |
| Survey the whole page | `snap` |

```bash
auto-browser find "提交"                    # by visible text
auto-browser find --kind=select             # by element type
auto-browser find --action=fill             # by supported action
auto-browser find "SQL" --kind=link         # combine
auto-browser find --kind=button --json      # machine-readable
auto-browser find "x" --all                 # include hidden elements
```

Output is one self-describing line per element:

```
  @e52    link            [click,open]           "查询所有列"
           -> https://www.nowcoder.com/practice/f9f8...
  @e140   text            [fill,type,click]      "请选择"
           value="中国 +86"
  @f1-e2  select          [select,click]         "Volvo Saab Opel Audi"
           value="audi"
           options: Volvo | Saab | Opel | Audi
  @e3     checkbox        [check,uncheck,click]  "同意条款"  {REQ}
```

Read it as: `@ref` · `kind` · `[actions]` · `"label"` · `{flags}`, then indented
extras (`->` href, `value=`, `options:`).

Every discover command also prints a page-wide type census:

```
Kinds: link=124  button=14  text=8  dropdown=2  icon=1  label=1
```

Use this to orient before drilling in. 124 links and 8 text inputs tells you
it's a listing page, not a form.

### Step 3 — Act

Take the `@ref` from step 2 and use the action the element advertised:

```bash
auto-browser click @e52
auto-browser fill @e140 "13800138000"
auto-browser select @f1-e2 "Audi"
auto-browser check @e3
```

**Every action command accepts either `@ref` or a CSS selector.** These are equivalent:

```bash
auto-browser click @e52
auto-browser click "a.question-link"
```

`@ref`s are stable across DOM rebuilds — they re-locate by CSS selector, then
XPath, then semantic scoring (role + accessible name + text + position). If
confidence is low you get a warning rather than a silent wrong click.

### Step 4 — Read the reaction

Every action command (`click`/`fill`/`type`/`select`/`check`/`hover`/`drag`/
`upload`/`contenteditable`) doesn't just fire and return — it watches the page
for a moment afterward and reports what happened, on `[reaction]` lines:

```bash
$ auto-browser click ".submit-btn"
Clicked: .submit-btn (result=changed)
[reaction] result: "通过全部用例 运行时间 34ms 占用内存 6556KB"
[reaction] modal: a dialog opened — "邀请朋友来挑战吧： 分享解题思路 进入下一题"

[action-required] (modal) A modal dialog opened and may block further actions.
```

What it surfaces:

| Line | Meaning |
|---|---|
| `result: "…"` | A judge/submit **verdict** (`通过全部用例`, `答案错误`, `SQL_ERROR…`, `Accepted`, `Wrong Answer`, …) read from the result panel |
| `toast:` / `alert:` | Transient notifications (Element/AntD/MUI/Toastify…) and ARIA live regions |
| `validation:` | HTML5 form-validation messages (`field -> "message"`) |
| `error:` | Inline field/error text (`.el-form-item__error`, `.invalid-feedback`, …) |
| `dialog(confirm):` | A native `alert/confirm/prompt` fired and was auto-dismissed |
| `modal:` / `overlay:` | A framework dialog opened / a dimming backdrop is blocking the page |
| `console-error:` / `page-error:` | JS errors thrown during the reaction window |
| `navigated -> <url>` | The action caused a navigation |
| `still running` | An async op didn't finish within the result window |

**Async results are handled.** A judge verdict, a submit result, or a search
response often renders *seconds* after the click, behind a spinner /
`评测中` / `正在为你查询结果` state. The reaction detector keeps observing until a
concrete signal appears (verdict / modal / toast / error) or the DOM goes idle —
so you get the real outcome, not the "still loading" intermediate. Tune with
`AUTO_BROWSER_RESULT_TIMEOUT` (max wait, default `15000` ms) and
`AUTO_BROWSER_COOLDOWN` (base window, default `1200` ms).

**Blocking situations are flagged, not silently retried.** When a login wall,
modal, or overlay covers the page, the action prints `[action-required]` and
exits with code **10** (`EXIT_ACTION_REQUIRED`) so a driving agent knows a human
is needed rather than looping. Set `AUTO_BROWSER_INTERACTIVE=1` (with a real TTY)
to pause and let a human resolve it, then continue.

With `--json`, the reaction is structured: `{ result, reaction, actionRequired }`.

---

## 2. Element Kinds and Actions

This is the table that removes the guesswork. `find --kind=<kind>` locates them.

| kind | What it is | Use this command |
|---|---|---|
| `link` | `<a>` with a real href | `click` (or read `->` href directly) |
| `button` | button, `role=button`, `<a>` without href | `click` |
| `text` | text/email/tel/number/date input, `role=textbox` | `fill` |
| `textarea` | `<textarea>` | `fill` |
| `select` | native `<select>` | `select <@ref> "<option>"` |
| `dropdown` | custom combobox (Element Plus / AntD / MUI) | `click` to open, then `click` the option |
| `checkbox` | checkbox input or framework checkbox | `check` / `uncheck` |
| `radio` | radio input | `check` |
| `toggle` | switch / `role=switch` | `click` |
| `slider` | `input[type=range]`, `role=slider` | `drag <@ref> --by=<dx>,0` |
| `file` | `input[type=file]`, upload widget | `upload <@ref> <path>` |
| `tab` | tab strip item | `click` |
| `menuitem` | menu / nav entry | `click` |
| `option` | dropdown option | `click` |
| `icon` | icon-only clickable | `click` or `hover` |
| `label` | `<label>` | `click` (toggles its control) |
| `contenteditable` | rich-text editor div | `contenteditable <@ref> "<text>"` |
| `draggable` | `draggable="true"` | `drag <@ref> <@target>` |
| `clickable` | fallback — clickable but unclassified | `click` |

Actions vocabulary: `click open fill type select check uncheck contenteditable
upload drag hover`.

**Flags** appearing in `{...}`: `HID` (not visible), `DISABLED`, `CHECKED`, `REQ` (required).

### Important: `select` vs `dropdown`

- `select` = native `<select>`. Use `select @ref "Audi"`. Works in one shot.
- `dropdown` = a JS-rendered fake dropdown. `select` will **not** work.
  You must `click` the dropdown to open it, then `find` the option, then `click` it.
  Element Plus dropdowns in particular ignore synthetic events — `click` uses real
  CDP mouse events, which is why it works.

Type mismatches fail loudly with a usable hint:

```
$ auto-browser check @f1-e2
check @f1-e2: not a checkbox/radio (got <SELECT> type="select-one")

$ auto-browser select @f1-e2 "Tesla"
select @f1-e2: option not found
Available: Volvo | Saab | Opel | Audi
```

---

## 3. Extracting Data

### Links: never click through to collect URLs

`snap`/`find`/`links` all emit resolved `href`. To harvest a list:

```bash
auto-browser links                            # every href, in page order
auto-browser links --contain=/practice/       # filter by substring
auto-browser links --contain=/practice/ --json
auto-browser links --limit=500
```

Output is sorted top-to-bottom by on-screen position, which is usually the
meaningful order (a numbered list's DOM order can be scrambled).

### Complex extraction: `eval --file`

For anything needing DOM traversal (walking up to a parent row, joining sibling
cells, regex on container text), write JS to a file and run it.

**Do not pass non-trivial JS inline.** Shells (PowerShell especially) strip inner
quotes, so `document.querySelectorAll('a[href*="/x/"]')` arrives mangled as
`a[href*=/x/]` and throws `not a valid selector`. This is a shell problem, not a
JS problem — rewriting the JS will not fix it.

```bash
# Write scrape.js, then:
auto-browser eval --file scrape.js
auto-browser eval --stdin < scrape.js
auto-browser eval "document.title"      # OK: no quotes, no semicolons
```

File contents are wrapped in an async IIFE, so multi-line statements and
`return` both work, and you can `await`:

```javascript
// scrape.js — harvest a table into structured rows
const norm = s => (s || '').replace(/\s+/g, ' ').trim();
const rows = [...document.querySelectorAll('a')]
  .filter(a => (a.getAttribute('href') || '').includes('/practice/'))
  .map(a => {
    // Walk up until an ancestor carries the row's ID text
    let node = a, rowText = norm(a.textContent);
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      const t = norm(node.innerText);
      if (/SQL\d+/.test(t)) { rowText = t; break; }
    }
    return {
      no: (rowText.match(/SQL(\d+)/) || [])[1],
      title: norm(a.textContent),
      difficulty: (rowText.match(/(入门|简单|中等|困难)/) || [])[1] || '',
      url: a.href,
      y: Math.round(a.getBoundingClientRect().top)
    };
  })
  .sort((a, b) => a.y - b.y);   // page order, not DOM order
return rows.slice(0, 10);
```

### Site adapters: zero-cost for supported sites

```bash
auto-browser site list
auto-browser site github-repo owner=zzfcharlie repo=auto-browser
auto-browser site hackernews count=20
auto-browser site arxiv-search query=transformer
```

Built in: `github-repo` `github-search` `arxiv-search` `hackernews` `wikipedia`
`zhihu` `baidu` `youtube`. These run `fetch()` inside the page with your real
cookies, so login-gated data works.

Add one at `site/registry/<name>.mjs`:

```javascript
export const description = 'What it does';
export const params = ['query', 'count'];
export default async function execute(page, { query, count }) {
  return page.evaluate(async ({ q, n }) => {
    const resp = await fetch(`https://api.example.com/search?q=${q}&n=${n}`);
    return resp.json();
  }, { q: query, n: count });
}
```

### Network capture: reverse-engineer the page's own API

```bash
auto-browser network nav https://example.com --with-body --json
```

Often the fastest path — if the page fetches its data as JSON, read that
endpoint instead of scraping the DOM.

---

## 4. Chrome Lifecycle

```bash
auto-browser launch            # explicit start
auto-browser launch --force    # kill existing instance, start fresh
auto-browser launch --headless
auto-browser status            # running? which PIDs? what tabs?
auto-browser close             # shut down
```

**You usually don't need `launch`** — every command auto-launches Chrome.

How it avoids the classic failure: auto-browser starts Chrome with a **dedicated
profile** at `%LOCALAPPDATA%\auto-browser\chrome-profile` (or `$XDG_DATA_HOME`).
Launching `chrome.exe --remote-debugging-port=9222` while the user's normal Chrome
is already running on the default profile silently reuses that process and never
opens the debug port — the reason naive setups require closing every Chrome window
first. A separate profile can't collide, so the port always opens. Startup polls
`/json/version` until the endpoint truly responds, not just until the process spawns.

`close` only kills processes whose command line contains our debug port, so the
user's everyday Chrome windows are untouched.

Login state persists in the dedicated profile across runs. First time you need
an authenticated site, `launch` and log in manually once.

Environment overrides: `AUTO_BROWSER_CHROME` (binary path),
`AUTO_BROWSER_PROFILE` (profile dir), `AUTO_BROWSER_PORT` (debug port),
`AUTO_BROWSER_HEADLESS=1` (launch headless), `AUTO_BROWSER_COOLDOWN` /
`AUTO_BROWSER_RESULT_TIMEOUT` (reaction timing, see Step 4),
`AUTO_BROWSER_INTERACTIVE=1` (pause for a human on `[action-required]`).

---

## 5. Command Reference

### Discover
| Command | Description |
|---|---|
| `snap` | Snapshot page; kinds census + first 50 elements |
| `snap --kind=<k>` | Only one kind |
| `snap --action=<a>` | Only elements supporting an action |
| `snap --text=<s>` | Only elements matching text |
| `snap --limit=<n>` | Show more than 50 |
| `snap -i` | Also inject numbered on-screen overlay |
| `find "<text>"` | Locate by visible text |
| `find --kind=<k>` | Locate by type |
| `find --action=<a>` | Locate by supported action |
| `find ... --json` | Machine-readable |
| `find ... --all` | Include hidden elements |
| `links` | Every href, page order |
| `links --contain=<s>` | Filter hrefs by substring |
| `detect` | Which UI framework (Element Plus / AntD / MUI) |
| `diff` | Compare current page against last snapshot |

### Act
| Command | Description |
|---|---|
| `click <@ref\|sel>` | Click; verifies whether the page actually changed |
| `click <x> <y>` | Click coordinates |
| `fill <@ref\|sel> <val>` | Fill input; reads back DOM value to confirm |
| `type <text>` | Type into focused element |
| `select <@ref\|sel> <val>` | Choose native `<select>` option |
| `check` / `uncheck <@ref\|sel>` | Toggle checkbox / radio |
| `contenteditable <@ref\|sel> <text>` | Set rich-text content |
| `upload <@ref\|sel> <file>...` | Attach files to file input |
| `drag <@ref\|sel> <@ref\|sel>` | Drag element onto element |
| `drag <@ref\|sel> --to=<x>,<y>` | Drag to coordinates |
| `drag <@ref\|sel> --by=<dx>,<dy>` | Drag by delta (sliders) |
| `hover <@ref\|sel>` | Hover |
| `scroll <x> <y>` | Scroll |

Every action here also prints a `[reaction]` report (toasts, validation, dialogs,
opened modals, judge/submit `result:` verdicts, navigations) and flags blocking
login/modal/overlay walls as `[action-required]` (exit code 10). See Step 4.

### Navigate / wait
| Command | Description |
|---|---|
| `open <url>` | Navigate |
| `wait selector <sel>` | Wait for node |
| `wait text <text>` | Wait for text |
| `wait url <pattern>` | Wait for URL match |
| `wait stable` | Wait for DOM to settle |
| `get <attr>` | Read `title` / `url` / `html` / `text` |
| `screenshot` | Save JPEG |
| `tab list` / `tab new` / `tab close <i>` | Tabs |

### Execute / extract
| Command | Description |
|---|---|
| `eval --file <path>` | Run JS from file — **preferred** |
| `eval --stdin` | Run JS from stdin |
| `eval <expr>` | Inline (simple expressions only) |
| `site list` / `site <name> k=v` | Site adapters |
| `network nav <url> --with-body --json` | Capture requests |
| `network start` / `requests` / `stop` / `clear` | Manual capture |

### Lifecycle / infra
| Command | Description |
|---|---|
| `launch` / `launch --force` / `launch --headless` | Start Chrome |
| `close` | Stop Chrome |
| `status` | Chrome state, PIDs, tabs |
| `daemon start` / `stop` / `status` | HTTP API on :19824 |
| `cache list` / `cache clear` | Page map cache |
| `overlay inject` / `overlay remove` | Numbered overlay |
| `help` | Full command list |

---

## 6. Worked Example

**Task:** get the first 10 questions from Nowcoder's "SQL 快速入门" list.

```bash
# 1. Navigate
auto-browser open "https://www.nowcoder.com/exam/oj?tab=SQL%E7%AF%87"

# 2. Survey — 124 links means it's a listing page
auto-browser snap --limit=10
#   Kinds: link=124  button=14  text=8  dropdown=2  icon=1  label=1

# 3. Question links live under /practice/ — harvest them all at once
auto-browser links --contain=/practice/ --json
```

That yields titles + URLs in page order. Question number and difficulty live in
the *parent row*, not the link, so those need one `eval --file` pass (see the
`scrape.js` example in section 3).

Non-obvious detail worth internalizing: sort by `getBoundingClientRect().top`,
not by the question number. This list has `SQL40` physically placed inside
chapter 3, so numeric sorting produces the wrong order. **Visual order is the
truth; DOM order and ID order are not.**

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `not a valid selector` from `eval` | Shell ate your quotes | Use `eval --file` |
| `Element not found: @e5` | No snapshot, or page changed | Re-run `snap` or `find` |
| Empty results, `Page:` blank | You never navigated | `open <url>` first |
| `find` returns 0 matches | Element hidden, or wrong kind | Add `--all`; check `Kinds:` census |
| `select` fails on a dropdown | It's `kind=dropdown`, not `select` | `click` to open, `find` option, `click` it |
| Page looks incomplete | JS still rendering | `wait stable` or `wait text "..."` |
| `no-observable-change` after click | Click landed but nothing happened | Element may be decorative; try its parent |
| Custom dropdown ignores clicks | Framework rejects synthetic events | Use `click` (real CDP events), not `eval` + `.click()` |
| Chrome won't start | Binary not found | Set `AUTO_BROWSER_CHROME` |
| Port busy | Stale instance | `auto-browser close`, or `--port=9333` |
| Command exits with code `10` | `[action-required]`: login/modal/overlay is blocking | Resolve in the browser (or `AUTO_BROWSER_INTERACTIVE=1`), then re-run |
| `[reaction] still running` | Async result outran the window | Raise `AUTO_BROWSER_RESULT_TIMEOUT` |
| Missed a judge/submit verdict | Result rendered very late | Raise `AUTO_BROWSER_RESULT_TIMEOUT`; read the `result:` reaction line |

---

## 8. Rules of Thumb

1. **Never guess an element's type.** `find` tells you the `kind` and the valid `actions`.
2. **Read `href` from output; don't click to discover URLs.** `links` gets all of them in one call.
3. **Put non-trivial JS in a file.** Inline JS dies to shell quoting.
4. **Check the `Kinds:` census first.** It tells you the page's shape before you drill in.
5. **`@ref` and CSS selector are interchangeable** in every action command.
6. **Sort extracted lists by `rect.y`.** Visual order ≠ DOM order ≠ ID order.
7. **`wait` beats sleeping.** `wait stable` / `wait text` / `wait selector`.
8. **Don't manage Chrome manually.** Commands auto-launch. Use `launch --force` only for a guaranteed-clean slate.
9. **`click` reports whether the page changed.** `no-observable-change` means your click did nothing — pick a different element rather than repeating.
10. **Check `site list` before writing a scraper.** An adapter may already exist.
11. **Read the `[reaction]` lines after every action.** They tell you the result verdict, validation errors, toasts, and opened dialogs — don't re-`snap` to find out what your click did. An `[action-required]` (exit 10) means a human is needed; stop looping.

---

## 9. Programmatic API

```javascript
import { AutoBrowser } from 'auto-browser';

const ab = new AutoBrowser();
await ab.connect();                    // auto-launches Chrome
await ab.navigate('https://example.com');

const map = await ab.buildMap({ compress: true });
// map.kinds    -> { link: 124, button: 14, ... }
// map.elements -> [{ ref, kind, actions, href, value, options, locator, rect, ... }]

const fw = await ab.detectFramework();
await ab.waitForDomStable();
const changes = await ab.diffMaps(map);

await ab.disconnect();
```

Query a built map without re-scraping:

```javascript
import { queryMap } from 'auto-browser/core/map.mjs';
const links = queryMap(map, { kind: 'link', text: 'SQL' });
const fillable = queryMap(map, { action: 'fill' });
```

Lifecycle control:

```javascript
import { ensureChrome, launchChrome, closeChrome, chromeStatus }
  from 'auto-browser/core/launcher.mjs';

const ready = await ensureChrome();        // idempotent; returns browserURL
await launchChrome({ force: true });
const status = await chromeStatus();
await closeChrome();
```

---

## 10. Known Limits

- Cross-origin iframes are skipped (same-origin works, refs look like `@f1-e2`).
- Closed Shadow DOM is unreachable by design; open Shadow DOM works.
- Custom dropdowns need open-then-click, not `select`.
- `diff` rebuilds and compares maps; it is not a live DOM mutation observer.
- `daemon` and `mcp` do not yet enforce URL allow-lists or confirm high-risk actions.
- Multi-tab snapshot lifecycles are not fully isolated.

---

## 11. Batch Workflow — 先跑通一次，再批量

`run` executes a whole plan in ONE call (`auto-browser run plan.json`), but a
new site always has surprises. The proven sequence (知乎实测, 2026-08):

1. **单条冒烟（一条即可）** — 写一个覆盖完整链路的 plan（open → wait →
   snap/probe → 关键交互 → assert），对**第 1 条**数据跑通：
   ```bash
   auto-browser run single-item.json
   ```
2. **适配中断源** — 逐个处理会打断批量操作的东西，全部反映在 plan 里：
   - **新窗口/新标签**：某步点了 `target=_blank` 或弹窗后，plan 的 page 会脱离
     当前上下文。`run` 输出会打 `⚠ new tab/window opened (tabDelta N)` 警告；
     用 `{"op":"probe"}` 查看 tabs，必要时加 `tab close` 或改用稳定 selector。
   - **停顿/加载慢**：`wait stable` / `wait text` 设足 timeout；`probe` 步骤报告
     `pending`（"加载中/评测中…"）与 `masked`（遮罩层）。
   - **弹窗/登录墙**：交互步骤的 reaction 会报 `modal`/`masked`；出现即视为
     中断源，在 plan 里前置处理或要求人工。
   - **键盘/编辑器怪癖**：Draft.js 类编辑器只认 `execCommand('insertText')`
     （contenteditable 步骤已内置）；按钮类名变化用 `snap` 看真实 class。
3. **先验验证通道** — 单条跑通后确认"如何证明成功"（like 状态、评论总数增量、
   DOM 断言、站点 API）。批量时每项后跟一个 verify 步骤或独立验证计划。
4. **再批量** — 循环同一 plan（或每项生成的 plan），逐项计时；`--continue`
   容忍单项失败，`--json` 拿结构化结果。watchdog 会按 plan 长度自动缩放
   （30s/步），不必手工调 `AUTO_BROWSER_TIMEOUT`。
5. **沉淀适配器** — 踩过的选择器/API/交互策略写进 `site/registry/<site>.mjs`
   （参考 `zhihu.mjs`：action=search/like/comment/likeAndComment/comments/probe），
   下次同站零成本。

经验值（知乎 10 条实测）：单条链路（探测+交互+验证）≈ 12s；批量 10 条 ≈ 2.2min；
而逐步 CLI + 逐次思考 ≈ 20-40min。中断源排查占首次适配的大头——这正是第 1、2 步要解决的事。
