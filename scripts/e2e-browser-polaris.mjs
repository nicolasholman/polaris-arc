import { spawnSync } from 'node:child_process';
for(const file of ['hosted-config','hosted-business','hosted-landing','hosted-shop']){
 const result=spawnSync(process.execPath,['scripts/e2e-browser-hosted.mjs'],{stdio:'inherit',env:{...process.env,HOSTED_CONFIG:`docs/${file}.json`}});
 if(result.status)process.exitCode=1;
}
