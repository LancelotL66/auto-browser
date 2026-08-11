// ============================================================
// core/locate.mjs — @ref resolution, shared by the CLI, the batch
// plan runner (core/plan.mjs) and the MCP server.
//
// A @ref ("@e12", "@f1-e3") captured by snap/find/links survives DOM
// rebuilds: we re-locate by CSS selector, then XPath, then semantic
// scoring (role + accessible name + text + position). Low-confidence
// matches warn instead of silently clicking a guess.
// ============================================================

export function parseRef(value) {
  if (!value?.startsWith('@')) return null;
  const raw = value.slice(1);
  const frameMatch = raw.match(/^f(\d+)-e(\d+)$/);
  if (frameMatch) {
    return { ref: raw, frameIndex: Number.parseInt(frameMatch[1], 10) - 1 };
  }
  const number = raw.startsWith('e') ? raw.slice(1) : raw;
  const index = Number.parseInt(number, 10);
  return Number.isInteger(index) && index > 0 ? { ref: `e${index}`, frameIndex: null } : null;
}

export async function resolveRef(page, value, elements = []) {
  const parsed = parseRef(value);
  if (!parsed) return null;

  const index = elements.findIndex(element => element.ref === parsed.ref);
  if (index < 0) return null;
  const element = elements[index];
  let context = page;
  if (parsed.frameIndex !== null) {
    const frames = page.frames().filter(frame => frame !== page.mainFrame());
    context = frames[parsed.frameIndex];
    if (!context) return null;
  }
  let handle = null;
  let method = null;
  let confidence = 0;
  if (element.locator?.shadow?.hostSelector) {
    const shadowHandle = await page.evaluateHandle(({ hostSelector, selector }) => {
      const host = document.querySelector(hostSelector);
      return host?.shadowRoot?.querySelector(selector) || null;
    }, element.locator.shadow);
    handle = shadowHandle.asElement();
    if (!handle) await shadowHandle.dispose();
    else {
      method = 'shadow-dom';
      confidence = 100;
    }
  }
  if (!handle && element.locator?.selector) {
    handle = await context.$(element.locator.selector);
    if (handle) {
      method = 'css';
      confidence = 100;
    }
  }
  if (!handle && element.locator?.xpath) {
    handle = await context.$(`xpath${element.locator.xpath}`);
    if (handle) {
      method = 'xpath';
      confidence = 90;
    }
  }
  if (!handle) {
    const match = await context.evaluate(({ tag, role, name, text, placeholder, rect, parentText }) => {
      const visible = node => {
        const rect = node.getBoundingClientRect();
        return node.offsetParent !== null && rect.width > 0 && rect.height > 0;
      };
      const candidates = [...document.querySelectorAll('*')]
        .filter(node => visible(node))
        .filter(node => !tag || node.tagName === tag);
      const accessibleName = node => node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent.trim();
      const path = node => {
        const parts = [];
        for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
          let index = 1;
          for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
            if (sibling.tagName === current.tagName) index++;
          }
          parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
        }
        return `/${parts.join('/')}`;
      };
      const distance = (a, b) => Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
      // Only genuinely interactive nodes may win relocation. Pure text/stat
      // nodes (counters, timestamps, "12.6k" like-texts) that sit next to the
      // original element must never outscore the real control (Zhihu bug:
      // 收藏 button re-located to the adjacent count text).
      const interactive = node => {
        const t = node.tagName;
        if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'OPTION'].includes(t)) return true;
        if (node.getAttribute('role') || node.isContentEditable) return true;
        if (node.hasAttribute('onclick') || node.hasAttribute('tabindex')) return true;
        const cls = typeof node.className === 'string' ? node.className : '';
        return /(el-button|ant-btn|MuiButton|el-select|ant-select|el-input|el-checkbox|el-radio|el-switch|el-tabs|el-dropdown|el-upload|Mui[A-Z]|btn|clickable|cursor-pointer)/.test(cls);
      };
      const scored = candidates.map(node => {
        const currentRect = node.getBoundingClientRect();
        const currentName = accessibleName(node);
        const currentParent = node.parentElement?.textContent.trim().slice(0, 120) || '';
        let score = 0;
        // Exact identity beats everything; a partial text match is weak.
        if (role && node.getAttribute('role') === role) score += 35;
        if (name && currentName === name) score += 45;
        else if (name && currentName && currentName.includes(name)) score += 5;
        if (text && node.textContent.trim() === text) score += 15;
        if (placeholder && node.getAttribute('placeholder') === placeholder) score += 25;
        if (parentText && currentParent === parentText) score += 10;
        const positionDistance = distance(currentRect, rect);
        if (positionDistance < 40) score += 15;
        else if (positionDistance < 150) score += 8;
        else if (positionDistance < 400) score -= 20;
        else score -= 40;   // far away: needs a very strong identity match
        // Stat/counter text ("12.6k", "1,024", "294") is almost never the target.
        if (/^[\d.,+\-%\s万kKmM倍条个赞人/]*$/.test(currentName.slice(0, 40))) score -= 25;
        // Non-interactive text nodes must not outscore the real control.
        if (!interactive(node)) score -= 40;
        if (node.disabled || node.getAttribute('aria-disabled') === 'true') score -= 25;
        return { node, score, xpath: path(node) };
      }).sort((a, b) => b.score - a.score);
      const best = scored[0];
      return best ? { xpath: best.xpath, score: best.score, candidates: scored.length } : null;
    }, {
      tag: element.tag,
      role: element.role,
      name: element.name,
      text: element.text,
      placeholder: element.placeholder,
      rect: element.rect,
      parentText: element.parentText
    });
    if (match && match.score >= 60) {
      handle = await context.$(`xpath${match.xpath}`);
      if (handle) {
        method = `semantic (${match.candidates} candidates)`;
        confidence = match.score;
      }
    } else if (match) {
      console.warn(`Warning: ${value} — nearest semantic candidate scored ${match.score} (< 60). The page likely changed structurally; run "snap" to rebuild references instead of clicking a guess.`);
    }
  }
  if (handle) {
    await handle.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center' }));
  }
  return handle ? { handle, element, index, method, confidence } : null;
}

// ------------------------------------------------------------
// Resolve either an @ref (from the last snap/find) or a raw CSS
// selector into an element handle. Lets every action command
// accept both forms interchangeably.
// opts.onError: fn(message) — default throws Error(message).
// ------------------------------------------------------------
export async function resolveTarget(page, target, elements = [], opts = {}) {
  const onError = opts.onError || (msg => { throw new Error(msg); });
  if (target.startsWith('@')) {
    const resolved = await resolveRef(page, target, elements);
    if (!resolved) {
      return onError(`Element not found: ${target}. Run "snap" or "find" first.`);
    }
    if (resolved.confidence < 80) {
      console.warn(`Warning: ${target} matched with confidence ${resolved.confidence} via ${resolved.method}`);
    }
    return { handle: resolved.handle, label: `@${resolved.element.ref}`, element: resolved.element };
  }
  const handle = await page.$(target);
  if (!handle) {
    return onError(`Element not found: ${target}`);
  }
  return { handle, label: target, element: null };
}
