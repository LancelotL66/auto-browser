#!/usr/bin/env node

// ============================================================
// auto-browser CLI v2.0
// Inspired by bb-browser — Your browser is the API.
//
// Usage:
//   auto-browser map <url>               Build page element map
//   auto-browser map <url> --visualize   With visual overlay
//
//   auto-browser site [list]             List site adapters
//   auto-browser site <name> [params]    Run a site adapter
//   auto-browser site update             Pull latest adapters (future)
//
//   auto-browser network start           Start network capture
//   auto-browser network requests        Show captured requests
//   auto-browser network stop            Stop + show results
//
//   auto-browser daemon start            Start daemon server
//   auto-browser daemon stop             Stop daemon
//   auto-browser daemon status           Daemon status
//
//   auto-browser tab list                List tabs
//   auto-browser tab new                 New tab
//   auto-browser tab close <id>          Close tab
//
//   auto-browser open <url>             Open URL
//   auto-browser snap                    Snapshot page elements
//   auto-browser detect                  Detect UI framework
//   auto-browser screenshot              Take screenshot
//
//   auto-browser click <x> <y>          Click at coordinates
//   auto-browser fill <sel> <val>       Fill input
//   auto-browser eval <code>            Run JS in page
//
//   auto-browser cache [list|clear]     Manage cache
//   auto-browser help                   Show this help
// ============================================================

import { AutoBrowser } from '../api/index.mjs';
import { CacheManager } from '../cache/manager.mjs';
import { connect, navigate, disconnect } from '../core/browser.mjs';
import { buildMap, formatMapJson, queryMap } from '../core/map.mjs';
import { detectFramework } from '../detector/index.mjs';
import * as network from '../core/network.mjs';
import { loadBuiltInAdapters, listAdapters, runAdapter } from '../site/loader.mjs';
import { startDaemon, stopDaemon } from '../daemon/index.mjs';
import { selectDropdown, readForm } from '../core/form.mjs';
import { selectValue, setChecked, fillContentEditable } from '../core/form.mjs';
import { waitForSelector, waitForText, waitForUrl, waitForDomStable } from '../core/wait.mjs';
import { diffMaps } from '../core/diff.mjs';
import { launchChrome, closeChrome, chromeStatus } from '../core/launcher.mjs';
import { parseRef as _parseRef, resolveRef as _resolveRef, resolveTarget as _resolveTarget } from '../core/locate.mjs';
import { executePlan, PLAN_OPS, buildEvalPayload } from '../core/plan.mjs';
import fs from 'fs';
import path from 'path';

const SNAPSHOT_FILE = new URL('../cache/last-snapshot.json', import.meta.url);

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')).elements || [];
  } catch {
    return [];
  }
}

function saveSnapshot(map) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(map, null, 2));
}

// ------------------------------------------------------------
// Bound a single CDP/browser call so a stuck page can't hang the
// whole CLI command. Puppeteer's ElementHandle.hover()/click() run
// CDP DOM.scrollIntoViewIfNeeded internally, which can block forever
// on long/dynamic pages (observed: 90s hang on Zhihu — only the
// process-wide watchdog saved us). The watchdog stays as the last
// resort; these per-call timeouts turn a hang into a fast, actionable
// error at the exact call site.
// ------------------------------------------------------------
function withTimeout(promise, ms, label = 'cdp-call') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------
// Render one element as a single self-describing CLI line:
//   @e37  link      [click,open]  "SQL快速入门"  -> https://...
// An agent can read kind + actions and immediately know which
// command to use, without guessing from the tag name.
// ------------------------------------------------------------
function formatElement(el, fallbackIndex = 0) {
  const ref = `@${el.ref || `e${fallbackIndex + 1}`}`.padEnd(7);
  const kind = String(el.kind || '?').padEnd(15);
  const acts = `[${(el.actions || []).join(',')}]`.padEnd(22);
  const flags = [
    el.visible === false ? 'HID' : '',
    el.disabled ? 'DISABLED' : '',
    el.checked === true ? 'CHECKED' : '',
    el.required ? 'REQ' : ''
  ].filter(Boolean).join(',');

  const label = String(el.name || el.text || el.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 42);
  let line = `  ${ref} ${kind} ${acts} "${label}"`;

  if (flags) line += ` {${flags}}`;
  if (el.href) line += `\n           -> ${el.href}`;
  if (el.value) line += `\n           value="${String(el.value).slice(0, 60)}"`;
  if (el.options?.length) {
    const opts = el.options.slice(0, 8).map(o => o.label).join(' | ');
    line += `\n           options: ${opts}${el.options.length > 8 ? ' ...' : ''}`;
  }
  return line;
}

function printKinds(kinds) {
  if (!kinds || !Object.keys(kinds).length) return;
  const parts = Object.entries(kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`);
  console.log(`Kinds: ${parts.join('  ')}`);
}

// @ref resolution lives in core/locate.mjs, shared with the plan runner
// (core/plan.mjs) and the MCP server. Thin wrappers keep the CLI's
// process.exit error behavior and bind the snapshot element store.
function parseRef(value) { return _parseRef(value); }
function resolveRef(page, value) { return _resolveRef(page, value, _lastElements); }
function resolveTarget(page, target) {
  return _resolveTarget(page, target, _lastElements, {
    onError: (msg) => { console.error(msg); process.exit(1); }
  });
}

const [,, cmd, ...args] = process.argv;

// ============================================================
// Helper: connect to browser
// ============================================================

let _ab = null;
let _lastElements = loadSnapshot(); // cache of last snap/map elements for @ref click
let _overlayActive = false; // persistent overlay state

// ============================================================
// Liveness: watchdog + heartbeat.
// A one-shot CLI command must never hang forever. Puppeteer's CDP WebSocket
// keeps the event loop alive, so an unbounded await (a selector that never
// appears, networkidle on a long-polling SPA) would freeze this process — and
// freeze whatever is waiting on it (opencode, a shell, CI).
//   - watchdog : hard deadline; force-exits with code 124 if exceeded.
//   - heartbeat: every 2s prints elapsed time + current phase to STDERR, so
//     silence becomes observable — a phase that stops advancing past the
//     deadline is a hang; a phase that keeps changing is real progress.
// Both timers are unref()'d: they never keep the process alive on their own,
// they only act when we are genuinely stuck. STDERR keeps --json stdout clean.
// Env: AUTO_BROWSER_TIMEOUT=<secs> (0 disables), AUTO_BROWSER_TRACE=1 (phase log).
// ============================================================
const _startedAt = Date.now();
let _phase = 'startup';
let _phaseAt = _startedAt;
let _watchdog = null;
let _heartbeat = null;

function setPhase(name) {
  _phase = name;
  _phaseAt = Date.now();
  if (process.env.AUTO_BROWSER_TRACE === '1') {
    const t = ((Date.now() - _startedAt) / 1000).toFixed(1);
    process.stderr.write(`[t+${t}s] ${name}\n`);
  }
}

function startLiveness(cmd, args) {
  // Commands that are long-running by design must be exempt from the deadline.
  const persistent = cmd === 'daemon'
    || (cmd === 'network' && ['start', 'requests', 'watch', 'stop', 'clear'].includes(args[0]));
  if (persistent) return;

  const secs = process.env.AUTO_BROWSER_TIMEOUT !== undefined
    ? Number(process.env.AUTO_BROWSER_TIMEOUT)
    : 90;
  armWatchdog(secs);

  let ticks = 0;
  _heartbeat = setInterval(() => {
    // Stay silent for the first ~4s so quick commands print nothing.
    if (++ticks < 2) return;
    const total = ((Date.now() - _startedAt) / 1000).toFixed(0);
    const inPhase = ((Date.now() - _phaseAt) / 1000).toFixed(0);
    process.stderr.write(`[watch] ${total}s elapsed — phase "${_phase}" (${inPhase}s)\n`);
  }, 2000);
  _heartbeat.unref();
}

// (Re)arm the hard deadline. `run` re-scales it to the plan length so a
// legit multi-step batch isn't killed by the 90s default while true hangs
// are still caught.
function armWatchdog(secs) {
  if (_watchdog) { clearTimeout(_watchdog); _watchdog = null; }
  if (secs > 0) {
    _watchdog = setTimeout(() => {
      const inPhase = ((Date.now() - _phaseAt) / 1000).toFixed(1);
      console.error(`\n[watchdog] '${cmd}' exceeded ${secs}s — stuck in phase "${_phase}" for ${inPhase}s. Forcing exit; this is a hang, not slow work.`);
      process.exit(124);
    }, secs * 1000);
    _watchdog.unref();
  }
}

function stopLiveness() {
  if (_watchdog) { clearTimeout(_watchdog); _watchdog = null; }
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; }
}


async function getAB() {
  if (!_ab) {
    setPhase('connect-chrome');
    _ab = new AutoBrowser();
    await _ab.connect();
    setPhase('connected');
  }
  return _ab;
}

async function getPage() {
  const ab = await getAB();
  const page = ab.getPage();
  attachReactionListeners(page); // idempotent: buffer dialogs/console/pageerror for reaction reports
  return page;
}

async function cleanup() {
  if (_ab) {
    // Do not let a stuck CDP transport keep one-shot CLI commands alive.
    await Promise.race([
      _ab.disconnect(),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
    _ab = null;
  }
}

// ============================================================
// Post-action reaction detection ("cooldown recognition").
//
// After every click/fill/select/etc. the page may respond in wildly different
// ways — a validation message, a toast, a native dialog, an inline error, a
// console/JS error, or a navigation — and there is no universal signal. So we
// take a short "cool-down" window after each action and report, in the agent's
// own output, what the page actually did. This stops the agent from blindly
// clicking on and surfaces "what happened / what support is needed".
//
// Two channels are combined:
//   1. Passive events buffered by listeners attached once per session
//      (native dialogs, console errors, uncaught page errors).
//   2. A before/after DOM diff of visible feedback surfaces
//      (role=alert / aria-live, framework toasts, form validation, error text).
// ============================================================

// --- passive event buffer (attached once in getPage) ---
let _reactionEvents = { dialogs: [], consoleErrors: [], pageErrors: [] };
let _reactionAttached = false;

function resetReactionEvents() {
  _reactionEvents = { dialogs: [], consoleErrors: [], pageErrors: [] };
}

function attachReactionListeners(page) {
  if (_reactionAttached) return;
  _reactionAttached = true;
  // A registered 'dialog' listener means WE own the dialog: it will block the
  // page until handled. Record it, then dismiss so the command can't hang.
  page.on('dialog', async d => {
    _reactionEvents.dialogs.push({ type: d.type(), message: d.message() });
    try { await d.dismiss(); } catch { /* already handled */ }
  });
  page.on('console', msg => {
    if (msg.type() === 'error') _reactionEvents.consoleErrors.push(String(msg.text()).slice(0, 300));
  });
  page.on('pageerror', err => {
    _reactionEvents.pageErrors.push(String(err?.message || err).slice(0, 300));
  });
}

// Runs INSIDE the page. Gathers every visible feedback surface we know about.
function collectSignalsInPage() {
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const texts = sel => {
    const out = [];
    document.querySelectorAll(sel).forEach(e => {
      if (!visible(e)) return;
      const t = norm(e.innerText || e.textContent);
      if (t) out.push(t.slice(0, 200));
    });
    return [...new Set(out)];
  };

  const alerts = texts('[role="alert"], [aria-live="assertive"], [aria-live="polite"], output[role="status"]');
  const toasts = texts([
    '.el-message', '.el-notification', '.ant-message-notice', '.ant-notification-notice',
    '.Toastify__toast', '.toast', '.toastify', '.MuiAlert-message', '.MuiSnackbar-root',
    '.v-snackbar__content', '.chakra-toast', '.notyf__toast', '.n-message', '[role="status"]'
  ].join(','));
  const errText = texts([
    '.error', '.is-error', '.has-error', '.field-error', '.invalid-feedback',
    '.el-form-item__error', '.ant-form-item-explain-error', '.form-error',
    '.text-danger', '.help-block.error', '.form-item-error', '.error-message'
  ].join(','));

  const validation = [];
  document.querySelectorAll('input, textarea, select').forEach(f => {
    try {
      if (f.willValidate && !f.validity.valid && f.validationMessage) {
        validation.push({
          field: norm(f.name || f.id || f.getAttribute('aria-label') || f.placeholder || f.tagName),
          message: norm(f.validationMessage).slice(0, 200)
        });
      }
    } catch { /* some inputs throw on .validity */ }
  });

  // Modal dialogs. Frameworks (Element-UI, AntD, MUI, Bootstrap) usually do NOT
  // set role=dialog / aria-modal, so match their container classes too. This is
  // what catches "a login window popped up and dimmed the page".
  const modalSel = [
    '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
    '.el-dialog', '.el-dialog__wrapper', '.el-message-box', '.el-drawer__body',
    '.ant-modal', '.ant-modal-content', '.ant-drawer-content',
    '.MuiDialog-paper', '.modal.show', '.modal.in', '.v-dialog',
    '[class*="login-dialog"]', '[class*="Dialog"]', '[class*="-modal"]'
  ].join(',');
  const modals = [];
  document.querySelectorAll(modalSel).forEach(el => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 60) return; // ignore tiny decorative bits
    const t = norm(el.innerText || el.textContent);
    if (t) modals.push(t.slice(0, 220));
  });
  // A big high-z fixed/absolute layer that dims/blocks the page (modal backdrop).
  let masked = false;
  const nodes = document.querySelectorAll('div, section');
  for (let i = 0; i < nodes.length && !masked; i++) {
    const el = nodes[i];
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'absolute') continue;
    if ((parseInt(s.zIndex) || 0) < 1000) continue;
    const r = el.getBoundingClientRect();
    if (r.width < innerWidth * 0.6 || r.height < innerHeight * 0.6) continue;
    const cls = (el.className || '').toString();
    if (/mask|overlay|modal|backdrop|dimmer|shadow/i.test(cls)) masked = true;
  }

  // Is an async operation still in flight? Detect this from a genuine BLOCKING
  // loader overlay or an explicit status TEXT ("评测中" / "正在为你查询结果").
  // Deliberately NOT keyed on generic [class*="loading"]/[class*="spinner"]:
  // rich editors (Monaco's "tokenize-loading") and decorative spinners are
  // ALWAYS present, which would make every page look perpetually busy and
  // disable the async-result wait.
  let pending = false;
  const PENDING_RE = /评测中|判题中|运行中|提交中|评测排队|排队中|加载中|评测进行中|判定中|正在为你查询结果|正在查询|查询结果中|结果生成中|正在评测|正在提交|Judging|Running\b|Pending|Evaluating|Submitting/i;
  const mask = document.querySelector('.el-loading-mask, .default-loading, [class*="submitting"], [class*="evaluating"], [class*="judging"]');
  if (mask && visible(mask)) pending = true;
  if (!pending) {
    const pnodes = document.querySelectorAll('span, div, button, p, i, b, [class*="btn"], .el-loading-text');
    for (let i = 0; i < pnodes.length && !pending; i++) {
      const e = pnodes[i];
      if (e.children.length > 1) continue; // leaf-ish only, avoid big containers
      const t = norm(e.innerText || e.textContent);
      if (t && t.length <= 20 && PENDING_RE.test(t) && visible(e)) pending = true;
    }
  }

  // A rendered pass/fail verdict (judge result, submit outcome). Scoped to
  // result/console/status panels + strong, unambiguous verdict phrases so it
  // can't match "通过率" in a problem description or the static "提示未通过的
  // 测试用例" debug hint. Pick the most specific (shortest) matching element.
  let verdict = null;
  const VERDICT_RE = /通过全部用例|答案错误|运行错误|运行时错误|编译错误|运行超时|时间超限|内存超限|格式错误|SQL_ERROR|案例通过率|Wrong Answer|Accepted|Runtime Error|Compile Error|Time Limit|Presentation Error|Memory Limit/;
  const vnodes = document.querySelectorAll('[class*="result"],[class*="Result"],[class*="judge"],[class*="Judge"],[class*="console"],[class*="Console"],[class*="output"],[class*="Output"],[class*="status"],.el-message,.el-message-box__message');
  for (let i = 0; i < vnodes.length; i++) {
    const e = vnodes[i];
    if (!visible(e)) continue;
    const t = norm(e.innerText || e.textContent);
    if (t && t.length < 240 && VERDICT_RE.test(t) && (!verdict || t.length < verdict.length)) verdict = t.slice(0, 240);
  }

  return {
    url: location.href,
    title: document.title,
    textLength: document.body?.innerText?.length || 0,
    // Cheap fingerprint of the rendered text: catches same-length text swaps
    // ("hover me" -> "hovered!", 8 vs 8 chars) that a length comparison alone
    // misses. Bounded to the first 200KB so huge pages stay cheap.
    textHash: (() => {
      const t = document.body?.innerText || '';
      let h = 0;
      const n = Math.min(t.length, 200000);
      for (let i = 0; i < n; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      return h;
    })(),
    domLength: document.documentElement?.outerHTML?.length || 0,
    dialogs: document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length,
    alerts, toasts, errText, validation,
    modals: [...new Set(modals)], masked, pending, verdict
  };
}

const _emptySignals = () => ({ url: '', title: '', textLength: 0, textHash: 0, domLength: 0, dialogs: 0, alerts: [], toasts: [], errText: [], validation: [], modals: [], masked: false, pending: false, verdict: null });

async function captureSignals(page) {
  const withTimeout = p => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('signal-timeout')), 2500))
  ]);
  try {
    return await withTimeout(page.evaluate(collectSignalsInPage));
  } catch {
    // Context destroyed mid-navigation, or the main thread was briefly busy — retry once.
    await new Promise(r => setTimeout(r, 200));
    try { return await withTimeout(page.evaluate(collectSignalsInPage)); }
    catch { return { ..._emptySignals(), url: (() => { try { return page.url(); } catch { return ''; } })() }; }
  }
}

const _diffText = (before, after) => after.filter(x => !before.includes(x));
const _diffVal = (before, after) => {
  const key = v => `${v.field}\u0000${v.message}`;
  const seen = new Set(before.map(key));
  return after.filter(v => !seen.has(key(v)));
};

// Observe the page for up to cooldownMs after an action, then diff against the
// pre-action snapshot. Returns a structured reaction report.
async function observeReaction(page, before, opts = {}) {
  const cooldownMs = opts.cooldownMs
    || (process.env.AUTO_BROWSER_COOLDOWN !== undefined ? Number(process.env.AUTO_BROWSER_COOLDOWN) : 1200);
  setPhase('observe-reaction');
  const started = Date.now();
  let after = await captureSignals(page);
  let stable = 0;
  let lastDom = after.domLength;

  while (Date.now() - started < cooldownMs) {
    const explicit =
      _diffText(before.alerts, after.alerts).length ||
      _diffText(before.toasts, after.toasts).length ||
      _diffText(before.errText, after.errText).length ||
      _diffText(before.modals, after.modals).length ||
      _diffVal(before.validation, after.validation).length ||
      (after.masked && !before.masked) ||
      after.dialogs > before.dialogs ||
      _reactionEvents.dialogs.length ||
      _reactionEvents.pageErrors.length;
    if (explicit) {
      // Give the widget one more beat to finish rendering its text.
      await new Promise(r => setTimeout(r, 150));
      after = await captureSignals(page);
      break;
    }
    await new Promise(r => setTimeout(r, 120));
    const next = await captureSignals(page);
    if (next.domLength === lastDom) stable++; else { stable = 0; lastDom = next.domLength; }
    after = next;
    const changedVsBefore = after.url !== before.url || after.domLength !== before.domLength || after.title !== before.title || after.textHash !== before.textHash;
    if (stable >= 2 && changedVsBefore) break; // settled after a real change
    if (stable >= 3) break;                    // settled, nothing happened
  }

  // ── Smart wait / async convergence ──────────────────────────────────────────
  // Many real outcomes (a judge verdict, a submit result, a search response)
  // render SECONDS after the click, long past the normal cooldown. Relying on a
  // transient "评测中"/spinner flag is fragile — the moment we sample can fall in
  // a gap. Instead: once an action has CHANGED the page (but not navigated) and
  // hasn't already surfaced a signal, keep observing until a concrete signal
  // appears (verdict / modal / overlay / toast / error / dialog), OR the DOM has
  // been stable-and-idle for a beat, OR we hit the result-timeout cap. This
  // reliably bridges the async gap without depending on catching the spinner.
  const resultTimeout = opts.resultTimeoutMs
    || (process.env.AUTO_BROWSER_RESULT_TIMEOUT !== undefined ? Number(process.env.AUTO_BROWSER_RESULT_TIMEOUT) : 15000);
  const navigatedEarly = Boolean(after.url && before.url && after.url !== before.url);
  const changedNow = after.url !== before.url || after.domLength !== before.domLength ||
    after.title !== before.title || after.textLength !== before.textLength || after.textHash !== before.textHash;
  const signalNow = s =>
    _diffText(before.alerts, s.alerts).length || _diffText(before.toasts, s.toasts).length ||
    _diffText(before.errText, s.errText).length || _diffText(before.modals, s.modals).length ||
    _diffVal(before.validation, s.validation).length || (s.masked && !before.masked) ||
    (s.verdict && s.verdict !== before.verdict) || s.dialogs > before.dialogs;
  let startedPending = Boolean(after.pending && !before.pending);
  if (resultTimeout > 0 && !navigatedEarly && changedNow && !signalNow(after) && !_reactionEvents.dialogs.length) {
    setPhase('await-result');
    const deadline = Date.now() + resultTimeout;
    let stableR = 0, lastR = after.domLength;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
      const next = await captureSignals(page);
      after = next;
      if (next.pending) startedPending = true;
      if (signalNow(next) || _reactionEvents.dialogs.length) {
        await new Promise(r => setTimeout(r, 300)); // let the result text settle
        after = await captureSignals(page);
        break;
      }
      if (next.domLength === lastR) stableR++; else { stableR = 0; lastR = next.domLength; }
      if (!next.pending && stableR >= 3) break; // settled (~750ms idle), nothing async surfaced
    }
    setPhase('observe-reaction');
  }

  const dialogs = _reactionEvents.dialogs.slice();
  const consoleErrors = _reactionEvents.consoleErrors.slice();
  const pageErrors = _reactionEvents.pageErrors.slice();
  const alerts = _diffText(before.alerts, after.alerts);
  const toasts = _diffText(before.toasts, after.toasts);
  const errors = _diffText(before.errText, after.errText);
  const modals = _diffText(before.modals, after.modals);
  const masked = Boolean(after.masked && !before.masked);
  const validation = _diffVal(before.validation, after.validation);
  const verdict = (after.verdict && after.verdict !== before.verdict) ? after.verdict : null;
  // Only "still running" if we timed out with NOTHING to show. If a verdict,
  // modal, or overlay already surfaced, the operation effectively resolved even
  // if a residual spinner/status element lingers.
  const pendingUnresolved = Boolean(after.pending && startedPending && !verdict && !modals.length && !masked);
  const navigated = after.url && before.url && after.url !== before.url;
  const changed = navigated || after.title !== before.title ||
    after.textLength !== before.textLength || after.domLength !== before.domLength ||
    after.textHash !== before.textHash || after.dialogs !== before.dialogs;
  const hasSignal = Boolean(
    dialogs.length || consoleErrors.length || pageErrors.length ||
    alerts.length || toasts.length || errors.length || validation.length ||
    modals.length || masked || verdict
  );
  // A modal/overlay that is present RIGHT NOW (even if it was already there
  // before this action) means the page is blocked and clicks miss their target.
  const blockedNow = Boolean(after.masked || after.modals.length);

  return { changed, navigated, url: after.url, dialogs, alerts, toasts, errors, validation, modals, masked, verdict, pendingUnresolved, blockedNow, currentModals: after.modals, consoleErrors, pageErrors, hasSignal };
}

// Collapse duplicates into "text (xN)".
function _tally(list) {
  const counts = new Map();
  for (const t of list) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].map(([t, n]) => (n > 1 ? `${t} (x${n})` : t));
}

const _looksLikeLogin = t => /登录|注册|登陆|验证码|扫码|sign\s?in|log\s?in|sign\s?up|authenticate/i.test(t);

function printReaction(r) {
  if (r.verdict) console.log(`[reaction] result: "${r.verdict}"`);
  for (const d of r.dialogs) console.log(`[reaction] dialog(${d.type}): "${d.message}" (auto-dismissed)`);
  for (const a of r.alerts) console.log(`[reaction] alert: "${a}"`);
  for (const v of r.validation) console.log(`[reaction] validation: ${v.field} -> "${v.message}"`);
  for (const e of r.errors) console.log(`[reaction] error: "${e}"`);
  for (const t of r.toasts) console.log(`[reaction] toast: "${t}"`);
  for (const m of r.modals) {
    const short = m.length > 100 ? m.slice(0, 100) + '…' : m;
    if (_looksLikeLogin(m)) {
      console.log(`[reaction] modal(login): a login/sign-up window appeared — NEEDS USER SUPPORT: log in first. text="${short}"`);
    } else {
      console.log(`[reaction] modal: a dialog opened — "${short}"`);
    }
  }
  if (r.masked && !r.modals.length) {
    console.log('[reaction] overlay: a modal/overlay dimmed and blocked the page (interaction likely blocked until it is dismissed)');
  }
  for (const c of _tally(r.consoleErrors)) console.log(`[reaction] console-error: ${c}`);
  for (const p of _tally(r.pageErrors)) console.log(`[reaction] page-error: ${p}`);
  if (r.pendingUnresolved) console.log('[reaction] still running: an async operation did not finish within the result window (raise AUTO_BROWSER_RESULT_TIMEOUT to wait longer)');
  if (r.navigated) console.log(`[reaction] navigated -> ${r.url}`);
  if (!r.hasSignal && !r.navigated) {
    if (r.blockedNow) {
      const m = r.currentModals[0] || '';
      const short = m.length > 100 ? m.slice(0, 100) + '…' : m;
      console.log(_looksLikeLogin(m)
        ? `[reaction] blocked: a login dialog is currently open and covering the page — NEEDS USER SUPPORT: log in first. Your action likely hit the overlay, not the target. text="${short}"`
        : '[reaction] blocked: a modal/overlay is currently covering the page — your action likely hit the overlay, not the intended target.');
    } else {
      console.log(r.changed
        ? '[reaction] page changed, but no explicit error/toast/dialog/validation was shown'
        : '[reaction] none — page showed no error, toast, dialog, or validation feedback');
    }
  }
}

// ============================================================
// "Action required" — surface blocking situations to the human IMMEDIATELY
// instead of silently waiting/retrying. When the page throws up a login/modal
// wall, we stop, tell the user exactly what is needed, and (in an interactive
// terminal) let them resolve it before continuing. A dedicated exit code lets
// an agent driving the CLI know "a human is needed" rather than "keep waiting".
// ============================================================
const EXIT_ACTION_REQUIRED = 10;

// Given a settled reaction (or a raw signals snapshot), decide whether the page
// now needs the human. Returns { reason, message } or null.
function actionRequiredReason(r) {
  const loginText = (r.modals || []).find(_looksLikeLogin)
    || ((r.blockedNow || r.masked) && _looksLikeLogin((r.currentModals || r.modals || [])[0] || ''));
  if (loginText) {
    return { reason: 'login', message: 'A login / sign-up window is blocking the page. Please log in in the Chrome window, then re-run the command.' };
  }
  const confirmDlg = (r.dialogs || []).find(d => d.type === 'confirm' || d.type === 'prompt' || d.type === 'beforeunload');
  if (confirmDlg) {
    return { reason: 'dialog', message: `A "${confirmDlg.type}" dialog appeared and was auto-dismissed (treated as cancel). If it needed to be accepted, tell me so I can handle it.` };
  }
  if ((r.modals || []).length) {
    return { reason: 'modal', message: 'A modal dialog opened and may block further actions. Handle it in the browser if needed, then re-run.' };
  }
  if (r.blockedNow || r.masked) {
    return { reason: 'overlay', message: 'A modal/overlay is currently covering the page; your action likely did not reach its target.' };
  }
  return null;
}

// Interactive resolve is STRICTLY OPT-IN (AUTO_BROWSER_INTERACTIVE=1 + a real
// TTY). By default we never block on stdin — an agent driving the CLI can't type,
// so blocking would just hang. Default behavior is: print [action-required],
// set the exit code, and return immediately so the caller can involve the human.
async function promptUserToResolve(page, req) {
  if (process.env.AUTO_BROWSER_INTERACTIVE !== '1' || !process.stdin.isTTY) return false;
  stopLiveness(); // human explicitly asked to wait here; don't let the watchdog fire
  process.stderr.write(`\n>>> ${req.message}\n>>> Resolve it in the browser, then press Enter to continue (Ctrl+C to abort)... `);
  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
  const after = await captureSignals(page);
  const stillBlocked = Boolean(after.masked || after.modals.length);
  console.log(stillBlocked
    ? '[action-required] still blocked — the dialog is still present.'
    : '[resolved] the blocking dialog is gone; continuing.');
  return !stillBlocked;
}

// Print the immediate action-required notice and set the exit code. Optionally
// offer the interactive resolve loop. Returns the reason (or null).
async function flagActionRequired(page, r, { interactive = true } = {}) {
  const req = actionRequiredReason(r);
  if (!req) return null;
  console.log(`\n[action-required] (${req.reason}) ${req.message}`);
  process.exitCode = EXIT_ACTION_REQUIRED;
  if (interactive) {
    const resolved = await promptUserToResolve(page, req);
    if (resolved) process.exitCode = 0;
  }
  return req;
}

// Shared post-action reporter: prints the action line + the settled reaction.
// Every action command routes through here so coverage is uniform.
// opts.retry: optional async () => boolean. When the action produced ZERO
// feedback (no change, no signal, no navigation), the retry runs once and the
// reaction is re-observed. Used by `click` for the native-DOM-click fallback —
// some frameworks (React controlled components, Zhihu buttons) ignore synthetic
// CDP mouse events entirely but respond to el.click().
async function reportAction(page, before, actionLine, opts = {}) {
  const json = args.includes('--json');
  let reaction = await observeReaction(page, before);
  let retried = false;

  if (opts.retry
    && !reaction.changed && !reaction.hasSignal && !reaction.navigated
    && !reaction.blockedNow && !_reactionEvents.dialogs.length) {
    const before2 = await captureSignals(page);
    resetReactionEvents();
    const ok = await opts.retry();
    if (ok) {
      retried = true;
      reaction = await observeReaction(page, before2);
    }
  }

  if (json) {
    const req = actionRequiredReason(reaction);
    if (req) process.exitCode = EXIT_ACTION_REQUIRED;
    console.log(JSON.stringify({ result: actionLine, reaction, actionRequired: req || null, retried }, null, 2));
    return reaction;
  }
  console.log(actionLine + (reaction.changed ? ' (result=changed)' : ' (result=no-observable-change)'));
  if (retried) console.log('(retried with native DOM click — js-fallback)');
  printReaction(reaction);
  await flagActionRequired(page, reaction);
  return reaction;
}

// ============================================================
// Command: help
// ============================================================

function showHelp() {
  console.log(`
auto-browser v3.0 — CDP-driven browser automation framework
Your browser is the API. No keys. No bots. No scrapers.

=== Chrome Lifecycle ===
  launch                 唤起 Chrome with CDP (auto-detects binary, dedicated profile)
  launch --force         Kill existing auto-browser Chrome, then launch fresh
  launch --headless      Launch in headless mode
  close                  关闭 auto-browser's Chrome (leaves your normal Chrome alone)
  status                 Show whether CDP Chrome is up, PIDs, and open tabs
  (all three accept --port=<n>)

=== Discover Elements (每个元素自带 kind + 可用动作) ===
  snap                   Snapshot page; each element shows kind & actions & href
  snap --kind=link       Only elements of one kind
  snap --action=fill     Only elements supporting an action
  snap --text=keyword    Only elements matching text
  snap --limit=200       Show more than the default 50
  find "登录"            Locate elements by text
  find --kind=text       Locate by kind
  find "SQL" --kind=link Combine text + kind
  find --action=select   Locate by supported action
  find ... --json        Machine-readable output
  links                  Harvest every href on the page (no clicking)
  links --contain=/foo/  Only hrefs containing a substring
  links --json           Machine-readable output

  kinds: link button text textarea select dropdown checkbox radio toggle
         slider file tab menuitem option icon label contenteditable
         draggable clickable
  actions: click open fill type select check uncheck contenteditable
           upload drag hover

=== Page Map Commands ===
  map <url>              Build page element map (7-layer detection)
  map <url> -v           Build map with visual overlay

=== Site Adapters (zero-token data extraction) ===
  site [list]            List available site adapters
  site <name> [args]     Run a site adapter (e.g. github-repo owner=zzfcharlie repo=auto-browser)

=== Overlay (bb-browser style element highlighting) ===
  snap -i                Snapshot with numbered overlay injected
  snap --inject          Same as -i
  overlay inject         Inject numbered overlay on cached elements
  overlay remove         Remove the numbered overlay

=== Click by Reference ===
  click @e3              Click element @e3 from last snapshot/find
  click <x> <y>          Click at pixel coordinates
  click <selector>       Click element matching CSS selector
  hover @e3              Hover element @e3
  (refs survive DOM rebuilds — they re-locate by CSS, XPath, then semantics)


=== Network Capture ===
  network start          Start capturing network requests
  network requests       Show captured requests (--with-body for bodies)
  network stop           Stop capture and show results
  network clear          Clear captured requests
  network nav <url>      Navigate and capture all network activity

=== Navigation & Observation ===
  open <url>             Navigate to URL
  snap                   Snapshot current page (build map)
  diff                   Compare current page map with last snapshot
  detect                 Detect UI framework on current page
  screenshot             Take a JPEG screenshot (base64)
  eval <js>              Execute JavaScript in page context
  eval --file <path.js>  Run JS from a file (avoids shell quote mangling)
  eval --stdin           Run JS piped from stdin
  get <attr>             Get page attribute (title, url, html, text)
  run <plan.json>        Execute a batch plan (JSON array of steps) in ONE call
  run --stdin            Read the plan from stdin (ops: open wait snap click fill
                         select check contenteditable type eval extract assert ...)

=== Interaction (每个命令都接受 @ref 或 CSS selector) ===
  click <@ref|sel>       Click element (or: click <x> <y> for coordinates)
  fill <@ref|sel> <val>  Fill a text input / textarea
  type <text>            Type into whatever has focus
  select <@ref|sel> <v>  Choose an option in a native <select>
  check <@ref|sel>       Tick a checkbox / radio
  uncheck <@ref|sel>     Untick a checkbox
  contenteditable <@ref|sel> <text>   Set a contenteditable's text
  upload <@ref|sel> <file> [f2 ...]   Attach files to <input type=file>
  drag <@ref|sel> <@ref|sel>          Drag one element onto another
  drag <@ref|sel> --to=<x>,<y>        Drag to viewport coordinates
  drag <@ref|sel> --by=<dx>,<dy>      Drag by a delta (sliders)
  hover <@ref|sel>       Hover an element
  scroll <x> <y>         Scroll to position

=== Waiting ===
  wait selector <sel>    Wait for a CSS selector to appear
  wait text <text>       Wait for text to appear
  wait url <pattern>     Wait for the URL to match
  wait stable            Wait for the DOM to stop changing


=== Daemon (background server) ===
  daemon start           Start daemon on 127.0.0.1:19824
  daemon start --port <p>  Start on custom port
  daemon stop            Stop daemon
  daemon status          Daemon status

=== Tab Management ===
  tab list               List all tabs
  tab new                Create new tab
  tab close <id>         Close a tab

=== Cache ===
  cache [list]           List cached page maps
  cache clear            Clear all cache

=== Other ===
  help                   Show this help

Examples:
  # The core loop: open -> discover -> act
  auto-browser open https://example.com
  auto-browser find "登录" --kind=button
  auto-browser click @e12

  # Harvest links without clicking through
  auto-browser links --contain=/practice/ --json

  # Fill a form
  auto-browser find --action=fill
  auto-browser fill @e5 "hello"
  auto-browser select @e8 "Audi"
  auto-browser check @e9

  # Complex extraction (put JS in a file to dodge shell quoting)
  auto-browser eval --file scrape.js

  auto-browser site github-repo owner=zzfcharlie repo=auto-browser
  auto-browser network nav https://example.com --with-body --json
  auto-browser close

Note: every command auto-launches Chrome if it isn't running, so
"launch" is optional — use it when you want an explicit/fresh start.
`.trim());
}

// Compact one-line summary of a plan step result (for `run` output).
function summarizeStepResult(r) {
  const res = r.result || {};
  switch (r.op) {
    case 'open': return `${res.url || ''}${res.title ? ' — ' + String(res.title).slice(0, 40) : ''}`;
    case 'snap': return `${res.elementCount} elements${res.kinds ? ' (' + Object.entries(res.kinds).map(([k, n]) => `${k}=${n}`).join(' ') + ')' : ''}`;
    case 'links': return `${res.count} links`;
    case 'extract': return `${res.count} items`;
    case 'click': return `${res.label || ''}${res.retried ? ' [js-fallback]' : ''}${res.changed ? ' changed' : ' no-change'}${res.verdict ? ' verdict="' + res.verdict + '"' : ''}`;
    case 'fill':
    case 'contenteditable': return `${res.label || ''} = "${String(res.value || '').slice(0, 30)}"${res.verified ? ' (verified)' : ''}`;
    case 'select': return `${res.label || ''} -> ${res.option || ''}`;
    case 'check':
    case 'uncheck': return `${res.label || ''} checked=${res.checked}`;
    case 'wait':
    case 'assert': return `${res.asserted || res.kind || ''} "${res.target || ''}"`;
    case 'eval': return typeof res.result === 'string' ? res.result.slice(0, 80) : JSON.stringify(res.result)?.slice(0, 80) || '';
    case 'type': return `"${res.text || ''}"`;
    default: return '';
  }
}

// ============================================================
// Main command dispatcher
// ============================================================

async function main() {
  // Pre-load site adapters
  try {
    await loadBuiltInAdapters();
  } catch {}

  switch (cmd) {

    // ==================== HELP ====================
    case undefined:
    case 'help':
    case '--help':
      showHelp();
      process.exit(0);

    // ==================== CHROME LIFECYCLE ====================
    // launch / close / status — explicit control over the CDP browser.
    case 'launch':
    case 'up':
    case 'start-chrome': {
      const force = args.includes('-f') || args.includes('--force');
      const headless = args.includes('--headless');
      const portArg = args.find(a => a.startsWith('--port='));
      const port = portArg ? Number(portArg.split('=')[1]) : undefined;

      const result = await launchChrome({ force, headless, port });
      if (result.launched) {
        console.log(`Chrome launched: ${result.browserURL}`);
        console.log(`Binary:  ${result.binary}`);
        console.log(`Profile: ${result.profileDir}`);
        console.log(`PID:     ${result.pid}`);
      } else {
        console.log(`Chrome already running: ${result.browserURL}`);
      }
      console.log(`Version: ${result.version?.Browser || 'unknown'}`);
      break;
    }

    case 'close':
    case 'down':
    case 'kill-chrome': {
      const portArg = args.find(a => a.startsWith('--port='));
      const port = portArg ? Number(portArg.split('=')[1]) : undefined;

      const result = await closeChrome({ port });
      if (!result.wasRunning && result.killed.length === 0) {
        console.log(`No auto-browser Chrome running on port ${result.port}.`);
      } else {
        console.log(`Closed auto-browser Chrome on port ${result.port}.`);
        if (result.killed.length) console.log(`Killed PIDs: ${result.killed.join(', ')}`);
        if (result.failed.length) console.log(`Failed PIDs: ${result.failed.join(', ')}`);
        console.log(`Port free: ${result.portFree}`);
      }
      break;
    }

    case 'status': {
      const portArg = args.find(a => a.startsWith('--port='));
      const port = portArg ? Number(portArg.split('=')[1]) : undefined;

      const s = await chromeStatus({ port });
      console.log(`Running: ${s.running}`);
      console.log(`Endpoint: ${s.browserURL}`);
      console.log(`Profile: ${s.profileDir}`);
      if (s.running) {
        console.log(`Version: ${s.version?.Browser || 'unknown'}`);
        console.log(`PIDs: ${s.pids.join(', ') || 'unknown'}`);
        console.log(`Tabs: ${s.tabs.length}`);
        s.tabs.slice(0, 10).forEach((t, i) => {
          console.log(`  ${i + 1}. ${String(t.title).slice(0, 50)} — ${String(t.url).slice(0, 70)}`);
        });
      }
      break;
    }

    // ==================== MAP ====================
    case 'map': {
      const url = args[0];
      if (!url) { console.error('Usage: auto-browser map <url> [-v]'); process.exit(1); }
      const visualize = args.includes('-v') || args.includes('--visualize');

      const ab = await getAB();
      await ab.navigate(url);

       const map = await ab.buildMap({ compress: true });
       const framework = await ab.detectFramework();
       saveSnapshot(map);

       console.log(`\nURL: ${map.url}`);
      console.log(`Title: ${map.title}`);
      console.log(`Framework: ${framework.detected} (confidence: ${framework.confidence})`);
      console.log(`Elements: ${map.elements.length}\n`);

      map.elements.slice(0, 50).forEach((el, i) => {
        const desc = el.text || el.role || el.tag;
        console.log(`  #${i + 1}: [${el.source || 'std'}] <${el.tag}> "${String(desc).slice(0, 40)}" at (${el.rect.x},${el.rect.y})`);
      });
      if (map.elements.length > 50) {
        console.log(`  ... and ${map.elements.length - 50} more`);
      }

      if (visualize) {
        await ab.injectOverlay(map.elements);
        console.log('\nOverlay injected. Press Ctrl+C to exit.');
        await new Promise(() => {});
      }
      break;
    }

    // ==================== SITE ====================
    case 'site': {
      const sub = args[0];

      if (!sub || sub === 'list') {
        const adapters = listAdapters();
        if (adapters.length === 0) {
          console.log('No site adapters loaded.');
          break;
        }
        console.log(`\nAvailable site adapters (${adapters.length}):\n`);
        adapters.forEach(a => {
          console.log(`  ${a.name}`);
          console.log(`    ${a.description}`);
          if (a.params?.length) console.log(`    Params: ${a.params.join(', ')}`);
          if (a.examples?.length) {
            a.examples.forEach(ex => {
              const paramStr = Object.entries(ex.params || {}).map(([k, v]) => `${k}=${v}`).join(' ');
              console.log(`    Example: auto-browser site ${a.name} ${paramStr}`);
            });
          }
          console.log('');
        });
        break;
      }

      // Parse key=value params
      const adapterName = sub;
      const params = {};
      for (const arg of args.slice(1)) {
        const eqIdx = arg.indexOf('=');
        if (eqIdx > 0) {
          params[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
        }
      }
      // Also support positional params (first unused)
      if (Object.keys(params).length === 0 && args.length > 1) {
        params._ = args.slice(1);
      }

      try {
        const ab = await getAB();
        const page = ab.getPage();
        const result = await runAdapter(page, adapterName, params);
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      break;
    }

    // ==================== NETWORK ====================
    case 'network': {
      const sub = args[0];

      switch (sub) {
        case 'start': {
          const withBody = args.includes('--with-body');
          const page = await getPage();
          await network.startCapture(page, { withBody });
          console.log(`Network capture started (body=${withBody}).`);
          console.log('Use "auto-browser network requests" to see captured requests.');
          console.log('Use "auto-browser network stop" to stop.');
          break;
        }
        case 'requests': {
          const requests = network.getCapturedRequests();
          const withBody = args.includes('--with-body');

          if (requests.length === 0) {
            console.log('No requests captured. Use "auto-browser network start" first.');
            break;
          }

          console.log(`\nCaptured ${requests.length} requests:\n`);
          requests.forEach((r, i) => {
            const method = r.method?.padEnd(6);
            const status = r.response ? r.response.status : '...';
            console.log(`  ${i + 1}. [${method}] ${status} ${r.url.slice(0, 100)}`);
            if (withBody && r.body) {
              const bodyStr = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
              console.log(`     Body: ${bodyStr.slice(0, 200)}`);
            }
          });

          if (args.includes('--json')) {
            console.log('\n--- JSON ---');
            console.log(JSON.stringify(requests, null, 2));
          }
          break;
        }
        case 'stop': {
          const page = await getPage();
          const count = await network.stopCapture(page);
          const requests = network.getCapturedRequests();
          console.log(`\nCaptured ${count} requests:\n`);
          requests.forEach((r, i) => {
            const method = r.method?.padEnd(6);
            const status = r.response ? r.response.status : '...';
            const type = r.resourceType?.padEnd(10);
            console.log(`  ${i + 1}. [${method}] ${status} ${type} ${r.url.slice(0, 90)}`);
          });

          if (args.includes('--json')) {
            console.log('\n--- JSON ---');
            console.log(JSON.stringify(requests, null, 2));
          }
          break;
        }
        case 'clear': {
          network.clearCapturedRequests();
          console.log('Captured requests cleared.');
          break;
        }
        case 'nav': {
          const url = args[1];
          if (!url) { console.error('Usage: auto-browser network nav <url> [--with-body]'); process.exit(1); }
          const withBody = args.includes('--with-body');
          const page = await getPage();
          const requests = await network.captureNavigation(page, url, { withBody });
          console.log(`\nCaptured ${requests.length} requests from ${url}:\n`);
          requests.forEach((r, i) => {
            const method = r.method?.padEnd(6);
            const status = r.response ? r.response.status : '...';
            console.log(`  ${i + 1}. [${method}] ${status} ${r.url.slice(0, 90)}`);
          });

          if (args.includes('--json')) {
            console.log('\n--- JSON ---');
            console.log(JSON.stringify(requests, null, 2));
          }
          break;
        }
        default:
          console.log('Usage: auto-browser network [start|stop|requests|clear|nav] [--with-body] [--json]');
      }
      break;
    }

    // ==================== DAEMON ====================
    case 'daemon': {
      const sub = args[0];

      switch (sub) {
        case 'start': {
          const portIdx = args.indexOf('--port');
          const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 19824;
          const hostIdx = args.indexOf('--host');
          const host = hostIdx >= 0 ? args[hostIdx + 1] : '127.0.0.1';

          try {
            const result = await startDaemon({ port, host });
            console.log(`Daemon started on http://${result.host}:${result.port}`);
            console.log('Run "auto-browser daemon status" to check.');
            console.log('Available daemon commands via HTTP POST /command');
          } catch (e) {
            console.error(`Failed to start daemon: ${e.message}`);
          }
          break;
        }
        case 'stop': {
          await stopDaemon();
          console.log('Daemon stopped.');
          break;
        }
        case 'status': {
          const { getDaemonStatus } = await import('../daemon/index.mjs');
          const status = getDaemonStatus();
          console.log(`\nDaemon running: ${status.running}`);
          console.log(`Server: ${status.serverRunning ? 'listening' : 'stopped'}`);
          console.log(`Browser connected: ${status.browser?.isConnected() || false}`);
          console.log(`Started at: ${status.startedAt || 'N/A'}`);
          console.log(`Tabs: ${Object.keys(status.pages || {}).length}`);
          if (Object.keys(status.pages || {}).length > 0) {
            console.log('');
            for (const [id, p] of Object.entries(status.pages)) {
              console.log(`  ${id}: ${p.title || 'untitled'} — ${p.url || '(blank)'}`);
            }
          }
          break;
        }
        default:
          console.log('Usage: auto-browser daemon [start|stop|status]');
      }
      break;
    }

    // ==================== OPEN ====================
    case 'open': {
      const url = args[0];
      if (!url) { console.error('Usage: auto-browser open <url>'); process.exit(1); }
      const ab = await getAB();
      await ab.navigate(url);
      const page = ab.getPage();
      attachReactionListeners(page);
      const title = await page.title();
      console.log(`Opened: ${url}`);
      console.log(`Title: ${title}`);
      // Sites often throw up a login wall right after load. Detect it now and
      // tell the user immediately instead of letting later commands wait on a
      // page that is already blocked.
      const signals = await captureSignals(page);
      if (args.includes('--json')) {
        const req = actionRequiredReason(signals);
        if (req) { process.exitCode = EXIT_ACTION_REQUIRED; console.log(JSON.stringify({ actionRequired: req }, null, 2)); }
      } else if (signals.masked || signals.modals.length) {
        const m = signals.modals[0] || '';
        const short = m.length > 100 ? m.slice(0, 100) + '…' : m;
        if (m) console.log(`[reaction] ${_looksLikeLogin(m) ? 'modal(login)' : 'modal'}: "${short}"`);
        await flagActionRequired(page, signals);
      }
      break;
    }

    // ==================== SNAP ====================
    case 'snap':
    case 'snapshot': {
      const ab = await getAB();
      const map = await ab.buildMap({ compress: true });
      const fw = await ab.detectFramework();
      _lastElements = map.elements; // cache for @ref clicks
      saveSnapshot(map);

      // Optional filters so a snap on a huge page stays readable:
      //   snap --kind=link       only links
      //   snap --action=fill     only fillable things
      //   snap --text=SQL        only matching text
      //   snap --limit=200
      const kindArg = args.find(a => a.startsWith('--kind='));
      const actionArg = args.find(a => a.startsWith('--action='));
      const textArg = args.find(a => a.startsWith('--text='));
      const limitArg = args.find(a => a.startsWith('--limit='));
      const limit = limitArg ? Number(limitArg.split('=')[1]) : 50;

      const filtered = (kindArg || actionArg || textArg)
        ? queryMap(map, {
            kind: kindArg?.split('=')[1],
            action: actionArg?.split('=')[1],
            text: textArg?.split('=').slice(1).join('='),
            visibleOnly: false,
            limit: Number.isFinite(limit) ? limit : 50
          })
        : map.elements.slice(0, Number.isFinite(limit) ? limit : 50);

      console.log(`\nTitle: ${map.title}`);
      console.log(`Framework: ${fw.detected}`);
      console.log(`Elements: ${map.elements.length}`);
      printKinds(map.kinds);
      console.log(`Showing: ${filtered.length}\n`);

      filtered.forEach((el, i) => console.log(formatElement(el, i)));

      const shown = filtered.length;
      if (!kindArg && !actionArg && !textArg && map.elements.length > shown) {
        console.log(`\n  ... and ${map.elements.length - shown} more`);
        console.log(`  Narrow it down: snap --kind=link | --action=fill | --text=keyword | --limit=200`);
      }


      // Inject overlay if -i or --inject flag
      if (args.includes('-i') || args.includes('--inject')) {
        await ab.injectOverlay(map.elements);
        _overlayActive = true;
        console.log('\n🟢 Overlay injected! Elements are numbered on screen.');
        console.log('   Use "click @N" to click by number.');
        console.log('   Use "overlay remove" to clear.');
      }

      if (args.includes('--json')) {
        console.log('\n--- JSON ---');
        console.log(JSON.stringify(map, null, 2));
      }
      break;
    }

    // ==================== FIND ====================
    // Locate elements by text / kind / action without dumping the page.
    //   find "登录"
    //   find --kind=text
    //   find "SQL" --kind=link --json
    //   find --action=select
    case 'find': {
      const ab = await getAB();
      const map = await ab.buildMap({ compress: true });
      _lastElements = map.elements;
      saveSnapshot(map);

      const kindArg = args.find(a => a.startsWith('--kind='));
      const actionArg = args.find(a => a.startsWith('--action='));
      const limitArg = args.find(a => a.startsWith('--limit='));
      const text = args.find(a => !a.startsWith('--')) || '';
      const limit = limitArg ? Number(limitArg.split('=')[1]) : 30;

      const hits = queryMap(map, {
        text,
        kind: kindArg?.split('=')[1],
        action: actionArg?.split('=')[1],
        visibleOnly: !args.includes('--all'),
        limit: Number.isFinite(limit) ? limit : 30
      });

      if (args.includes('--json')) {
        console.log(JSON.stringify(hits, null, 2));
        break;
      }

      const criteria = [
        text ? `text~"${text}"` : '',
        kindArg ? kindArg.replace('--', '') : '',
        actionArg ? actionArg.replace('--', '') : ''
      ].filter(Boolean).join(' ') || 'all';

      console.log(`\nPage: ${map.title}`);
      printKinds(map.kinds);
      console.log(`Query: ${criteria}`);
      console.log(`Matches: ${hits.length}\n`);

      if (!hits.length) {
        console.log('  No match. Try: find --kind=<kind>  (see Kinds above), or add --all for hidden elements.');
        break;
      }
      hits.forEach((el, i) => console.log(formatElement(el, i)));
      console.log(`\n  Act on one: click @<ref> | fill @<ref> "value" | select @<ref> "option" | hover @<ref>`);
      break;
    }

    // ==================== LINKS ====================
    // Harvest hrefs in one shot — no click-through needed.
    //   links
    //   links --contain=/practice/
    //   links --json
    case 'links': {
      const ab = await getAB();
      const map = await ab.buildMap({ compress: true });
      _lastElements = map.elements;
      saveSnapshot(map);

      const containArg = args.find(a => a.startsWith('--contain='));
      const needle = containArg ? containArg.split('=').slice(1).join('=') : '';
      const limitArg = args.find(a => a.startsWith('--limit='));
      const limit = limitArg ? Number(limitArg.split('=')[1]) : 200;

      let links = map.elements
        .filter(el => el.href)
        .filter(el => (needle ? el.href.includes(needle) : true))
        .map(el => ({
          ref: el.ref,
          text: String(el.name || el.text || '').replace(/\s+/g, ' ').trim(),
          href: el.href,
          y: el.rect?.y ?? 0
        }));

      // Page order (top-to-bottom) is usually the meaningful order.
      links.sort((a, b) => a.y - b.y);
      links = links.slice(0, Number.isFinite(limit) ? limit : 200);

      if (args.includes('--json')) {
        console.log(JSON.stringify(links, null, 2));
        break;
      }
      console.log(`\nPage: ${map.title}`);
      console.log(`Links: ${links.length}${needle ? ` (containing "${needle}")` : ''}\n`);
      links.forEach((l, i) => {
        console.log(`  ${String(i + 1).padStart(3)}. @${(l.ref || '').padEnd(6)} "${l.text.slice(0, 44)}"`);
        console.log(`       ${l.href}`);
      });
      break;
    }

    // ==================== DRAG ====================
    // drag @a @b            drag element a onto element b
    // drag @a --to=300,400  drag element a to viewport coords
    // drag @slider --by=120,0  move by a delta (sliders)
    case 'drag': {
      const page = await getPage();
      const from = args[0];
      if (!from) {
        console.error('Usage: auto-browser drag <@ref|selector> <@ref|selector>');
        console.error('       auto-browser drag <@ref|selector> --to=<x>,<y>');
        console.error('       auto-browser drag <@ref|selector> --by=<dx>,<dy>');
        process.exit(1);
      }

      const src = await resolveTarget(page, from);
      const srcBox = await src.handle.boundingBox();
      if (!srcBox) {
        console.error(`drag: ${src.label} has no layout box (hidden?)`);
        process.exit(1);
      }
      const start = { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 };

      const toArg = args.find(a => a.startsWith('--to='));
      const byArg = args.find(a => a.startsWith('--by='));
      let end;
      let destLabel;

      if (toArg) {
        const [x, y] = toArg.split('=')[1].split(',').map(Number);
        end = { x, y };
        destLabel = `(${x},${y})`;
      } else if (byArg) {
        const [dx, dy] = byArg.split('=')[1].split(',').map(Number);
        end = { x: start.x + dx, y: start.y + dy };
        destLabel = `delta(${dx},${dy})`;
      } else {
        const to = args.find((a, i) => i > 0 && !a.startsWith('--'));
        if (!to) {
          console.error('drag: provide a destination (@ref, selector, --to=x,y, or --by=dx,dy)');
          process.exit(1);
        }
        const dst = await resolveTarget(page, to);
        const dstBox = await dst.handle.boundingBox();
        await dst.handle.dispose();
        if (!dstBox) {
          console.error(`drag: ${dst.label} has no layout box (hidden?)`);
          process.exit(1);
        }
        end = { x: dstBox.x + dstBox.width / 2, y: dstBox.y + dstBox.height / 2 };
        destLabel = dst.label;
      }
      await src.handle.dispose();

      const before = await captureSignals(page);
      resetReactionEvents();
      // Move in steps: HTML5 drag & drop and slider widgets both need
      // intermediate mousemove events, not a single jump.
      await page.mouse.move(Math.round(start.x), Math.round(start.y));
      await page.mouse.down();
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
          Math.round(start.x + ((end.x - start.x) * i) / steps),
          Math.round(start.y + ((end.y - start.y) * i) / steps)
        );
        await new Promise(r => setTimeout(r, 12));
      }
      await page.mouse.up();
      await reportAction(page, before, `Dragged ${src.label} -> ${destLabel}`);
      break;
    }

    // ==================== UPLOAD ====================
    // upload @ref <file> [more files...]
    case 'upload': {
      const target = args[0];
      const files = args.slice(1).filter(a => !a.startsWith('--'));
      if (!target || !files.length) {
        console.error('Usage: auto-browser upload <@ref|selector> <file> [file2 ...]');
        process.exit(1);
      }
      for (const f of files) {
        if (!fs.existsSync(f)) {
          console.error(`upload: file not found: ${f}`);
          process.exit(1);
        }
      }
      const page = await getPage();
      const { handle, label } = await resolveTarget(page, target);
      const isFileInput = await handle.evaluate(el => el.tagName === 'INPUT' && el.type === 'file');
      if (!isFileInput) {
        console.error(`upload ${label}: not an <input type="file">. Use "find --kind=file" to locate one.`);
        await handle.dispose();
        process.exit(1);
      }
      const before = await captureSignals(page);
      resetReactionEvents();
      await handle.uploadFile(...files.map(f => path.resolve(f)));
      await handle.dispose();
      await reportAction(page, before, `Uploaded ${files.length} file(s) to ${label}: ${files.join(', ')}`);
      break;
    }

    // ==================== DETECT ====================
    case 'detect': {
      const ab = await getAB();
      const result = await ab.detectFramework();
      console.log(`Framework: ${result.detected}`);
      console.log(`Confidence: ${result.confidence}/3`);
      console.log('Details:', JSON.stringify(result.results));
      break;
    }

    // ==================== SCREENSHOT ====================
    case 'screenshot': {
      const ab = await getAB();
      const page = ab.getPage();
      const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
      const filename = `screenshot-${Date.now()}.jpg`;
      fs.writeFileSync(filename, buffer);
      console.log(`Screenshot saved: ${filename}`);
      break;
    }

    // ==================== EVAL ====================
    // Inline code is fragile in shells that eat quotes (PowerShell).
    // Prefer:  eval --file script.js   or   eval --stdin
    case 'eval': {
      const fileArg = args.find(a => a.startsWith('--file='));
      const fileFlagIndex = args.indexOf('--file');
      let code = '';
      let source = 'inline';

      if (fileArg) {
        const p = fileArg.split('=').slice(1).join('=');
        code = fs.readFileSync(p, 'utf8');
        source = p;
      } else if (fileFlagIndex >= 0 && args[fileFlagIndex + 1]) {
        const p = args[fileFlagIndex + 1];
        code = fs.readFileSync(p, 'utf8');
        source = p;
      } else if (args.includes('--stdin') || args.includes('-')) {
        code = fs.readFileSync(0, 'utf8');
        source = 'stdin';
      } else {
        code = args.filter(a => !a.startsWith('--')).join(' ');
      }

      if (!code.trim()) {
        console.error('Usage: auto-browser eval <js-code>');
        console.error('       auto-browser eval --file <path.js>   (recommended — avoids shell quoting)');
        console.error('       auto-browser eval --stdin            (pipe code in)');
        process.exit(1);
      }

      const page = await getPage();

            // A file may contain statements/newlines. buildEvalPayload picks the
            // right wrapper: single expression -> direct; explicit return/top-level
            // await -> async IIFE; statement list -> eval completion value so the
            // last expression becomes the result WITHOUT requiring `return`.
            const payload = buildEvalPayload(code);

      let result;
      try {
        result = await page.evaluate(payload);
      } catch (e) {
        console.error(`Eval failed (${source}): ${e.message}`);
        if (source === 'inline') {
          console.error('Hint: shells strip quotes from inline JS. Put the code in a file and use --file.');
        }
        process.exit(1);
      }
      console.log(typeof result === 'object' ? JSON.stringify(result, null, 2) : result);
      break;
    }

    // ==================== GET ====================
    case 'get': {
      const attr = args[0];
      if (!attr) { console.error('Usage: auto-browser get <attr> (title, url, html, text)'); process.exit(1); }
      const page = await getPage();
      const value = await page.evaluate((a) => {
        if (a === 'url') return location.href;
        if (a === 'title') return document.title;
        if (a === 'html') return document.documentElement.outerHTML;
        if (a === 'text') return document.body.innerText;
        return document[a]?.toString?.();
      }, attr);
      console.log(value?.slice(0, 5000));
      break;
    }

    // ==================== CLICK ====================
    case 'click': {
      const page = await getPage();

      // Click by @ref number (bb-browser style)
      if (args[0]?.startsWith('@')) {
        const resolved = await resolveRef(page, args[0]);
        if (!resolved) {
          console.error(`Invalid ref: ${args[0]}. Available: 1-${_lastElements.length}`);
          console.log('Run "snap" first to see element references.');
          process.exit(1);
        }
        const state = await resolved.handle.evaluate(node => ({
          disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
          connected: node.isConnected,
          visible: node.offsetParent !== null
        }));
        if (!state.connected || !state.visible || state.disabled) {
          await resolved.handle.dispose();
          console.error(`Ref ${args[0]} is not actionable (visible=${state.visible}, disabled=${state.disabled})`);
          process.exit(1);
        }
        if (resolved.confidence < 80) {
          console.warn(`Warning: ${args[0]} matched with confidence ${resolved.confidence} via ${resolved.method}`);
        }
        const before = await captureSignals(page);
        resetReactionEvents();
        const box = await withTimeout(resolved.handle.boundingBox(), 5000, 'boundingBox');
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          // No layout box: fall back to a native DOM click (also avoids
          // puppeteer's hang-prone scrollIntoViewIfNeeded path).
          await resolved.handle.evaluate(el => el.click());
        }
        const el = resolved.element;
        await reportAction(page, before, `Clicked @${el.ref}: <${el.tag}> "${String(el.text || '').slice(0, 40)}" (re-located)`, {
          retry: async () => {
            const ok = await resolved.handle.evaluate(node => {
              if (node.isConnected && typeof node.click === 'function') { node.click(); return true; }
              return false;
            }).catch(() => false);
            return ok;
          }
        });
        await resolved.handle.dispose();
        break;
      }

      // Click by selector if first arg starts with . or #
      if (args[0]?.startsWith('.') || args[0]?.startsWith('#')) {
        const el = await page.$(args[0]);
        if (!el) { console.error(`Element not found: ${args[0]}`); process.exit(1); }
        const before = await captureSignals(page);
        resetReactionEvents();
        // Use a raw mouse click at the element's box center (like the @ref path)
        // instead of puppeteer's awaited el.click(), which can hang when the
        // element is covered by an overlay/modal.
        const box = await withTimeout(el.boundingBox(), 5000, 'boundingBox');
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await el.evaluate(node => node.click());
        }
        await reportAction(page, before, `Clicked: ${args[0]}`, {
          retry: async () => {
            const ok = await el.evaluate(node => {
              if (node.isConnected && typeof node.click === 'function') { node.click(); return true; }
              return false;
            }).catch(() => false);
            return ok;
          }
        });
        await el.dispose();
      } else if (args[0] && args[1]) {
        const x = parseInt(args[0]), y = parseInt(args[1]);
        if (isNaN(x) || isNaN(y)) { console.error('Click: provide x y coordinates'); process.exit(1); }
        const before = await captureSignals(page);
        resetReactionEvents();
        await page.mouse.click(x, y);
        await reportAction(page, before, `Clicked at (${x}, ${y})`);
      } else {
        console.error('Usage: auto-browser click <@N | x y | selector>');
        process.exit(1);
      }
      break;
    }

    // ==================== FILL ====================
    case 'fill': {
      const [selector, value] = args;
      if (!selector || value === undefined) {
        console.error('Usage: auto-browser fill <selector> <value>');
        process.exit(1);
      }
      const page = await getPage();
      let handle;
      let label = selector;
      if (selector.startsWith('@')) {
        const resolved = await resolveRef(page, selector);
        if (!resolved) {
          console.error(`Element not found: ${selector}. Run "snap" first.`);
          process.exit(1);
        }
        handle = resolved.handle;
        label = resolved.element.ref;
        if (resolved.confidence < 80) {
          console.warn(`Warning: ${selector} matched with confidence ${resolved.confidence} via ${resolved.method}`);
        }
      } else {
        handle = await page.$(selector);
      }
      if (!handle) {
        console.error(`Element not found: ${selector}`);
        process.exit(1);
      }
      const fillState = await handle.evaluate(node => ({
        connected: node.isConnected,
        visible: node.offsetParent !== null,
        disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
        // isContentEditable covers contenteditable="true" AND contenteditable=""
        // (React's common form); the old [contenteditable="true"] check missed "".
        editable: node.isContentEditable || node.matches('input, textarea'),
        contentEditable: node.isContentEditable
      }));
      if (!fillState.connected || !fillState.visible || fillState.disabled || !fillState.editable) {
        await handle.dispose();
        console.error(`Element is not fillable: ${selector}`);
        process.exit(1);
      }
      const before = await captureSignals(page);
      resetReactionEvents();
      await handle.evaluate(node => node.focus());
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(value, { delay: 10 });
      const actualValue = await handle.evaluate(node => node.isContentEditable ? node.textContent : node.value);
      await handle.dispose();
      if (actualValue !== value) {
        if (fillState.contentEditable) {
          // Rich editors (Draft.js, ProseMirror) normalize/transform input, so
          // exact equality can't be guaranteed — warn instead of hard-failing.
          console.warn(`Fill verification: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualValue)} — rich editors may transform input; continuing`);
        } else {
          console.error(`Fill verification failed for ${selector}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actualValue)}`);
          process.exit(1);
        }
      }
      await reportAction(page, before, `Filled "${label}" with "${value}" (verified)`);
      break;
    }

    case 'diff': {
      if (!fs.existsSync(SNAPSHOT_FILE)) {
        console.error('No previous snapshot. Run "snap" first.');
        process.exit(1);
      }
      const previous = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      const current = await getAB().then(ab => ab.buildMap({ compress: true }));
      const diff = diffMaps(previous, current);
      console.log(JSON.stringify({
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        details: diff
      }, null, 2));
      break;
    }

    // ==================== WAIT ====================
    case 'wait': {
      const kind = args[0];
      const target = args[1];
      const timeout = Number(args[2]) || 10000;
      const page = await getPage();
      if (kind === 'selector') await waitForSelector(page, target, { timeout });
      else if (kind === 'text') await waitForText(page, target, { timeout });
      else if (kind === 'url') await waitForUrl(page, target, { timeout });
      else if (kind === 'stable') await waitForDomStable(page, { timeout });
      else {
        console.error('Usage: auto-browser wait [selector|text|url|stable] <value> [timeout]');
        process.exit(1);
      }
      console.log(`Wait satisfied: ${kind}${target ? ` ${target}` : ''}`);
      break;
    }

    // ==================== HOVER ====================
    case 'hover': {
      const target = args[0];
      if (!target) {
        console.error('Usage: auto-browser hover <@ref | selector>');
        process.exit(1);
      }
      const page = await getPage();
      let handle;
      let label = target;
      if (target.startsWith('@')) {
        const resolved = await resolveRef(page, target);
        if (!resolved) {
          console.error(`Element not found: ${target}. Run "snap" first.`);
          process.exit(1);
        }
        handle = resolved.handle;
        label = resolved.element.ref;
        if (resolved.confidence < 80) {
          console.warn(`Warning: ${target} matched with confidence ${resolved.confidence} via ${resolved.method}`);
        }
      } else {
        handle = await page.$(target);
      }
      if (!handle) {
        console.error(`Element not found: ${target}`);
        process.exit(1);
      }
      const hoverState = await withTimeout(handle.evaluate(node => ({
        connected: node.isConnected,
        visible: node.offsetParent !== null,
        disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true')
      })), 5000, 'hover:state');
      if (!hoverState.connected || !hoverState.visible || hoverState.disabled) {
        await handle.dispose();
        console.error(`Element is not hoverable: ${target}`);
        process.exit(1);
      }
      const before = await captureSignals(page);
      resetReactionEvents();
      // Never use puppeteer's ElementHandle.hover() here: it runs CDP
      // DOM.scrollIntoViewIfNeeded internally, which blocked indefinitely on
      // Zhihu's long/dynamic DOM (observed: 90s hang in the "connected" phase,
      // only the watchdog killed it). resolveRef already scrolled the element
      // into view, so moving the real mouse to the box center is equivalent
      // and cannot hang.
      const box = await withTimeout(handle.boundingBox(), 5000, 'hover:boundingBox');
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        const pt = await withTimeout(handle.evaluate(node => {
          node.scrollIntoView({ block: 'center', inline: 'center' });
          const r = node.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }), 5000, 'hover:rect').catch(() => null);
        if (pt) await page.mouse.move(pt.x, pt.y);
      }
      await handle.dispose();
      await reportAction(page, before, `Hovered "${label}"`);
      break;
    }

    // ==================== FORM CONTROLS ====================
    // All of these accept either an @ref (from snap/find) or a CSS selector,
    // so the discover -> act loop is uniform across every command.
    case 'select': {
      const [target, value] = args;
      if (!target || value === undefined) {
        console.error('Usage: auto-browser select <@ref|selector> <value>');
        process.exit(1);
      }
      const page = await getPage();
      const { handle, label } = await resolveTarget(page, target);
      const before = await captureSignals(page);
      resetReactionEvents();
      const ok = await handle.evaluate((el, wanted) => {
        if (el.tagName !== 'SELECT') return { error: `not a <select> (got <${el.tagName}>)` };
        const option = [...el.options].find(
          o => o.value === wanted || o.textContent.trim() === wanted
        );
        if (!option) {
          return { error: 'option not found', available: [...el.options].map(o => o.textContent.trim()) };
        }
        el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: el.value, label: option.textContent.trim() };
      }, value);
      await handle.dispose();
      if (ok.error) {
        console.error(`select ${label}: ${ok.error}`);
        if (ok.available) console.error(`Available: ${ok.available.join(' | ')}`);
        process.exit(1);
      }
      await reportAction(page, before, `Selected "${ok.label}" (value=${ok.value}) in ${label}`);
      break;
    }

    case 'check':
    case 'uncheck': {
      const target = args[0];
      if (!target) {
        console.error(`Usage: auto-browser ${cmd} <@ref|selector>`);
        process.exit(1);
      }
      const page = await getPage();
      const { handle, label } = await resolveTarget(page, target);
      const before = await captureSignals(page);
      resetReactionEvents();
      const res = await handle.evaluate((el, wanted) => {
        const isNative = ['checkbox', 'radio'].includes(el.type);
        const box = isNative ? el : el.querySelector('input[type=checkbox],input[type=radio]');
        if (!box) return { error: `not a checkbox/radio (got <${el.tagName}> type="${el.type || ''}")` };
        if (box.checked !== wanted) box.click();
        return { checked: box.checked };
      }, cmd === 'check');
      await handle.dispose();
      if (res.error) {
        console.error(`${cmd} ${label}: ${res.error}`);
        process.exit(1);
      }
      await reportAction(page, before, `${cmd === 'check' ? 'Checked' : 'Unchecked'} ${label} (now checked=${res.checked})`);
      break;
    }

    case 'contenteditable': {
      const [target, value] = args;
      if (!target || value === undefined) {
        console.error('Usage: auto-browser contenteditable <@ref|selector> <value>');
        process.exit(1);
      }
      const page = await getPage();
      const { handle, label } = await resolveTarget(page, target);
      const before = await captureSignals(page);
      resetReactionEvents();
      const editable = await withTimeout(handle.evaluate(el => Boolean(el.isContentEditable)), 5000, 'contenteditable:check');
      if (!editable) {
        await handle.dispose();
        console.error(`contenteditable ${label}: element is not contenteditable`);
        process.exit(1);
      }
      // Draft.js / React controlled editors ignore key events and direct
      // textContent mutation; execCommand insertText goes through the
      // browser's editing pipeline (beforeinput/input) and handles CJK +
      // digits without IME loss — verified on Zhihu's comment composer.
      await handle.evaluate(el => el.focus());
      const ok = await page.evaluate((text) => {
        try {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          return true;
        } catch { return false; }
      }, value);
      await new Promise(r => setTimeout(r, 250));
      const typed = ok
        ? await handle.evaluate(el => (el.textContent || el.innerText || '').trim().slice(0, 80))
        : '';
      await handle.dispose();
      await reportAction(page, before, `Filled contenteditable ${label} -> "${typed}" (execCommand)`);
      break;
    }

    // ==================== TYPE ====================
    case 'type': {
      const text = args.join(' ');
      if (!text) { console.error('Usage: auto-browser type <text>'); process.exit(1); }
      const page = await getPage();
      const before = await captureSignals(page);
      resetReactionEvents();
      await page.keyboard.type(text, { delay: 10 });
      await reportAction(page, before, `Typed: ${text}`);
      break;
    }

    // ==================== SCROLL ====================
    case 'scroll': {
      const x = parseInt(args[0]) || 0;
      const y = parseInt(args[1]) || 0;
      const page = await getPage();
      await page.evaluate((sx, sy) => window.scrollTo(sx, sy), x, y);
      console.log(`Scrolled to (${x}, ${y})`);
      break;
    }

    // ==================== TAB ====================
    case 'tab': {
      const sub = args[0];
      const ab = await getAB();

      switch (sub) {
        case 'list': {
          const browser = ab.browser;
          const pages = await browser.pages();
          console.log(`\nTabs (${pages.length}):\n`);
          for (let i = 0; i < pages.length; i++) {
            const p = pages[i];
            try {
              const title = await p.title();
              const url = p.url().slice(0, 80);
              console.log(`  ${i}: ${title || 'untitled'}`);
              console.log(`     ${url}`);
              console.log('');
            } catch {}
          }
          break;
        }
        case 'new': {
          const browser = ab.browser;
          const newPage = await browser.newPage();
          console.log(`Tab created: ${await newPage.title()}`);
          if (args[1]) {
            await newPage.goto(args[1], { waitUntil: 'networkidle0' });
            console.log(`Navigated to: ${args[1]}`);
          }
          break;
        }
        case 'close': {
          const idx = parseInt(args[1]);
          if (isNaN(idx)) { console.error('Usage: auto-browser tab close <index>'); process.exit(1); }
          const browser = ab.browser;
          const pages = await browser.pages();
          if (idx < 0 || idx >= pages.length) { console.error(`Tab index ${idx} out of range`); process.exit(1); }
          await pages[idx].close();
          console.log(`Tab ${idx} closed`);
          break;
        }
        default:
          console.log('Usage: auto-browser tab [list|new|close]');
      }
      break;
    }

    // ==================== OVERLAY ====================
    case 'overlay': {
      const sub = args[0];
      const ab = await getAB();
      const page = ab.getPage();

      switch (sub) {
        case 'inject':
        case 'show':
        case 'on': {
          if (_lastElements.length === 0) {
            console.log('No elements cached. Run "snap" first.');
            break;
          }
          await ab.injectOverlay(_lastElements);
          _overlayActive = true;
          console.log(`🟢 Overlay injected: ${_lastElements.length} elements numbered.`);
          break;
        }
        case 'remove':
        case 'hide':
        case 'off': {
          const { removeOverlay } = await import('../core/map.mjs');
          await removeOverlay(page);
          _overlayActive = false;
          console.log('🔴 Overlay removed.');
          break;
        }
        default:
          console.log('Usage: auto-browser overlay [inject|remove]');
      }
      break;
    }

    // ==================== CACHE ====================
    case 'cache': {
      const sub = args[0] || 'list';
      const cache = new CacheManager();

      switch (sub) {
        case 'list':
        case 'ls': {
          const entries = cache.list();
          if (entries.length === 0) {
            console.log('No cached pages.');
          } else {
            console.log(`\nCached pages: ${entries.length}\n`);
            entries.forEach(e => {
              console.log(`  ${e.site}/${e.pageName}`);
              console.log(`    URL: ${e.urlPattern}`);
              console.log(`    Elements: ${e.elementCount}`);
              console.log(`    Built: ${e.lastBuild}`);
              console.log(`    Scripts: ${(e.scripts || []).join(', ') || 'none'}`);
              console.log('');
            });
          }
          break;
        }
        case 'clear': {
          cache.clear();
          console.log('Cache cleared.');
          break;
        }
        default:
          console.log('Usage: auto-browser cache [list|clear]');
      }
      break;
    }

    // ==================== RUN ====================
    // run <plan.json> | --stdin | <inline JSON>  — batch plan executor.
    // Executes N steps in ONE process / ONE CDP connection. The agent
    // thinks once, writes the plan, gets back compact per-step results:
    // no per-command process startup, no inter-step round trips.
    case 'run': {
      const fileArg = args.find(a => a.startsWith('--file='));
      const fileFlagIndex = args.indexOf('--file');
      let planText = '';
      if (fileArg) {
        planText = fs.readFileSync(fileArg.split('=').slice(1).join('='), 'utf8');
      } else if (fileFlagIndex >= 0 && args[fileFlagIndex + 1]) {
        planText = fs.readFileSync(args[fileFlagIndex + 1], 'utf8');
      } else if (args.includes('--stdin') || args.includes('-')) {
        planText = fs.readFileSync(0, 'utf8');
      } else {
        // Positional: a plan file path, or an inline JSON array.
        const pos = args.filter(a => !a.startsWith('--'));
        if (pos.length === 1 && fs.existsSync(pos[0])) {
          planText = fs.readFileSync(pos[0], 'utf8');
        } else {
          planText = pos.join(' ');
        }
      }
      if (!planText.trim()) {
        console.error('Usage: auto-browser run <plan.json> | run --stdin | run <inline-json>');
        console.error('  plan = JSON array of steps; ops: ' + PLAN_OPS.join(' '));
        process.exit(1);
      }
      let plan;
      try {
        plan = JSON.parse(planText);
      } catch (e) {
        console.error(`run: invalid plan JSON: ${e.message}`);
        process.exit(1);
      }
      if (!Array.isArray(plan)) {
        console.error('run: plan must be a JSON array of steps, e.g. [{"op":"open","url":"..."}, {"op":"snap"}, {"op":"click","target":"@e3"}]');
        process.exit(1);
      }

      // A legit multi-step batch can outlive the 90s default watchdog; scale
      // the hard deadline to the plan length (30s/step) unless the user set
      // AUTO_BROWSER_TIMEOUT explicitly.
      if (process.env.AUTO_BROWSER_TIMEOUT === undefined) {
        armWatchdog(Math.max(90, plan.length * 30));
      }

      const page = await getPage();
      const outcome = await executePlan(page, plan, {
        elements: _lastElements,
        continueOnError: args.includes('--continue'),
        fast: args.includes('--fast')
      });
      _lastElements = outcome.elements;
      saveSnapshot({
        url: page.url(),
        title: await page.title().catch(() => ''),
        elements: outcome.elements
      });

      if (args.includes('--json')) {
        console.log(JSON.stringify(outcome, null, 2));
        if (!outcome.ok) process.exitCode = 1;
        break;
      }
      console.log(`run: ${outcome.executed}/${outcome.steps} steps, ${(outcome.ms / 1000).toFixed(1)}s`);
      for (const r of outcome.results) {
        const brief = summarizeStepResult(r);
        if (r.ok) {
          console.log(`  ✓ ${r.step}. ${r.op}${brief ? ' — ' + brief : ''} (${r.ms}ms)`);
        } else {
          console.log(`  ✗ ${r.step}. ${r.op} FAILED: ${r.error}${brief ? ' — ' + brief : ''} (${r.ms}ms)`);
        }
        if (r.newTab) {
          console.log(`      ⚠ new tab/window opened (tabDelta ${r.tabDelta}) — the plan's page may no longer be the active context; add a probe/close step or handle the popup before continuing`);
        }
      }
      if (!outcome.ok) {
        console.log('  (run with --continue to execute remaining steps; --json for machine-readable output)');
        process.exitCode = 1;
      }
      break;
    }

    // ==================== UNKNOWN ====================
    default:
      console.error(`Unknown command: "${cmd}"`);
      console.error('Run "auto-browser help" to see available commands.');
      process.exit(1);
  }
}

startLiveness(cmd, args);
setPhase(`command:${cmd || 'help'}`);
main()
  .catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    stopLiveness();
    setPhase('cleanup');
    await cleanup();
    // Optional auto-close: set AUTO_BROWSER_AUTOCLOSE=1 (or pass --close) and the
    // dedicated Chrome is shut down when the command finishes, so no window is
    // left open for you to close by hand. Lifecycle/help commands are exempt.
    const autoClose = process.env.AUTO_BROWSER_AUTOCLOSE === '1' || args.includes('--close');
    const exemptCmds = ['close', 'status', 'launch', 'help', '--help', undefined];
    if (autoClose && !exemptCmds.includes(cmd)) {
      const portArg = args.find(a => a.startsWith('--port='));
      const port = portArg ? Number(portArg.split('=')[1]) : undefined;
      try { await closeChrome({ port, quiet: true }); } catch { /* best effort */ }
    }
    // Puppeteer can retain a CDP transport handle after disconnect().
    // This process is a one-shot CLI command, so always exit once cleanup is
    // done — preserving any exit code set earlier (e.g. EXIT_ACTION_REQUIRED),
    // otherwise the lingering CDP socket would keep the process alive.
    process.exit(process.exitCode ?? 0);
  });
