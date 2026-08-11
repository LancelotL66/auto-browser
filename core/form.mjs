import { sleep } from './browser.mjs';

// --- Select dropdown by label + index ---

export async function selectDropdown(page, label, targetValue, index = 0) {
  // Click trigger to open
  const triggerBox = await page.evaluate(({ lbl, idx }) => {
    const items = document.querySelectorAll('.el-form-item');
    let count = 0;
    for (const item of items) {
      if (item.offsetParent === null) continue;
      const labelEl = item.querySelector('.el-form-item__label');
      if (labelEl && labelEl.textContent.includes(lbl)) {
        if (count === idx) {
          item.scrollIntoView({ block: 'center', behavior: 'instant' });
          const trigger = item.querySelector('.el-select__wrapper, .el-input__wrapper');
          if (trigger) {
            const r = trigger.getBoundingClientRect();
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
        }
        count++;
      }
    }
    return null;
  }, { lbl: label, idx: index });

  if (!triggerBox) return false;
  await page.mouse.click(triggerBox.x, triggerBox.y);
  await sleep(1200);

  // Click dropdown option (CDP click → JS fallback)
  const clicked = await page.evaluate((tv) => {
    const items = document.querySelectorAll('.el-select-dropdown__item');
    // CDP click first
    for (const i of items) {
      if (i.offsetParent !== null && i.textContent.trim() === tv) {
        const r = i.getBoundingClientRect();
        if (r.x > 0 && r.y > 0) {
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
    }
    // Fallback JS click
    for (const i of items) {
      if (i.offsetParent !== null && i.textContent.trim() === tv) {
        i.click();
        return { js: true };
      }
    }
    return null;
  }, targetValue);

  if (!clicked) return false;
  if (clicked.js) {
    await sleep(500);
  } else {
    await page.mouse.click(clicked.x, clicked.y);
    await sleep(500);
  }
  return true;
}

// --- Fill form fields by label ---

export async function fillForm(page, fields) {
  const keys = Object.keys(fields);
  for (const key of keys) {
    await typeByLabel(page, key, fields[key]);
  }
}

export async function selectValue(page, selector, value) {
  const selected = await page.$eval(selector, (el, target) => {
    if (el.tagName !== 'SELECT') throw new Error('selectValue requires a native select');
    const option = [...el.options].find(o => o.value === target || o.textContent.trim() === target);
    if (!option) return false;
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, value);
  if (!selected) throw new Error(`Option not found: ${value}`);
  return true;
}

export async function setChecked(page, selector, checked = true) {
  await page.$eval(selector, (el, target) => {
    if (!['checkbox', 'radio'].includes(el.type)) throw new Error('setChecked requires checkbox or radio');
    if (el.checked !== target) el.click();
  }, checked);
  return true;
}

export async function fillContentEditable(page, selector, value) {
  const handle = await page.$(selector);
  if (!handle) throw new Error(`Element not found: ${selector}`);
  const editable = await handle.evaluate(el => Boolean(el.isContentEditable));
  if (!editable) {
    await handle.dispose();
    throw new Error('Element is not contenteditable');
  }
  // Draft.js / React controlled editors ignore direct textContent mutation;
  // real keystrokes are the only reliable input path.
  await handle.evaluate(el => el.focus());
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value, { delay: 10 });
  await handle.dispose();
  return true;
}

// --- Read all form items in current active tab ---

export async function readForm(page) {
  return page.evaluate(() => {
    const result = [];
    document.querySelectorAll('.el-form-item').forEach(item => {
      if (item.offsetParent === null) return;
      const parent = item.parentElement;
      if (parent && parent.className.includes('flex-1')) return;
      const label = item.querySelector('.el-form-item__label');
      const inp = item.querySelector('.el-input__inner');
      const ta = item.querySelector('textarea');
      const lbl = label ? label.textContent.trim() : '';
      const val = inp ? inp.value : (ta ? ta.value : '');
      if (lbl && lbl !== '封面图') result.push({ label: lbl, value: val });
    });
    return result;
  });
}

// --- Type by label (for form.mjs style) ---

async function typeByLabel(page, label, value) {
  await page.evaluate(({ lbl, val }) => {
    const items = document.querySelectorAll('.el-form-item');
    for (const item of items) {
      if (item.offsetParent === null) continue;
      const labelEl = item.querySelector('.el-form-item__label');
      const inp = item.querySelector('.el-input__inner, input');
      const ta = item.querySelector('textarea');
      const target = inp || ta;
      if (labelEl && labelEl.textContent.includes(lbl) && target && !target.value) {
        target.value = val;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, { lbl: label, val: value });
}
