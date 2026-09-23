/**
 * DOCX 解析：docx 本质是 zip，取出 word/document.xml 后按 <w:p> / <w:tbl> 顺序抽文本。
 * 依赖全局 JSZip（由 vendor/jszip.min.js 以 UMD 方式挂到 globalThis）。
 */
import '../vendor/jszip.min.js';

const TEXT_NS_TAGS = ['w:t', 'm:t', 'w:delText'];

function xmlUnescape(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 抽取一个段落 XML 的纯文本（含制表符与换行符） */
function paragraphText(pXml, wantSymbols = false) {
  let xml = pXml;
  // 删除域代码、批注、被删除的修订文本
  xml = xml.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '');
  xml = xml.replace(/<w:delText[\s\S]*?<\/w:delText>/g, '');
  xml = xml.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  xml = xml.replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n');
  let out = '';
  const re = /<(w:t|m:t|w:sym)\b([^>]*)>([\s\S]*?)<\/\1>|<(w:t|m:t)\b([^>]*)\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] === 'w:sym') continue;
    if (m[1] === undefined && m[4] === undefined) continue;
    const body = m[3] !== undefined ? m[3] : '';
    out += xmlUnescape(body);
  }
  if (wantSymbols) {
    // 复选框等符号：w:sym 的 char 属性
    const symRe = /<w:sym\b[^>]*w:char="([0-9A-Fa-f]+)"[^>]*\/>/g;
    let s;
    while ((s = symRe.exec(xml))) {
      const code = parseInt(s[1], 16);
      out += code === 0xf0fe ? '☑' : code === 0xf06f ? '☐' : '';
    }
  }
  return out.replace(/\u000b/g, '\n');
}

/** 在 xml 中从 startIndex 的 <tag 起，找到与之匹配的结束标签位置 */
function findMatchingEnd(xml, startIndex, tagName) {
  const openRe = new RegExp(`<${tagName}\\b`, 'g');
  const closeRe = new RegExp(`</${tagName}>`, 'g');
  let depth = 0;
  let i = startIndex;
  while (i < xml.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const o = openRe.exec(xml);
    const c = closeRe.exec(xml);
    if (!c) return -1;
    if (o && o.index < c.index) {
      depth += 1;
      i = o.index + o[0].length;
    } else {
      depth -= 1;
      i = c.index + c[0].length;
      if (depth === 0) return { end: c.index, next: i };
    }
  }
  return -1;
}

function parseTable(tableXml) {
  const rows = [];
  let ri = 0;
  while (true) {
    const rStart = tableXml.indexOf('<w:tr', ri);
    if (rStart === -1) break;
    const rEnd = findMatchingEnd(tableXml, rStart, 'w:tr');
    if (!rEnd || typeof rEnd === 'number') break;
    const rowXml = tableXml.slice(rStart, rEnd.next);
    const cells = [];
    let ci = 0;
    while (true) {
      const cStart = rowXml.indexOf('<w:tc', ci);
      if (cStart === -1) break;
      const cEnd = findMatchingEnd(rowXml, cStart, 'w:tc');
      if (!cEnd || typeof cEnd === 'number') break;
      const cellXml = rowXml.slice(cStart, cEnd.next);
      const pTexts = [];
      let pi = 0;
      while (true) {
        const pStart = cellXml.indexOf('<w:p', pi);
        if (pStart === -1) break;
        const pEnd = findMatchingEnd(cellXml, pStart, 'w:p');
        if (!pEnd || typeof pEnd === 'number') break;
        const t = paragraphText(cellXml.slice(pStart, pEnd.next)).replace(/\n+/g, ' ').trim();
        if (t) pTexts.push(t);
        pi = pEnd.next;
      }
      cells.push(pTexts.join(' ').trim());
      ci = cEnd.next;
    }
    if (cells.length) rows.push(cells);
    ri = rEnd.next;
  }
  return rows;
}

/** 主入口：解析 docx 的 ArrayBuffer/Uint8Array */
export async function parseDocx(input) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('JSZip 未加载，无法解析 docx');
  const zip = await JSZip.loadAsync(input);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('不是有效的 .docx 文件（缺少 word/document.xml）');
  const xml = await docFile.async('string');

  const paragraphs = [];
  const tables = [];
  let i = 0;
  while (i < xml.length) {
    const pStart = xml.indexOf('<w:p', i);
    const tStart = xml.indexOf('<w:tbl', i);
    let useTable = false;
    if (tStart !== -1 && (pStart === -1 || tStart < pStart)) useTable = true;
    else if (pStart === -1) break;

    if (useTable) {
      const tEnd = findMatchingEnd(xml, tStart, 'w:tbl');
      if (!tEnd || typeof tEnd === 'number') {
        i = tStart + 5;
        continue;
      }
      const rows = parseTable(xml.slice(tStart, tEnd.next));
      if (rows.length) tables.push(rows);
      i = tEnd.next;
    } else {
      const pEnd = findMatchingEnd(xml, pStart, 'w:p');
      if (!pEnd || typeof pEnd === 'number') {
        i = pStart + 4;
        continue;
      }
      const text = paragraphText(xml.slice(pStart, pEnd.next)).trim();
      if (text) paragraphs.push(text);
      i = pEnd.next;
    }
  }

  const lines = [];
  for (const p of paragraphs) {
    for (const piece of p.split('\n')) {
      const t = piece.trim();
      if (t) lines.push(t);
    }
  }
  const text = [...paragraphs, ...tables.flatMap((rows) => rows.map((r) => r.join('\t')))].join('\n');

  return { kind: 'docx', paragraphs, tables, lines, text };
}

/** 纯文本文件解析 */
export function parsePlainText(str) {
  const text = String(str || '').replace(/\r\n?/g, '\n');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return { kind: 'txt', paragraphs: lines, tables: [], lines, text };
}
