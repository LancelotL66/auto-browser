// ============================================================
// core/plan.mjs — batch plan executor.
//
// The "think once, act many" tool: one process, one CDP connection,
// N steps. The agent writes a JSON plan and gets back a compact
// per-step result — no per-command process startup, no connect
// round-trips, no inter-step LLM thinking.
//
// Step ops mirror the CLI commands 1:1 so the vocabulary stays
// generic (no site-specific logic):
//   open wait sleep snap links get eval evalFile
//   click fill select check uncheck contenteditable type scroll
//   extract assert screenshot
//
// @ref resolution is in-process: a `snap` step refreshes the element
// store (ctx.elements), and later steps reference @eN from the most
// recent snap — no cross-process snapshot file needed.
// ============================================================

import { buildMap, queryMap } from './map.mjs';
import { waitForSelector, waitForText, waitForUrl, waitForDomStable } from './wait.mjs';
import { resolveTarget } from './locate.mjs';
import fs from 'fs';
import path from 'path';

export const PLAN_OPS = [
  'open', 'wait', 'sleep', 'snap', 'links', 'get', 'eval', 'evalFile',
  'click', 'fill', 'select', 'check', 'uncheck', 'contenteditable',
  'type', 'scroll', 'extract', 'assert', 'screenshot'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Bound a CDP call so a stuck page can't hang the whole plan.
function withTimeout(promise, ms, label = 'cdp-call') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ------------------------------------------------------------
// Compact page snapshot used for per-step reaction summaries.
// Deliberately lighter than the CLI's full signal collector —
// batch mode favors speed; the agent opted out of interactive
// observation by using a plan.
// ------------------------------------------------------------
async function quickSnapshot(page) {
  try {
    return await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const visible = el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const texts = sel => {
        const out = [];
        document.querySelectorAll(sel).forEach(e => {
          if (!visible(e)) return;
          const t = norm(e.innerText || e.textContent);
          if (t) out.push(t.slice(0, 160));
        });
        return [...new Set(out)];
      };
      const body = document.body?.innerText || '';
      let h = 0;
      const n = Math.min(body.length, 200000);
      for (let i = 0; i < n; i++) h = (h * 31 + body.charCodeAt(i)) >>> 0;
      return {
        url: location.href,
        title: document.title,
        textLength: body.length,
        textHash: h,
        domLength: document.documentElement?.outerHTML?.length || 0,
        toasts: texts('.el-message,.el-notification,.ant-message-notice,.ant-notification-notice,.Toastify__toast,.MuiAlert-message,[role="status"]'),
        errors: texts('.el-form-item__error,.ant-form-item-explain-error,.invalid-feedback,.error-message,.is-error,.text-danger'),
        modals: texts('[role="dialog"],[aria-modal="true"],.el-dialog,.el-message-box,.ant-modal,.MuiDialog-paper,.modal.show'),
        masked: (() => {
          const nodes = document.querySelectorAll('div, section');
          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            const s = getComputedStyle(el);
            if (s.position !== 'fixed' && s.position !== 'absolute') continue;
            if ((parseInt(s.zIndex) || 0) < 1000) continue;
            const r = el.getBoundingClientRect();
            if (r.width < innerWidth * 0.6 || r.height < innerHeight * 0.6) continue;
            if (/mask|overlay|modal|backdrop|dimmer|shadow/i.test((el.className || '').toString())) return true;
          }
          return false;
        })(),
        verdict: (() => {
          const VERDICT_RE = /通过全部用例|答案错误|运行错误|编译错误|运行超时|SQL_ERROR|Wrong Answer|Accepted|Runtime Error|Compile Error|Time Limit|Presentation Error/;
          const nodes = document.querySelectorAll('[class*="result"],[class*="Result"],[class*="judge"],[class*="Judge"],[class*="console"],[class*="Console"],[class*="output"],[class*="Output"],[class*="status"],.el-message');
          for (let i = 0; i < nodes.length; i++) {
            const e = nodes[i];
            if (!visible(e)) continue;
            const t = norm(e.innerText || e.textContent);
            if (t && t.length < 240 && VERDICT_RE.test(t)) return t.slice(0, 240);
          }
          return null;
        })()
      };
    });
  } catch {
    return null; // context destroyed mid-navigation
  }
}

// Observe the page for a short window after an action, then diff against the
// pre-action snapshot. Returns { changed, navigated, toasts, errors, modals, verdict, masked }.
async function observeAction(page, before, opts = {}) {
  const cooldown = opts.fast ? 250 : 800;
  const deadline = Date.now() + cooldown;
  let after = await quickSnapshot(page);
  let stable = 0;
  let last = after?.domLength ?? 0;
  while (Date.now() < deadline) {
    await sleep(120);
    const next = await quickSnapshot(page);
    if (!next) continue;
    if (next.domLength === last) stable++;
    else { stable = 0; last = next.domLength; }
    after = next;
    if (stable >= 2) break;
  }
  if (!before || !after) return { changed: true, navigated: false, toasts: [], errors: [], modals: [], verdict: null, masked: false, after };
  const diff = {
    changed: after.url !== before.url || after.title !== before.title ||
      after.textLength !== before.textLength || after.textHash !== before.textHash ||
      after.domLength !== before.domLength,
    navigated: Boolean(before.url && after.url && after.url !== before.url),
    toasts: after.toasts.filter(t => !(before.toasts || []).includes(t)),
    errors: after.errors.filter(t => !(before.errors || []).includes(t)),
    modals: after.modals.filter(t => !(before.modals || []).includes(t)),
    verdict: after.verdict && after.verdict !== before.verdict ? after.verdict : null,
    masked: Boolean(after.masked && !before.masked),
    after
  };
  return diff;
}

// Compact element list for snap/links results (keeps plan output small).
function compactElements(elements, limit = 50) {
  return elements.slice(0, limit).map(el => ({
    ref: el.ref,
    kind: el.kind,
    text: String(el.text || '').slice(0, 60),
    href: el.href || '',
    value: el.value !== undefined ? String(el.value).slice(0, 60) : undefined,
    actions: el.actions || [],
    rect: el.rect
  }));
}

// ------------------------------------------------------------
// Run ONE step. ctx: { elements (ref store, in/out), fast, log }.
// Returns { op, ok, ms, error?, result? }.
// ------------------------------------------------------------
export async function executeStep(page, step, ctx = {}) {
  const started = Date.now();
  const base = { op: step.op };
  try {
    const r = await runOp(page, step, ctx);
    return { ...base, ok: true, ms: Date.now() - started, result: r };
  } catch (e) {
    return { ...base, ok: false, ms: Date.now() - started, error: e.message };
  }
}

async function runOp(page, step, ctx) {
  const target = async () => resolveTarget(page, step.target, ctx.elements || [], {
    onError: msg => { throw new Error(msg); }
  });

  switch (step.op) {

    case 'open': {
      await page.goto(step.url, {
        waitUntil: step.waitUntil || 'domcontentloaded',
        timeout: step.timeout || 30000
      });
      await sleep(300);
      return { url: page.url(), title: await page.title().catch(() => '') };
    }

    case 'wait': {
      const kind = step.kind || step.what;
      const targetVal = step.target ?? step.value;
      const timeout = step.timeout || 10000;
      if (kind === 'selector') await waitForSelector(page, targetVal, { timeout });
      else if (kind === 'text') await waitForText(page, targetVal, { timeout });
      else if (kind === 'url') await waitForUrl(page, targetVal, { timeout });
      else if (kind === 'stable') await waitForDomStable(page, { timeout });
      else throw new Error(`wait: unknown kind "${kind}" (selector|text|url|stable)`);
      return { kind, target: targetVal };
    }

    case 'sleep': {
      await sleep(step.ms || step.timeout || 0);
      return { ms: step.ms || 0 };
    }

    case 'snap': {
      const map = await buildMap(page, { compress: true });
      ctx.elements = map.elements; // refresh @ref store for later steps
      const filtered = (step.kind || step.action || step.text || step.all)
        ? queryMap(map, {
            kind: step.kind,
            action: step.action,
            text: step.text,
            visibleOnly: !step.all,
            limit: step.limit || 100
          })
        : map.elements;
      return {
        elementCount: map.elements.length,
        kinds: map.kinds,
        matched: filtered.length,
        elements: compactElements(filtered, step.limit || 50)
      };
    }

    case 'links': {
      const map = await buildMap(page, { compress: true });
      ctx.elements = map.elements;
      let links = map.elements
        .filter(el => el.href)
        .filter(el => (step.contain ? el.href.includes(step.contain) : true))
        .map(el => ({ ref: el.ref, text: String(el.name || el.text || '').replace(/\s+/g, ' ').trim(), href: el.href, y: el.rect?.y ?? 0 }));
      links.sort((a, b) => a.y - b.y);
      links = links.slice(0, step.limit || 200);
      return { count: links.length, links };
    }

    case 'get': {
      const attr = step.attr || step.target;
      const value = await page.evaluate((a) => {
        if (a === 'url') return location.href;
        if (a === 'title') return document.title;
        if (a === 'html') return document.documentElement.outerHTML.slice(0, 50000);
        if (a === 'text') return document.body.innerText.slice(0, 50000);
        return document[a]?.toString?.();
      }, attr);
      return { [attr]: String(value || '').slice(0, 5000) };
    }

    case 'eval': {
      const code = step.code;
      if (!code) throw new Error('eval: missing "code"');
      const isExpression = !/[\n;]/.test(String(code).trim());
      const payload = isExpression ? code : `(async () => { ${code}\n })()`;
      const result = await page.evaluate(payload);
      return { result };
    }

    case 'evalFile': {
      const p = step.path || step.file;
      if (!p) throw new Error('evalFile: missing "path"');
      const code = fs.readFileSync(p, 'utf8');
      const result = await page.evaluate(`(async () => { ${code}\n })()`);
      return { result };
    }

    case 'click': {
      const { handle, label } = await target();
      try {
        const state = await withTimeout(handle.evaluate(node => ({
          connected: node.isConnected,
          visible: node.offsetParent !== null,
          disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true')
        })), 5000, 'click:state');
        if (!state.connected || !state.visible || state.disabled) {
          throw new Error(`target not actionable (visible=${state.visible}, disabled=${state.disabled})`);
        }
        const before = await quickSnapshot(page);
        const box = await withTimeout(handle.boundingBox(), 5000, 'click:boundingBox');
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await handle.evaluate(el => el.click());
        }
        let diff = await observeAction(page, before, { fast: step.fast });
        let retried = false;
        // Native DOM click fallback for frameworks that ignore synthetic
        // CDP mouse events (React controlled components, Zhihu buttons).
        if (!diff.changed && !diff.toasts.length && !diff.errors.length && !diff.modals.length && !diff.masked) {
          // Snapshot BEFORE the retry: el.click() mutates the DOM
          // synchronously, so a post-click snapshot would already contain
          // the change and the diff would falsely report no-change.
          const before2 = await quickSnapshot(page);
          const ok = await handle.evaluate(node => {
            if (node.isConnected && typeof node.click === 'function') { node.click(); return true; }
            return false;
          }).catch(() => false);
          if (ok) {
            retried = true;
            diff = await observeAction(page, before2, { fast: step.fast });
          }
        }
        return {
          label,
          changed: diff.changed,
          retried,
          navigated: diff.navigated,
          verdict: diff.verdict,
          toasts: diff.toasts,
          errors: diff.errors,
          modals: diff.modals
        };
      } finally {
        await handle.dispose().catch(() => {});
      }
    }

    case 'fill': {
      const { handle, label } = await target();
      try {
        const state = await withTimeout(handle.evaluate(node => ({
          connected: node.isConnected,
          visible: node.offsetParent !== null,
          disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
          editable: node.isContentEditable || node.matches('input, textarea'),
          contentEditable: node.isContentEditable
        })), 5000, 'fill:state');
        if (!state.connected || !state.visible || state.disabled || !state.editable) {
          throw new Error(`element not fillable (visible=${state.visible}, disabled=${state.disabled})`);
        }
        const before = await quickSnapshot(page);
        await handle.evaluate(node => node.focus());
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(step.value, { delay: step.delay ?? 10 });
        const actual = await handle.evaluate(node => node.isContentEditable ? node.textContent : node.value);
        const diff = await observeAction(page, before, { fast: step.fast });
        return {
          label,
          value: String(actual || '').slice(0, 120),
          verified: actual === step.value,
          contentEditable: state.contentEditable,
          changed: diff.changed
        };
      } finally {
        await handle.dispose().catch(() => {});
      }
    }

    case 'select': {
      const { handle, label } = await target();
      try {
        const before = await quickSnapshot(page);
        const res = await handle.evaluate((el, wanted) => {
          if (el.tagName !== 'SELECT') return { error: `not a <select> (got <${el.tagName}>)` };
          const option = [...el.options].find(o => o.value === wanted || o.textContent.trim() === wanted);
          if (!option) return { error: 'option not found', available: [...el.options].map(o => o.textContent.trim()) };
          el.value = option.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { value: el.value, label: option.textContent.trim() };
        }, step.value);
        if (res.error) throw new Error(`${res.error}${res.available ? ` — available: ${res.available.join(' | ')}` : ''}`);
        const diff = await observeAction(page, before, { fast: step.fast });
        return { label, option: res.label, value: res.value, changed: diff.changed };
      } finally {
        await handle.dispose().catch(() => {});
      }
    }

    case 'check':
    case 'uncheck': {
      const { handle, label } = await target();
      try {
        const before = await quickSnapshot(page);
        const wanted = step.op === 'check';
        const res = await handle.evaluate((el, w) => {
          const isNative = ['checkbox', 'radio'].includes(el.type);
          const box = isNative ? el : el.querySelector('input[type=checkbox],input[type=radio]');
          if (!box) return { error: `not a checkbox/radio (got <${el.tagName}> type="${el.type || ''}")` };
          if (box.checked !== w) box.click();
          return { checked: box.checked };
        }, wanted);
        if (res.error) throw new Error(res.error);
        const diff = await observeAction(page, before, { fast: step.fast });
        return { label, checked: res.checked, changed: diff.changed };
      } finally {
        await handle.dispose().catch(() => {});
      }
    }

    case 'contenteditable': {
      const { handle, label } = await target();
      try {
        const editable = await handle.evaluate(el => Boolean(el.isContentEditable));
        if (!editable) throw new Error('element is not contenteditable');
        const before = await quickSnapshot(page);
        // Real keystrokes: Draft.js / React editors ignore textContent mutation.
        await handle.evaluate(el => el.focus());
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(step.value, { delay: step.delay ?? 10 });
        const typed = await handle.evaluate(el => (el.textContent || el.innerText || '').trim().slice(0, 80));
        const diff = await observeAction(page, before, { fast: step.fast });
        return { label, value: typed, changed: diff.changed };
      } finally {
        await handle.dispose().catch(() => {});
      }
    }

    case 'type': {
      const before = await quickSnapshot(page);
      await page.keyboard.type(step.text, { delay: step.delay ?? 10 });
      const diff = await observeAction(page, before, { fast: step.fast });
      return { text: String(step.text).slice(0, 80), changed: diff.changed };
    }

    case 'scroll': {
      const x = parseInt(step.x) || 0;
      const y = parseInt(step.y) || 0;
      await page.evaluate((sx, sy) => window.scrollTo(sx, sy), x, y);
      await sleep(200);
      return { x, y };
    }

    case 'extract': {
      if (!step.selector) throw new Error('extract: missing "selector"');
      const items = await page.evaluate(({ sel, attrs, all, limit }) => {
        const nodes = [...document.querySelectorAll(sel)];
        return nodes
          .filter(n => all || n.offsetParent !== null)
          .slice(0, limit)
          .map(n => {
            const out = {};
            for (const a of attrs || ['text']) {
              if (a === 'text') out.text = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
              else if (a === 'href') out.href = n.href || n.getAttribute('href') || '';
              else if (a === 'value') out.value = n.value !== undefined ? String(n.value) : '';
              else if (a === 'html') out.html = n.outerHTML.slice(0, 2000);
              else out[a] = n.getAttribute(a) || '';
            }
            const r = n.getBoundingClientRect();
            out.y = Math.round(r.top);
            return out;
          });
      }, { sel: step.selector, attrs: step.attrs, all: step.all, limit: step.limit || 100 });
      return { count: items.length, items };
    }

    case 'assert': {
      const kind = step.kind || 'text';
      const targetVal = step.target ?? step.value;
      const timeout = step.timeout || 10000;
      if (kind === 'text') await waitForText(page, targetVal, { timeout });
      else if (kind === 'selector') await waitForSelector(page, targetVal, { timeout });
      else if (kind === 'url') await waitForUrl(page, targetVal, { timeout });
      else if (kind === 'value') {
        const ok = await page.evaluate(({ sel, val }) => {
          const el = document.querySelector(sel);
          return !!el && (el.value ?? el.textContent ?? '') === val;
        }, { sel: targetVal, val: step.value });
        if (!ok) throw new Error(`value assertion failed: ${targetVal} !== ${JSON.stringify(step.value)}`);
      } else throw new Error(`assert: unknown kind "${kind}" (text|selector|url|value)`);
      return { asserted: kind, target: targetVal };
    }

    case 'screenshot': {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
      if (step.path) {
        fs.writeFileSync(step.path, buffer);
        return { saved: path.resolve(step.path), bytes: buffer.length };
      }
      return { base64: buffer.toString('base64'), bytes: buffer.length };
    }

    default:
      throw new Error(`unknown op "${step.op}" (supported: ${PLAN_OPS.join(', ')})`);
  }
}

// ------------------------------------------------------------
// Run a whole plan. opts: { elements, continueOnError, fast, log }.
// Returns { results, ok, steps, executed, ms, elements }.
// ------------------------------------------------------------
export async function executePlan(page, plan, opts = {}) {
  if (!Array.isArray(plan)) throw new Error('plan must be a JSON array of steps');
  const ctx = {
    elements: opts.elements || [],
    fast: !!opts.fast,
    log: opts.log || (() => {})
  };
  const results = [];
  const started = Date.now();
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (!step || typeof step !== 'object' || !step.op) {
      results.push({ step: i + 1, op: step?.op || '?', ok: false, ms: 0, error: 'step is missing "op"' });
      if (!ctx.continueOnError) break;
      continue;
    }
    const r = await executeStep(page, step, ctx);
    results.push({ step: i + 1, ...r });
    if (!r.ok && !opts.continueOnError) break;
  }
  return {
    results,
    ok: results.length > 0 && results.every(r => r.ok),
    steps: plan.length,
    executed: results.length,
    ms: Date.now() - started,
    elements: ctx.elements
  };
}
