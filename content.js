/**
 * 内容脚本：悬浮窗 + 表单自动填写
 * - 顶层窗口显示悬浮窗，所有 frame（含 iframe）都参与填写
 * - 通过 window.postMessage 在 frame 之间协同（网申表单常在 iframe 里）
 */
(function () {
  'use strict';
  if (window.__AUTOAPPLY_ASSISTANT__) return;
  window.__AUTOAPPLY_ASSISTANT__ = true;

  const CHANNEL = 'autoapply-assistant-v1';
  const FRAME_ID = `f${Math.random().toString(36).slice(2, 9)}`;
  const IS_TOP = (() => {
    try {
      return window.top === window;
    } catch (e) {
      return false;
    }
  })();

  const state = {
    spec: null,
    profile: null,
    settings: {},
    fileStates: null,
    profileMeta: null,
    changed: false,
    panelOpen: true,
    busy: false,
    lastReport: null,
    pendingMissing: [],
  };

  /* ------------------------------ 基础工具 ------------------------------ */

  function normalizeLabel(input) {
    if (input === null || input === undefined) return '';
    let t = String(input);
    t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    t = t.replace(/\u3000/g, ' ');
    t = t.replace(/[（(][^)）]{0,24}[)）]/g, ' ');
    t = t.replace(/[☆★*＊]/g, ' ');
    t = t.replace(/必填|选填|required|optional/gi, ' ');
    t = t.toLowerCase();
    t = t.replace(/[\s:：.。、,，;；·•\-—_/\\|"'“”‘’\[\]【】<>《》?？!！]+/g, '');
    return t;
  }

  function cleanText(input) {
    return String(input || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compact(s, max = 60) {
    const t = cleanText(s);
    return t.length > max ? t.slice(0, max) : t;
  }

  /** 与 fields.js scoreLabel 同算法 */
  function scoreField(field, rawText) {
    const label = normalizeLabel(rawText);
    if (!label || label.length > 40) return 0;
    for (const ex of field.exclude || []) {
      const exN = normalizeLabel(ex);
      if (exN && label.includes(exN)) return 0;
    }
    let best = 0;
    for (const alias of field.aliases) {
      const a = normalizeLabel(alias);
      if (!a) continue;
      if (label === a) best = Math.max(best, 200 + a.length * 3);
      else if (a.length >= 2 && label.includes(a)) best = Math.max(best, 100 + a.length * 3);
      else if (label.length >= 2 && a.includes(label)) {
        const diff = a.length - label.length;
        best = Math.max(best, Math.max(0, 150 - diff * 10));
      }
    }
    return best;
  }

  function valuesMatch(a, b, synonyms) {
    const na = normalizeLabel(a);
    const nb = normalizeLabel(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    for (const group of synonyms || []) {
      const g = group.map(normalizeLabel);
      if (g.includes(na) && g.includes(nb)) return true;
    }
    if (na.length >= 2 && nb.length >= 2 && (na.includes(nb) || nb.includes(na))) return true;
    return false;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message) });
      }
    });
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.type === 'hidden') return false;
    return true;
  }

  function isFillable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'reset' || el.type === 'file' || el.type === 'image') return false;
    return true;
  }

  function cssEscapeValue(v) {
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return String(v).replace(/["\\]/g, '\\$&');
  }

  /* ------------------------------ 标签识别 ------------------------------ */

  const LABEL_SELECTORS = [
    '.ant-form-item-label',
    '.el-form-item__label',
    '.layui-form-label',
    '.form-label',
    '.control-label',
    '.item-label',
    '.cell-label',
    '.form-item-label',
    '.weui-label',
    'label',
    '.label',
    'dt',
    'th',
    '.name',
    '.title',
  ];

  function elementHints(el) {
    const hints = [];
    const add = (text, weight) => {
      const t = compact(text);
      if (!t) return;
      hints.push({ text: t, weight: weight || 1 });
    };

    add(el.getAttribute('aria-label'), 1);
    add(el.getAttribute('placeholder'), 0.85);
    add(el.getAttribute('title'), 0.6);
    add(el.getAttribute('data-label') || el.getAttribute('data-title') || el.getAttribute('data-name'), 1);

    if (el.id) {
      try {
        const root = el.getRootNode ? el.getRootNode() : document;
        root.querySelectorAll(`label[for="${cssEscapeValue(el.id)}"]`).forEach((l) => add(l.textContent, 1));
      } catch (e) {
        /* ignore */
      }
    }
    const wrapLabel = el.closest ? el.closest('label') : null;
    if (wrapLabel) add(wrapLabel.textContent, 1);

    // 表格布局：左侧单元格 / 表头列名
    const cell = el.closest ? el.closest('td, th, .cell') : null;
    if (cell) {
      const prev = cell.previousElementSibling;
      if (prev && !prev.querySelector('input,select,textarea')) add(prev.textContent, 0.95);
      const row = cell.parentElement;
      const table = cell.closest('table');
      if (row && table) {
        const cells = Array.prototype.slice.call(row.children);
        const idx = cells.indexOf(cell);
        const firstRow = table.querySelector('tr');
        if (firstRow && firstRow !== row && idx >= 0) {
          const th = firstRow.children[idx];
          if (th) add(th.textContent, 0.9);
        }
      }
    }

    // 表单行
    const item = el.closest
      ? el.closest(
          '.ant-form-item, .el-form-item, .layui-form-item, .form-item, .form-group, .weui-cell, .form-row, .field, .row, .item, .input-group, .control-group',
        )
      : null;
    if (item) {
      for (const sel of LABEL_SELECTORS) {
        const node = item.querySelector(sel);
        if (node && !node.contains(el)) add(node.textContent, 1);
      }
      let sib = item.firstElementChild;
      while (sib && sib !== el && !sib.contains(el)) {
        if (!sib.querySelector('input,select,textarea')) add(sib.textContent, 0.8);
        sib = sib.nextElementSibling;
      }
      try {
        const clone = item.cloneNode(true);
        clone.querySelectorAll('input,select,textarea,button,script,style,svg').forEach((n) => n.remove());
        const t = compact(clone.textContent);
        if (t && t.length <= 40) add(t, 0.45);
      } catch (e) {
        /* ignore */
      }
    }

    for (const attr of ['name', 'id', 'data-field', 'data-key', 'data-prop', 'formcontrolname', 'prop', 'v-model', 'field']) {
      const v = el.getAttribute ? el.getAttribute(attr) : null;
      if (v) add(String(v).replace(/[_\-\[\]]+/g, ' '), 0.7);
    }

    // 通用兜底：向上找若干层，把同一容器里的 label / 纯文本当作标签
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (tag === 'html' || tag === 'body' || tag === 'form' || tag === 'table') break;
      // 层级越高包含的控件越多，说明只是"区域"而不是"这一个字段所在的容器"；
      // 但单选/复选按钮组例外（一行里多个同名单选按钮属于同一个字段）
      const controls = Array.prototype.slice.call(
        node.querySelectorAll('input, select, textarea, [contenteditable="true"]'),
      );
      const names = new Set(controls.map((c) => c.getAttribute('name') || ''));
      const isChoiceGroup =
        controls.length > 0 && controls.every((c) => c.type === 'radio' || c.type === 'checkbox') && names.size <= 1;
      if (depth > 0 && controls.length > 1 && !isChoiceGroup) break;
      const labels = node.querySelectorAll('label, .label, .title, .name');
      for (const l of labels) {
        if (l.contains(el)) continue;
        const t = compact(l.textContent);
        if (t && t.length <= 20) add(t, 0.9);
      }
      let clone = null;
      try {
        clone = node.cloneNode(true);
        clone.querySelectorAll('input,select,textarea,button,script,style,svg,iframe').forEach((n) => n.remove());
        const t = compact(clone.textContent).replace(/\s*\*\s*$/, '');
        if (t && t.length <= 30) add(t, 0.5);
      } catch (e) {
        /* ignore */
      }
      // 上一个兄弟节点的文本（如 <div class="label">姓名</div><input>）
      const prev = node.previousElementSibling;
      if (prev && !prev.querySelector('input,select,textarea')) {
        const t = compact(prev.textContent);
        if (t && t.length <= 20) add(t, 0.85);
      }
    }
    return hints;
  }

  function isRequiredControl(el, hints) {
    if (el.required) return true;
    if (el.getAttribute && (el.getAttribute('aria-required') === 'true' || el.getAttribute('required') !== null)) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/required|is-required/.test(cls)) return true;
    for (const h of hints) {
      if (/\*|＊|必填/.test(h.text)) return true;
    }
    const item = el.closest ? el.closest('.ant-form-item, .el-form-item, .layui-form-item, .form-item, .form-group, .form-row') : null;
    if (item && item.className && /required/.test(String(item.className))) return true;
    return false;
  }

  function matchFieldFor(el, hints) {
    const spec = state.spec;
    if (!spec) return null;
    let best = null;
    for (const field of spec.fields) {
      let top = 0;
      for (const hint of hints) {
        const s = scoreField(field, hint.text) * (hint.weight || 1);
        if (s > top) top = s;
      }
      if (top > 0 && (!best || top > best.score)) best = { field, score: top };
    }
    // autocomplete 提示
    const ac = el.getAttribute && el.getAttribute('autocomplete');
    if (ac && spec.autocomplete && spec.autocomplete[ac]) {
      const key = spec.autocomplete[ac];
      const field = spec.fields.find((f) => f.key === key);
      if (field && (!best || best.score < 150)) best = { field, score: 220 };
    }
    if (!best || best.score < 100) return null;
    return best.field;
  }

  function bestHintText(hints) {
    if (!hints.length) return '';
    const sorted = hints.slice().sort((a, b) => (b.weight || 1) - (a.weight || 1));
    return sorted[0].text;
  }

  /** 自定义字段（面板里手动补充过的站点专有字段）：按标签精确匹配 */
  function matchCustomField(hints) {
    const map = (state.profile && state.profile.customMappings) || {};
    const keys = Object.keys(map);
    if (!keys.length) return null;
    for (const hint of hints) {
      const n = normalizeLabel(hint.text);
      if (!n) continue;
      for (const k of keys) {
        if (normalizeLabel(k) === n) return { label: k, value: map[k] };
      }
    }
    return null;
  }

  /* ------------------------------ 控件收集 ------------------------------ */

  function collectControls() {
    const widgetSelector = '.ant-select, .el-select, .ant-picker, .el-date-editor, [role="combobox"], .layui-form-select, .ivu-select';
    const nodes = document.querySelectorAll(
      'input:not([type=hidden]), select, textarea, [contenteditable="true"], .ant-select, .el-select, .ant-picker, .el-date-editor, [role="combobox"]',
    );
    const out = [];
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input') {
        // 组件库内部的原生 input 交给外层组件处理，避免重复填写
        if (el.closest && el.closest(widgetSelector)) continue;
        if (!isFillable(el)) continue;
        if (type === 'radio' || type === 'checkbox') {
          out.push({ el, kind: type });
        } else {
          out.push({ el, kind: 'text' });
        }
      } else if (tag === 'select') {
        if (el.closest && el.closest(widgetSelector)) continue;
        if (el.disabled) continue;
        out.push({ el, kind: 'select' });
      } else if (tag === 'textarea') {
        if (el.closest && el.closest(widgetSelector)) continue;
        if (!isFillable(el)) continue;
        out.push({ el, kind: 'textarea' });
      } else if (el.isContentEditable) {
        out.push({ el, kind: 'editable' });
      } else {
        // 组件库自定义控件：内部通常有 input 或 select
        const inner = el.querySelector('input:not([type=hidden]), textarea, select');
        if (inner && !isFillable(inner) && !inner.readOnly) {
          /* 只读输入也允许通过组件交互填写 */
        }
        out.push({ el, kind: 'widget', inner });
      }
    }
    return out;
  }

  /** 给控件生成候选：{el, kind, key, label, value, required, current} */
  function buildCandidates(controls) {
    const list = [];
    for (const c of controls) {
      const el = c.el;
      const hints = elementHints(el);
      const required = isRequiredControl(el, hints);
      const custom = matchCustomField(hints);
      if (custom) {
        list.push({
          ...c,
          hints,
          required,
          key: `custom:${custom.label}`,
          label: custom.label,
          value: custom.value,
          custom: true,
        });
        continue;
      }
      const field = matchFieldFor(el, hints);
      if (!field) {
        list.push({ ...c, hints, required, key: null, label: bestHintText(hints), value: '' });
        continue;
      }
      const value = state.profile ? state.profile[field.key] : '';
      list.push({
        ...c,
        hints,
        required,
        key: field.key,
        label: field.label,
        fieldType: field.type,
        value: value == null ? '' : String(value),
      });
    }
    return list;
  }

  function currentValue(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' && el.type === 'radio') {
      const name = el.name;
      const root = el.form || document;
      let checked = null;
      if (name) {
        try {
          checked = root.querySelector(`input[type=radio][name="${cssEscapeValue(name)}"]:checked`);
        } catch (e) {
          checked = el.checked ? el : null;
        }
      } else if (el.checked) {
        checked = el;
      }
      return checked ? radioLabelText(checked) || checked.value || '已选中' : '';
    }
    if (tag === 'input' && el.type === 'checkbox') return el.checked ? '是' : '';
    if (tag === 'select') return el.value || '';
    if (tag === 'input' || tag === 'textarea') return el.value || '';
    if (el.isContentEditable) return cleanText(el.textContent);
    const inner = el.querySelector && el.querySelector('input,textarea');
    if (inner) return inner.value || '';
    return cleanText(el.textContent).slice(0, 60);
  }

  /* ------------------------------ 写值 ------------------------------ */

  function setNativeValue(el, value) {
    const proto =
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    try {
      if (el._valueTracker && typeof el._valueTracker.setValue === 'function') el._valueTracker.setValue('');
    } catch (e) {
      /* ignore */
    }
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillTextLike(el, value) {
    if (el.maxLength && el.maxLength > 0 && value.length > el.maxLength) value = value.slice(0, el.maxLength);
    setNativeValue(el, value);
    let ok = false;
    try {
      ok = String(el.value || '').trim() !== '' && normalizeLabel(el.value) === normalizeLabel(value);
    } catch (e) {
      ok = true;
    }
    if (!ok && el.value !== value) {
      el.dispatchEvent(new Event('keydown', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
    }
    return { ok: true };
  }

  function optionTexts(sel) {
    return Array.prototype.map.call(sel.options || [], (o) => cleanText(o.textContent));
  }

  function pickOption(sel, value, synonyms, key) {
    const options = Array.prototype.slice.call(sel.options || []);
    const nv = normalizeLabel(value);
    let target = options.find((o) => normalizeLabel(o.value) === nv && nv !== '');
    if (!target) target = options.find((o) => valuesMatch(cleanText(o.textContent), value, synonyms));
    if (!target) target = options.find((o) => {
      const t = normalizeLabel(cleanText(o.textContent));
      return t.length >= 2 && nv.length >= 2 && (t.includes(nv) || nv.includes(t));
    });
    if (!target && /Date$/.test(key || '')) target = pickDateOption(options, value, key);
    return target || null;
  }

  function pickDateOption(options, value, key) {
    const parts = String(value || '').match(/(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/);
    if (!parts) return null;
    const year = parts[1];
    const month = parts[2] ? String(Number(parts[2])) : '';
    const day = parts[3] ? String(Number(parts[3])) : '';
    const numeric = options.map((o) => cleanText(o.textContent)).filter((t) => /^\d{1,4}$/.test(t));
    if (!numeric.length) return null;
    const maxLen = Math.max(...numeric.map((n) => n.length));
    if (maxLen === 4 && key === 'birthDate') return options.find((o) => /^\d{4}$/.test(cleanText(o.textContent)) && cleanText(o.textContent) === year) || null;
    if (maxLen <= 2) {
      return (
        options.find((o) => cleanText(o.textContent) === month && Number(month) >= 1 && Number(month) <= 12) ||
        options.find((o) => cleanText(o.textContent) === day) ||
        null
      );
    }
    return null;
  }

  function fillSelect(el, value, synonyms, key) {
    const target = pickOption(el, value, synonyms, key);
    if (!target) return { ok: false, reason: '选项中没有匹配值' };
    el.focus({ preventScroll: true });
    el.value = target.value;
    if (el.value !== target.value) el.selectedIndex = Array.prototype.indexOf.call(el.options, target);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    const ok = normalizeLabel(el.value) === normalizeLabel(target.value);
    return ok ? { ok: true, detail: cleanText(target.textContent) } : { ok: false, reason: '下拉框未接受所选值' };
  }

  function radioLabelText(el) {
    const wrap = el.closest('label');
    if (wrap) return compact(wrap.textContent);
    if (el.id) {
      try {
        const lab = document.querySelector(`label[for="${cssEscapeValue(el.id)}"]`);
        if (lab) return compact(lab.textContent);
      } catch (e) {
        /* ignore */
      }
    }
    const next = el.nextElementSibling;
    if (next && !next.querySelector('input,select,textarea')) return compact(next.textContent);
    const parent = el.parentElement;
    if (parent) return compact(parent.textContent);
    return '';
  }

  function fillRadioGroup(control, value, synonyms) {
    const el = control.el;
    const name = el.name;
    const root = el.form || document;
    let group = name
      ? Array.prototype.filter.call(root.querySelectorAll(`input[type=radio][name="${cssEscapeValue(name)}"]`), () => true)
      : [];
    if (!group.length) group = [el];
    const chosen = group.find((r) => valuesMatch(radioLabelText(r), value, synonyms) || valuesMatch(r.value, value, synonyms));
    if (!chosen) return { ok: false, reason: `没有与「${value}」匹配的选项` };
    if (!chosen.checked) chosen.click();
    else chosen.checked = true;
    return { ok: true, detail: radioLabelText(chosen) };
  }

  function fillCheckbox(control, value, synonyms) {
    const el = control.el;
    const want = valuesMatch(value, '是', synonyms) || valuesMatch(value, 'true', synonyms);
    const label = radioLabelText(el);
    const matchesYes = valuesMatch(label, '是', synonyms) || valuesMatch(label, '有', synonyms);
    const matchesNo = valuesMatch(label, '否', synonyms) || valuesMatch(label, '无', synonyms);
    const shouldCheck = want ? matchesYes || (!matchesNo && valuesMatch(label, value, synonyms)) : matchesNo && valuesMatch(label, value, synonyms);
    if (shouldCheck && !el.checked) el.click();
    else if (!shouldCheck && el.checked && (matchesYes || matchesNo)) el.click();
    return { ok: shouldCheck, reason: shouldCheck ? '' : '与是否类选项不匹配' };
  }

  function fillEditable(el, value) {
    el.focus({ preventScroll: true });
    el.textContent = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return { ok: cleanText(el.textContent) !== '' };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  const POPUP_SELECTORS = [
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
    '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
    '.el-select-dropdown',
    '.el-popper',
    '.layui-form-select',
    '.ivu-select-dropdown',
    '.van-popup',
    '[role="listbox"]',
  ];

  function visiblePopupItems() {
    const items = [];
    for (const sel of POPUP_SELECTORS) {
      for (const popup of document.querySelectorAll(sel)) {
        if (!isVisible(popup)) continue;
        popup
          .querySelectorAll('.ant-select-item-option, .el-select-dropdown__item, dd, li, [role="option"], .ant-picker-cell-inner, td')
          .forEach((item) => {
            if (!isVisible(item)) return;
            const t = cleanText(item.textContent);
            if (t && t.length <= 40) items.push({ el: item, text: t });
          });
      }
    }
    return items;
  }

  async function fillCustomSelect(widget, value, synonyms) {
    try {
      widget.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) {
      /* ignore */
    }
    widget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    widget.click();
    await sleep(180);
    const items = visiblePopupItems();
    if (!items.length) return { ok: false, reason: '下拉面板未打开' };
    let target = items.find((i) => valuesMatch(i.text, value, synonyms));
    if (!target) {
      target = items.find((i) => {
        const a = normalizeLabel(i.text);
        const b = normalizeLabel(value);
        return a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
      });
    }
    if (!target) {
      closePopups();
      return { ok: false, reason: '下拉面板中没有匹配项' };
    }
    target.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.el.click();
    await sleep(80);
    return { ok: true, detail: target.text };
  }

  function closePopups() {
    try {
      const active = document.activeElement;
      const ev = { key: 'Escape', keyCode: 27, which: 27, bubbles: true };
      if (active && active.dispatchEvent) active.dispatchEvent(new KeyboardEvent('keydown', ev));
      document.body.dispatchEvent(new KeyboardEvent('keydown', ev));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.body.click();
    } catch (e) {
      /* ignore */
    }
  }

  async function fillPicker(widget, value, key) {
    const input = widget.querySelector('input');
    if (!input) return { ok: false, reason: '未找到日期输入框' };
    const pattern = guessPatternForKey(key, input);
    const text = formatDateValue(value, pattern);
    if (!text) return { ok: false, reason: '日期格式无法识别' };
    input.focus({ preventScroll: true });
    setNativeValue(input, text);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(60);
    return { ok: true, detail: text };
  }

  function guessPatternForKey(key, input) {
    const ph = (input && input.getAttribute('placeholder')) || '';
    if (input && input.type === 'month') return 'yyyy-MM';
    if (input && input.type === 'date') return 'yyyy-MM-dd';
    if (/yyy?y?[\/.-]m/i.test(ph) && !/d/i.test(ph)) return 'yyyy-MM';
    if (/年/.test(ph) && /月/.test(ph) && !/日/.test(ph)) return 'yyyy年MM月';
    if (/年/.test(ph) && /月/.test(ph) && /日/.test(ph)) return 'yyyy年MM月dd日';
    if (key === 'birthDate') return 'yyyy-MM';
    return 'yyyy-MM';
  }

  function formatDateValue(value, pattern) {
    const m = String(value || '').match(/(\d{4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?/);
    if (!m) return '';
    const y = m[1];
    const mo = m[2] ? String(Number(m[2])).padStart(2, '0') : '';
    const d = m[3] ? String(Number(m[3])).padStart(2, '0') : '';
    return pattern
      .replace(/yyyy/i, y)
      .replace(/mm/i, mo || '01')
      .replace(/dd/i, d || '01')
      .replace(/(\D|^)m(\D|$)/, (s, a, b) => `${a}${mo ? Number(mo) : 1}${b}`)
      .replace(/(\D|^)d(\D|$)/, (s, a, b) => `${a}${d ? Number(d) : 1}${b}`);
  }

  /* ------------------------------ 填充主流程 ------------------------------ */

  async function fillCandidate(cand, opts) {
    const synonyms = (state.spec && state.spec.synonyms) || [];
    const value = cand.value == null ? '' : String(cand.value);
    if (!value) return { status: 'nodata' };
    const existing = currentValue(cand.el);
    if (existing && !opts.overwrite) {
      return valuesMatch(existing, value, synonyms) ? { status: 'existing' } : { status: 'existing-diff', existing };
    }
    try {
      if (cand.kind === 'text') {
        const inputType = (cand.el.getAttribute('type') || '').toLowerCase();
        if (['date', 'month', 'datetime-local', 'week'].includes(inputType)) {
          const pattern = guessPatternForKey(cand.key, cand.el);
          const formatted = formatDateValue(value, pattern);
          if (!formatted) return { status: 'fill', ...fillTextLike(cand.el, value) };
          return { status: 'fill', ...fillTextLike(cand.el, formatted), detail: formatted };
        }
        return { status: 'fill', ...fillTextLike(cand.el, value) };
      }
      if (cand.kind === 'textarea') return { status: 'fill', ...fillTextLike(cand.el, value) };
      if (cand.kind === 'select') {
        const res = fillSelect(cand.el, value, synonyms, cand.key);
        return res.ok ? { status: 'fill', detail: res.detail } : { status: 'fail', reason: res.reason };
      }
      if (cand.kind === 'radio') {
        const res = fillRadioGroup(cand, value, synonyms);
        return res.ok ? { status: 'fill', detail: res.detail } : { status: 'fail', reason: res.reason };
      }
      if (cand.kind === 'checkbox') {
        const res = fillCheckbox(cand, value, synonyms);
        return res.ok ? { status: 'fill' } : { status: 'fail', reason: res.reason };
      }
      if (cand.kind === 'editable') {
        const res = fillEditable(cand.el, value);
        return res.ok ? { status: 'fill' } : { status: 'fail', reason: '富文本填写失败' };
      }
      if (cand.kind === 'widget') {
        const cls = String(cand.el.className || '');
        const isSelectWidget =
          /ant-select|el-select|layui-select|ivu-select|select/.test(cls) || cand.el.getAttribute('role') === 'combobox';
        const isDateWidget = /picker|date|time/i.test(cls) || (cand.key && /Date$/.test(cand.key) && /pick/.test(cls));
        if (isSelectWidget && !/picker|date/i.test(cls)) {
          const res = await fillCustomSelect(cand.el, value, synonyms);
          return res.ok ? { status: 'fill', detail: res.detail } : { status: 'fail', reason: res.reason };
        }
        if (isDateWidget) {
          const res = await fillPicker(cand.el, value, cand.key);
          return res.ok ? { status: 'fill', detail: res.detail } : { status: 'fail', reason: res.reason };
        }
        const inner = cand.inner || cand.el.querySelector('input,textarea');
        if (inner) {
          const res = fillTextLike(inner, value);
          return res.ok ? { status: 'fill' } : { status: 'fail', reason: '组件填写失败' };
        }
        return { status: 'fail', reason: '不支持的控件类型' };
      }
      return { status: 'fail', reason: '未知控件类型' };
    } catch (err) {
      return { status: 'fail', reason: String((err && err.message) || err) };
    }
  }

  /** 单个控件的描述（用于报告中定位） */
  function describeControl(cand) {
    let selector = '';
    try {
      if (cand.el.id) selector = `#${CSS.escape(cand.el.id)}`;
      else if (cand.el.name) selector = `[name="${cssEscapeValue(cand.el.name)}"]`;
    } catch (e) {
      selector = '';
    }
    return {
      key: cand.key && cand.key.startsWith('custom:') ? '' : cand.key || '',
      customLabel: cand.key && cand.key.startsWith('custom:') ? cand.key.slice(7) : '',
      label: String(cand.label || '').replace(/^[\s*＊☆★]+/, '').replace(/[\s*＊☆★]+$/, ''),
      required: Boolean(cand.required),
      selector,
    };
  }

  async function runFill(opts = {}) {
    const overwrite = Boolean(opts.overwrite);
    const controls = collectControls();
    const candidates = buildCandidates(controls);
    const report = {
      frameId: FRAME_ID,
      url: location.href,
      isTop: IS_TOP,
      filled: [],
      existing: [],
      existingDiff: [],
      noData: [],
      unknown: [],
      failed: [],
      scanned: candidates.length,
      matched: 0,
    };

    const nativeCands = candidates.filter((c) => c.kind !== 'widget');
    const widgetCands = candidates.filter((c) => c.kind === 'widget');

    for (const cand of nativeCands) {
      if (!cand.key) {
        if (cand.required) report.unknown.push(describeControl(cand));
        continue;
      }
      report.matched += 1;
      const res = await fillCandidate(cand, { overwrite });
      const desc = describeControl(cand);
      if (res.status === 'fill') report.filled.push(desc);
      else if (res.status === 'existing') report.existing.push(desc);
      else if (res.status === 'existing-diff') report.existingDiff.push({ ...desc, existing: res.existing });
      else if (res.status === 'nodata') report.noData.push(desc);
      else if (res.status === 'fail') report.failed.push({ ...desc, reason: res.reason || '' });
    }

    for (const cand of widgetCands) {
      if (!cand.key) {
        if (cand.required) report.unknown.push(describeControl(cand));
        continue;
      }
      report.matched += 1;
      const res = await fillCandidate(cand, { overwrite });
      const desc = describeControl(cand);
      if (res.status === 'fill') report.filled.push(desc);
      else if (res.status === 'existing') report.existing.push(desc);
      else if (res.status === 'existing-diff') report.existingDiff.push({ ...desc, existing: res.existing });
      else if (res.status === 'nodata') report.noData.push(desc);
      else if (res.status === 'fail') report.failed.push({ ...desc, reason: res.reason || '' });
    }

    report.unknown = dedupeDesc(report.unknown);
    report.noData = dedupeDesc(report.noData);
    report.failed = dedupeDesc(report.failed);
    report.filled = dedupeDesc(report.filled);
    return report;
  }

  function dedupeDesc(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const k = `${item.key}|${item.customLabel}|${item.label}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
    return out;
  }

  /* ------------------------------ Frame 协同 ------------------------------ */

  function postToChildren(msg, hop) {
    const frames = window.frames;
    for (let i = 0; i < frames.length; i += 1) {
      try {
        frames[i].postMessage(msg, '*');
      } catch (e) {
        /* ignore */
      }
    }
  }

  function postToTop(msg) {
    try {
      (IS_TOP ? window : window.top).postMessage(msg, '*');
    } catch (e) {
      /* ignore */
    }
  }

  async function handleFillRun(msg) {
    const report = await runFill({ overwrite: msg.overwrite });
    postToTop({ channel: CHANNEL, type: 'fill:result', id: msg.id, report });
  }

  async function handleFillOne(msg) {
    const controls = collectControls();
    const candidates = buildCandidates(controls);
    const target = candidates.find((c) => {
      if (msg.target.key) return c.key === msg.target.key;
      const n = normalizeLabel(msg.target.label);
      return c.hints.some((h) => normalizeLabel(h.text) === n) || normalizeLabel(c.label) === n;
    });
    if (!target) return { ok: false, reason: 'not-found' };
    const res = await fillCandidate({ ...target, value: msg.value }, { overwrite: true });
    return { ok: res.status === 'fill', reason: res.reason || res.status };
  }

  const runFilled = new Set();
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    const path = data.path || [];
    if (path.indexOf(FRAME_ID) !== -1) return; // 防止消息在 frame 之间来回转发

    if (data.type === 'fill:run') {
      if (!runFilled.has(data.id)) {
        runFilled.add(data.id);
        handleFillRun(data);
      }
    } else if (data.type === 'fill:one') {
      if (!data.frameId || data.frameId === FRAME_ID) {
        handleFillOne(data).then((res) =>
          postToTop({ channel: CHANNEL, type: 'fill:one:result', id: data.id, ok: res.ok, reason: res.reason }),
        );
      }
    } else if (data.type === 'fill:result') {
      if (IS_TOP) {
        onFrameResult(data.id, data.report);
        return;
      }
    } else if (data.type === 'fill:one:result') {
      if (IS_TOP) {
        onFillOneResult(data);
        return;
      }
    }

    if (path.length < 8) {
      postToChildren({ ...data, path: path.concat(FRAME_ID) });
    }
  });

  /* ------------------------------ 待补充字段 ------------------------------ */

  function collectMissing(report) {
    const rows = [];
    for (const item of report.noData) {
      if (item.key) rows.push({ kind: 'key', key: item.key, label: item.label, required: item.required, frameId: item.frameId });
      else if (item.customLabel) rows.push({ kind: 'custom', label: item.customLabel, required: item.required, frameId: item.frameId });
    }
    for (const item of report.unknown) {
      if (!item.label) continue;
      rows.push({ kind: 'custom', label: item.label, required: item.required, frameId: item.frameId });
    }
    for (const item of report.failed) {
      rows.push({ kind: 'failed', key: item.key, label: item.label, reason: item.reason, required: item.required, frameId: item.frameId });
    }
    return dedupeRows(rows);
  }

  function dedupeRows(rows) {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const k = `${r.kind}|${r.key || ''}|${normalizeLabel(r.label)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }

  /* ------------------------------ 结果聚合 ------------------------------ */

  const pendingRuns = new Map();

  function onFrameResult(id, report) {
    const agg = pendingRuns.get(id);
    if (!agg) return;
    agg.reports.push(report);
    if (!agg.timer) agg.timer = setTimeout(() => finishRun(id), 500);
  }

  function mergeReports(reports) {
    const merged = {
      frames: reports.length,
      scanned: 0,
      matched: 0,
      filled: [],
      existing: [],
      existingDiff: [],
      noData: [],
      unknown: [],
      failed: [],
    };
    for (const r of reports) {
      const tag = (list) => (list || []).map((item) => ({ ...item, frameId: item.frameId || r.frameId }));
      merged.scanned += r.scanned || 0;
      merged.matched += r.matched || 0;
      merged.filled.push(...tag(r.filled));
      merged.existing.push(...tag(r.existing));
      merged.existingDiff.push(...tag(r.existingDiff));
      merged.noData.push(...tag(r.noData));
      merged.unknown.push(...tag(r.unknown));
      merged.failed.push(...tag(r.failed));
    }
    merged.filled = dedupeDesc(merged.filled);
    merged.existing = dedupeDesc(merged.existing);
    merged.existingDiff = dedupeDesc(merged.existingDiff);
    merged.noData = dedupeDesc(merged.noData);
    merged.unknown = dedupeDesc(merged.unknown);
    merged.failed = dedupeDesc(merged.failed);
    return merged;
  }

  function finishRun(id) {
    const agg = pendingRuns.get(id);
    if (!agg) return;
    pendingRuns.delete(id);
    const merged = mergeReports(agg.reports);
    state.lastReport = merged;
    state.pendingMissing = collectMissing(merged);
    state.busy = false;
    renderReport();
    renderActions();
    sendMessage({
      type: 'report:save',
      report: {
        url: location.href,
        filled: merged.filled.length,
        existing: merged.existing.length,
        noData: merged.noData.length,
        unknown: merged.unknown.length,
        failed: merged.failed.length,
      },
    });
  }

  function startFillRun() {
    if (!state.profile) {
      setStatus('尚未加载资料文件，请先上传信息文档与简历');
      return;
    }
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    pendingRuns.set(id, { reports: [], timer: null });
    state.busy = true;
    renderActions();
    setStatus('正在识别并填写…');
    const overwrite = Boolean(state.settings.overwriteFilled);
    runFill({ overwrite }).then((report) => onFrameResult(id, report));
    for (let i = 0; i < window.frames.length; i += 1) {
      try {
        window.frames[i].postMessage({ channel: CHANNEL, type: 'fill:run', id, overwrite, path: [FRAME_ID] }, '*');
      } catch (e) {
        /* ignore */
      }
    }
  }

  function onFillOneResult() {
    /* 单项填写结果无需额外处理，失败时会在下一次报告中体现 */
  }

  /* ------------------------------ 悬浮窗 ------------------------------ */

  const PANEL_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .aa-root {
    position: fixed; z-index: 2147483646; right: 18px; top: 50%;
    transform: translateY(-50%);
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 13px; color: #1f2937; line-height: 1.5;
  }
  .aa-ball {
    width: 46px; height: 46px; border-radius: 50%; border: none; cursor: pointer;
    background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; font-size: 15px; font-weight: 700;
    box-shadow: 0 6px 18px rgba(37, 99, 235, .35); display: flex; align-items: center; justify-content: center;
  }
  .aa-ball:hover { transform: translateY(-1px); }
  .aa-ball .aa-badge {
    position: absolute; transform: translate(18px, -18px); background: #ef4444; color: #fff;
    border-radius: 9px; min-width: 18px; height: 18px; font-size: 11px; line-height: 18px; padding: 0 4px; text-align: center;
  }
  .aa-panel {
    position: relative; width: 372px; max-height: 76vh; overflow: auto; background: #fff;
    border-radius: 14px; box-shadow: 0 12px 40px rgba(15, 23, 42, .22); border: 1px solid #e5e7eb;
  }
  .aa-panel.aa-hidden, .aa-ball.aa-hidden { display: none; }
  .aa-head {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eef2f7;
    background: linear-gradient(135deg, #eff6ff, #f8fafc); border-radius: 14px 14px 0 0; cursor: move;
  }
  .aa-title { font-weight: 700; font-size: 13.5px; flex: 1; color: #1e3a8a; }
  .aa-icon-btn {
    border: none; background: #fff; border-radius: 8px; cursor: pointer; width: 26px; height: 26px;
    color: #475569; border: 1px solid #e2e8f0; font-size: 13px;
  }
  .aa-body { padding: 10px 12px 14px; }
  .aa-section { margin-bottom: 12px; }
  .aa-section-title { font-size: 12px; color: #64748b; margin-bottom: 6px; font-weight: 600; }
  .aa-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid #eef2f7; border-radius: 9px; margin-bottom: 6px; background: #fbfdff; }
  .aa-row .aa-grow { flex: 1; min-width: 0; }
  .aa-name { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aa-meta { font-size: 11px; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button.aa-btn {
    border: 1px solid #d7dfea; background: #fff; color: #1f2937; border-radius: 8px; padding: 5px 9px;
    cursor: pointer; font-size: 12px; white-space: nowrap;
  }
  button.aa-btn:hover { background: #f1f5f9; }
  button.aa-btn.aa-primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
  button.aa-btn.aa-primary:hover { background: #1d4ed8; }
  button.aa-btn.aa-ghost { border-color: transparent; color: #2563eb; background: transparent; }
  .aa-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .aa-status {
    background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 9px; padding: 8px 10px; font-size: 12px; color: #334155;
    white-space: pre-wrap; word-break: break-word;
  }
  .aa-stats { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
  .aa-chip { border-radius: 999px; padding: 2px 9px; font-size: 11.5px; border: 1px solid #dbeafe; background: #eff6ff; color: #1d4ed8; }
  .aa-chip.aa-ok { background: #ecfdf5; border-color: #bbf7d0; color: #047857; }
  .aa-chip.aa-warn { background: #fffbeb; border-color: #fde68a; color: #b45309; }
  .aa-chip.aa-danger { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
  .aa-missing { border-top: 1px solid #eef2f7; margin-top: 6px; padding-top: 8px; }
  .aa-missing-row { border: 1px solid #eef2f7; border-radius: 9px; padding: 7px 8px; margin-bottom: 7px; background: #fffdf5; }
  .aa-missing-label { font-size: 12px; font-weight: 600; margin-bottom: 5px; display: flex; gap: 6px; align-items: center; }
  .aa-missing-label .aa-tag { font-size: 10.5px; font-weight: 500; color: #b45309; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 0 5px; }
  .aa-missing-input { display: flex; gap: 6px; }
  input.aa-input, textarea.aa-input {
    flex: 1; border: 1px solid #d7dfea; border-radius: 8px; padding: 5px 7px; font-size: 12px; font-family: inherit; color: #111827;
    background: #fff; min-width: 0;
  }
  textarea.aa-input { resize: vertical; min-height: 46px; }
  .aa-footer { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding-top: 6px; border-top: 1px solid #eef2f7; }
  .aa-switch { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: #475569; cursor: pointer; }
  .aa-log { margin-top: 8px; font-size: 11.5px; color: #475569; max-height: 92px; overflow: auto; }
  .aa-log div { padding: 1px 0; }
  .aa-hint { font-size: 11px; color: #94a3b8; margin-top: 4px; }
  .aa-empty { font-size: 12px; color: #94a3b8; }
  .aa-error { color: #b91c1c; }
  .aa-ok { color: #047857; }
  `;

  let ui = null;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function ensurePanel() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.id = `autoapply-host-${FRAME_ID}`;
    host.style.cssText = 'all: initial;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    const root = el('div', { class: 'aa-root' });
    const ball = el('button', { class: 'aa-ball', title: '网申自动填写助手', text: '填' });
    const badge = el('span', { class: 'aa-badge' });
    badge.style.display = 'none';
    ball.appendChild(badge);
    const panel = el('div', { class: 'aa-panel aa-hidden' });
    root.appendChild(panel);
    root.appendChild(ball);
    shadow.appendChild(root);

    // 头部
    const title = el('div', { class: 'aa-title', text: '网申自动填写助手' });
    const btnMin = el('button', { class: 'aa-icon-btn', title: '收起', text: '–' });
    const btnHide = el('button', { class: 'aa-icon-btn', title: '隐藏悬浮窗（点插件图标可再次显示）', text: '×' });
    const head = el('div', { class: 'aa-head' }, title, btnMin, btnHide);

    const body = el('div', { class: 'aa-body' });
    const fileSection = el('div', { class: 'aa-section' });
    const actionsSection = el('div', { class: 'aa-section' });
    const statusSection = el('div', { class: 'aa-section' });
    const missingSection = el('div', { class: 'aa-section aa-missing' });
    const logSection = el('div', { class: 'aa-log' });
    body.append(fileSection, actionsSection, statusSection, missingSection, logSection);
    panel.append(head, body);
    (document.body || document.documentElement).appendChild(host);

    // 拖动
    let dragging = null;
    const onDown = (e) => {
      if (e.target.closest && e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const x = Math.min(Math.max(4, e.clientX - dragging.dx), window.innerWidth - 120);
      const y = Math.min(Math.max(4, e.clientY - dragging.dy), window.innerHeight - 60);
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
      root.style.right = 'auto';
      root.style.transform = 'none';
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = null;
      const rect = root.getBoundingClientRect();
      state.settings.panelPosition = { left: rect.left, top: rect.top };
      sendMessage({ type: 'panel:state:set', panelState: { position: state.settings.panelPosition, collapsed: !panel.classList.contains('aa-hidden') ? false : true } });
    };
    head.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);

    btnMin.addEventListener('click', () => togglePanel(false));
    btnHide.addEventListener('click', () => {
      root.style.display = 'none';
    });
    ball.addEventListener('click', () => togglePanel(true));

    ui = { host, shadow, root, ball, badge, panel, head, body, fileSection, actionsSection, statusSection, missingSection, logSection, title };
    return ui;
  }

  function togglePanel(open) {
    const u = ensurePanel();
    const willOpen = open === undefined ? u.panel.classList.contains('aa-hidden') : open;
    u.panel.classList.toggle('aa-hidden', !willOpen);
    u.ball.classList.toggle('aa-hidden', false);
    state.panelOpen = willOpen;
    state.settings = state.settings || {};
    state.settings.panelOpen = willOpen;
    sendMessage({ type: 'settings:set', values: { panelOpen: willOpen } });
    if (willOpen) renderPanel();
  }

  function setStatus(text, cls) {
    state.statusText = text;
    state.statusClass = cls || '';
    renderStatus();
  }

  function pushLog(text, cls) {
    state.logs = state.logs || [];
    state.logs.unshift({ text, cls: cls || '', at: Date.now() });
    if (state.logs.length > 30) state.logs.pop();
    renderLog();
  }

  function renderStatus() {
    if (!ui) return;
    ui.statusSection.textContent = '';
    const box = el('div', { class: 'aa-status' + (state.statusClass ? ` ${state.statusClass}` : '') });
    box.textContent = state.statusText || '准备就绪';
    ui.statusSection.appendChild(box);

    const report = state.lastReport;
    if (report) {
      const stats = el('div', { class: 'aa-stats' });
      stats.append(
        el('span', { class: 'aa-chip aa-ok', text: `已填写 ${report.filled.length}` }),
        el('span', { class: 'aa-chip', text: `已有内容 ${report.existing.length}` }),
        el('span', { class: 'aa-chip aa-warn', text: `缺数据 ${report.noData.length}` }),
        el('span', { class: 'aa-chip aa-danger', text: `未识别 ${report.unknown.length}` }),
      );
      if (report.failed.length) stats.appendChild(el('span', { class: 'aa-chip aa-danger', text: `填写失败 ${report.failed.length}` }));
      ui.statusSection.appendChild(stats);
    }
  }

  function renderLog() {
    if (!ui) return;
    ui.logSection.textContent = '';
    for (const line of state.logs || []) {
      ui.logSection.appendChild(el('div', { class: line.cls, text: line.text }));
    }
  }

  function humanSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function timeAgo(ts) {
    if (!ts) return '未读取';
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚更新';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前更新`;
    return `${Math.floor(diff / 86_400_000)} 天前更新`;
  }

  function renderFiles() {
    if (!ui) return;
    const fs = state.fileStates || {};
    const meta = state.profileMeta || {};
    const docs = meta.docs || [];
    const wrap = ui.fileSection;
    wrap.textContent = '';
    wrap.appendChild(el('div', { class: 'aa-section-title', text: '资料文件（保存在插件中，长期有效）' }));
    const defs = [
      { slot: 'info', title: '网申信息文档', accept: '.docx,.doc,.txt,.md' },
      { slot: 'resume', title: '简历', accept: '.pdf,.docx,.doc,.txt,.md' },
    ];
    for (const def of defs) {
      const st = fs[def.slot] || {};
      const doc = docs.find((d) => d.slot === def.slot);
      const name = (st.name || (doc && doc.name) || '未加载') + (st.origin === 'upload' ? '（插件内上传）' : st.exists ? '（插件目录 data/）' : '');
      const info = st.exists
        ? `${humanSize(st.size)} · ${doc && doc.chars ? `${doc.chars} 字` : ''} ${doc && doc.pageCount ? `· ${doc.pageCount} 页` : ''}`
        : '请放入插件 data/ 目录，或点击右侧按钮上传';
      const row = el('div', { class: 'aa-row' });
      const grow = el('div', { class: 'aa-grow' });
      grow.append(el('div', { class: 'aa-name', text: `${def.title}：${name}` }), el('div', { class: 'aa-meta', text: info }));
      const input = el('input', { type: 'file', accept: def.accept, style: 'display:none' });
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        uploadFile(def.slot, file);
        input.value = '';
      });
      const btn = el('button', { class: 'aa-btn', text: st.exists ? '替换' : '上传' });
      btn.addEventListener('click', () => input.click());
      row.append(grow, btn, input);
      if (st.origin === 'upload') {
        const btnFolder = el('button', { class: 'aa-btn aa-ghost', text: '用目录文件', title: '改用插件 data/ 目录中的文件' });
        btnFolder.addEventListener('click', async () => {
          btnFolder.disabled = true;
          const res = await sendMessage({ type: 'file:clear', slot: def.slot });
          applyStatus(res);
          pushLog(`已切回插件目录文件：${def.title}`);
        });
        row.appendChild(btnFolder);
      }
      wrap.appendChild(row);
    }
    wrap.appendChild(
      el(
        'div',
        { class: 'aa-hint' },
        `资料读取时间：${timeAgo(meta.parsedAt)}${meta.error ? `　⚠ ${meta.error}` : ''}`,
        meta.docs && meta.docs.some((d) => d.warning === 'pdf_no_text') ? '（简历 PDF 未提取到文字，可能是扫描件，建议换成可复制文字的 PDF）' : '',
      ),
    );
  }

  function renderActions() {
    if (!ui) return;
    const wrap = ui.actionsSection;
    wrap.textContent = '';
    const actions = el('div', { class: 'aa-actions' });
    const fillBtn = el('button', { class: 'aa-btn aa-primary', text: state.busy ? '填写中…' : '▶ 开始填写' });
    fillBtn.disabled = Boolean(state.busy);
    fillBtn.addEventListener('click', () => {
      startFillRun();
    });
    const refreshBtn = el('button', { class: 'aa-btn', text: '↻ 重新读取文件' });
    refreshBtn.addEventListener('click', async () => {
      setStatus('正在重新读取资料文件…');
      const res = await sendMessage({ type: 'files:refresh', force: false });
      applyStatus(res);
      pushLog(res && res.changed ? '检测到文件变化，资料已更新' : '文件未变化，资料保持最新');
    });
    const optionsBtn = el('button', { class: 'aa-btn', text: '⚙ 资料设置' });
    optionsBtn.addEventListener('click', () => sendMessage({ type: 'options:open' }));
    actions.append(fillBtn, refreshBtn, optionsBtn);
    wrap.appendChild(actions);

    const footer = el('div', { class: 'aa-footer', style: 'margin-top:8px' });
    const switchLabel = el('label', { class: 'aa-switch' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = Boolean(state.settings.overwriteFilled);
    cb.addEventListener('change', async () => {
      state.settings.overwriteFilled = cb.checked;
      await sendMessage({ type: 'settings:set', values: { overwriteFilled: cb.checked } });
    });
    switchLabel.append(cb, el('span', { text: '覆盖页面已有内容' }));
    const count = el('span', { class: 'aa-hint', text: `本页可填 ${state.controlCount || 0} 项` });
    footer.append(switchLabel, count);
    wrap.appendChild(footer);
  }

  function renderMissing() {
    if (!ui) return;
    const wrap = ui.missingSection;
    wrap.textContent = '';
    const rows = state.pendingMissing || [];
    if (!rows.length) {
      wrap.appendChild(el('div', { class: 'aa-empty', text: '暂无需要补充的字段' }));
      return;
    }
    wrap.appendChild(el('div', { class: 'aa-section-title', text: `需要补充的资料（${rows.length} 项，填写一次后永久记住）` }));
    for (const row of rows) {
      const box = el('div', { class: 'aa-missing-row' });
      const headLine = el('div', { class: 'aa-missing-label' });
      headLine.appendChild(el('span', { text: row.label || '未命名字段' }));
      if (row.kind === 'custom') headLine.appendChild(el('span', { class: 'aa-tag', text: '页面专有字段' }));
      if (row.kind === 'failed') headLine.appendChild(el('span', { class: 'aa-tag', text: row.reason || '填写失败' }));
      if (row.kind === 'key' && state.profile) {
        headLine.appendChild(el('span', { class: 'aa-tag', text: state.profile[row.key] ? '页面未匹配' : '资料缺数据' }));
      }
      const inputRow = el('div', { class: 'aa-missing-input' });
      const isLong = row.kind === 'key' && isTextareaKey(row.key);
      const input = isLong ? el('textarea', { class: 'aa-input' }) : el('input', { class: 'aa-input', type: 'text' });
      if (row.kind === 'key' && state.profile && state.profile[row.key]) input.value = String(state.profile[row.key]);
      const btn = el('button', { class: 'aa-btn aa-primary', text: '保存并填入' });
      btn.addEventListener('click', async () => {
        const value = String(input.value || '').trim();
        if (!value) return;
        btn.disabled = true;
        const payload =
          row.kind === 'key'
            ? { values: { [row.key]: value } }
            : { custom: { [row.label]: value } };
        const res = await sendMessage({ type: 'overrides:set', ...payload });
        if (res && res.ok) {
          state.profile = res.profile;
          pushLog(`已保存「${row.label}」并尝试填入页面`, 'aa-ok');
          await refillOne(row, value);
          state.pendingMissing = (state.pendingMissing || []).filter((r) => r !== row);
          renderMissing();
          renderStatus();
        } else {
          pushLog(`保存失败：${(res && res.error) || '未知错误'}`, 'aa-error');
        }
        btn.disabled = false;
      });
      inputRow.append(input, btn);
      box.append(headLine, inputRow);
      wrap.appendChild(box);
    }
  }

  function isTextareaKey(key) {
    const spec = state.spec;
    if (!spec) return false;
    const f = spec.fields.find((x) => x.key === key);
    return Boolean(f && f.type === 'textarea');
  }

  async function refillOne(row, value) {
    const target = row.kind === 'key' ? { key: row.key, label: row.label } : { label: row.label };
    const id = `one-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await handleFillOne({ target, value });
    postToChildren({ channel: CHANNEL, type: 'fill:one', id, target, value, frameId: row.frameId || '', hop: 0 }, 0);
  }

  function renderReport() {
    const report = state.lastReport;
    if (!report) {
      renderStatus();
      renderMissing();
      return;
    }
    const parts = [`已填写 ${report.filled.length} 项`];
    if (report.existing.length) parts.push(`页面已有内容 ${report.existing.length} 项（勾选“覆盖页面已有内容”可重填）`);
    if (report.noData.length) parts.push(`资料缺数据 ${report.noData.length} 项`);
    if (report.unknown.length) parts.push(`未识别必填项 ${report.unknown.length} 项`);
    if (report.failed.length) parts.push(`填写失败 ${report.failed.length} 项`);
    parts.push(`（扫描 ${report.scanned} 个控件，识别 ${report.matched} 个）`);
    setStatus(parts.join('　|　'), report.filled.length ? 'aa-ok' : '');
    renderStatus();
    renderMissing();
  }

  function renderBadge() {
    if (!ui) return;
    const rows = state.pendingMissing || [];
    if (rows.length) {
      ui.badge.style.display = 'block';
      ui.badge.textContent = String(rows.length);
    } else {
      ui.badge.style.display = 'none';
    }
  }

  function renderPanel() {
    if (!ui) return;
    renderFiles();
    renderActions();
    renderStatus();
    renderLog();
    renderMissing();
    renderBadge();
  }

  async function uploadFile(slot, file) {
    setStatus(`正在读取并解析《${file.name}》…`);
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
      reader.readAsDataURL(file);
    }).catch((err) => {
      pushLog(`读取失败：${err.message}`, 'aa-error');
      return '';
    });
    if (!dataUrl) return;
    const res = await sendMessage({
      type: 'file:upload',
      slot,
      name: file.name,
      mime: file.type,
      size: file.size,
      dataUrl,
    });
    applyStatus(res);
    if (res && res.ok) {
      const doc = (res.profileMeta && res.profileMeta.docs || []).find((d) => d.slot === slot);
      if (doc && doc.ok === false) pushLog(`解析失败：${doc.error}`, 'aa-error');
      else pushLog(`已保存并解析《${file.name}》，${doc && doc.chars ? `提取 ${doc.chars} 字` : ''}`, 'aa-ok');
    } else {
      pushLog(`保存失败：${(res && res.error) || '未知错误'}`, 'aa-error');
    }
  }

  function applyStatus(res) {
    if (!res || !res.ok) {
      setStatus(`操作失败：${(res && res.error) || '未知错误'}`, 'aa-error');
      return;
    }
    state.fileStates = res.fileStates || state.fileStates;
    state.profileMeta = res.profileMeta || state.profileMeta;
    state.settings = res.settings || state.settings;
    if (res.changed) {
      pushLog('检测到资料文件变化，已自动重新解析', 'aa-ok');
      refreshFromBackground();
    }
    const counts = res.counts || {};
    setStatus(
      `资料已就绪：已识别 ${counts.filled || 0} 项字段${counts.overrides ? `，手动补充 ${counts.overrides} 项` : ''}${counts.custom ? `，页面专有字段 ${counts.custom} 项` : ''}`,
      'aa-ok',
    );
    renderPanel();
  }

  let refreshTimer = null;
  async function refreshFromBackground() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
    }, 700);
    const res = await sendMessage({ type: 'profile:get' });
    if (!res || !res.ok) return;
    const prevParsed = state.profileMeta && state.profileMeta.parsedAt;
    state.spec = res.spec || state.spec;
    state.profile = res.profile;
    state.settings = res.settings || state.settings;
    state.fileStates = res.fileStates || state.fileStates;
    state.profileMeta = res.profileMeta || state.profileMeta;
    if (prevParsed && state.profileMeta && state.profileMeta.parsedAt !== prevParsed) {
      pushLog('文件已更新，资料自动重新识别完成', 'aa-ok');
    }
    if (IS_TOP) renderPanel();
  }

  function scanControlCount() {
    try {
      return collectControls().length;
    } catch (e) {
      return 0;
    }
  }

  /* ------------------------------ 初始化 ------------------------------ */

  async function init() {
    const res = await sendMessage({ type: 'profile:get' });
    if (res && res.ok) {
      state.spec = res.spec;
      state.profile = res.profile;
      state.settings = res.settings || {};
      state.fileStates = res.fileStates || null;
      state.profileMeta = res.profileMeta || null;
    } else if (res && res.error) {
      state.statusText = `初始化失败：${res.error}`;
    }
    state.controlCount = scanControlCount();
    if (!IS_TOP) return;
    ensurePanel();
    state.statusText =
      state.profile && Object.keys(state.profile).length > 3
        ? `资料已就绪（${(res && res.counts && res.counts.filled) || 0} 项字段）`
        : '尚未加载资料文件：请上传信息文档与简历，或把文件放进插件 data/ 目录';
    if (state.settings.panelPosition) {
      const { left, top } = state.settings.panelPosition;
      ui.root.style.left = `${left}px`;
      ui.root.style.top = `${top}px`;
      ui.root.style.right = 'auto';
      ui.root.style.transform = 'none';
    }
    if (state.settings.panelOpen === false) ui.panel.classList.add('aa-hidden');
    renderPanel();
    pushLog('插件已就绪，点击「开始填写」自动填写当前页面表单');
    // 观察 body 被替换/页面被清空的情况，保持悬浮窗存在
    const mo = new MutationObserver(() => {
      if (ui && !document.documentElement.contains(ui.host)) {
        (document.body || document.documentElement).appendChild(ui.host);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: false });
    window.addEventListener('resize', () => {
      if (!ui) return;
      const rect = ui.root.getBoundingClientRect();
      if (rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
        ui.root.style.left = 'auto';
        ui.root.style.top = '50%';
        ui.root.style.right = '18px';
        ui.root.style.transform = 'translateY(-50%)';
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'panel:toggle' && IS_TOP) {
      const u = ensurePanel();
      u.root.style.display = '';
      togglePanel(u.panel.classList.contains('aa-hidden'));
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.profile || changes.profileMeta || changes.uploads || changes.settings || changes.overrides || changes.customFields) {
      refreshFromBackground();
    }
  });

  init();
})();
