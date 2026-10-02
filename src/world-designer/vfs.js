'use strict';
const VFS = (typeof module !== 'undefined' && module.exports ? require('../shared/vfs.js') : VFSCore).create({
  "readableRoots": [
    "workspace",
    "skills",
    "tmp"
  ],
  "writableRoots": [
    "workspace",
    "tmp"
  ],
  "binaryReadError": "非文本文件：read_file 只能读取文本。图片可在多模态开启时使用 view_image；其他格式暂不支持解析，可保存或下载。"
});
if (typeof module !== 'undefined' && module.exports) module.exports = VFS;
