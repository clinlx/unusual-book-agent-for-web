'use strict';
const VFS = (typeof module !== 'undefined' && module.exports ? require('./shared/vfs.js') : VFSCore).create({
  "readableRoots": [
    "workspace",
    ".reference"
  ],
  "writableRoots": [
    "workspace"
  ],
  "binaryReadError": "该文件不能作为文本读取"
});
if (typeof module !== 'undefined' && module.exports) module.exports = VFS;
