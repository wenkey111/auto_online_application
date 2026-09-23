/**
 * PDF 文字提取：使用本地打包的 pdf.js（vendor/pdf.min.mjs + pdf.worker.min.mjs）。
 * 按行聚合文本项，尽量还原简历的阅读顺序（适合中文简历）。
 */
import * as pdfjsLib from '../vendor/pdf.min.mjs';

function workerSrc() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
    }
  } catch (e) {
    /* ignore */
  }
  return new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc();

/** 把 pdf.js 的文本项聚合成行 */
function itemsToLines(items) {
  const rows = [];
  for (const item of items) {
    const str = item.str === undefined || item.str === null ? '' : String(item.str);
    const tr = item.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4];
    const y = tr[5];
    const size = Math.abs(tr[3]) || Math.abs(tr[0]) || 10;
    const tol = Math.max(1.6, size * 0.45);
    let row = rows.find((r) => Math.abs(r.y - y) <= tol && !r.closed);
    if (!row) {
      row = { y, size, items: [], eol: false, closed: false, pendingSpace: false };
      rows.push(row);
    }
    row.size = Math.max(row.size, size);
    if (!str.trim()) {
      // pdf.js 会把空格作为独立的文本项返回，这里记录成"下一个词前需要空格"
      if (str.length) row.pendingSpace = true;
      if (item.hasEOL) row.eol = true;
      continue;
    }
    row.items.push({ x, w: item.width || 0, str, spaceBefore: row.pendingSpace });
    row.pendingSpace = false;
    if (item.hasEOL) row.eol = true;
  }
  rows.sort((a, b) => b.y - a.y);
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let line = '';
    let prevEnd = null;
    for (const it of row.items) {
      const gap = prevEnd === null ? 0 : it.x - prevEnd;
      const prevChar = line.slice(-1);
      const nextChar = it.str[0] || '';
      const asciiBoundary = /[A-Za-z0-9)\]}%,.;:!?]/.test(prevChar) || /[A-Za-z0-9([{（]/.test(nextChar);
      const explicitSpace = it.spaceBefore && line && !/\s$/.test(line);
      const needSpace =
        explicitSpace || (prevEnd !== null && gap > Math.max(1, row.size * 0.14) && asciiBoundary && !/\s$/.test(line));
      if (needSpace) line += ' ';
      line += it.str;
      prevEnd = it.x + it.w;
    }
    const trimmed = line.replace(/\s+$/g, '');
    if (trimmed.trim()) lines.push(trimmed.trim());
    if (row.eol && lines.length) lines.push('');
  }
  // 去掉重复空行
  const out = [];
  for (const l of lines) {
    if (!l && out[out.length - 1] === '') continue;
    out.push(l);
  }
  return out.filter((l, idx) => l || (out[idx - 1] !== '' && out[idx + 1] !== ''));
}

/**
 * 解析 PDF
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{onProgress?:Function}} [opts]
 */
export async function parsePdf(input, opts = {}) {
  // 统一转成普通 Uint8Array（pdf.js 不接受 Buffer 之类的视图）
  const data = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength))
    : new Uint8Array(input);
  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
  }).promise;

  const pages = [];
  let emptyPages = 0;
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent({ includeMarkedContent: false });
    const lines = itemsToLines(content.items).filter((l) => l.trim());
    if (!lines.length) emptyPages += 1;
    pages.push({ index: p, lines, text: lines.join('\n') });
    if (typeof opts.onProgress === 'function') opts.onProgress(p, doc.numPages);
    page.cleanup();
  }
  const text = pages.map((p) => p.text).join('\n');
  let info = {};
  try {
    const meta = await doc.getMetadata();
    info = meta && meta.info ? { title: meta.info.Title || '', author: meta.info.Author || '' } : {};
  } catch (e) {
    info = {};
  }
  const pageCount = doc.numPages;
  await doc.destroy();

  return {
    kind: 'pdf',
    pageCount,
    pages,
    emptyPages,
    lines: pages.flatMap((p) => p.lines),
    tables: [],
    paragraphs: pages.flatMap((p) => p.lines),
    text,
    info,
    warning: emptyPages === pageCount ? 'pdf_no_text' : '',
  };
}
