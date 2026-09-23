import { GROUP_LABELS } from './lib/fields.js';

const state = { spec: null, profile: null, settings: {}, fileStates: {}, profileMeta: null, dirty: {} };

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false });
    });
  });
}

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function humanSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadAll() {
  const res = await sendMessage({ type: 'profile:get' });
  if (!res || !res.ok) {
    toast(`加载失败：${(res && res.error) || '未知错误'}`);
    return;
  }
  state.spec = res.spec;
  state.profile = res.profile || {};
  state.settings = res.settings || {};
  state.fileStates = res.fileStates || {};
  state.profileMeta = res.profileMeta || null;
  state.overrides = res.overrides || {};
  state.customFields = res.customFields || {};
  renderFiles();
  renderCounts();
  renderFields();
  renderCustomFields();
  fillJson();
}

function renderFiles() {
  const wrap = document.getElementById('files');
  wrap.textContent = '';
  const docs = (state.profileMeta && state.profileMeta.docs) || [];
  const defs = [
    { slot: 'info', title: '网申信息文档（Word）', accept: '.docx,.doc,.txt,.md' },
    { slot: 'resume', title: '简历（PDF）', accept: '.pdf,.docx,.doc,.txt,.md' },
  ];
  for (const def of defs) {
    const st = state.fileStates[def.slot] || {};
    const doc = docs.find((d) => d.slot === def.slot);
    const row = document.createElement('div');
    row.className = 'row';
    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${def.title}：${st.name || '未加载'} ${st.origin === 'upload' ? '（插件内上传）' : st.exists ? '（data/ 目录）' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [];
    if (st.exists) bits.push(humanSize(st.size));
    if (doc && doc.chars) bits.push(`提取 ${doc.chars} 字`);
    if (doc && doc.pageCount) bits.push(`${doc.pageCount} 页`);
    if (st.updatedAt) bits.push(`更新于 ${fmtTime(st.updatedAt)}`);
    if (doc && doc.ok === false) bits.push(`解析失败：${doc.error}`);
    if (doc && doc.warning === 'pdf_no_text') bits.push('未提取到文字（可能是扫描件）');
    meta.textContent = bits.join(' · ') || '未找到文件';
    grow.append(name, meta);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = def.accept;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(file);
      });
      toast('正在解析…');
      const r = await sendMessage({ type: 'file:upload', slot: def.slot, name: file.name, mime: file.type, size: file.size, dataUrl });
      if (r && r.ok) {
        toast('已保存并解析');
        await loadAll();
      } else {
        toast(`失败：${(r && r.error) || '未知错误'}`);
      }
      fileInput.value = '';
    });
    const btn = document.createElement('button');
    btn.textContent = st.exists ? '替换文件' : '上传文件';
    btn.addEventListener('click', () => fileInput.click());
    const btnDefault = document.createElement('button');
    btnDefault.textContent = '改用目录文件';
    btnDefault.addEventListener('click', async () => {
      const r = await sendMessage({ type: 'file:clear', slot: def.slot });
      if (r && r.ok) {
        toast('已切回 data/ 目录文件');
        await loadAll();
      }
    });
    row.append(grow, btn, btnDefault, fileInput);
    wrap.appendChild(row);
  }
  const hint = document.createElement('div');
  hint.className = 'hint';
  const meta = state.profileMeta || {};
  hint.textContent = `最近解析：${fmtTime(meta.parsedAt)}${meta.error ? `　⚠ ${meta.error}` : ''}`;
  wrap.appendChild(hint);
}

function renderCounts() {
  const wrap = document.getElementById('counts');
  wrap.textContent = '';
  const total = state.spec ? state.spec.fields.length : 0;
  const filled = state.spec ? state.spec.fields.filter((f) => state.profile[f.key]).length : 0;
  const chips = [
    ['已识别字段', filled, filled ? 'ok' : ''],
    ['可填写字段总数', total, ''],
    ['手动补充字段', Object.keys(state.overrides || {}).length, 'warn'],
    ['页面专有字段', Object.keys(state.customFields || {}).length, 'warn'],
    ['手动覆盖优先', state.settings.preferUpload === false ? '目录文件' : '插件内上传', ''],
  ];
  for (const [label, value, cls] of chips) {
    const chip = document.createElement('span');
    chip.className = `chip ${cls}`;
    chip.textContent = `${label}：${value}`;
    wrap.appendChild(chip);
  }
}

function renderFields() {
  const wrap = document.getElementById('fields');
  wrap.textContent = '';
  const groups = ['basic', 'contact', 'edu', 'exp', 'family', 'other'];
  for (const g of groups) {
    const fields = state.spec.fields.filter((f) => f.group === g);
    if (!fields.length) continue;
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = GROUP_LABELS[g] || g;
    wrap.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const f of fields) {
      const box = document.createElement('div');
      box.className = 'field';
      const label = document.createElement('label');
      label.textContent = f.label;
      const meta = state.profile._meta && state.profile._meta[f.key];
      if (meta && meta.source) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = meta.source;
        label.appendChild(tag);
      }
      if (state.overrides && state.overrides[f.key]) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '手动';
        label.appendChild(tag);
      }
      const long = f.type === 'textarea';
      const input = document.createElement(long ? 'textarea' : 'input');
      if (!long) input.type = 'text';
      const value = state.overrides && state.overrides[f.key] !== undefined ? state.overrides[f.key] : state.profile[f.key] || '';
      input.value = value;
      input.dataset.key = f.key;
      input.addEventListener('input', () => {
        state.dirty[f.key] = input.value;
        input.classList.add('dirty');
      });
      box.append(label, input);
      grid.appendChild(box);
    }
    wrap.appendChild(grid);
  }
}

function renderCustomFields() {
  const wrap = document.getElementById('customFields');
  wrap.textContent = '';
  const entries = Object.entries(state.customFields || {});
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = '暂无。当网申页面出现字典里没有的字段时，在悬浮窗里补充一次，就会记录在这里。';
    wrap.appendChild(empty);
    return;
  }
  for (const [label, value] of entries) {
    const row = document.createElement('div');
    row.className = 'row';
    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.dataset.custom = label;
    input.addEventListener('input', () => {
      state.dirtyCustom = state.dirtyCustom || {};
      state.dirtyCustom[label] = input.value;
      input.classList.add('dirty');
    });
    grow.append(name, input);
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await sendMessage({ type: 'overrides:set', removeCustom: [label] });
      toast('已删除');
      await loadAll();
    });
    row.append(grow, del);
    wrap.appendChild(row);
  }
}

function fillJson() {
  const data = { overrides: state.overrides || {}, customFields: state.customFields || {} };
  document.getElementById('json').value = JSON.stringify(data, null, 2);
}

async function saveDirty() {
  const values = { ...(state.dirty || {}) };
  const custom = { ...(state.dirtyCustom || {}) };
  if (!Object.keys(values).length && !Object.keys(custom).length) {
    toast('没有需要保存的修改');
    return;
  }
  const res = await sendMessage({ type: 'overrides:set', values, custom });
  if (res && res.ok) {
    state.dirty = {};
    state.dirtyCustom = {};
    toast('已保存，自动填写将优先使用这些内容');
    await loadAll();
  } else {
    toast(`保存失败：${(res && res.error) || '未知错误'}`);
  }
}

document.getElementById('saveAll').addEventListener('click', saveDirty);

document.getElementById('refresh').addEventListener('click', async () => {
  toast('正在重新读取 data/ 目录文件…');
  const res = await sendMessage({ type: 'files:refresh', force: true });
  if (res && res.ok) {
    toast(res.changed ? '已重新解析' : '文件未变化');
    await loadAll();
  } else {
    toast(`失败：${(res && res.error) || '未知错误'}`);
  }
});

document.getElementById('preferUpload').addEventListener('click', async () => {
  const res = await sendMessage({ type: 'file:prefer-source', preferUpload: true });
  if (res && res.ok) {
    toast('已设为优先使用插件内上传的文件');
    await loadAll();
  }
});

document.getElementById('resetOverrides').addEventListener('click', async () => {
  if (!confirm('确定清除全部手动修改（不影响 data/ 目录文件与已上传文件）？')) return;
  const res = await sendMessage({ type: 'overrides:set', removeOverrides: Object.keys(state.overrides || {}) });
  if (res && res.ok) {
    toast('已清除手动修改');
    await loadAll();
  }
});

document.getElementById('loadJson').addEventListener('click', fillJson);

document.getElementById('applyJson').addEventListener('click', async () => {
  try {
    const data = JSON.parse(document.getElementById('json').value);
    const res = await sendMessage({ type: 'overrides:set', values: data.overrides || {}, custom: data.customFields || {} });
    if (res && res.ok) {
      toast('已应用');
      await loadAll();
    } else {
      toast(`失败：${(res && res.error) || '未知错误'}`);
    }
  } catch (e) {
    toast(`JSON 格式错误：${e.message}`);
  }
});

document.getElementById('copyJson').addEventListener('click', async () => {
  const text = document.getElementById('json').value;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch (e) {
    toast('复制失败，请手动选择复制');
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveDirty();
  }
});

loadAll();
