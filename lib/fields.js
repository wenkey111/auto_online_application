/**
 * 字段字典：网申表单 / 信息文档 / 简历 共用一套字段定义与同义词。
 * 该文件同时被 background.js（module service worker）与 offscreen.js 引用，
 * 并由 background 以数据形式下发给 content.js 使用。
 */

/** 全角转半角 + 去空白 + 去标点，用于标签比对 */
export function normalizeLabel(input) {
  if (input === null || input === undefined) return '';
  let t = String(input);
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.replace(/\u3000/g, ' ');
  // 去掉括号内的补充说明（如 "手机号（常用）"）
  t = t.replace(/[（(][^)）]{0,24}[)）]/g, ' ');
  t = t.replace(/[☆★*＊]/g, ' ');
  t = t.replace(/必填|选填|required|optional/gi, ' ');
  t = t.toLowerCase();
  t = t.replace(/[\s:：.。、,，;；·•\-—_/\\|"'“”‘’\[\]【】<>《》?？!！]+/g, '');
  return t;
}

/** 只做基础清洗，保留原文用于取值 */
export function cleanValue(input) {
  if (input === null || input === undefined) return '';
  let t = String(input).replace(/\u3000/g, ' ');
  t = t.replace(/[\u200b\u200e\u200f\ufeff]/g, '');
  t = t.replace(/^[\s:：.。、,，;；\-—•·]+/, '');
  t = t.replace(/[\s:：、,，;；]+$/, '');
  t = t.replace(/\s{2,}/g, ' ');
  return t.trim();
}

/** 日期类字段取值时的常见格式 */
export const DATE_KEYS = [
  'birthDate',
  'partyJoinDate',
  'enrollmentDate',
  'graduationDate',
  'availableDate',
];

const F = (key, label, aliases, opts = {}) => ({
  key,
  label,
  aliases: [label, ...aliases],
  type: opts.type || 'text',
  group: opts.group || 'basic',
  exclude: opts.exclude || [],
  format: opts.format || null,
  note: opts.note || '',
});

export const FIELDS = [
  // ------------------------------ 基本信息 ------------------------------
  F('name', '姓名', ['名字', '真实姓名', '申请人姓名', '报考人姓名', '本人姓名', '本人名字', '中文姓名', '应聘者姓名', '考生姓名', '填表人姓名', '请填写姓名'], {
    exclude: ['英文', '拼音', '用户名', '账号', '账户', '昵称', '登录', '曾用名', '护照', '公司名', '项目名', '学校名', '专业名', '联系人姓名'],
    group: 'basic',
  }),
  F('surname', '姓', ['姓氏', '本人姓'], { exclude: ['姓名', '民族', '姓氏名'] }),
  F('givenName', '名', ['本人名'], { exclude: ['姓名', '名称', '项目名', '学校名', '公司名', '专业名', '用户名', '昵称', '名族'] }),
  F('nameEn', '英文姓名', ['英文名', '英文名字', '姓名拼音', '汉语拼音', '拼音', '英文全名', 'full name', 'english name']),
  F('gender', '性别', ['性 别', '生理性别'], { type: 'select' }),
  F('birthDate', '出生日期', ['出生年月', '出生年月日', '出生时间', '生日', '出生日期（年月日）'], { type: 'date' }),
  F('age', '年龄', ['周岁'], { type: 'number' }),
  F('nationality', '国籍', ['国家', '国籍/地区', '国家地区'], { type: 'select' }),
  F('ethnicity', '民族', ['民族成分'], { type: 'select' }),
  F('politicalStatus', '政治面貌', ['政治身份', '政治情况', '党派', '政治面貌情况'], { type: 'select' }),
  F('partyJoinDate', '入党时间', ['入党日期', '入团时间', '入团日期', '入党（团）时间'], { type: 'date' }),
  F('maritalStatus', '婚姻状况', ['婚否', '婚姻状态', '是否已婚', '婚姻'], { type: 'select' }),
  F('healthStatus', '健康状况', ['身体状况', '健康情况', '身体情况'], { type: 'select' }),
  F('height', '身高', ['身高cm', '身高（cm）', '身高厘米'], { type: 'number' }),
  F('weight', '体重', ['体重kg', '体重（kg）', '体重公斤'], { type: 'number' }),
  F('bloodType', '血型', ['血型（abo）'], { type: 'select' }),
  F('idCard', '身份证号', ['身份证号码', '身份证', '证件号码', '居民身份证号', '居民身份证号码', '身份证件号码', '有效身份证号', '身份证件号'], {
    exclude: ['有效期', '签发', '有效期至', '证件类型', '照片', '复印件', '身份证号后'],
  }),
  F('idCardType', '证件类型', ['身份证件类型', '有效证件类型'], { type: 'select' }),
  F('hukouAddress', '户籍地址', ['户口所在地', '户籍所在地', '户口地址', '户籍地', '户籍详细地址', '户口所在地详细地址', '户口所在地地址']),
  F('hukouType', '户口性质', ['户籍类型', '户口类型', '户籍性质', '户口类型（城镇/农村）'], { type: 'select' }),
  F('nativePlace', '籍贯', ['籍贯地', '祖籍', '出生地', '籍贯省市', '籍贯（省/市）', '籍贯所在地']),
  F('originPlace', '生源地', ['生源所在地', '生源地区', '高考所在地', '高考省份', '高考生源地']),
  F('province', '省', ['省份', '所在省', '省（直辖市）', '现居省份'], { type: 'select' }),
  F('city', '市', ['城市', '所在市', '市（地区）', '地市', '现居城市'], { type: 'select' }),
  F('district', '区', ['区县', '县', '所在区', '区/县', '县区'], { type: 'select' }),
  F('address', '现居住地址', ['通讯地址', '联系地址', '详细地址', '居住地址', '现住址', '家庭住址', '邮寄地址', '通信地址', '地址', '现居地址', '现居', '现居地', '家庭地址', '常住地址', '详细住址', '目前居住地'], {
    exclude: ['邮箱', '邮件', '网址', '身份证', '户籍', '户口', '学校地址', '公司地址', '紧急'],
  }),
  F('postalCode', '邮编', ['邮政编码', '邮编/邮政编码', '住宅邮编']),

  // ------------------------------ 联系方式 ------------------------------
  F('phone', '手机号码', ['手机号', '手机', '联系电话', '移动电话', '本人电话', '常用电话', '电话', '联系方式', '联系手机', '本人手机号', '手机（微信同号）'], {
    exclude: ['紧急', '父亲', '母亲', '家长', '监护人', '座机', '固定', '区号', '传真', '单位电话', '推荐人', '亲属', '家庭电话', '宿舍电话', '学校电话'],
    format: 'mobile',
  }),
  F('landline', '固定电话', ['座机', '住宅电话', '家庭电话', '宿舍电话'], { exclude: ['紧急'] }),
  F('email', '电子邮箱', ['邮箱', '电子邮件', '邮件地址', 'email', 'e-mail', '邮箱地址', '常用邮箱', '电子邮件地址'], { format: 'email' }),
  F('wechat', '微信', ['微信号', '微信账号', '微信id', '微信id号']),
  F('qq', 'QQ', ['qq号', 'qq号码', 'qq邮箱']),
  F('emergencyName', '紧急联系人姓名', ['紧急联系人', '紧急联络人', '紧急情况联系人'], { group: 'family' }),
  F('emergencyRelation', '紧急联系人关系', ['与紧急联系人关系', '紧急联系人关系类型', '紧急联系人关系（与本人关系）'], { group: 'family' }),
  F('emergencyPhone', '紧急联系人电话', ['紧急联系电话', '紧急联系人手机', '紧急联系方式', '紧急联系人手机号'], { group: 'family', format: 'mobile' }),

  // ------------------------------ 教育背景 ------------------------------
  F('school', '毕业院校', ['学校', '院校', '学校名称', '就读学校', '毕业学校', '本科院校', '最高学历院校', '毕业院校名称', '就读院校', '毕业学校名称', '院校名称'], {
    group: 'edu',
    exclude: ['高中', '中学', '初中', '小学', '学校地址', '学校所在地', '学校电话', '学校类型'],
  }),
  F('major', '专业', ['所学专业', '专业名称', '本科专业', '就读专业', '主修专业', '专业方向', '学科专业'], {
    group: 'edu',
    exclude: ['专业排名', '专业方向描述', '双学位', '辅修'],
  }),
  F('degree', '学历', ['最高学历', '学位', '学历层次', '最高学位', '学历/学位', '文化程度', '最高学历（学位）', '学历学位'], { group: 'edu', type: 'select' }),
  F('studyMode', '培养方式', ['学习形式', '招生类别', '培养类型', '办学形式', '学习方式'], { group: 'edu', type: 'select' }),
  F('enrollmentDate', '入学时间', ['入学日期', '入学年月', '入学年份'], { group: 'edu', type: 'date' }),
  F('graduationDate', '毕业时间', ['毕业日期', '毕业年月', '预计毕业时间', '毕业年份', '毕业时间（年月）'], { group: 'edu', type: 'date' }),
  F('studentId', '学号', ['学生学号', '学籍号', '学号（如有）'], { group: 'edu' }),
  F('gpa', '平均绩点', ['gpa', '绩点', '平均成绩', '平均分', 'gpa（平均绩点）', '课程平均分'], { group: 'edu', exclude: ['排名'] }),
  F('classRank', '专业排名', ['排名', '班级排名', '年级排名', '综合排名', '成绩排名', '专业排名（x/总人数）'], { group: 'edu' }),
  F('schoolCity', '学校所在地', ['院校所在地', '学校所在城市', '学校所在省市'], { group: 'edu' }),
  F('schoolType', '院校类型', ['学校类别', '院校属性', '学校性质', '院校层次', '学校类型'], { group: 'edu', type: 'select' }),
  F('degreeCertNo', '学位证书编号', ['毕业证书编号', '学位证编号', '学历证书编号', '证书编号'], { group: 'edu' }),
  F('isFreshGraduate', '是否应届毕业生', ['是否应届', '应届生', '应届毕业生', '是否为应届毕业生'], { group: 'edu', type: 'select' }),
  F('eduExperience', '教育经历', ['教育背景', '学习经历', '教育经历（从高中填起）', '主要学习经历'], { group: 'edu', type: 'textarea' }),

  // ------------------------------ 语言 / 技能 ------------------------------
  F('foreignLanguage', '外语水平', ['外语语种', '英语水平', '外语能力', '外语等级', '英语能力'], { group: 'other' }),
  F('cet4', '英语四级', ['cet-4', 'cet4', '大学英语四级', '四级成绩', '四级分数', '英语四级成绩'], { group: 'other' }),
  F('cet6', '英语六级', ['cet-6', 'cet6', '大学英语六级', '六级成绩', '六级分数', '英语六级成绩'], { group: 'other' }),
  F('computerLevel', '计算机等级', ['计算机水平', '计算机等级考试', '计算机二级', '计算机能力'], { group: 'other' }),
  F('certificates', '资格证书', ['证书', '技能证书', '获取证书', '证书名称', '相关证书', '职业资格', '已获证书'], { group: 'other', type: 'textarea' }),
  F('skills', '专业技能', ['技能', '技能特长', '掌握技能', '专业能力', '擅长技能', '计算机技能', '技能与特长'], { group: 'other', type: 'textarea' }),
  F('awards', '获奖情况', ['奖项', '荣誉', '所获奖励', '荣誉奖励', '获奖经历', '主要奖项', '奖励情况', '奖学金情况'], { group: 'other', type: 'textarea' }),
  F('selfEvaluation', '自我评价', ['自我介绍', '个人简介', '个人评价', '自我描述', '个人优势', '自我鉴定', '特长优势', '个人情况介绍'], { group: 'other', type: 'textarea' }),
  F('hobbies', '兴趣爱好', ['爱好', '兴趣特长', '业余爱好'], { group: 'other' }),

  // ------------------------------ 经历 ------------------------------
  F('campusExperience', '校园经历', ['在校经历', '学生工作经历', '社团经历', '学生干部经历', '校园活动', '校内实践'], { group: 'exp', type: 'textarea' }),
  F('socialPractice', '社会实践', ['志愿服务', '志愿经历', '社会实践经历', '公益活动'], { group: 'exp', type: 'textarea' }),
  F('internship', '实习经历', ['实习经验', '实习情况及收获', '实习经历（如有）'], { group: 'exp', type: 'textarea' }),
  F('workExperience', '工作经历', ['工作经验', '工作履历', '任职经历', '工作经历（含实习）'], { group: 'exp', type: 'textarea' }),
  F('projectExperience', '项目经历', ['项目经验', '项目实践', '主要项目', '参与项目'], { group: 'exp', type: 'textarea' }),
  F('trainingExperience', '培训经历', ['培训情况', '受训经历', '培训经历（如有）'], { group: 'exp', type: 'textarea' }),
  F('paperPatent', '论文专利', ['论文', '专利', '科研成果', '发表论文', '科研经历'], { group: 'exp', type: 'textarea' }),

  // ------------------------------ 求职意向 ------------------------------
  F('expectedPosition', '应聘岗位', ['意向岗位', '求职意向', '应聘职位', '申请职位', '期望岗位', '报考岗位', '应聘职位名称', '岗位名称', '意向职位', '申请岗位', '应聘岗位名称', '意向部门'], {
    group: 'other',
    exclude: ['岗位类别', '岗位序列'],
  }),
  F('expectedCity', '期望工作城市', ['期望城市', '意向工作地点', '工作地点', '期望工作地', '意向城市', '期望工作地区', '期望工作地点'], { group: 'other' }),
  F('expectedSalary', '期望薪资', ['薪资要求', '期望薪酬', '薪资期望', '期望月薪', '期望年薪'], { group: 'other' }),
  F('availableDate', '到岗时间', ['可到岗时间', '最快到岗时间', '可实习时间', '入职时间', '可到岗日期'], { group: 'other', type: 'date' }),
  F('acceptAdjustment', '是否服从调剂', ['服从调剂', '是否接受调剂', '是否服从专业调剂', '是否服从岗位调剂'], { group: 'other', type: 'select' }),
  F('hasRelatives', '是否有亲属在本单位工作', ['是否有亲属在本单位', '回避关系', '是否与本单位员工有亲属关系', '是否存在回避关系'], { group: 'other', type: 'select' }),
  F('referralSource', '招聘信息来源', ['获知渠道', '招聘渠道', '信息来源', '了解渠道', '获知招聘信息渠道', '消息来源'], { group: 'other' }),

  // ------------------------------ 家庭 ------------------------------
  F('fatherName', '父亲姓名', ['父亲名字', '父姓名'], { group: 'family' }),
  F('fatherWork', '父亲工作单位', ['父亲职业', '父亲单位', '父亲工作单位及职务', '父亲工作'], { group: 'family' }),
  F('fatherPhone', '父亲电话', ['父亲手机', '父亲联系电话', '父亲手机号'], { group: 'family', format: 'mobile' }),
  F('motherName', '母亲姓名', ['母亲名字', '母姓名'], { group: 'family' }),
  F('motherWork', '母亲工作单位', ['母亲职业', '母亲单位', '母亲工作单位及职务', '母亲工作'], { group: 'family' }),
  F('motherPhone', '母亲电话', ['母亲手机', '母亲联系电话', '母亲手机号'], { group: 'family', format: 'mobile' }),
  F('familyMembers', '家庭成员', ['家庭主要成员', '家庭情况', '家庭基本情况', '主要家庭成员', '家庭成员及工作单位'], { group: 'family', type: 'textarea' }),

  // ------------------------------ 其他 ------------------------------
  F('remark', '备注', ['其他说明', '其他信息', '补充说明', '其他需要说明的情况'], { group: 'other', type: 'textarea' }),
  F('username', '用户名', ['账号', '登录名', '账户名', '登录账号'], { group: 'other', exclude: ['密码', '身份证'] }),
];

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

export const GROUP_LABELS = {
  basic: '基本信息',
  contact: '联系方式',
  edu: '教育背景',
  exp: '实践与经历',
  family: '家庭与紧急联系人',
  other: '求职意向与其他',
};

/** 用于表单填充时的分组（联系方式类字段归到 contact） */
export const FILL_GROUPS = {
  name: 'basic',
  surname: 'basic',
  givenName: 'basic',
  nameEn: 'basic',
  gender: 'basic',
  birthDate: 'basic',
  age: 'basic',
  nationality: 'basic',
  ethnicity: 'basic',
  politicalStatus: 'basic',
  partyJoinDate: 'basic',
  maritalStatus: 'basic',
  healthStatus: 'basic',
  height: 'basic',
  weight: 'basic',
  bloodType: 'basic',
  idCard: 'basic',
  idCardType: 'basic',
  hukouAddress: 'basic',
  hukouType: 'basic',
  nativePlace: 'basic',
  originPlace: 'basic',
  province: 'basic',
  city: 'basic',
  district: 'basic',
  address: 'basic',
  postalCode: 'basic',
  phone: 'contact',
  landline: 'contact',
  email: 'contact',
  wechat: 'contact',
  qq: 'contact',
  emergencyName: 'contact',
  emergencyRelation: 'contact',
  emergencyPhone: 'contact',
};

/**
 * 下拉框 / 单选框选项与资料取值的等价说法。
 * 每行是一组等价写法，匹配时取规范化后相等或互相包含。
 */
export const VALUE_SYNONYMS = [
  ['男', '男性', 'male', 'm', '1'],
  ['女', '女性', 'female', 'f', '2'],
  ['是', 'yes', 'y', '有', '同意', '服从'],
  ['否', 'no', 'n', '无', '没有', '不同意', '不服从'],
  ['未婚', '未婚未育', 'single', '未结婚'],
  ['已婚', '已婚已育', 'married', '结婚'],
  ['中国', '中华人民共和国', '中国国籍', 'china', '中国大陆'],
  ['汉族', '汉'],
  ['中共党员', '党员', '中国共产党党员', '中共正式党员', '中国共产党'],
  ['中共预备党员', '预备党员'],
  ['共青团员', '团员', '中国共产主义青年团团员'],
  ['民主党派', '民主党派成员', '其它党派'],
  ['群众', '普通群众', '无党派', '无'],
  ['本科', '大学本科', '本科生', '全日制本科', '本科学历', '大学本科（学士）'],
  ['硕士', '硕士研究生', '研究生', '硕士学历', '硕士研究生（硕士）', '硕研'],
  ['博士', '博士研究生', '博士学历', '博研'],
  ['大专', '专科', '大学专科', '高职', '专科（高职）'],
  ['高中', '普通高中', '高中毕业'],
  ['中专', '中等专业学校', '中等职业学校'],
  ['全日制', '普通全日制', '统招', '全日制统招', '普通高等教育'],
  ['非全日制', '成人教育', '在职学习', '自考'],
  ['应届毕业生', '应届', '应届生', '今年毕业', '是'],
  ['往届毕业生', '往届', '非应届', '已毕业'],
  ['城镇', '城镇户口', '非农业户口', '非农业家庭户口', '城市户口', '居民户口'],
  ['农村', '农村户口', '农业户口', '农业家庭户口'],
  ['居民身份证', '身份证', '中华人民共和国居民身份证'],
  ['良好', '健康', '身体状况良好', '身体健康', '无疾病'],
  ['a型', 'a'],
  ['b型', 'b'],
  ['o型', 'o'],
  ['ab型', 'ab'],
  ['985', '985高校', '985工程'],
  ['211', '211高校', '211工程'],
  ['双一流', '双一流高校', '双一流建设高校'],
  ['普通本科', '普通院校', '普通高校', '普通本科院校'],
  ['校园招聘', '校招', '校园招聘会', '学校就业网'],
  ['社会招聘', '社招'],
  ['网络招聘', '线上招聘', '招聘网站', '智联招聘', '前程无忧', 'boss直聘'],
  ['内部推荐', '员工推荐', '内推', '推荐'],
];

/** 34 个省级行政区，用于"省"下拉框识别 */
export const PROVINCES = [
  '北京市', '天津市', '上海市', '重庆市',
  '河北省', '山西省', '辽宁省', '吉林省', '黑龙江省',
  '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省',
  '河南省', '湖北省', '湖南省', '广东省', '海南省',
  '四川省', '贵州省', '云南省', '陕西省', '甘肃省', '青海省',
  '台湾省', '内蒙古自治区', '广西壮族自治区', '西藏自治区', '宁夏回族自治区', '新疆维吾尔自治区',
  '香港特别行政区', '澳门特别行政区',
];

/** 省级简称（无"省/市"后缀） */
export const PROVINCE_SHORT = PROVINCES.map((p) =>
  p.replace(/(省|市|自治区|特别行政区|壮族|回族|维吾尔|自治)/g, ''),
);

/** 常见直辖市/省会在地址里的写法，用于省市区下拉匹配 */
export function provinceMatchTokens(provinceName) {
  if (!provinceName) return [];
  const short = provinceName.replace(/(省|市|自治区|特别行政区)/g, '');
  const extra = [];
  if (provinceName.startsWith('内蒙古')) extra.push('内蒙');
  if (provinceName.startsWith('广西')) extra.push('广西');
  if (provinceName.startsWith('新疆')) extra.push('新疆');
  if (provinceName.startsWith('宁夏')) extra.push('宁夏');
  if (provinceName.startsWith('西藏')) extra.push('西藏');
  if (provinceName.startsWith('香港')) extra.push('香港');
  if (provinceName.startsWith('澳门')) extra.push('澳门');
  return Array.from(new Set([provinceName, short, short.replace(/(壮族|回族|维吾尔)/g, ''), ...extra])).filter(Boolean);
}

/** 判断两个取值是否等价（下拉选项 / 单选框用） */
export function valuesMatch(valueA, valueB) {
  const a = normalizeLabel(valueA);
  const b = normalizeLabel(valueB);
  if (!a || !b) return false;
  if (a === b) return true;
  for (const group of VALUE_SYNONYMS) {
    const ga = group.map(normalizeLabel);
    if (ga.includes(a) && ga.includes(b)) return true;
  }
  // 互相包含：如资料 "本科" vs 选项 "本科（学士）"
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
  // 英文大小写/空格已被 normalize 处理
  return false;
}

/** 单个字段与某个标签文本的匹配分（0 表示不匹配） */
export function scoreLabel(rawLabel, field) {
  const label = normalizeLabel(rawLabel);
  if (!label) return 0;
  for (const ex of field.exclude || []) {
    const exN = normalizeLabel(ex);
    if (exN && label.includes(exN)) return 0;
  }
  let best = 0;
  for (const alias of field.aliases) {
    const a = normalizeLabel(alias);
    if (!a) continue;
    if (label === a) {
      best = Math.max(best, 200 + a.length * 3);
    } else if (a.length >= 2 && label.includes(a)) {
      best = Math.max(best, 100 + a.length * 3);
    } else if (label.length >= 2 && a.includes(label)) {
      // 反向包含："手机" 匹配 "手机号码"；差距越大分越低
      const diff = a.length - label.length;
      best = Math.max(best, Math.max(0, 150 - diff * 10));
    }
  }
  return best;
}

/**
 * 在字段字典里为标签找最合适的字段
 * @param {string} rawLabel
 * @param {number} [minScore] 判定下限（默认 60；解析文档表格建议 100）
 */
export function matchLabel(rawLabel, minScore = 60) {
  let winner = null;
  let top = 0;
  let second = 0;
  for (const field of FIELDS) {
    const score = scoreLabel(rawLabel, field);
    if (score > top) {
      second = top;
      top = score;
      winner = field;
    } else if (score > second) {
      second = score;
    }
  }
  if (!winner || top < minScore) return null;
  return { field: winner, score: top, margin: top - second };
}

/**
 * 常见"取值"词：这些词是下拉框/单选框的选项，不应被当成标签。
 * 例如表格里出现 "本科 | 全日制" 时，"本科" 是学历取值，不能当成"本科专业"的标签。
 */
const VALUE_TOKENS = [
  '男', '女', '男性', '女性', 'male', 'female',
  '是', '否', '有', '无', '无党派', '其他', '其它',
  '本科', '大学本科', '本科生', '硕士', '硕士研究生', '研究生', '博士', '博士研究生',
  '大专', '专科', '高职', '高中', '中专', 'MBA', 'EMBA',
  '中共党员', '中共预备党员', '党员', '预备党员', '共青团员', '团员', '群众', '民主党派',
  '未婚', '已婚', '离异', '丧偶',
  '全日制', '非全日制', '统招', '自考', '成人教育', '在职',
  '城镇', '农村', '农业户口', '非农业户口', '居民户口',
  '健康', '良好', '一般', '较差', '优秀',
  '双一流', '985', '211', '一本', '二本', '普通本科', '普通院校',
  '中国', '中华人民共和国', '汉族', '应届', '应届生', '往届', '在读', '已毕业',
  'A型', 'B型', 'O型', 'AB型',
];

const VALUE_TOKEN_SET = new Set(VALUE_TOKENS.map((t) => normalizeLabel(t)));

export function isFieldValueToken(text) {
  const n = normalizeLabel(text);
  return Boolean(n) && VALUE_TOKEN_SET.has(n);
}

/** 表单自动完成属性（autocomplete）到字段的映射 */
export const AUTOCOMPLETE_MAP = {
  name: 'name',
  'given-name': 'givenName',
  'family-name': 'surname',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  bday: 'birthDate',
  'street-address': 'address',
  'address-line1': 'address',
  'postal-code': 'postalCode',
  'address-level1': 'province',
  'address-level2': 'city',
  organization: null,
};

/** 生成空白档案（也是 options 页与导出 JSON 的结构） */
export function blankProfile() {
  const profile = {};
  for (const f of FIELDS) {
    profile[f.key] = f.type === 'textarea' ? '' : '';
  }
  // 结构化经历
  profile.educationList = [];
  profile.workList = [];
  profile.projectList = [];
  return profile;
}

/** 供 content script 使用的紧凑字段规范 */
export function fieldSpecForContent() {
  return FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    group: FILL_GROUPS[f.key] || f.group,
    aliases: f.aliases,
    exclude: f.exclude,
    format: f.format,
  }));
}
