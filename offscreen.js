/**
 * Offscreen document：负责解析 Word / PDF 并生成档案。
 * 放在这里而不是 service worker，是为了能用 DOM/Worker/大文件 API，且不受页面 CSP 影响。
 */
import { parseDocx, parsePlainText } from './lib/docx.js';
import { parsePdf } from './lib/pdftext.js';
import { buildProfile } from './lib/profile.js';

function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function looksLikeZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function looksLikePdf(bytes) {
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

async function parseOne(file) {
  const name = file.name || file.slot;
  const lower = String(name).toLowerCase();
  const bytes = base64ToBytes(file.base64);
  let parsed = null;
  if (lower.endsWith('.docx') || (lower.endsWith('.doc') && looksLikeZip(bytes))) {
    parsed = await parseDocx(bytes);
  } else if (lower.endsWith('.pdf') || looksLikePdf(bytes)) {
    parsed = await parsePdf(bytes);
  } else if (lower.endsWith('.doc')) {
    throw new Error('不支持旧版 .doc 格式，请在 Word 中另存为 .docx 后重新上传');
  } else {
    parsed = parsePlainText(new TextDecoder('utf-8').decode(bytes));
  }
  parsed.name = name;
  parsed.source = file.slot;
  return parsed;
}

async function handleParse(payload) {
  const files = payload.files || [];
  const docs = [];
  const fileReports = [];
  for (const file of files) {
    try {
      const parsed = await parseOne(file);
      docs.push(parsed);
      fileReports.push({
        slot: file.slot,
        name: file.name,
        ok: true,
        chars: (parsed.text || '').replace(/\s/g, '').length,
        lines: (parsed.lines || []).length,
        pageCount: parsed.pageCount || 0,
        emptyPages: parsed.emptyPages || 0,
        warning: parsed.warning || '',
      });
    } catch (err) {
      fileReports.push({ slot: file.slot, name: file.name, ok: false, error: String((err && err.message) || err) });
    }
  }
  const { profile, meta, warnings, stats } = buildProfile({
    docs,
    overrides: payload.overrides || {},
    customMappings: payload.customMappings || {},
  });
  return { ok: true, profile, meta, warnings, stats, docs: fileReports };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;
  if (msg.type === 'offscreen:ping') {
    sendResponse({ ok: true });
    return undefined;
  }
  if (msg.type === 'offscreen:parse') {
    handleParse(msg.payload || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  return undefined;
});
