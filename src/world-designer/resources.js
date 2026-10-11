'use strict';
const DesignerResources = (() => {
  const loader = typeof module !== 'undefined' && module.exports ? require('./skill-loader.js') : SkillLoader;
  const names = Object.freeze(['write-novel', 'desire-analysis', 'grilling', 'game-world-builder']);
  const isRequired = name => name === 'game-world-builder';
  function installed(skills) {
    return (skills || []).filter(skill => names.includes(skill.name))
      .map(skill => ({ ...skill, special: isRequired(skill.name), required: isRequired(skill.name) }))
      .sort((a, b) => Number(b.required) - Number(a.required));
  }
  const active = (skills, disabled = new Set()) => installed(skills).filter(skill => skill.required || !disabled.has(skill.name));
  function worldBuilderDownload(snapshot){
    const prefix='skills/game-world-builder/';
    if(!snapshot?.[prefix+'SKILL.md'])throw Error('World Builder 技能尚未加载');
    return Object.entries(snapshot).filter(([path])=>path.startsWith(prefix)&&!path.slice(prefix.length).split('/').some(p=>!p||p==='.'||p==='..'))
      .map(([path,text])=>({name:'game-world-builder/'+path.slice(prefix.length),text}));
  }

  async function load({ href, fetchFn, snapshot, standalone = false }) {
    async function read(get, origin) {
      let complete = true;
      const fetchResource = async (file, as) => {
        try { return await get(file, as); }
        catch (error) { complete = false; throw error; }
      };
      const report = await loader.loadAll(async (file, as) => {
        if (file === loader.ENABLE_LIST) {
          const parsed = loader.parseEnableList(await fetchResource(file, 'json'));
          return names.filter(name => parsed.names.includes(name));
        }
        const parts = file.split('/');
        if (parts[0] !== 'skills' || !names.includes(parts[1]) || parts.includes('..'))
          throw Error('技能资源不属于世界设计者');
        return fetchResource(file, as);
      });
      report.skills = installed(report.skills);
      for (const skill of report.skills) if (skill.required) {
        skill.warnings = (skill.warnings || []).filter(message => !message.includes('本环境不执行脚本'));
      }
      report.warnings = report.warnings.filter(message => !(message.startsWith('game-world-builder:') && message.includes('本环境不执行脚本')));
      return { ...report, origin, complete };
    }
    if (!standalone && /^https?:/i.test(href) && fetchFn) {
      const base = new URL('./world-designer/', href).href;
      const report = await read(loader.createFetcher(fetchFn, base), 'external');
      if (report.complete && !report.errors.length && names.every(name => report.skills.some(skill => skill.name === name))) return report;
    }
    return read(loader.createBundleFetcher(snapshot), 'bundled');
  }
  return { names, load, installed, active, isRequired, worldBuilderDownload };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DesignerResources;
