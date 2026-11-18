'use strict';
// Keep existing command and MCP configurations working.
const entry=require('./src/desktop-patch.cjs');
if(require.main===module)entry.run();
module.exports=entry;
