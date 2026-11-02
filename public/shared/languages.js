// Language list shared by the browser and the server.
// Codes follow the Google Translate convention (the widest coverage of the free
// engines). Engine adapters map them to their own codes where needed
// (e.g. DeepL "EN-US", Microsoft "zh-Hans", Google "iw" for Hebrew).

export const LANGUAGES = [
  ['af', 'Afrikaans', 'Afrikaans'],
  ['sq', 'Albanian', 'Shqip'],
  ['am', 'Amharic', 'አማርኛ'],
  ['ar', 'Arabic', 'العربية'],
  ['hy', 'Armenian', 'Հայերեն'],
  ['as', 'Assamese', 'অসমীয়া'],
  ['ay', 'Aymara', 'Aymar aru'],
  ['az', 'Azerbaijani', 'Azərbaycan dili'],
  ['bm', 'Bambara', 'Bamanankan'],
  ['eu', 'Basque', 'Euskara'],
  ['be', 'Belarusian', 'Беларуская'],
  ['bn', 'Bengali', 'বাংলা'],
  ['bho', 'Bhojpuri', 'भोजपुरी'],
  ['bs', 'Bosnian', 'Bosanski'],
  ['bg', 'Bulgarian', 'Български'],
  ['ca', 'Catalan', 'Català'],
  ['ceb', 'Cebuano', 'Cebuano'],
  ['ny', 'Chichewa', 'Chichewa'],
  ['zh-CN', 'Chinese (Simplified)', '简体中文'],
  ['zh-TW', 'Chinese (Traditional)', '繁體中文'],
  ['co', 'Corsican', 'Corsu'],
  ['hr', 'Croatian', 'Hrvatski'],
  ['cs', 'Czech', 'Čeština'],
  ['da', 'Danish', 'Dansk'],
  ['dv', 'Dhivehi', 'ދިވެހި'],
  ['doi', 'Dogri', 'डोगरी'],
  ['nl', 'Dutch', 'Nederlands'],
  ['en', 'English', 'English'],
  ['eo', 'Esperanto', 'Esperanto'],
  ['et', 'Estonian', 'Eesti'],
  ['ee', 'Ewe', 'Eʋegbe'],
  ['tl', 'Filipino', 'Filipino'],
  ['fi', 'Finnish', 'Suomi'],
  ['fr', 'French', 'Français'],
  ['fy', 'Frisian', 'Frysk'],
  ['gl', 'Galician', 'Galego'],
  ['ka', 'Georgian', 'ქართული'],
  ['de', 'German', 'Deutsch'],
  ['el', 'Greek', 'Ελληνικά'],
  ['gn', 'Guarani', 'Avañeʼẽ'],
  ['gu', 'Gujarati', 'ગુજરાતી'],
  ['ht', 'Haitian Creole', 'Kreyòl ayisyen'],
  ['ha', 'Hausa', 'Hausa'],
  ['haw', 'Hawaiian', 'ʻŌlelo Hawaiʻi'],
  ['he', 'Hebrew', 'עברית'],
  ['hi', 'Hindi', 'हिन्दी'],
  ['hmn', 'Hmong', 'Hmoob'],
  ['hu', 'Hungarian', 'Magyar'],
  ['is', 'Icelandic', 'Íslenska'],
  ['ig', 'Igbo', 'Igbo'],
  ['ilo', 'Ilocano', 'Ilokano'],
  ['id', 'Indonesian', 'Bahasa Indonesia'],
  ['ga', 'Irish', 'Gaeilge'],
  ['it', 'Italian', 'Italiano'],
  ['ja', 'Japanese', '日本語'],
  ['jv', 'Javanese', 'Basa Jawa'],
  ['kn', 'Kannada', 'ಕನ್ನಡ'],
  ['kk', 'Kazakh', 'Қазақ тілі'],
  ['km', 'Khmer', 'ខ្មែរ'],
  ['rw', 'Kinyarwanda', 'Ikinyarwanda'],
  ['gom', 'Konkani', 'कोंकणी'],
  ['ko', 'Korean', '한국어'],
  ['kri', 'Krio', 'Krio'],
  ['ku', 'Kurdish (Kurmanji)', 'Kurdî'],
  ['ckb', 'Kurdish (Sorani)', 'کوردی'],
  ['ky', 'Kyrgyz', 'Кыргызча'],
  ['lo', 'Lao', 'ລາວ'],
  ['la', 'Latin', 'Latina'],
  ['lv', 'Latvian', 'Latviešu'],
  ['ln', 'Lingala', 'Lingála'],
  ['lt', 'Lithuanian', 'Lietuvių'],
  ['lg', 'Luganda', 'Luganda'],
  ['lb', 'Luxembourgish', 'Lëtzebuergesch'],
  ['mk', 'Macedonian', 'Македонски'],
  ['mai', 'Maithili', 'मैथिली'],
  ['mg', 'Malagasy', 'Malagasy'],
  ['ms', 'Malay', 'Bahasa Melayu'],
  ['ml', 'Malayalam', 'മലയാളം'],
  ['mt', 'Maltese', 'Malti'],
  ['mi', 'Maori', 'Te Reo Māori'],
  ['mr', 'Marathi', 'मराठी'],
  ['mni-Mtei', 'Meiteilon (Manipuri)', 'ꯃꯤꯇꯩꯂꯣꯟ'],
  ['lus', 'Mizo', 'Mizo ṭawng'],
  ['mn', 'Mongolian', 'Монгол'],
  ['my', 'Myanmar (Burmese)', 'မြန်မာ'],
  ['ne', 'Nepali', 'नेपाली'],
  ['no', 'Norwegian', 'Norsk'],
  ['or', 'Odia (Oriya)', 'ଓଡ଼ିଆ'],
  ['om', 'Oromo', 'Afaan Oromoo'],
  ['ps', 'Pashto', 'پښتو'],
  ['fa', 'Persian', 'فارسی'],
  ['pl', 'Polish', 'Polski'],
  ['pt', 'Portuguese', 'Português'],
  ['pa', 'Punjabi', 'ਪੰਜਾਬੀ'],
  ['qu', 'Quechua', 'Runa Simi'],
  ['ro', 'Romanian', 'Română'],
  ['ru', 'Russian', 'Русский'],
  ['sm', 'Samoan', 'Gagana Sāmoa'],
  ['sa', 'Sanskrit', 'संस्कृतम्'],
  ['gd', 'Scots Gaelic', 'Gàidhlig'],
  ['nso', 'Sepedi', 'Sesotho sa Leboa'],
  ['sr', 'Serbian', 'Српски'],
  ['st', 'Sesotho', 'Sesotho'],
  ['sn', 'Shona', 'ChiShona'],
  ['sd', 'Sindhi', 'سنڌي'],
  ['si', 'Sinhala', 'සිංහල'],
  ['sk', 'Slovak', 'Slovenčina'],
  ['sl', 'Slovenian', 'Slovenščina'],
  ['so', 'Somali', 'Soomaali'],
  ['es', 'Spanish', 'Español'],
  ['su', 'Sundanese', 'Basa Sunda'],
  ['sw', 'Swahili', 'Kiswahili'],
  ['sv', 'Swedish', 'Svenska'],
  ['tg', 'Tajik', 'Тоҷикӣ'],
  ['ta', 'Tamil', 'தமிழ்'],
  ['tt', 'Tatar', 'Татар'],
  ['te', 'Telugu', 'తెలుగు'],
  ['th', 'Thai', 'ไทย'],
  ['ti', 'Tigrinya', 'ትግርኛ'],
  ['ts', 'Tsonga', 'Xitsonga'],
  ['tr', 'Turkish', 'Türkçe'],
  ['tk', 'Turkmen', 'Türkmençe'],
  ['ak', 'Twi (Akan)', 'Twi'],
  ['uk', 'Ukrainian', 'Українська'],
  ['ur', 'Urdu', 'اردو'],
  ['ug', 'Uyghur', 'ئۇيغۇرچە'],
  ['uz', 'Uzbek', 'Oʻzbekcha'],
  ['vi', 'Vietnamese', 'Tiếng Việt'],
  ['cy', 'Welsh', 'Cymraeg'],
  ['xh', 'Xhosa', 'isiXhosa'],
  ['yi', 'Yiddish', 'ייִדיש'],
  ['yo', 'Yoruba', 'Yorùbá'],
  ['zu', 'Zulu', 'isiZulu'],
].map(([code, name, native]) => ({ code, name, native }));

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

// Common aliases people (and other APIs) use for the same language.
const ALIASES = {
  iw: 'he', jw: 'jv', zh: 'zh-CN', 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW', 'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW', 'zh-hk': 'zh-TW', fil: 'tl', nb: 'no', nn: 'no', 'pt-br': 'pt', 'pt-pt': 'pt',
  'en-us': 'en', 'en-gb': 'en', kmr: 'ku', 'mni': 'mni-Mtei', 'sr-cyrl': 'sr', 'sr-latn': 'sr',
};

/** Normalise any language code to the canonical code used in this app ('auto' allowed). */
export function normalizeLang(code, { allowAuto = true } = {}) {
  if (code == null) return allowAuto ? 'auto' : null;
  const c = String(code).trim();
  if (!c || c.toLowerCase() === 'auto' || c.toLowerCase() === 'autodetect') return allowAuto ? 'auto' : null;
  const lower = c.toLowerCase().replace('_', '-');
  if (ALIASES[lower]) return ALIASES[lower];
  const hit = BY_CODE.get(lower);
  if (hit) return hit.code;
  const base = lower.split('-')[0];
  if (ALIASES[base]) return ALIASES[base];
  const baseHit = BY_CODE.get(base);
  return baseHit ? baseHit.code : null;
}

export function languageName(code) {
  if (!code || code === 'auto') return 'Detect language';
  const l = BY_CODE.get(String(code).toLowerCase());
  return l ? l.name : code;
}

export function isRtl(code) {
  return ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb'].includes(code);
}
