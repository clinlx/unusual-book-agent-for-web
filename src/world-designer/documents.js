'use strict';
const Documents = (() => {
  const vfs = typeof module !== 'undefined' && module.exports ? require('./vfs') : VFS;
  const images = typeof module !== 'undefined' && module.exports ? require('./images') : Images;
  const runtime = () => typeof DocumentRuntime !== 'undefined' ? DocumentRuntime : null;
  const supported = name => /\.(pdf|docx)$/i.test(name);
  function safePath(value) {
    if (typeof value !== 'string' || !/^\/(workspace|tmp)\//.test(value) || /[\\:\u0000-\u001f]/.test(value)
      || value.split('/').slice(1).some(p => !p || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(p)))
      throw Error('文档与输出路径必须位于 /workspace/ 或 /tmp/，不能包含越界路径');
    return value;
  }
  function pages(total, args) {
    const start = args.start_page ?? 1, end = args.end_page ?? Math.min(total, start + (args.format === 'images' ? 4 : 19));
    const max = args.format === 'images' ? 5 : 100;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total || end - start + 1 > max)
      throw Error('页码范围无效：文档共 ' + total + ' 页，本次最多 ' + max + ' 页');
    return { start_page: start, end_page: end, total_pages: total, next_page: end < total ? end + 1 : null };
  }
  async function parse(tree, args, options = {}) {
    const path = safePath(args.path);
    if (!supported(path)) throw Error('文档解析仅支持 PDF 和 DOCX');
    if (!['text', 'images'].includes(args.format) || !['return', 'file'].includes(args.output)) throw Error('format 必须为 text/images，output 必须为 return/file');
    const source = vfs.resolve(tree, vfs.normalize(path));
    if (!source || source.type !== 'file') throw Error('文档文件不存在: ' + path);
    const sourceSize = source.encoding === 'base64' ? source.content.length * 3 / 4 - (source.content.endsWith('==') ? 2 : source.content.endsWith('=') ? 1 : 0) : new TextEncoder().encode(source.content).length;
    if (sourceSize > 50 * 1024 * 1024) throw Error('文档超过 50 MiB 解析上限');
    let target;
    if (args.output === 'file') {
      target = safePath(args.format === 'text' ? args.output_path : args.output_dir);
      if (args.format === 'images' && vfs.resolve(tree, vfs.normalize(target))?.type === 'file') throw Error('图片输出位置必须是目录');
      if (args.offset !== undefined || args.limit !== undefined) throw Error('offset/limit 仅用于直接返回文字');
    }
    if (args.format === 'images' && (args.offset !== undefined || args.limit !== undefined)) throw Error('图片模式不能使用 offset/limit');
    const offset = args.offset ?? 0, limit = args.limit ?? 32000;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 120000) throw Error('offset/limit 无效，limit 上限 120000');
    const content = source.content, encoding = source.encoding;
    const check = () => {
      if (options.signal?.aborted) throw new DOMException('文档解析已中止', 'AbortError');
      if (vfs.resolve(tree, vfs.normalize(path)) !== source || source.content !== content || source.encoding !== encoding) throw Error('源文档已变化，请重新解析');
      options.checkActive?.();
    };
    check();
    const backend = options.runtime || runtime();
    if (!backend) throw Error('文档解析器尚未加载');
    const bytes = vfs.fileBytes(source);
    const type = /\.pdf$/i.test(path) ? 'pdf' : 'docx';
    const parsed = await backend[type](bytes, args, { pages, check, signal: options.signal });
    check();
    const result = { source: path, format: args.format, output: args.output, ...parsed.info };
    if (args.format === 'text') {
      const text = parsed.text;
      result.total_characters = text.length;
      if (!text.trim()) result.note = '没有可提取的文字；扫描件请使用 images 模式查看。';
      if (args.output === 'return') {
        Object.assign(result, { text: text.slice(offset, offset + limit), offset, truncated: offset + limit < text.length,
          next_offset: offset + limit < text.length ? offset + limit : null });
      } else {
        if (vfs.resolve(tree, vfs.normalize(target))) throw Error('输出文件已存在，请选择其他路径: ' + target);
        vfs.writeFile(tree, target, text); result.path = target;
      }
      return { result: JSON.stringify(result) };
    }
    result.pages = parsed.images.map(image => ({ page: image.page, width: image.width, height: image.height }));
    if (args.output === 'return') return { result: JSON.stringify(result), images: parsed.images };
    const files = parsed.images.map(image => ({ image, path: target + '/page-' + String(image.page).padStart(4, '0') + '.png' }));
    for (const file of files) if (vfs.resolve(tree, vfs.normalize(file.path))) throw Error('输出文件已存在，请选择其他目录: ' + file.path);
    const copy = vfs.clone(tree);
    for (const file of files) {
      const { originalDataUrl, ...prepared } = file.image;
      images.store(copy, file.path, images.fromDataUrl(originalDataUrl || prepared.dataUrl), prepared);
    }
    check(); Object.assign(tree, copy);
    result.pages.forEach((page, i) => { page.path = files[i].path; });
    return { result: JSON.stringify(result) };
  }
  return { parse, supported, safePath, pages };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Documents;
