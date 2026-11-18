'use strict';
// Keep existing command and MCP configurations working.
const entry=require('./src/server.cjs');
if(require.main===module)entry.serve();
module.exports=entry;
