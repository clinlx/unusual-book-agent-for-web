'use strict';
const FileWriteValidation = (() => {
  const normalize = key => String(key).replace(/[_\s-]/g, '').toLowerCase();
  const identityFields = new Set(['姓名','名称','Name','昵称','Nickname','性别','Gender','Sex',
    '职业','Occupation','Job','身份','Identity','Role','年龄','Age'].map(normalize));
  const annotation = /[（）()→]/;
  function annotations(value, path, found) {
    if (typeof value === 'string') { if (annotation.test(value)) found.push(path); }
    else if (Array.isArray(value)) value.forEach((item, i) => annotations(item, path + '[' + i + ']', found));
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      const next = path + '.' + key;
      if (annotation.test(key)) found.push(next);
      annotations(child, next, found);
    }
  }
  const retiredJournal = path => /(?:^|\/)(?:日志|物品日志|场景日志|世界日志)\.txt$/.test(String(path));
  function openingFiles(value) {
    const fail=()=>{throw Error('开局预读.json 必须为 {"version":1,"files":["工作目录内的文件路径"]}，最多 100 个路径，不支持外部地址、目录或越界路径');};
    if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!Array.isArray(value.files)||value.files.length>100)fail();
    return [...new Set(value.files.map(raw=>{
      if(typeof raw!=='string'||!raw.trim()||raw!==raw.trim()||/[\\:\u0000-\u001f?#]/.test(raw))fail();
      const relative=raw.replace(/^\/?workspace\//,'');
      if(relative.startsWith('/')||relative.split('/').some(p=>!p||['.','..','__proto__','prototype','constructor'].includes(p)))fail();
      return '/workspace/'+relative;
    }))].filter(path=>!retiredJournal(path));
  }
  function validate(path, content, metadata = {}) {
    const parts = String(path).split('/').filter(Boolean), file = parts.at(-1) || '';
    if (!/\.json$/i.test(file)) return;
    if (metadata.encoding === 'base64') throw Error('JSON 文件必须保存文本内容: ' + path);
    if(file==='世界触发器.json'){
      const rules=typeof module!=='undefined'&&module.exports?require('../../skills/game-world-builder/scripts/world-trigger-rules.js'):WorldTriggerRules;
      rules.parse(content);
    }
    if (!content.trim()) {if(file==='开局预读.json')openingFiles(null);return;}
    let value;
    try { value = JSON.parse(content.replace(/^\uFEFF/, '')); }
    catch (error) {
      throw Error('JSON 格式错误: ' + path + '。' + error.message + '。请提交完整合法的 JSON；大文件可先分段写入 .txt，完成后再改为 .json。本次修改未写入。');
    }
    if(file==='开局预读.json')openingFiles(value);
    if (/^Player-.+/i.test(parts.at(-2) || '') && /^基础信息\.json$/i.test(file)
      && value && typeof value === 'object' && !Array.isArray(value)) {
      const found = [];
      for (const [key, child] of Object.entries(value)) if (identityFields.has(normalize(key))) annotations(child, key, found);
      if (found.length) throw Error('玩家身份字段含注释: ' + [...new Set(found)].join('、')
        + '。姓名、性别、年龄、职业和身份只填写当前值，括号或 → 中的历史与解释请精简移入相关记忆或相应隐藏字段。本次修改未写入。');
    }
    if (/^(背包|场景物品列表)\.json$/i.test(file) && Array.isArray(value)) {
      const ids = new Map();
      value.forEach((id, i) => { if (typeof id === 'string') { if (!ids.has(id)) ids.set(id, []); ids.get(id).push(i); } });
      const duplicates = [...ids].filter(([, positions]) => positions.length > 1);
      if (duplicates.length) throw Error('物品列表存在重复 ID: ' + path + '；'
        + duplicates.map(([id, positions]) => JSON.stringify(id) + '（下标 ' + positions.join('、') + '）').join('；')
        + '。同一列表的 ID 必须唯一，多件同类物品使用数量/余量，不同实例使用不同 ID 并建立索引。本次修改未写入。');
    }
  }
  return { validate, openingFiles, retiredJournal };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FileWriteValidation;
