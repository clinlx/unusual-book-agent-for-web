'use strict';
const WorkspaceImport = (typeof module !== 'undefined' && module.exports
  ? require('../shared/workspace-import.js').create(require('./vfs.js'), require('./zip.js'))
  : WorkspaceImportCore.create(VFS, ZIP));
if (typeof module !== 'undefined' && module.exports) module.exports = WorkspaceImport;
