/** 文本处理工具：清洗、断行、日期解析与格式化、取值校验。 */

export function toHalfWidth(s) {
  if (!s) return '';
  return String(s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

export function squeeze(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u2007\u200b]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

export function stripBullets(line) {
  return String(line || '').replace(/^\s*(?:[-–—•·●○◆◇■□▪▫*※▶▪]|\d+[.、)）]|[（(]\d+[)）])\s*/, '');
}

/** 文本按行切分，去掉空行与纯装饰行 */
export function toLines(text) {
  const raw = squeeze(text).split('\n');
  const out = [];
  for (const line of raw) {
    const t = line.replace(/\t/g, ' | ').trim();
    if (!t) continue;
    if (/^[\-–—_=*·•。.,，、\s|]+$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

export function isLikelyEmail(v) {
  return /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(String(v || '').trim());
}

export function isLikelyMobile(v) {
  return /^1[3-9]\d{9}$/.test(String(v || '').replace(/[^\d]/g, ''));
}

export function isLikelyIdCard(v) {
  return /^\d{17}[\dXx]$/.test(String(v || '').trim());
}

export function onlyDigits(v) {
  return String(v || '').replace(/[^\d]/g, '');
}

/**
 * 解析日期/年月，返回 { value, precision }
 * value 规范化为 YYYY / YYYY-MM / YYYY-MM-DD
 * 例："1999年8月" -> {value:'1999-08', precision:'month'}
 */
export function parseDateParts(input) {
  if (!input && input !== 0) return null;
  const t = toHalfWidth(String(input)).replace(/\s/g, '');
  let m = t.match(/(19|20)(\d{2})[年\-/.](\d{1,2})[月\-/.](\d{1,2})[日号]?/);
  if (m) {
    const [y, mo, d] = [Number(m[1] + m[2]), Number(m[3]), Number(m[4])];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { value: `${y}-${pad2(mo)}-${pad2(d)}`, precision: 'day', year: y, month: mo, day: d };
    }
  }
  m = t.match(/(19|20)(\d{2})[年\-/.](\d{1,2})[月]?/);
  if (m) {
    const y = Number(m[1] + m[2]);
    const mo = Number(m[3]);
    if (mo >= 1 && mo <= 12) return { value: `${y}-${pad2(mo)}`, precision: 'month', year: y, month: mo };
  }
  m = t.match(/(19|20)(\d{2})[年]?/);
  if (m) {
    const y = Number(m[1] + m[2]);
    if (y >= 1900 && y <= 2100) return { value: String(y), precision: 'year', year: y };
  }
  return null;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 把规范化日期按目标格式输出 */
export function formatDate(value, pattern) {
  const parsed = typeof value === 'object' && value ? value : parseDateParts(value);
  if (!parsed) return '';
  const { year, month, day } = parsed;
  switch (pattern) {
    case 'yyyy-MM':
      return month ? `${year}-${pad2(month)}` : String(year);
    case 'yyyy年MM月dd日':
      return day ? `${year}年${pad2(month)}月${pad2(day)}日` : month ? `${year}年${pad2(month)}月` : `${year}年`;
    case 'yyyy年MM月':
      return month ? `${year}年${pad2(month)}月` : `${year}年`;
    case 'yyyy/MM/dd':
      return day ? `${year}/${pad2(month)}/${pad2(day)}` : month ? `${year}/${pad2(month)}` : String(year);
    case 'yyyy.MM':
      return month ? `${year}.${pad2(month)}` : String(year);
    case 'yyyy':
      return String(year);
    case 'yyyy-MM-dd':
    default:
      return day ? `${year}-${pad2(month)}-${pad2(day)}` : month ? `${year}-${pad2(month)}` : String(year);
  }
}

/** 依据输入框类型/占位符/标签推断日期格式 */
export function guessDatePattern({ inputType, placeholder, label, value }) {
  const ph = toHalfWidth(placeholder || '').toLowerCase();
  const lb = toHalfWidth(label || '');
  if (inputType === 'month') return 'yyyy-MM';
  if (inputType === 'date') return 'yyyy-MM-dd';
  if (inputType === 'week' || inputType === 'time') return '';
  if (/年\/月\/日|yyyy\/mm\/dd/.test(ph)) return 'yyyy/MM/dd';
  if (/年-月-日|yyyy-mm-dd/.test(ph)) return 'yyyy-MM-dd';
  if (/yyyy年mm月dd日/.test(ph)) return 'yyyy年MM月dd日';
  if (/yyyy年mm月/.test(ph)) return 'yyyy年MM月';
  if (/yyyy\.mm/.test(ph)) return 'yyyy.MM';
  if (/yyyy\/mm/.test(ph)) return 'yyyy-MM';
  if (/年月日/.test(lb) || /出生日期|入学日期|毕业日期|日期/.test(lb)) return 'yyyy-MM-dd';
  if (/年月|出生年月|毕业年月/.test(lb)) return 'yyyy-MM';
  if (parsed_precision_ok(value)) return 'yyyy-MM-dd';
  return 'yyyy-MM';
}

function parsed_precision_ok(value) {
  const p = parseDateParts(value);
  return Boolean(p && p.precision === 'day');
}

/** 从一段文本里寻找日期区间，如 2019.09-2023.06 */
export function findDateRange(text) {
  const t = toHalfWidth(String(text || ''));
  const re =
    /((?:19|20)\d{2}\s*[年\-/.]?\s*\d{0,2}\s*月?)\s*(?:-|–|—|~|～|至|到|—)\s*((?:19|20)\d{2}\s*[年\-/.]?\s*\d{0,2}\s*月?|至今|现在|今|now|present)/gi;
  const m = re.exec(t);
  if (!m) return null;
  const startRaw = m[1];
  const endRaw = /至今|现在|今|now|present/i.test(m[2]) ? '至今' : m[2];
  const start = parseDateParts(startRaw);
  const end = endRaw === '至今' ? { value: '至今', precision: 'now' } : parseDateParts(endRaw);
  if (!start) return null;
  return {
    raw: m[0].trim(),
    start: start.value,
    end: end ? end.value : '',
    ongoing: endRaw === '至今',
  };
}

/** 中文文本里判断某行是否像"学校" */
export function looksLikeSchool(text) {
  return /(大学|学院|學校|学校|高中|中学|职业技术|师范|研究院|研究所)/.test(text);
}

export function looksLikeCompany(text) {
  return /(公司|集团|银行|事务所|研究院|研究所|中心|医院|学校|事业部|科技|有限|股份|局|厂|工作室)/.test(text);
}

export function looksLikePosition(text) {
  return /(工程师|实习|助理|专员|经理|主管|总监|顾问|教师|研究员|设计师|程序员|分析师|运营|销售|会计|文员|技术员|律师|医师|护士|技师|班长|部长|组长|主席|委员|干事|负责)/.test(
    text,
  );
}

/** 去重（按规范化后的值） */
export function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** 把多行文本压成一个值（用于 textarea 类字段） */
export function joinBlocks(lines) {
  return lines
    .map((l) => String(l || '').trim())
    .filter(Boolean)
    .join('\n');
}

/** 清洗从文档里提取到的值：去掉页码、装饰符等 */
export function scrubValue(v) {
  let t = String(v || '').trim();
  t = t.replace(/\s*\|\s*/g, ' ');
  t = t.replace(/^[|:：\s]+/, '');
  t = t.replace(/^(?:无|暂无|没有)$/g, '无');
  return t.trim();
}

export const CN_NUM = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 中文数字（1-99）转阿拉伯数字，用于"三/四"等字段值 */
export function cnToNumber(s) {
  const t = String(s || '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (!/^[零一二三四五六七八九十]+$/.test(t)) return null;
  if (t === '十') return 10;
  if (t.length === 1) return CN_NUM[t];
  const idx = t.indexOf('十');
  if (idx === -1) return null;
  const tens = idx === 0 ? 1 : CN_NUM[t[idx - 1]];
  const ones = idx === t.length - 1 ? 0 : CN_NUM[t[idx + 1]];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}
