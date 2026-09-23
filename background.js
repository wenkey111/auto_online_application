/**
 * Service worker：管理资料文件（插件目录 / 插件内上传）、变更检测、档案合成、各页面消息路由。
 */
import { AUTOCOMPLETE_MAP, FIELD_BY_KEY, FIELDS, VALUE_SYNONYMS, PROVINCES, fieldSpecForContent } from './lib/fields.js';
import { summarizeProfile } from './lib/profile.js';

const DEFAULT_MANIFEST = { info: 'info.docx', resume: 'resume.pdf' };
const DEFAULT_SETTINGS = {
  preferUpload: true,
  showPanel: true,
  panelOpen: true,
  overwriteFilled: false,
  panelCollapsed: false,
  panelPosition: null,
};

const KEYS = [
  'settings',
  'uploads',
  'overrides',
  'customFields',
  'baseProfile',
  'profile',
  'profileMeta',
  'panelState',
  'lastReport',
];

/* ------------------------------ 基础工具 ------------------------------ */

async function getState(keys = KEYS) {
  const data = await chrome.storage.local.get(keys);
  return data || {};
}

async function setState(obj) {
  await chrome.storage.local.set(obj);
}

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function dataUrlToBytes(dataUrl) {
  const b64 = String(dataUrl || '').replace(/^data:[^;]+;base64,/, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToDataUrl(bytes, mime) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`;
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/* ------------------------------ 文件读取 ------------------------------ */

async function readManifest() {
  try {
    const url = `${chrome.runtime.getURL('data/manifest.json')}?t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('manifest missing');
    const json = await res.json();
    return { ...DEFAULT_MANIFEST, ...(json || {}) };
  } catch (e) {
    return { ...DEFAULT_MANIFEST };
  }
}

async function fetchFolderFile(name) {
  if (!name) return null;
  try {
    const url = `${chrome.runtime.getURL(`data/${encodeURIComponent(name)}`)}?t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) return null;
    return { name, bytes: new Uint8Array(buf) };
  } catch (e) {
    return null;
  }
}

/** 取得某个资料位（info / resume）当前应当使用的文件 */
async function loadSlot(slot, uploads, settings, manifest) {
  const up = uploads && uploads[slot] ? uploads[slot] : null;
  const preferUpload = (settings && settings.preferUpload) !== false;
  if (up && up.dataUrl && preferUpload) {
    return { origin: 'upload', name: up.name || `${slot}`, bytes: dataUrlToBytes(up.dataUrl), updatedAt: up.updatedAt || 0 };
  }
  const folder = await fetchFolderFile(manifest[slot]);
  if (folder) return { origin: 'folder', name: folder.name, bytes: folder.bytes, updatedAt: 0 };
  if (up && up.dataUrl) {
    return { origin: 'upload', name: up.name, bytes: dataUrlToBytes(up.dataUrl), updatedAt: up.updatedAt || 0 };
  }
  return null;
}

/* ------------------------------ Offscreen 解析 ------------------------------ */

let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER', 'BLOBS'],
        justification: '解析本地的 Word 信息文档与 PDF 简历文本',
      });
    }
    // 等待脚本注册监听
    for (let i = 0; i < 25; i += 1) {
      const ok = await chrome.runtime.sendMessage({ type: 'offscreen:ping' }).catch(() => null);
      if (ok && ok.ok) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error('解析模块启动超时');
  })();
  try {
    await offscreenReady;
  } catch (e) {
    offscreenReady = null;
    throw e;
  }
  return offscreenReady;
}

let parsingInFlight = null;

/** 确保档案是最新的：文件内容（哈希）变化时自动重新解析 */
async function ensureProfile({ force = false, quiet = false } = {}) {
  if (parsingInFlight) return parsingInFlight;
  parsingInFlight = (async () => {
    const state = await getState(['settings', 'uploads', 'profileMeta', 'baseProfile', 'overrides', 'customFields']);
    const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
    const uploads = state.uploads || {};
    const manifest = await readManifest();

    const slots = ['info', 'resume'];
    const files = [];
    const hashes = {};
    const fileStates = {
      info: { name: '', origin: '', size: 0, loaded: false, exists: false },
      resume: { name: '', origin: '', size: 0, loaded: false, exists: false },
    };

    for (const slot of slots) {
      const loaded = await loadSlot(slot, uploads, settings, manifest);
      if (!loaded) {
        fileStates[slot].exists = false;
        continue;
      }
      const hash = await sha256Hex(loaded.bytes);
      hashes[slot] = hash;
      fileStates[slot] = {
        name: loaded.name,
        origin: loaded.origin,
        size: loaded.bytes.length,
        loaded: true,
        exists: true,
        hash,
        updatedAt: loaded.updatedAt || 0,
      };
      files.push({ slot, name: loaded.name, base64: bytesToBase64(loaded.bytes) });
    }

    const prevHashes = (state.profileMeta && state.profileMeta.hashes) || {};
    const changed =
      force ||
      !state.baseProfile ||
      slots.some((s) => (prevHashes[s] || '') !== (hashes[s] || ''));

    if (!changed) {
      return buildStatus(state.baseProfile, state.profileMeta, fileStates, settings, state.overrides || {}, state.customFields || {}, false);
    }

    let result = null;
    let error = '';
    if (files.length) {
      try {
        await ensureOffscreen();
        result = await chrome.runtime.sendMessage({
          type: 'offscreen:parse',
          payload: { files, overrides: {}, customMappings: {} },
        });
      } catch (e) {
        error = String((e && e.message) || e);
      }
    } else {
      error = '尚未找到资料文件';
    }

    if (result && result.ok) {
      const profileMeta = {
        hashes,
        parsedAt: Date.now(),
        docs: result.docs,
        stats: result.stats,
        warnings: result.warnings,
        error: '',
      };
      const composed = composeProfile(result.profile, state.overrides || {}, state.customFields || {});
      await setState({ baseProfile: result.profile, profileMeta, profile: composed });
      return buildStatus(result.profile, profileMeta, fileStates, settings, state.overrides || {}, state.customFields || {}, true);
    }

    const profileMeta = {
      hashes,
      parsedAt: Date.now(),
      docs: result && result.docs ? result.docs : [],
      stats: state.profileMeta ? state.profileMeta.stats : null,
      warnings: [],
      error: error || '解析失败',
    };
    await setState({ profileMeta });
    return buildStatus(state.baseProfile || null, profileMeta, fileStates, settings, state.overrides || {}, state.customFields || {}, false);
  })();

  try {
    return await parsingInFlight;
  } finally {
    parsingInFlight = null;
  }
}

/** 用户手动补充的内容覆盖在解析结果之上 */
function composeProfile(base, overrides, customFields) {
  const profile = { ...(base || {}) };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!FIELD_BY_KEY[key]) continue;
    if (value === '' || value === null || value === undefined) continue;
    profile[key] = value;
  }
  if (profile._meta && typeof profile._meta === 'object') profile._meta = { ...profile._meta };
  profile.customMappings = { ...(customFields || {}) };
  return profile;
}

async function buildStatus(base, profileMeta, fileStates, settings, overrides, customFields, changed) {
  const composed = composeProfile(base, overrides, customFields);
  const summary = base ? summarizeProfile(composed) : [];
  const overrideCount = Object.keys(overrides || {}).length;
  const customCount = Object.keys(customFields || {}).length;
  return {
    ok: true,
    changed: Boolean(changed),
    fileStates,
    profileMeta: profileMeta || null,
    settings,
    overrides,
    customFields,
    summary,
    counts: { filled: summary.length, overrides: overrideCount, custom: customCount, total: FIELDS.length },
  };
}

/* ------------------------------ 消息路由 ------------------------------ */

async function handleMessage(msg, sender) {
  const type = msg && msg.type;
  switch (type) {
    case 'state:get': {
      const status = await ensureProfile({});
      const state = await getState(['panelState', 'lastReport']);
      return { ...status, panelState: state.panelState || null, lastReport: state.lastReport || null };
    }
    case 'profile:get': {
      const status = await ensureProfile({});
      const state = await getState(['profile', 'baseProfile']);
      return {
        ...status,
        profile: status ? composeProfile(state.baseProfile, status.overrides, status.customFields) : null,
        spec: { fields: fieldSpecForContent(), synonyms: VALUE_SYNONYMS, provinces: PROVINCES, autocomplete: AUTOCOMPLETE_MAP },
      };
    }
    case 'files:refresh': {
      const status = await ensureProfile({ force: Boolean(msg.force) });
      return status;
    }
    case 'file:upload': {
      const { slot, name, dataUrl, mime, size } = msg || {};
      if (!slot || !dataUrl) return { ok: false, error: '缺少文件内容' };
      const state = await getState(['uploads', 'settings']);
      const uploads = { ...(state.uploads || {}) };
      uploads[slot] = {
        name: name || `${slot}`,
        mime: mime || '',
        size: size || dataUrl.length,
        dataUrl,
        updatedAt: Date.now(),
      };
      const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}), preferUpload: true };
      await setState({ uploads, settings });
      const status = await ensureProfile({ force: true });
      return { ...status, uploaded: slot };
    }
    case 'file:clear': {
      const state = await getState(['uploads']);
      const uploads = { ...(state.uploads || {}) };
      if (uploads[msg.slot]) delete uploads[msg.slot];
      await setState({ uploads });
      const status = await ensureProfile({ force: true });
      return { ...status, cleared: msg.slot };
    }
    case 'file:prefer-source': {
      const state = await getState(['settings']);
      const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}), preferUpload: msg.preferUpload !== false };
      await setState({ settings });
      const status = await ensureProfile({ force: true });
      return status;
    }
    case 'overrides:set': {
      const state = await getState(['overrides', 'customFields', 'baseProfile']);
      const overrides = { ...(state.overrides || {}) };
      const customFields = { ...(state.customFields || {}) };
      for (const [key, value] of Object.entries(msg.values || {})) {
        if (value === '' || value === null || value === undefined) delete overrides[key];
        else if (FIELD_BY_KEY[key]) overrides[key] = value;
      }
      for (const [label, value] of Object.entries(msg.custom || {})) {
        if (value === '' || value === null || value === undefined) delete customFields[label];
        else customFields[label] = value;
      }
      for (const key of msg.removeOverrides || []) delete overrides[key];
      for (const label of msg.removeCustom || []) delete customFields[label];
      const composed = composeProfile(state.baseProfile, overrides, customFields);
      await setState({ overrides, customFields, profile: composed });
      return { ok: true, overrides, customFields, profile: composed, summary: summarizeProfile(composed) };
    }
    case 'settings:set': {
      const state = await getState(['settings']);
      const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}), ...(msg.values || {}) };
      await setState({ settings });
      return { ok: true, settings };
    }
    case 'panel:state:set': {
      await setState({ panelState: msg.panelState || null });
      return { ok: true };
    }
    case 'report:save': {
      await setState({ lastReport: { ...(msg.report || {}), at: Date.now(), url: (sender && sender.tab && sender.tab.url) || '' } });
      return { ok: true };
    }
    case 'options:open': {
      chrome.runtime.openOptionsPage();
      return { ok: true };
    }
    case 'profile:blank': {
      return {
        ok: true,
        spec: { fields: fieldSpecForContent(), synonyms: VALUE_SYNONYMS, provinces: PROVINCES, autocomplete: AUTOCOMPLETE_MAP },
      };
    }
    default:
      return { ok: false, error: `未知消息类型: ${type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type && String(msg.type).startsWith('offscreen:'))) return undefined;
  handleMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'panel:toggle' });
  } catch (e) {
    /* 页面上没有内容脚本时忽略 */
  }
});

async function bootstrap() {
  const state = await getState(['settings']);
  if (!state.settings) await setState({ settings: { ...DEFAULT_SETTINGS } });
  ensureProfile({}).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap();
});

bootstrap();
