// ============================================================
// mcp/server.mjs — MCP server for auto-browser.
//
// v2: full tool surface + persistent connection. The browser stays
// connected across calls (no per-call connect/navigate/disconnect),
// so tools are fast and stateful: @refs captured by snap/find/links
// resolve against an in-process element store, just like the CLI.
//
// Every interactive tool is implemented on top of core/plan.mjs's
// executeStep — the SAME robust logic as `auto-browser run` and the
// CLI commands (js-fallback retry, @ref re-location, contenteditable
// real keystrokes, per-step reaction summary). One implementation,
// three surfaces: CLI, plan, MCP.
// ============================================================

import puppeteer from 'puppeteer-core';
import { buildMap, queryMap } from '../core/map.mjs';
import { detectFramework } from '../detector/index.mjs';
import { CacheManager } from '../cache/manager.mjs';
import { executeStep, executePlan, PLAN_OPS } from '../core/plan.mjs';
import { ensureChrome } from '../core/launcher.mjs';

// --- persistent connection state ---
let _browser = null;
let _page = null;
const _ctx = { elements: [] }; // @ref store, updated by snap/find/links/run
const cache = new CacheManager();

async function ensurePage() {
  if (_browser && typeof _browser.isConnected === 'function' && _browser.isConnected()) {
    if (_page && !_page.isClosed()) return _page;
    _page = (await _browser.pages())[0] || await _browser.newPage();
    return _page;
  }
  const ready = await ensureChrome({});
  _browser = await puppeteer.connect({ browserURL: ready.browserURL });
  const pages = await _browser.pages();
  _page = pages[0] || await _browser.newPage();
  await _page.setViewport({ width: 1920, height: 1080 });
  _page.setDefaultTimeout(8000);
  return _page;
}

// Run one plan step against the persistent page. A failed step becomes a
// thrown error so MCP reports it as isError:true (the agent sees a real
// failure instead of a silent ok:false envelope).
async function runStep(step) {
  const page = await ensurePage();
  const r = await executeStep(page, step, _ctx);
  if (!r.ok) throw new Error(`${step.op} failed: ${r.error}`);
  return r.result;
}

// ------------------------------------------------------------
// Tool registry: name -> { description, inputSchema }.
// ------------------------------------------------------------
const tools = {
  'auto-browser-open': {
    description: 'Navigate the browser to a URL (SPA-safe, domcontentloaded).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        waitUntil: { type: 'string', description: 'load event to wait for (default domcontentloaded)' }
      },
      required: ['url']
    }
  },
  'auto-browser-snap': {
    description: 'Snapshot the current page: every interactive element with its @ref, kind and actions. Also refreshes the @ref store for later tools. Use before clicking/filling by @ref.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Only one kind: link|button|text|textarea|select|dropdown|checkbox|radio|toggle|slider|file|tab|menuitem|option|icon|label|contenteditable|draggable|clickable' },
        action: { type: 'string', description: 'Only elements supporting an action: click|fill|type|select|check|uncheck|upload|drag|hover|open' },
        text: { type: 'string', description: 'Only elements whose text/name/placeholder contains this' },
        all: { type: 'boolean', description: 'Include hidden elements' },
        limit: { type: 'number', description: 'Max elements to return (default 50)' }
      }
    }
  },
  'auto-browser-find': {
    description: 'Locate elements on the current page by text/kind/action (alias of snap with filters). Returns matching @refs.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text to match' },
        kind: { type: 'string', description: 'Element kind to match' },
        action: { type: 'string', description: 'Supported action to match' },
        all: { type: 'boolean', description: 'Include hidden elements' },
        limit: { type: 'number', description: 'Max results (default 30)' }
      }
    }
  },
  'auto-browser-links': {
    description: 'Harvest every href on the page, sorted by on-screen position. No clicking.',
    inputSchema: {
      type: 'object',
      properties: {
        contain: { type: 'string', description: 'Only hrefs containing this substring' },
        limit: { type: 'number', description: 'Max links (default 200)' }
      }
    }
  },
  'auto-browser-click': {
    description: 'Click an element by @ref (from snap/find) or CSS selector. Watches the page afterwards and reports change/verdict/toasts. Auto-retries with a native DOM click when the first click produced no feedback (js-fallback).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '@e12 or a CSS selector' }
      },
      required: ['target']
    }
  },
  'auto-browser-fill': {
    description: 'Fill a text input / textarea / contenteditable by @ref or CSS selector. Reads the DOM value back to verify. Real keystrokes, Draft.js-safe.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '@e12 or a CSS selector' },
        value: { type: 'string', description: 'Text to type' }
      },
      required: ['target', 'value']
    }
  },
  'auto-browser-select': {
    description: 'Choose an option in a native <select> by @ref or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '@e12 or a CSS selector' },
        value: { type: 'string', description: 'Option value or visible label' }
      },
      required: ['target', 'value']
    }
  },
  'auto-browser-check': {
    description: 'Tick a checkbox / radio by @ref or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target']
    }
  },
  'auto-browser-uncheck': {
    description: 'Untick a checkbox by @ref or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target']
    }
  },
  'auto-browser-contenteditable': {
    description: 'Type text into a contenteditable (rich text editor) with real keystrokes. Draft.js/React-safe (no textContent mutation).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '@e12 or a CSS selector' },
        value: { type: 'string', description: 'Text to type' }
      },
      required: ['target', 'value']
    }
  },
  'auto-browser-type': {
    description: 'Type text into whatever currently has focus.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    }
  },
  'auto-browser-wait': {
    description: 'Wait for the page to satisfy a condition.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['selector', 'text', 'url', 'stable'], description: 'What to wait for' },
        target: { type: 'string', description: 'selector / text / url pattern' },
        timeout: { type: 'number', description: 'ms (default 10000)' }
      },
      required: ['kind', 'target']
    }
  },
  'auto-browser-eval': {
    description: 'Execute JavaScript in the page context. For anything beyond a trivial expression, wrap statements in an async IIFE (return works).',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JS to run' } },
      required: ['code']
    }
  },
  'auto-browser-eval-file': {
    description: 'Execute a JavaScript file in the page context (avoids shell quoting entirely).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to a .js/.mjs file' } },
      required: ['path']
    }
  },
  'auto-browser-extract': {
    description: 'Extract structured data from the page by CSS selector. Generic: returns text/href/value/html/attrs per matched node.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        attrs: { type: 'array', items: { type: 'string' }, description: 'What to extract per node: text|href|value|html or any attribute name (default ["text"])' },
        all: { type: 'boolean', description: 'Include hidden nodes' },
        limit: { type: 'number', description: 'Max nodes (default 100)' }
      },
      required: ['selector']
    }
  },
  'auto-browser-assert': {
    description: 'Assert the page state; fails the tool call when the condition is not met.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['text', 'selector', 'url', 'value'], description: 'text: visible text; selector: CSS node; url: URL pattern; value: input value equality' },
        target: { type: 'string', description: 'text / selector / url pattern / input selector' },
        value: { type: 'string', description: 'Expected value when kind=value' },
        timeout: { type: 'number', description: 'ms (default 10000)' }
      },
      required: ['kind', 'target']
    }
  },
  'auto-browser-get': {
    description: 'Read a page attribute: title, url, html, text.',
    inputSchema: {
      type: 'object',
      properties: { attr: { type: 'string', enum: ['title', 'url', 'html', 'text'] } },
      required: ['attr']
    }
  },
  'auto-browser-scroll': {
    description: 'Scroll the page to viewport coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'default 0' },
        y: { type: 'number', description: 'default 0' }
      }
    }
  },
  'auto-browser-screenshot': {
    description: 'Take a JPEG screenshot of the current page. Returns base64.',
    inputSchema: { type: 'object', properties: {} }
  },
  'auto-browser-run': {
    description: `Execute a batch plan in ONE call — the "think once, act many" tool. Plan is a JSON array of steps; ops: ${PLAN_OPS.join(', ')}. @refs from a snap step resolve for later steps. Returns per-step {op, ok, ms, result}. Fails fast unless continue=true.`,
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          description: 'JSON array of steps, e.g. [{"op":"open","url":"https://x.com"},{"op":"snap"},{"op":"click","target":"@e3"}]',
          oneOf: [{ type: 'array', items: { type: 'object' } }, { type: 'string' }]
        },
        continue: { type: 'boolean', description: 'Keep executing after a failed step (default false)' }
      },
      required: ['plan']
    }
  },
  'auto-browser-map': {
    description: 'Build a page element map from a URL (navigates first). Legacy convenience tool — prefer open + snap.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  'auto-browser-detect': {
    description: 'Detect the UI framework on the current page (Element Plus / Ant Design / MUI).',
    inputSchema: { type: 'object', properties: {} }
  },
  'auto-browser-status': {
    description: 'Current browser connection state: connected, current URL, title, element-store size.',
    inputSchema: { type: 'object', properties: {} }
  },
  'auto-browser-cache-list': {
    description: 'List all cached page maps.',
    inputSchema: { type: 'object', properties: {} }
  },
  'auto-browser-cache-clear': {
    description: 'Clear all cached page maps and scripts.',
    inputSchema: { type: 'object', properties: {} }
  }
};

// ------------------------------------------------------------
// Tool implementations.
// ------------------------------------------------------------
async function callTool(name, args) {
  switch (name) {
    case 'auto-browser-open':
      return runStep({ op: 'open', url: args.url, waitUntil: args.waitUntil });

    case 'auto-browser-snap':
      return runStep({
        op: 'snap',
        kind: args.kind,
        action: args.action,
        text: args.text,
        all: args.all,
        limit: args.limit
      });

    case 'auto-browser-find':
      return runStep({
        op: 'snap',
        kind: args.kind,
        action: args.action,
        text: args.text,
        all: args.all,
        limit: args.limit || 30
      });

    case 'auto-browser-links':
      return runStep({ op: 'links', contain: args.contain, limit: args.limit });

    case 'auto-browser-click':
      return runStep({ op: 'click', target: args.target });

    case 'auto-browser-fill':
      return runStep({ op: 'fill', target: args.target, value: args.value });

    case 'auto-browser-select':
      return runStep({ op: 'select', target: args.target, value: args.value });

    case 'auto-browser-check':
      return runStep({ op: 'check', target: args.target });

    case 'auto-browser-uncheck':
      return runStep({ op: 'uncheck', target: args.target });

    case 'auto-browser-contenteditable':
      return runStep({ op: 'contenteditable', target: args.target, value: args.value });

    case 'auto-browser-type':
      return runStep({ op: 'type', text: args.text });

    case 'auto-browser-wait':
      return runStep({ op: 'wait', kind: args.kind, target: args.target, timeout: args.timeout });

    case 'auto-browser-eval':
      return runStep({ op: 'eval', code: args.code });

    case 'auto-browser-eval-file':
      return runStep({ op: 'evalFile', path: args.path });

    case 'auto-browser-extract':
      return runStep({ op: 'extract', selector: args.selector, attrs: args.attrs, all: args.all, limit: args.limit });

    case 'auto-browser-assert':
      return runStep({ op: 'assert', kind: args.kind, target: args.target, value: args.value, timeout: args.timeout });

    case 'auto-browser-get':
      return runStep({ op: 'get', attr: args.attr });

    case 'auto-browser-scroll':
      return runStep({ op: 'scroll', x: args.x, y: args.y });

    case 'auto-browser-screenshot':
      return runStep({ op: 'screenshot' });

    case 'auto-browser-run': {
      const page = await ensurePage();
      let plan = args.plan;
      if (typeof plan === 'string') plan = JSON.parse(plan);
      const outcome = await executePlan(page, plan, {
        elements: _ctx.elements,
        continueOnError: !!args.continue
      });
      _ctx.elements = outcome.elements;
      return outcome;
    }

    case 'auto-browser-map': {
      const page = await ensurePage();
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const map = await buildMap(page, { compress: true });
      _ctx.elements = map.elements;
      const fw = await detectFramework(page);
      return {
        url: map.url, title: map.title, framework: fw.detected,
        elementCount: map.elements.length,
        elements: map.elements.slice(0, 50).map(el => ({ ref: el.ref, kind: el.kind, text: el.text, href: el.href }))
      };
    }

    case 'auto-browser-detect': {
      const page = await ensurePage();
      return detectFramework(page);
    }

    case 'auto-browser-status': {
      const page = await ensurePage();
      return {
        connected: !!_browser && _browser.isConnected(),
        url: page.url(),
        title: await page.title().catch(() => ''),
        elementStore: _ctx.elements.length
      };
    }

    case 'auto-browser-cache-list':
      return { entries: cache.list() };

    case 'auto-browser-cache-clear':
      cache.clear();
      return { cleared: true };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ------------------------------------------------------------
// JSON-RPC handling (MCP stdio transport).
// ------------------------------------------------------------
async function handleRequest(request) {
  const { method, params } = request;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'auto-browser', version: '2.0.0' }
      };
    case 'tools/list':
      // MCP spec: tools must be an ARRAY of { name, description, inputSchema }.
      return { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await callTool(name, args || {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true
        };
      }
    }
    case 'notifications/initialized':
      return {};
    case 'ping':
      return {};
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function main() {
  console.error('[MCP] auto-browser server starting (v2, full tools)...');
  process.stdin.setEncoding('utf-8');
  let buffer = '';

  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        const response = await handleRequest(request);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: response
        }) + '\n');
      } catch (e) {
        // A thrown error becomes a proper JSON-RPC error response so the
        // client never hangs waiting for an answer.
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32603, message: e.message }
        }) + '\n');
        console.error('[MCP] Error:', e.message);
      }
    }
  });

  process.stdin.on('end', () => {
    console.error('[MCP] Server shutting down...');
    process.exit(0);
  });
}

main().catch(e => {
  console.error('[MCP] Fatal:', e.message);
  process.exit(1);
});
