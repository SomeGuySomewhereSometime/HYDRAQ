import os from 'node:os';
import path from 'node:path';
const rule=(action,effect='allow',resource='*')=>({action,resource,effect});
const inspectionCommands=['pwd','ls *','rg *','grep *','cat *','head *','tail *','wc *','stat *','file *','git status *','git diff *','git show *','git log *','git ls-files *'];

/** Let routine work proceed; unknown tools and explicit external/secret access still ask. */
export function openCodePermissions(context,{sandbox='workspace-write'}={}) {
  return [
    rule('*','ask'),
    ...['read','glob','grep','execute','skill','question','webfetch','websearch'].map(action=>rule(action)),
    ...(sandbox==='plan'?openCodePlanPermissions():[rule('edit'),rule('shell')]),
    rule('external_directory','ask'),
    rule('read','ask','*.env'),rule('read','ask','*.env.*'),rule('read','allow','*.env.example'),
    rule('hydraq_*','deny'),
    rule('subagent','deny'),
    ...(context?[...context.names.map(name=>rule(context.name+'_'+name)),rule('opencode_list_mcp_resources','allow',context.name),rule('opencode_read_mcp_resource','allow',context.name+':*')]:[])
  ];
}

/** Native Plan already restricts edits; preserve shell inspection when the TUI switches agents. */
export function openCodePlanPermissions(){return [rule('edit','deny'),rule('edit','allow',path.join(os.homedir(),'.opencode/plan/*')),rule('shell','ask'),...inspectionCommands.map(command=>rule('shell','allow',command))];}
