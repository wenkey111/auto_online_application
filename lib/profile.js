/**
 * 档案抽取引擎：把「信息文档」与「简历」的文本合并成统一的个人资料对象。
 * 优先使用「标签: 值」结构（信息表最常见），再用正则与章节启发式补全。
 */
import {
  FIELDS,
  FIELD_BY_KEY,
  blankProfile,
  cleanValue,
  isFieldValueToken,
  matchLabel,
  normalizeLabel,
  PROVINCES,
} from './fields.js';
import {
  toHalfWidth,
  parseDateParts,
  formatDate,
  findDateRange,
  looksLikeSchool,
  looksLikeCompany,
  looksLikePosition,
  scrubValue,
  joinBlocks,
} from './textutil.js';

const DEGREE_RANK = {
  博士研究生: 5,
  博士: 5,
  硕士研究生: 4,
  硕士: 4,
  研究生: 4,
  本科: 3,
  大学本科: 3,
  学士: 3,
  大专: 2,
  专科: 2,
  高职: 2,
  中专: 1,
  高中: 1,
};

const DEGREE_PATTERN = /博士研究生|硕士研究生|博士|硕士|大学本科|本科|大专|专科|高职|中专|高中/g;

const ETHNICITIES = [
  '汉族', '壮族', '满族', '回族', '苗族', '维吾尔族', '土家族', '彝族', '蒙古族', '藏族',
  '布依族', '侗族', '瑶族', '朝鲜族', '白族', '哈尼族', '哈萨克族', '黎族', '傣族', '畲族',
  '傈僳族', '仡佬族', '东乡族', '高山族', '拉祜族', '水族', '佤族', '纳西族', '羌族', '土族',
  '仫佬族', '锡伯族', '柯尔克孜族', '达斡尔族', '景颇族', '毛南族', '撒拉族', '布朗族', '塔吉克族',
  '阿昌族', '普米族', '鄂温克族', '怒族', '京族', '基诺族', '德昂族', '保安族', '俄罗斯族',
  '裕固族', '乌孜别克族', '门巴族', '鄂伦春族', '独龙族', '赫哲族', '高山', '珞巴族', '塔塔尔族',
];

const SECTION_DEFS = [
  { key: 'eduExperience', title: '教育经历', kind: 'education', re: /^(教育经历|教育背景|学习经历|主要学习经历|学历经历|教育情况|教育与培训经历)/ },
  { key: 'internship', title: '实习经历', kind: 'work', re: /^(实习经历|实习经验|实习情况|实习经历及收获|实习)/ },
  { key: 'workExperience', title: '工作经历', kind: 'work', re: /^(工作经历|工作经验|工作履历|任职经历|职业经历)/ },
  { key: 'projectExperience', title: '项目经历', kind: 'project', re: /^(项目经历|项目经验|主要项目|参与项目|科研项目)/ },
  { key: 'campusExperience', title: '校园经历', kind: 'text', re: /^(校园经历|在校经历|学生工作|学生干部|社团经历|校园活动|校内实践)/ },
  { key: 'socialPractice', title: '社会实践', kind: 'text', re: /^(社会实践|志愿服务|志愿经历|公益活动|社会活动)/ },
  { key: 'trainingExperience', title: '培训经历', kind: 'text', re: /^(培训经历|受训经历|培训情况)/ },
  { key: 'paperPatent', title: '论文专利', kind: 'text', re: /^(论文|专利|科研成果|发表论文|科研经历|学术成果)/ },
  { key: 'awards', title: '获奖情况', kind: 'text', re: /^(获奖情况|获奖经历|获奖项|荣誉奖励|所获奖励|奖励情况|奖项|荣誉|奖学金|获奖及荣誉)/ },
  { key: 'skills', title: '专业技能', kind: 'text', re: /^(专业技能|技能特长|技能证书|技能与特长|技能|计算机技能|专业能力)/ },
  { key: 'certificates', title: '资格证书', kind: 'text', re: /^(资格证书|证书情况|已获证书|证书)/ },
  { key: 'selfEvaluation', title: '自我评价', kind: 'text', re: /^(自我评价|自我介绍|个人简介|个人评价|自我鉴定|个人优势|自我描述|个人情况介绍)/ },
  { key: 'hobbies', title: '兴趣爱好', kind: 'text', re: /^(兴趣爱好|业余爱好|兴趣|爱好)/ },
  { key: 'familyMembers', title: '家庭成员', kind: 'family', re: /^(家庭成员|家庭主要成员|家庭情况|家庭基本情况)/ },
  { key: 'foreignLanguage', title: '外语水平', kind: 'text', re: /^(外语水平|外语能力|英语水平|语言能力)/ },
];

const LIST_KEYS = new Set(['educationList', 'workList', 'projectList']);

const LABEL_MIN_SCORE = 100;

function isLabelLike(text, minScore = LABEL_MIN_SCORE) {
  const t = cleanValue(text);
  if (!t || t.length > 20) return false;
  if (isFieldValueToken(t)) return false;
  if (/^\d/.test(t)) return false;
  return Boolean(matchLabel(t, minScore));
}

/** 值里可能内嵌了下一个「标签：值」（PDF 常把一行压成一段），在这里拆开 */
function splitEmbeddedLabels(value) {
  const marks = [];
  const re = /[：:]/g;
  let m;
  while ((m = re.exec(value))) {
    const colonIdx = m.index;
    let start = colonIdx;
    while (start > 0 && colonIdx - start < 20) {
      const ch = value[start - 1];
      if (/[\s：:，,。;；、]/.test(ch)) break;
      start -= 1;
    }
    if (start >= colonIdx) continue;
    const cand = cleanValue(value.slice(start, colonIdx));
    if (!cand || cand.length > 20) continue;
    if (!isLabelLike(cand)) continue;
    if (marks.some((mk) => mk.index === start)) continue;
    marks.push({ index: start, label: cand, len: colonIdx - start + 1 });
  }
  if (!marks.length) return [];
  const out = [];
  const head = cleanValue(value.slice(0, marks[0].index));
  if (head) out.push({ label: null, value: head });
  for (let i = 0; i < marks.length; i += 1) {
    const cur = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].index : value.length;
    const seg = cleanValue(value.slice(cur.index + cur.len, end));
    if (!seg) continue;
    if (isLabelLike(cur.label)) out.push({ label: cur.label, value: seg });
    else out.push({ label: null, value: seg });
  }
  return out;
}

/** 从一行文本里取所有「标签：值」 */
function pairsFromLine(line) {
  // 注意：先按原始空白切分，避免 cleanValue 把多空格/全角空格压成单空格后无法分段
  const rawLine = String(line).replace(/\t/g, ' ').replace(/\u3000/g, ' ');
  if (!rawLine.trim() || rawLine.length > 600) return [];
  const segments = [];
  for (const coarse of rawLine.split(/\s{2,}|[|｜]/)) {
    // 分号只在后面跟着「标签：」时才作为分隔，避免把一句话拆断
    const parts = coarse.split(/[；;]/);
    let buf = parts.shift() || '';
    for (const part of parts) {
      const m = part.match(/^(.{1,20}?)\s*[：:]/);
      if (m && isLabelLike(m[1])) {
        segments.push(cleanValue(buf));
        buf = part;
      } else {
        buf = `${buf}；${part}`;
      }
    }
    segments.push(cleanValue(buf));
  }
  const raw = [];
  for (const seg of segments) {
    const m = seg.match(/^(.{1,20}?)\s*[：:]\s*(.*)$/);
    if (m) {
      raw.push({ label: cleanValue(m[1]), value: cleanValue(m[2]) });
      continue;
    }
    const m2 = seg.match(/^(.{2,14}?)\s+(.+)$/);
    if (m2 && isLabelLike(m2[1])) {
      raw.push({ label: cleanValue(m2[1]), value: cleanValue(m2[2]) });
      continue;
    }
    raw.push({ label: null, value: seg });
  }
  const out = [];
  for (const item of raw) {
    if (!item.value) continue;
    if (!item.label) continue;
    if (item.value.length > 120 || /[：:]/.test(item.value)) {
      const parts = splitEmbeddedLabels(item.value);
      if (parts.length) {
        const head = parts.find((p) => p.label === null);
        const labelOk = isLabelLike(item.label);
        if (head && head.value && labelOk) out.push({ label: item.label, value: head.value });
        for (const p of parts) {
          if (p.label) out.push({ label: p.label, value: p.value });
        }
        continue;
      }
    }
    if (isLabelLike(item.label)) out.push({ label: item.label, value: item.value });
  }
  return out;
}

/** 表格行：相邻单元格配对（跳过表头与取值型单元格） */
function pairsFromCells(rawCells) {
  const cells = rawCells.map((c) => cleanValue(c));
  const labelFlags = cells.map((c) => isLabelLike(c));
  const nonEmpty = cells.filter(Boolean).length;
  const labelCount = labelFlags.filter(Boolean).length;
  const out = [];
  if (!nonEmpty) return out;
  // 多个单元格都是字段名 -> 表头行
  if (labelCount >= 2 && cells.length > 2) return out;
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i];
    if (!cell) {
      i += 1;
      continue;
    }
    if (cells.length === 2 && labelFlags[0] && cells[1]) {
      out.push({ label: cells[0], value: cells[1] });
      break;
    }
    if (labelFlags[i] && i + 1 < cells.length && cells[i + 1] && !labelFlags[i + 1]) {
      const value = cells[i + 1];
      if (/[：:]/.test(value)) {
        const parts = splitEmbeddedLabels(value);
        const head = parts.find((p) => p.label === null);
        if (head && head.value) out.push({ label: cell, value: head.value });
        for (const p of parts) if (p.label) out.push({ label: p.label, value: p.value });
      } else {
        out.push({ label: cell, value });
      }
      i += 2;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 收集文档中的「标签-值」对（表格 + 文本行） */
export function collectPairs(doc) {
  const pairs = [];
  const tables = doc.tables || [];
  for (const rows of tables) {
    for (const rawCells of rows) {
      for (const p of pairsFromCells(rawCells)) {
        pairs.push({ ...p, source: 'table', raw: rawCells.join(' | ') });
      }
    }
  }
  for (const line of doc.lines || []) {
    for (const p of pairsFromLine(line)) {
      pairs.push({ ...p, source: 'line', raw: line });
    }
  }
  return pairs;
}

function isSectionHeading(line) {
  const t = cleanValue(line).replace(/[\s:：\-—_·•]+/g, '');
  if (!t || t.length > 18) return null;
  for (const def of SECTION_DEFS) {
    if (def.re.test(t)) return def;
  }
  return null;
}

/** 把文档切成章节块 */
export function splitSections(doc) {
  const lines = doc.lines || [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const def = isSectionHeading(line);
    if (def) {
      current = { def, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  // 章节内容过长时截断（避免把整份简历都算进一个章节）
  for (const s of sections) s.lines = s.lines.slice(0, 60);
  return sections;
}

function splitSegments(line) {
  return cleanValue(line)
    .split(/\s+|\t|\||｜|,|，|;|；|、/)
    .map((s) => cleanValue(s))
    .filter(Boolean);
}

/** 合并重复条目（同一条经历在不同来源出现时，互补字段） */
function mergeEntries(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!key.replace(/\|/g, '')) continue;
    if (!map.has(key)) {
      map.set(key, { ...item });
      continue;
    }
    const exist = map.get(key);
    for (const [k, v] of Object.entries(item)) {
      if ((exist[k] === '' || exist[k] === undefined || exist[k] === null) && v) exist[k] = v;
      else if (k === 'details' && Array.isArray(v) && Array.isArray(exist[k])) exist[k] = Array.from(new Set([...exist[k], ...v]));
    }
  }
  return Array.from(map.values());
}

function pickDegree(text) {
  const t = toHalfWidth(String(text || ''));
  let best = '';
  let rank = 0;
  const re = new RegExp(DEGREE_PATTERN.source, 'g');
  let m;
  while ((m = re.exec(t))) {
    const r = DEGREE_RANK[m[0]] || 0;
    if (r > rank) {
      rank = r;
      best = m[0];
    }
  }
  return best;
}

function pickSchool(parts) {
  for (const p of parts) {
    if (looksLikeSchool(p) && p.length <= 25) return p;
  }
  return '';
}

/** 从整行里用正则抓学校名（PDF 常把一行压成一段，没有空格分隔） */
function schoolFromText(text) {
  const m = String(text || '').match(/([\u4e00-\u9fa5]{2,18}?(?:大学|学院|学校|职业技术学院|高等专科学校|高中|中学))/);
  if (!m) return '';
  const name = m[1].replace(/^[一二三四五六七八九十]+、/, '');
  return name.length <= 25 ? name : '';
}

/** 去掉结尾的学历词，得到专业名 */
function stripDegreeWords(text) {
  let t = String(text || '').trim();
  for (let i = 0; i < 3; i += 1) {
    t = t.replace(/(博士研究生|硕士研究生|研究生|博士|硕士|大学本科|本科|大专|专科|高职|中专|高中)\s*$/, '').trim();
  }
  return t.replace(/[（(][^)）]*[)）]\s*$/, '').trim();
}

function majorFromText(text, school) {
  let rest = String(text || '');
  if (school) {
    const idx = rest.indexOf(school);
    if (idx >= 0) rest = rest.slice(idx + school.length);
  }
  const m = rest.match(
    /^\s*([\u4e00-\u9fa5A-Za-z]{2,20}?)(?=\s*(?:博士研究生|硕士研究生|研究生|博士|硕士|大学本科|本科|大专|专科|高职|中专|专业|学位|GPA|$))/,
  );
  if (!m) return '';
  const major = stripDegreeWords(m[1].replace(/^专业[:：]?/, ''));
  if (!major || major.length > 20) return '';
  if (/(排名|成绩|绩点|全日制|时间|学校|学院)/.test(major)) return '';
  return major;
}

function pickMajor(parts) {
  for (const p of parts) {
    if (/专业$/.test(p)) return p.replace(/专业$/, '');
    if (/^(专业方向|主修)/.test(p)) return p.replace(/^(专业方向|主修)[:：]?/, '');
  }
  return '';
}

/** 从「教育经历」章节里抽取结构化条目 */
function extractEducationEntries(lines) {
  const entries = [];
  let cur = null;
  const push = () => {
    if (cur && (cur.school || cur.major || cur.degree || cur.start)) entries.push(cur);
    cur = null;
  };
  for (const rawLine of lines) {
    const line = cleanValue(rawLine);
    if (!line) continue;
    const range = findDateRange(line);
    const segments = splitSegments(line);
    const degree = pickDegree(line);
    const school = pickSchool(segments) || schoolFromText(line);
    const major = pickMajor(segments) || majorFromText(line, school);
    const hasContent = Boolean(range || school || degree || major);
    if (range && (school || degree || major || segments.length >= 2)) {
      push();
      cur = {
        start: range.start,
        end: range.ongoing ? '至今' : range.end,
        rangeRaw: range.raw,
        school,
        major,
        degree,
        details: [],
      };
      const rest = segments.filter((s) => s !== school && s !== major && !pickDegree(s) && !/^\d{4}/.test(s) && !/[至到~-]/.test(s));
      if (rest.length) cur.details.push(rest.join(' '));
      continue;
    }
    if (!hasContent) {
      if (cur) cur.details.push(line);
      continue;
    }
    if (!cur) cur = { start: '', end: '', school: '', major: '', degree: '', details: [] };
    if (school && !cur.school) cur.school = school;
    if (major && !cur.major) cur.major = major;
    if (degree && !cur.degree) cur.degree = degree;
    const leftover = segments.filter((s) => s !== school && s !== major && !pickDegree(s));
    if (leftover.length) cur.details.push(leftover.join(' '));
  }
  push();
  return mergeEntries(
    entries.filter((e) => e.school || e.major || e.degree),
    (e) => `${e.school}|${e.major}|${e.degree}|${e.start}`,
  );
}

/** 从「工作/实习经历」章节里抽取结构化条目 */
function companyFromText(text) {
  const m = String(text || '').match(
    /([\u4e00-\u9fa5]{2,20}?(?:科技有限公司|股份有限公司|有限公司|集团|银行|事务所|研究院|研究所|分公司|公司|医院|学校|中心|工作室))/,
  );
  if (!m) return '';
  const name = m[1].replace(/^\d{4}[.\-/]?\d{0,2}[-–—~至]?\d{0,4}[.\-/]?\d{0,2}/, '');
  return name.length <= 30 ? name : '';
}

function positionFromText(text) {
  const m = String(text || '').match(
    /([\u4e00-\u9fa5]{2,12}?(?:实习生|工程师|助理|专员|经理|主管|总监|顾问|研究员|设计师|程序员|分析师|运营|销售|会计|教师|医师|技术员|律师))/,
  );
  return m ? m[1] : '';
}

function extractWorkEntries(lines) {
  const entries = [];
  let cur = null;
  const push = () => {
    if (cur && (cur.company || cur.position || cur.start)) entries.push(cur);
    cur = null;
  };
  for (const rawLine of lines) {
    const line = cleanValue(rawLine);
    if (!line) continue;
    const range = findDateRange(line);
    const segments = splitSegments(line);
    const company = segments.find((s) => looksLikeCompany(s) && !looksLikePosition(s) && s.length <= 30) || companyFromText(line);
    const position = segments.find((s) => looksLikePosition(s)) || positionFromText(line);
    if (range && (company || position)) {
      push();
      cur = {
        start: range.start,
        end: range.ongoing ? '至今' : range.end,
        rangeRaw: range.raw,
        company,
        position,
        details: [],
      };
      continue;
    }
    if (!company && !position) {
      if (cur) cur.details.push(line);
      continue;
    }
    if (!cur || cur.details.length > 6) {
      push();
      cur = { start: '', end: '', company, position, details: [] };
      continue;
    }
    if (company && !cur.company) cur.company = company;
    if (position && !cur.position) cur.position = position;
  }
  push();
  return mergeEntries(
    entries.filter((e) => e.company || e.position),
    (e) => `${e.company}|${e.position}|${e.start}`,
  );
}

/** 常见网申信息表：按表头解析经历表格 */
function parseExperienceTables(doc) {
  const eduList = [];
  const workList = [];
  for (const rows of doc.tables || []) {
    if (!rows.length) continue;
    for (let r = 0; r < rows.length; r += 1) {
      const header = rows[r].map((c) => normalizeLabel(c));
      const hasHeader = header.filter(Boolean).length >= 3;
      if (!hasHeader) continue;
      const idx = (label) => header.findIndex((h) => h && (h === label || h.includes(label)));
      const iStart = idx('起止时间') >= 0 ? idx('起止时间') : Math.max(idx('时间'), idx('起始时间'));
      const isEduTable = header.some((h) => h.includes('学校') || h.includes('专业') || h.includes('学历'));
      const isWorkTable = header.some((h) => h.includes('单位') || h.includes('公司') || h.includes('职位') || h.includes('岗位'));
      if (!isEduTable && !isWorkTable) continue;
      const iSchool = idx('学校') >= 0 ? idx('学校') : idx('院校');
      const iMajor = idx('专业');
      const iDegree = idx('学历') >= 0 ? idx('学历') : idx('学位');
      const iMode = idx('培养方式') >= 0 ? idx('培养方式') : idx('学习形式');
      const iCompany = idx('单位') >= 0 ? idx('单位') : idx('公司');
      const iRole = idx('职位') >= 0 ? idx('职位') : idx('岗位') >= 0 ? idx('岗位') : idx('职务');
      for (let k = r + 1; k < rows.length; k += 1) {
        const cells = rows[k].map((c) => cleanValue(c));
        if (!cells.length || cells.every((c) => !c)) continue;
        const timeCell = iStart >= 0 ? cells[iStart] : '';
        const range = findDateRange(timeCell || cells.join(' '));
        if (isEduTable) {
          const entry = {
            start: range ? range.start : '',
            end: range ? (range.ongoing ? '至今' : range.end) : '',
            school: iSchool >= 0 ? cells[iSchool] : '',
            major: iMajor >= 0 ? cells[iMajor] : '',
            degree: iDegree >= 0 ? cells[iDegree] : '',
            mode: iMode >= 0 ? cells[iMode] : '',
            details: [],
          };
          if (entry.school || entry.major || entry.degree) eduList.push(entry);
        } else {
          const entry = {
            start: range ? range.start : '',
            end: range ? (range.ongoing ? '至今' : range.end) : '',
            company: iCompany >= 0 ? cells[iCompany] : '',
            position: iRole >= 0 ? cells[iRole] : '',
            details: [],
          };
          if (entry.company || entry.position) workList.push(entry);
        }
      }
      break;
    }
  }
  return { eduList, workList };
}

const EMPTY_VALUES = new Set(['', '/', '-', '—', '无', '暂无', '没有', 'n/a', 'na', 'null', '未填写', '空']);

function isEmptyValue(v) {
  return EMPTY_VALUES.has(String(v || '').trim().toLowerCase());
}

const STRICT_KEYS = new Set([
  'name', 'surname', 'givenName', 'nameEn', 'phone', 'landline', 'email', 'idCard',
  'emergencyPhone', 'fatherPhone', 'motherPhone', 'school', 'major', 'degree', 'studentId',
]);

/** 这些字段一律是短值，过长说明抽取错了 */
const SHORT_KEYS = new Set([
  'name', 'surname', 'givenName', 'gender', 'maritalStatus', 'politicalStatus', 'ethnicity',
  'nationality', 'healthStatus', 'bloodType', 'school', 'major', 'degree', 'studyMode',
  'province', 'city', 'district', 'postalCode', 'schoolCity', 'schoolType', 'idCardType',
  'isFreshGraduate', 'acceptAdjustment', 'hasRelatives', 'referralSource', 'emergencyRelation',
  'expectedCity', 'cet4', 'cet6', 'computerLevel', 'hukouType', 'originPlace',
]);

function normalizeValueFor(key, value) {
  const field = FIELD_BY_KEY[key];
  let v = scrubValue(value);
  if (!field) return v;
  if (SHORT_KEYS.has(key) && v.length > 20) {
    if (key === 'province') {
      const hit = PROVINCES.find((p) => v.startsWith(p) || v.includes(p));
      if (hit) return hit;
    }
    return '';
  }
  if (field.format === 'mobile') {
    const digits = v.replace(/[^\d]/g, '');
    if (digits.length >= 11) return digits.slice(0, 11);
    return v;
  }
  if (field.format === 'email') {
    const m = v.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    return m ? m[0] : v;
  }
  if (key === 'idCard') return v.replace(/\s/g, '').toUpperCase();
  if (field.type === 'date') {
    const parts = parseDateParts(v);
    if (parts) return parts.value;
  }
  if (key === 'height' || key === 'weight' || key === 'age') {
    const m = v.match(/\d+(?:\.\d+)?/);
    return m ? m[0] : v;
  }
  if (key === 'name' || key === 'surname' || key === 'givenName' || key === 'fatherName' || key === 'motherName' || key === 'emergencyName') {
    return v.replace(/[\s\u00a0]/g, '');
  }
  return v;
}

function mergeScalar(profile, meta, key, rawValue, source, opts = {}) {
  const field = FIELD_BY_KEY[key];
  if (!field || LIST_KEYS.has(key)) return false;
  let value = normalizeValueFor(key, rawValue);
  if (!value) return false;
  if (STRICT_KEYS.has(key) && isEmptyValue(value)) return false;
  if (value.length > (field.type === 'textarea' ? 4000 : 300)) return false;
  const existing = profile[key];
  const isTextarea = field.type === 'textarea';
  if (existing) {
    if (!opts.overwrite) {
      if (isTextarea && value.length > existing.length + 10) {
        profile[key] = value;
        meta[key] = { source, snippet: value.slice(0, 80) };
        return true;
      }
      return false;
    }
  }
  profile[key] = value;
  meta[key] = { source, snippet: String(rawValue).slice(0, 80) };
  return true;
}

function guessNameFromFilename(name) {
  if (!name) return '';
  let base = name.replace(/\.(docx|doc|pdf|txt|md)$/i, '');
  base = base.replace(/(个人)?简历|resume|cv|信息(表|文档)?|资料|申请表|附件|\d{6,}/gi, ' ');
  base = base.replace(/[_\-\s（）()【】\[\]]+/g, ' ').trim();
  const candidates = base.split(' ').filter(Boolean);
  for (const c of candidates) {
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(c)) return c;
  }
  return '';
}

function applyRegexFallbacks(profile, meta, text, source) {
  if (!text) return;
  const t = toHalfWidth(text);
  const source_ = source;
  if (!profile.phone) {
    const phones = t.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g) || [];
    if (phones.length) mergeScalar(profile, meta, 'phone', phones[0], source_ + ':regex');
  }
  if (!profile.email) {
    const m = t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    if (m) mergeScalar(profile, meta, 'email', m[0], source_ + ':regex');
  }
  if (!profile.idCard) {
    const m = t.match(/(?<!\d)\d{17}[\dXx](?!\d)/);
    if (m) mergeScalar(profile, meta, 'idCard', m[0], source_ + ':regex');
  }
  if (!profile.birthDate) {
    const m = t.match(/(?:出生(?:日期|年月|时间)?|生日)[^\d]{0,4}((?:19|20)\d{2}\s*[年\-/.]\s*\d{1,2}(?:\s*[月\-/.]\s*\d{1,2})?)/);
    if (m) mergeScalar(profile, meta, 'birthDate', m[1], source_ + ':regex');
  }
  if (!profile.ethnicity) {
    const hit = ETHNICITIES.find((e) => t.includes(e));
    if (hit) mergeScalar(profile, meta, 'ethnicity', hit, source_ + ':regex');
  }
  if (!profile.politicalStatus) {
    const m = t.match(/(中共正式党员|中共预备党员|中共党员|预备党员|共青团员|民主党派\S{0,6}|群众)/);
    if (m) mergeScalar(profile, meta, 'politicalStatus', m[1], source_ + ':regex');
  }
  if (!profile.gender) {
    const m = t.match(/性\s*别[^\u4e00-\u9fa5]{0,4}(男|女)/) || t.match(/(?:^|\n)\s*(男|女)\s*(?:\n|$)/);
    if (m) mergeScalar(profile, meta, 'gender', m[1], source_ + ':regex');
  }
}

/** 从姓名以外的信息推断（文件名 / 首页标题行） */
function guessName(docs, profile, meta) {
  if (profile.name) return;
  for (const d of docs) {
    const hint = guessNameFromFilename(d.name);
    if (hint) {
      mergeScalar(profile, meta, 'name', hint, `${d.source}:filename`, { overwrite: true });
      return;
    }
  }
  const lines = docs.flatMap((d) => (d.lines || []).slice(0, 8).map((l) => ({ l, source: d.source })));
  for (const { l, source } of lines) {
    const t = cleanValue(l);
    if (!t || t.length > 12) continue;
    if (/简历|个人|求职|应聘|信息|表格|申请/.test(t)) continue;
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(t)) {
      mergeScalar(profile, meta, 'name', t, `${source}:headline`, { overwrite: true });
      return;
    }
    if (/^[\u4e00-\u9fa5]{2,4}[\s|｜]+/.test(t)) {
      const cand = t.split(/[\s|｜]+/)[0];
      if (/^[\u4e00-\u9fa5]{2,4}$/.test(cand)) {
        mergeScalar(profile, meta, 'name', cand, `${source}:headline`, { overwrite: true });
        return;
      }
    }
  }
}

/** 省市区分拆 */
function deriveFamily(profile, meta) {
  const text = String(profile.familyMembers || '');
  if (!text) return;
  const nameOf = (kw) => {
    const m = text.match(new RegExp(`(?:${kw})[：:]?\\s*(?:姓名[：:])?([\\u4e00-\\u9fa5]{2,4}?)(?=\\s|$|，|,|；|;|（|\\()`));
    return m ? m[1] : '';
  };
  const workOf = (kw) => {
    const m = text.match(new RegExp(`(?:${kw})[：:]?\\s*[\\u4e00-\\u9fa5]{2,4}?\\s+([^\\s，,；;]{2,20})`));
    return m ? m[1] : '';
  };
  if (!profile.fatherName) {
    const v = nameOf('父亲|父亲姓名|父');
    if (v) mergeScalar(profile, meta, 'fatherName', v, 'derive:family');
  }
  if (!profile.fatherWork) {
    const v = workOf('父亲|父');
    if (v && !/^[0-9]+$/.test(v)) mergeScalar(profile, meta, 'fatherWork', v, 'derive:family');
  }
  if (!profile.motherName) {
    const v = nameOf('母亲|母亲姓名|母');
    if (v) mergeScalar(profile, meta, 'motherName', v, 'derive:family');
  }
  if (!profile.motherWork) {
    const v = workOf('母亲|母');
    if (v && !/^[0-9]+$/.test(v)) mergeScalar(profile, meta, 'motherWork', v, 'derive:family');
  }
  // 家庭信息里的手机号按前后的"父/母"归属
  const phoneRe = /1[3-9]\d{9}/g;
  let m;
  while ((m = phoneRe.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 10), m.index);
    if (/父/.test(before) && !profile.fatherPhone) mergeScalar(profile, meta, 'fatherPhone', m[0], 'derive:family');
    else if (/母/.test(before) && !profile.motherPhone) mergeScalar(profile, meta, 'motherPhone', m[0], 'derive:family');
  }
}

function deriveRegion(profile, meta) {
  const source = String(profile.address || profile.hukouAddress || profile.nativePlace || profile.originPlace || '').replace(/\s/g, '');
  if (!source) return;
  if (!profile.province) {
    const hit = PROVINCES.find((p) => source.startsWith(p) || source.includes(p));
    if (hit) mergeScalar(profile, meta, 'province', hit, 'derive:address');
    else {
      const m = source.match(/^([\u4e00-\u9fa5]{2,8}?(?:省|自治区|特别行政区))/);
      if (m) mergeScalar(profile, meta, 'province', m[1], 'derive:address');
    }
  }
  let rest = source;
  if (profile.province) {
    const shortProvince = profile.province
      .replace(/(省|市|自治区|特别行政区)$/, '')
      .replace(/(壮族|回族|维吾尔)/g, '');
    if (shortProvince && rest.startsWith(shortProvince)) rest = rest.slice(shortProvince.length);
    rest = rest.replace(/^(市|省|自治区|特别行政区)+/, '');
  }
  if (!profile.city) {
    const m = rest.match(/^([\u4e00-\u9fa5]{2,8}?(?:市|自治州|地区|盟))/);
    if (m) mergeScalar(profile, meta, 'city', m[1], 'derive:address');
    else if (profile.province && /市$/.test(profile.province)) mergeScalar(profile, meta, 'city', profile.province, 'derive:address');
  }
  if (profile.city) {
    const cityShort = profile.city.replace(/(市|自治州|地区|盟)$/, '');
    if (cityShort && rest.startsWith(cityShort)) rest = rest.slice(cityShort.length);
    rest = rest.replace(/^(市|州|盟|地区)+/, '');
  }
  if (!profile.district) {
    const m = rest.match(/^([\u4e00-\u9fa5]{2,10}?(?:区|县|旗|市辖区))/);
    if (m) mergeScalar(profile, meta, 'district', m[1], 'derive:address');
  }
}

function deriveOthers(profile, meta) {
  if (!profile.age && profile.birthDate) {
    const p = parseDateParts(profile.birthDate);
    if (p && p.year) {
      const now = new Date();
      let age = now.getFullYear() - p.year;
      if (p.month && now.getMonth() + 1 < p.month) age -= 1;
      if (age > 0 && age < 100) mergeScalar(profile, meta, 'age', String(age), 'derive:birthDate');
    }
  }
  if (!profile.idCardType && profile.idCard) mergeScalar(profile, meta, 'idCardType', '居民身份证', 'derive:idCard');
  if (!profile.nationality && profile.idCard) mergeScalar(profile, meta, 'nationality', '中国', 'derive:idCard');
  // 学历取最高
  const list = profile.educationList || [];
  if (list.length) {
    const score = (e) => (DEGREE_RANK[pickDegree(e.degree) || e.degree] || 0) * 10 + (e.mode ? 1 : 0);
    const best = list.slice().sort((a, b) => score(b) - score(a))[0];
    if (!profile.school && best.school) mergeScalar(profile, meta, 'school', best.school, 'derive:education');
    if (!profile.major && best.major) mergeScalar(profile, meta, 'major', best.major, 'derive:education');
    if (!profile.degree && best.degree) mergeScalar(profile, meta, 'degree', pickDegree(best.degree) || best.degree, 'derive:education');
    if (!profile.studyMode && best.mode) mergeScalar(profile, meta, 'studyMode', best.mode, 'derive:education');
    if (!profile.graduationDate && best.end && best.end !== '至今') mergeScalar(profile, meta, 'graduationDate', best.end, 'derive:education');
    if (!profile.enrollmentDate && best.start) mergeScalar(profile, meta, 'enrollmentDate', best.start, 'derive:education');
    // 经历文本按时间倒序拼接（通常简历也是倒序）
    if (!profile.school && !best.school) {
      const withSchool = list.find((e) => e.school);
      if (withSchool) mergeScalar(profile, meta, 'school', withSchool.school, 'derive:education');
    }
  }
}

function fillExperienceTexts(profile, meta) {
  const edu = profile.educationList || [];
  if (!profile.eduExperience && edu.length) {
    mergeScalar(
      profile,
      meta,
      'eduExperience',
      edu.map((e) => [`${e.start || ''}${e.end ? '-' + e.end : ''}`.trim(), e.school, e.major, e.degree, e.mode].filter(Boolean).join('  ')).join('\n'),
      'derive:education',
      { overwrite: true },
    );
  }
  const work = profile.workList || [];
  if (!profile.workExperience && work.length) {
    mergeScalar(
      profile,
      meta,
      'workExperience',
      work.map((w) => [`${w.start || ''}${w.end ? '-' + w.end : ''}`.trim(), w.company, w.position].filter(Boolean).join('  ')).join('\n'),
      'derive:work',
      { overwrite: true },
    );
  }
}

/**
 * 主入口
 * @param {{docs:Array, overrides?:Object, customMappings?:Object}} params
 */
export function buildProfile({ docs = [], overrides = {}, customMappings = {} } = {}) {
  const profile = blankProfile();
  const meta = {};
  const warnings = [];
  const scalarKeys = FIELDS.filter((f) => f.type !== 'textarea' && !LIST_KEYS.has(f.key)).map((f) => f.key);

  // 1) 通用「标签-值」抽取：简历先写入，信息文档覆盖（信息文档更权威）
  for (const doc of docs) {
    const docLabel = doc.source === 'info' ? '信息文档' : '简历';
    const pairs = collectPairs(doc);
    for (const p of pairs) {
      const hit = matchLabel(p.label);
      if (!hit) continue;
      const key = hit.field.key;
      if (LIST_KEYS.has(key)) continue;
      const overwrite = doc.source === 'info';
      mergeScalar(profile, meta, key, p.value, `${docLabel}:${p.label}`, { overwrite });
    }
    // 2) 章节块
    for (const section of splitSections(doc)) {
      const { def, lines } = section;
      if (def.kind === 'education') {
        const entries = extractEducationEntries(lines);
        if (entries.length) {
          profile.educationList = mergeEntries([...(profile.educationList || []), ...entries], (e) => `${e.school}|${e.major}|${e.degree}|${e.start}`);
        } else {
          mergeScalar(profile, meta, def.key, joinBlocks(lines), `${docLabel}:${def.title}`, { overwrite: doc.source === 'info' });
        }
      } else if (def.kind === 'work') {
        const entries = extractWorkEntries(lines);
        if (entries.length) {
          profile.workList = mergeEntries([...(profile.workList || []), ...entries], (e) => `${e.company}|${e.position}|${e.start}`);
        }
        const textBlock = joinBlocks(lines);
        if (textBlock && (!profile[def.key] || (doc.source === 'info' && textBlock.length > String(profile[def.key] || '').length))) {
          mergeScalar(profile, meta, def.key, textBlock, `${docLabel}:${def.title}`, { overwrite: true });
        }
      } else if (def.kind === 'project') {
        const blocks = [];
        let cur = [];
        for (const l of lines) {
          if (findDateRange(l) && cur.length) {
            blocks.push(cur.join('\n'));
            cur = [];
          }
          cur.push(l);
        }
        if (cur.length) blocks.push(cur.join('\n'));
        const text = blocks.join('\n\n') || joinBlocks(lines);
        mergeScalar(profile, meta, def.key, text, `${docLabel}:${def.title}`, { overwrite: doc.source === 'info' });
      } else {
        mergeScalar(profile, meta, def.key, joinBlocks(lines), `${docLabel}:${def.title}`, { overwrite: doc.source === 'info' });
      }
    }
    // 3) 正则兜底
    applyRegexFallbacks(profile, meta, doc.text, doc.source);
  }

  // 4) 信息表里的经历表格
  for (const doc of docs) {
    const { eduList, workList } = parseExperienceTables(doc);
    if (eduList.length) {
      profile.educationList = mergeEntries([...(profile.educationList || []), ...eduList], (e) => `${e.school}|${e.major}|${e.degree}|${e.start}`);
    }
    if (workList.length) {
      profile.workList = mergeEntries([...(profile.workList || []), ...workList], (e) => `${e.company}|${e.position}|${e.start}`);
    }
  }

  guessName(docs, profile, meta);
  fillExperienceTexts(profile, meta);
  deriveOthers(profile, meta);
  deriveFamily(profile, meta);
  deriveRegion(profile, meta);

  // 5) 用户手动覆盖（最高优先级）
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!FIELD_BY_KEY[key] || LIST_KEYS.has(key)) continue;
    if (value === '' || value === null || value === undefined) continue;
    mergeScalar(profile, meta, key, value, '手动补充', { overwrite: true });
  }
  profile.customMappings = { ...(customMappings || {}) };
  profile._meta = meta;
  profile._warnings = warnings;
  profile._scalarKeys = scalarKeys;

  const filledCount = scalarKeys.filter((k) => profile[k]).length;
  return { profile, meta, warnings, stats: { filledCount, totalKeys: scalarKeys.length } };
}

/** 生成给用户看的资料摘要 */
export function summarizeProfile(profile) {
  const rows = [];
  for (const f of FIELDS) {
    const v = profile[f.key];
    if (v && !LIST_KEYS.has(f.key)) rows.push({ key: f.key, label: f.label, value: String(v) });
  }
  return rows;
}

export { formatDate };
