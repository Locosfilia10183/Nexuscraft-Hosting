'use strict';
// NEXUSCRAFT Hosting-Agent (Windows/Linux/Mac, Node >= 20; ZIP-Modpacks benötigen yauzl).
// Standardmäßig Loopback; jede Anfrage braucht den Token. Keine frei wählbaren Shell-Befehle.
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {spawn,spawnSync}=require('child_process');
let yauzl=null;try{yauzl=require('yauzl')}catch(e){}
try{require('dotenv').config({path:process.env.ENV_FILE||path.join(__dirname,'..','.env')})}catch(e){}
const PORT=+process.env.AGENT_PORT||3100, HOST=process.env.AGENT_HOST||'127.0.0.1', JAVA=process.env.JAVA_BIN||'java';
const API=process.env.PAPER_API||'https://fill.papermc.io/v3/projects';
const MODRINTH='https://api.modrinth.com/v2';
const ROOT=process.env.AGENT_HOME||__dirname, SRV=path.join(ROOT,'servers'), BAK=path.join(ROOT,'backups');
const CFG=path.join(ROOT,'agent-config.json'), META=path.join(ROOT,'servers.json');
const MAX_SERVERS=5, CMDS=['list','say','whitelist','gamemode','difficulty','time','weather','save-all','op','deop','kick','ban','pardon','ban-ip','pardon-ip','tp','give'];
[SRV,BAK].forEach(d=>fs.mkdirSync(d,{recursive:true}));
let cfg={};try{cfg=JSON.parse(fs.readFileSync(CFG,'utf8'))}catch(e){}
if(!cfg.token){cfg.token=crypto.randomBytes(24).toString('hex');fs.writeFileSync(CFG,JSON.stringify(cfg));console.log('Neuer Token (geheim halten, nicht teilen):\n'+cfg.token)}
let meta={};try{meta=JSON.parse(fs.readFileSync(META,'utf8'))}catch(e){}
const saveMeta=()=>fs.writeFileSync(META,JSON.stringify(meta));
const run={}; // id -> {proc,log,status,startedAt,restarts,stopping}
const ID=/^[a-z0-9]{1,32}$/;
function javaInfo(){const r=spawnSync(JAVA,['-version'],{encoding:'utf8',timeout:5000});if(r.error||r.status!==0)return{found:false};const m=/version "([^"]+)"/.exec(r.stderr||'');return{found:true,version:m?m[1]:'?'}}
const usedRam=()=>Object.keys(run).filter(i=>run[i].proc).reduce((a,i)=>a+(meta[i]?meta[i].ram:0),0);
function log(id,l){const r=run[id];if(!r)return;r.log.push(...String(l).split(/\r?\n/).filter(Boolean));if(r.log.length>500)r.log.splice(0,r.log.length-500)}

const cpuSamples={};
function sampleCpu(id){
 const r=run[id];if(!r||!r.proc||!r.proc.pid)return null;
 let seconds=null;
 try{
  if(process.platform==='win32'){const x=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-Process -Id "+Number(r.proc.pid)+" -ErrorAction Stop).CPU"],{encoding:'utf8',timeout:3000});if(x.status===0)seconds=Number(String(x.stdout).trim())}
  else {const x=spawnSync('ps',['-p',String(r.proc.pid),'-o','%cpu='],{encoding:'utf8',timeout:3000});if(x.status===0){const n=Number(String(x.stdout).trim());return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n*10)/10)):null}}
 }catch(e){}
 if(!Number.isFinite(seconds))return null;
 const now=Date.now(),old=cpuSamples[id];cpuSamples[id]={seconds,at:now};
 if(!old||now<=old.at)return null;
 return Math.max(0,Math.min(100,Math.round(((seconds-old.seconds)/((now-old.at)/1000)/os.cpus().length)*1000)/10));
}
function recordPlayers(id){
 const r=run[id];if(!r)return;
 const lines=r.log.slice(-40).join('\n'),m=lines.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online(?::\s*(.*))?/i);
 if(!m)return;
 const arr=meta[id].playerHistory=meta[id].playerHistory||[];
 arr.push({at:Date.now(),count:+m[1],max:+m[2],players:m[3]?m[3].split(',').map(x=>x.trim()).filter(Boolean):[]});
 if(arr.length>240)arr.splice(0,arr.length-240);saveMeta();
}
function info(id){const m=meta[id],r=run[id];return{id,name:m.name,version:m.version,ram:m.ram,port:m.port,status:r&&r.status||(m.installed?'stopped':'installing'),startedAt:r&&r.status==='running'?r.startedAt:null,error:m.error||null}}
async function getJson(url){const r=await fetch(url,{headers:{'User-Agent':'NEXUSCRAFT/1.0 (local server manager)'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('Download-API antwortet mit HTTP '+r.status);return r.json()}
async function download(url,dest,sha){const r=await fetch(url,{headers:{'User-Agent':'NEXUSCRAFT/1.0'},signal:AbortSignal.timeout(300000)});if(!r.ok)throw new Error('Download fehlgeschlagen (HTTP '+r.status+')');const buf=Buffer.from(await r.arrayBuffer());if(!buf.length||buf.length>300*1024*1024)throw new Error('Ungültige oder zu große Serverdatei');if(sha){const alg=sha.length===40?'sha1':sha.length===128?'sha512':'sha256';if(crypto.createHash(alg).update(buf).digest('hex')!==sha)throw new Error(alg.toUpperCase()+'-Prüfsumme stimmt nicht')}fs.writeFileSync(dest,buf)}

function runInstaller(jar,args,dir,timeout=900000){
 const r=spawnSync(JAVA,['-jar',jar,...args],{cwd:dir,encoding:'utf8',timeout,windowsHide:true,maxBuffer:16*1024*1024});
 if(r.error)throw new Error('Installer konnte nicht gestartet werden: '+r.error.message);
 if(r.status!==0)throw new Error('Installer fehlgeschlagen: '+String(r.stderr||r.stdout||'').slice(-1200));
}
async function installForge(m,dir){
 const promotions=await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
 const mc=m.version, chosen=m.loaderVersion||promotions.promos[mc+'-recommended']||promotions.promos[mc+'-latest'];
 if(!chosen)throw new Error('Für Minecraft '+mc+' wurde keine Forge-Version gefunden');
 const fv=chosen, full=mc+'-'+fv, url='https://maven.minecraftforge.net/net/minecraftforge/forge/'+full+'/forge-'+full+'-installer.jar';
 const jar=path.join(dir,'forge-installer.jar');await download(url,jar);
 runInstaller(jar,['--installServer'],dir);fs.rmSync(jar,{force:true});
 const runbat=path.join(dir,'run.bat');let text='';try{text=fs.readFileSync(runbat,'utf8')}catch(e){}
 const match=text.match(/@((?:libraries[\\/])[^\r\n"]+\.txt)/i);
 if(match)m.launchArgsFile=match[1].replace(/\\/g,path.sep);
 else {const candidates=[];function walk(d,depth){if(depth>8)return;for(const x of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,x.name);if(x.isDirectory())walk(f,depth+1);else if(/(?:win|unix)_args\.txt$/i.test(x.name))candidates.push(f)}}walk(path.join(dir,'libraries'),0);if(candidates.length)m.launchArgsFile=path.relative(dir,candidates[0])}
 if(!m.launchArgsFile)throw new Error('Forge wurde installiert, aber keine Start-Argumentdatei gefunden. Bitte Installationsordner prüfen.');
 m.loaderVersion=fv;
}
async function installNeoForge(m,dir){
 const mc=m.version, major=Number((mc.match(/^1\.(\d+)/)||[])[1]||0);
 if(!major)throw new Error('Minecraft-Version für NeoForge ungültig');
 const meta=await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
 const versions=(meta.versions||[]).filter(x=>x.startsWith(String(major)+'.')).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
 if(!versions.length)throw new Error('Keine NeoForge-Version für Minecraft '+mc+' gefunden');
 const nv=(m.loaderVersion&&versions.includes(m.loaderVersion)?m.loaderVersion:versions[0]),url='https://maven.neoforged.net/releases/net/neoforged/neoforge/'+nv+'/neoforge-'+nv+'-installer.jar';
 const jar=path.join(dir,'neoforge-installer.jar');await download(url,jar);
 runInstaller(jar,['--install-server'],dir);fs.rmSync(jar,{force:true});
 const runbat=path.join(dir,'run.bat');let text='';try{text=fs.readFileSync(runbat,'utf8')}catch(e){}
 const match=text.match(/@((?:libraries[\\/])[^\r\n"]+\.txt)/i);
 if(match)m.launchArgsFile=match[1].replace(/\\/g,path.sep);
 else {const candidates=[];function walk(d,depth){if(depth>8)return;for(const x of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,x.name);if(x.isDirectory())walk(f,depth+1);else if(/(?:win|unix)_args\.txt$/i.test(x.name))candidates.push(f)}}walk(path.join(dir,'libraries'),0);if(candidates.length)m.launchArgsFile=path.relative(dir,candidates[0])}
 if(!m.launchArgsFile)throw new Error('NeoForge installiert, aber Start-Argumentdatei fehlt.');
 m.loaderVersion=nv;
}
function safeArchivePath(name){
 const v=String(name).replace(/\\/g,'/');
 if(!v||v.startsWith('/')||/^[a-z]:/i.test(v)||v.split('/').includes('..'))throw new Error('ZIP enthält einen unsicheren Dateipfad: '+v);
 const low=v.toLowerCase();
 if(['server.jar','run.bat','start.bat','.env','agent-config.json'].includes(low))throw new Error('ZIP darf keine geschützte Server-/Konfigurationsdatei überschreiben: '+v);
 return v;
}
function extractZip(zip,dest){
 if(!yauzl)throw new Error('ZIP-Bibliothek fehlt. Bitte npm install ausführen.');
 return new Promise((resolve,reject)=>{
  yauzl.open(zip,{lazyEntries:true,decodeStrings:true,validateEntrySizes:true},(err,zf)=>{
   if(err)return reject(err);let total=0,count=0,finished=false;
   const fail=e=>{if(finished)return;finished=true;try{zf.close()}catch(x){}reject(e)};
   zf.on('error',fail);
   zf.on('end',()=>{if(!finished){finished=true;resolve()}});
   zf.on('entry',entry=>{
    if(finished)return;
    try{
     count++;if(count>10000)throw new Error('ZIP enthält zu viele Dateien');
     const rel=safeArchivePath(entry.fileName),mode=(entry.externalFileAttributes>>>16)&0xF000;
     if(mode===0xA000)throw new Error('ZIP-Symlinks sind nicht erlaubt');
     total+=Number(entry.uncompressedSize||0);if(total>2*1024*1024*1024)throw new Error('Modpack entpackt größer als 2 GB');
     const target=path.resolve(dest,rel),base=path.resolve(dest);if(target!==base&&!target.startsWith(base+path.sep))throw new Error('ZIP-Pfad verlässt das Zielverzeichnis');
     if(rel.endsWith('/')||mode===0x4000){fs.mkdirSync(target,{recursive:true});zf.readEntry();return}
     fs.mkdirSync(path.dirname(target),{recursive:true});
     zf.openReadStream(entry,(e,rs)=>{
      if(e)return fail(e);
      const ws=fs.createWriteStream(target,{flags:'w'});
      rs.on('error',fail);ws.on('error',fail);ws.on('finish',()=>zf.readEntry());rs.pipe(ws);
     });
    }catch(e){fail(e)}
   });
   zf.readEntry();
  });
 });
}
async function applyModrinthPack(id,b){
 const m=meta[id],dir=path.join(SRV,id);if(run[id]&&run[id].proc)throw new Error('Server vor Modpack-Installation stoppen');
 if(!b.archiveBase64||typeof b.archiveBase64!=='string'||b.archiveBase64.length>350*1024*1024)throw new Error('Modpack-Archiv fehlt oder ist größer als 250 MB');
 const tmp=path.join(dir,'.modpack-'+crypto.randomBytes(5).toString('hex')+'.mrpack'),stage=path.join(dir,'.modpack-stage-'+crypto.randomBytes(5).toString('hex'));
 fs.writeFileSync(tmp,Buffer.from(b.archiveBase64,'base64'));
 try{
  const backupFile=await backup(id);await extractZip(tmp,stage);
  const index=JSON.parse(fs.readFileSync(path.join(stage,'modrinth.index.json'),'utf8'));
  if(index.game!=='minecraft'||!index.dependencies||!Array.isArray(index.files))throw new Error('Ungültiges Modrinth-Modpack');
  const mc=index.dependencies.minecraft;if(!/^1\.\d+(\.\d+)?$/.test(mc||''))throw new Error('Minecraft-Version fehlt oder ungültig');
  const loaders=Object.keys(index.dependencies).filter(x=>['fabric-loader','forge','neoforge','quilt-loader'].includes(x));
  if(!loaders.length)throw new Error('Kein unterstützter Server-Loader im Modpack gefunden');
  const loader=loaders[0],software=loader==='fabric-loader'?'fabric':loader==='quilt-loader'?'quilt':loader;
  m.version=mc;m.software=software;m.launchArgsFile=null;m.loaderVersion=index.dependencies[loader];
  fs.rmSync(path.join(dir,'mods'),{recursive:true,force:true});
  await installBase(m,dir);
  for(const f of index.files){
   if(!f.downloads||!f.downloads.length)continue;
   const rel=String(f.path||'').replace(/\\/g,'/');if(rel.startsWith('/')||/^[a-z]:/i.test(rel)||rel.split('/').includes('..')||['server.jar','run.bat','agent-config.json','.env'].includes(rel.toLowerCase()))throw new Error('Unsicherer Modpack-Dateipfad');
   const target=path.resolve(dir,rel),base=path.resolve(dir);if(!target.startsWith(base+path.sep))throw new Error('Modpack-Dateipfad verlässt den Serverordner');fs.mkdirSync(path.dirname(target),{recursive:true});
   const u=f.downloads.find(x=>/^https:\/\//.test(x));if(!u)throw new Error('Keine sichere Download-URL für '+rel);
   const host=new URL(u).hostname;if(!(host==='cdn.modrinth.com'||host.endsWith('.modrinth.com')))throw new Error('Modpack-Datei verweist auf einen nicht freigegebenen Download-Host: '+host);
   const hash=f.hashes&&(f.hashes.sha1||f.hashes.sha512);await download(u,target,hash);
  }
  const over=path.join(stage,'overrides'),serverOver=path.join(stage,'server-overrides');
  const source=fs.existsSync(serverOver)?serverOver:over;
  if(fs.existsSync(source)){fs.cpSync(source,dir,{recursive:true,force:true})}
  let projectId=b.projectId||null;if(!projectId&&index.versionId){try{const vi=await getJson(MODRINTH+'/version/'+encodeURIComponent(index.versionId));projectId=vi.project_id||null}catch(e){}}
  m.modpack={platform:'modrinth',name:index.name||'Modrinth Modpack',version:index.versionId||'',projectId,installedAt:Date.now(),backupBefore:backupFile};
  saveMeta();return {ok:true,modpack:m.modpack,loader:software,minecraft:mc,files:index.files.length,backup:backupFile};
 }finally{fs.rmSync(tmp,{force:true});fs.rmSync(stage,{recursive:true,force:true})}
}
async function applyCurseForgePack(id,b){
 const m=meta[id],dir=path.join(SRV,id);if(run[id]&&run[id].proc)throw new Error('Server vor Modpack-Installation stoppen');
 const key=process.env.CURSEFORGE_API_KEY;if(!key)throw new Error('CURSEFORGE_API_KEY fehlt. API-Key in der Server-Umgebung eintragen.');
 let mf=b.manifest,stage=null;
 if(b.archiveBase64){
  if(typeof b.archiveBase64!=='string'||b.archiveBase64.length>350*1024*1024)throw new Error('CurseForge-Archiv fehlt oder ist zu groß');
  stage=path.join(dir,'.curseforge-stage-'+crypto.randomBytes(5).toString('hex'));const zf=path.join(dir,'.curseforge-'+crypto.randomBytes(5).toString('hex')+'.zip');
  fs.writeFileSync(zf,Buffer.from(b.archiveBase64,'base64'));
  try{await extractZip(zf,stage);mf=JSON.parse(fs.readFileSync(path.join(stage,'manifest.json'),'utf8'))}finally{fs.rmSync(zf,{force:true})}
 }
 if(!mf||!mf.minecraft||!Array.isArray(mf.files))throw new Error('Ungültiges CurseForge-Manifest');
 const mc=String(mf.minecraft.version||'');if(!/^1\.\d+(\.\d+)?$/.test(mc))throw new Error('Minecraft-Version ungültig');
 const backupFile=await backup(id),loader=(mf.minecraft.modLoaders||[]).find(x=>x.primary)||((mf.minecraft.modLoaders||[])[0]);
 if(loader){if(loader.id.startsWith('forge-')){m.software='forge';m.loaderVersion=loader.id.slice(6)}else if(loader.id.startsWith('neoforge-')){m.software='neoforge';m.loaderVersion=loader.id.slice(9)}else if(loader.id.startsWith('fabric-')){m.software='fabric';m.loaderVersion=loader.id.slice(7)}}
 m.version=mc;m.launchArgsFile=null;fs.rmSync(path.join(dir,'mods'),{recursive:true,force:true});await installBase(m,dir);
 for(const f of mf.files){
  if(f.required===false)continue;
  const r=await fetch('https://api.curseforge.com/v1/mods/'+Number(f.projectID)+'/files/'+Number(f.fileID)+'/download-url',{headers:{'x-api-key':key,'Accept':'application/json'},signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('CurseForge Download-API Fehler HTTP '+r.status);
  const j=await r.json(),u=j.data;if(!u||!/^https:\/\//.test(u))throw new Error('CurseForge liefert keine Download-URL');
  const host=new URL(u).hostname;if(!(host.endsWith('.forgecdn.net')||host==='forgecdn.net'))throw new Error('Nicht freigegebener CurseForge-Download-Host: '+host);
  const name=path.basename(new URL(u).pathname);if(!/^[a-z0-9_. -]+$/i.test(name))throw new Error('Ungültiger CurseForge-Dateiname');
  const dest=path.join(dir,'mods',name);fs.mkdirSync(path.dirname(dest),{recursive:true});await download(u,dest);
 }
 if(stage){const over=path.join(stage,'overrides');if(fs.existsSync(over))fs.cpSync(over,dir,{recursive:true,force:true});fs.rmSync(stage,{recursive:true,force:true})}
 m.modpack={platform:'curseforge',name:mf.name||'CurseForge Modpack',version:mf.version||'',installedAt:Date.now(),backupBefore:backupFile};saveMeta();
 return {ok:true,modpack:m.modpack,loader:m.software,minecraft:mc,files:mf.files.length,backup:backupFile};
}

async function installBase(m,dir){const v=encodeURIComponent(m.version),sw=String(m.software||'paper').toLowerCase();
 if(sw==='paper'||sw==='folia'){const project=sw==='folia'?'folia':'paper';const b=await getJson(`${API}/${project}/versions/${v}/builds/latest`);const d=b.downloads&&b.downloads['server:default'];if(!d||!d.url)throw new Error('Keine passende '+sw+'-Version gefunden');await download(d.url,path.join(dir,'server.jar'),d.checksums&&d.checksums.sha256);return}
 if(sw==='purpur'){const b=await getJson(`https://api.purpurmc.org/v2/purpur/${v}/latest`);await download(`https://api.purpurmc.org/v2/purpur/${v}/${b.build}/download`,path.join(dir,'server.jar'));return}
 if(sw==='vanilla'){const manifest=await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');const entry=manifest.versions.find(x=>x.id===m.version);if(!entry)throw new Error('Minecraft-Version nicht im Mojang-Manifest');const meta=await getJson(entry.url);if(!meta.downloads||!meta.downloads.server)throw new Error('Vanilla-Serverdatei fehlt');await download(meta.downloads.server.url,path.join(dir,'server.jar'),meta.downloads.server.sha1);return}
 if(sw==='fabric'||sw==='quilt'){const base=sw==='fabric'?'https://meta.fabricmc.net/v2/versions/loader':'https://meta.quiltmc.org/v3/versions/loader';const loaders=await getJson(`${base}/${v}`);if(!loaders.length)throw new Error('Kein '+sw+'-Loader für diese Minecraft-Version');const loader=(m.loaderVersion&&loaders.find(x=>x.loader.version===m.loaderVersion)?m.loaderVersion:loaders[0].loader.version);const installer=sw==='fabric'?'1.0.1':'0.10.2';const url=sw==='fabric'?`${base}/${v}/${loader}/${installer}/server/jar`:`${base}/${v}/${loader}/${installer}/server/jar`;await download(url,path.join(dir,'server.jar'));m.loaderVersion=loader;return}
 if(sw==='forge'){await installForge(m,dir);return}
 if(sw==='neoforge'){await installNeoForge(m,dir);return}
 if(sw==='spigot')throw new Error('Spigot benötigt BuildTools (separater Build-Prozess); automatische Installation ist noch nicht freigegeben.');
 throw new Error('Unbekannte Server-Software: '+sw)
}
async function installCrossplay(m,dir){if(!m.crossplay)return;const sw=String(m.software||'paper').toLowerCase();if(!['paper','purpur','folia','spigot'].includes(sw))throw new Error('Geyser/Floodgate werden hier nur für Paper/Purpur/Folia/Spigot angeboten.');
 const plugins=path.join(dir,'plugins');fs.mkdirSync(plugins,{recursive:true});
 for(const slug of ['geyser','floodgate']){const versions=await getJson(`${MODRINTH}/project/${slug}/version?loaders=%5B%22paper%22%5D&game_versions=${encodeURIComponent(JSON.stringify([m.version]))}`);if(!versions.length)throw new Error('Kein kompatibles '+slug+'-Plugin für Minecraft '+m.version+' gefunden');const ver=versions[0],file=ver.files.find(x=>x.primary)||ver.files[0];if(!file||!file.url)throw new Error('Plugin-Datei für '+slug+' fehlt');await download(file.url,path.join(plugins,file.filename),file.hashes&&file.hashes.sha256)}
 m.crossplayInstalled=true;
}

async function installModrinthProject(id,slug){
 const versions=await getJson(MODRINTH+'/project/'+encodeURIComponent(slug)+'/version');
 const ver=(versions||[]).find(v=>(v.files||[]).some(f=>/\.mrpack$/i.test(f.filename)))||(versions||[])[0];
 if(!ver)throw new Error('Für dieses Modrinth-Modpack wurde keine Version gefunden');
 const file=(ver.files||[]).find(f=>/\.mrpack$/i.test(f.filename))||(ver.files||[]).find(f=>f.primary)||(ver.files||[])[0];
 if(!file||!file.url)throw new Error('Kein herunterladbares .mrpack gefunden');
 const dir=path.join(SRV,id),tmp=path.join(dir,'.selected-modpack.mrpack');
 await download(file.url,tmp,file.hashes&&file.hashes.sha1);
 try{return await applyModrinthPack(id,{archiveBase64:fs.readFileSync(tmp).toString('base64'),projectId:ver.project_id||slug})}
 finally{fs.rmSync(tmp,{force:true})}
}
async function installCurseForgeProject(id,projectId,fileId){
 const key=process.env.CURSEFORGE_API_KEY;if(!key)throw new Error('CURSEFORGE_API_KEY fehlt');
 const r=await fetch('https://api.curseforge.com/v1/mods/'+Number(projectId)+'/files/'+Number(fileId)+'/download-url',{headers:{'x-api-key':key,'Accept':'application/json'},signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new Error('CurseForge Download-API HTTP '+r.status);
 const j=await r.json(),url=j.data;if(!url||!/^https:\/\//.test(url))throw new Error('Für diese CurseForge-Version gibt es keine Download-URL (evtl. nicht freigegeben)');
 const host=new URL(url).hostname;if(!(host.endsWith('.forgecdn.net')||host==='forgecdn.net'))throw new Error('Nicht freigegebener CurseForge-Download-Host: '+host);
 const dir=path.join(SRV,id),tmp=path.join(dir,'.selected-curseforge.zip');await download(url,tmp);
 try{return await applyCurseForgePack(id,{archiveBase64:fs.readFileSync(tmp).toString('base64')})}
 finally{fs.rmSync(tmp,{force:true})}
}
async function checkModpackUpdate(id){
 const m=meta[id],pack=m.modpack;if(!pack||pack.platform!=='modrinth'||!pack.projectId)return {supported:false,message:'Für automatische Updates ist ein Modrinth-Modpack mit Projekt-ID erforderlich. CurseForge kann per neuer Export-ZIP manuell aktualisiert werden.'};
 const loaders=['fabric','forge','neoforge','quilt'].includes(m.software)?[m.software]:[];
 const q=MODRINTH+'/project/'+encodeURIComponent(pack.projectId)+'/version?game_versions='+encodeURIComponent(JSON.stringify([m.version]))+(loaders.length?'&loaders='+encodeURIComponent(JSON.stringify(loaders)):'');
 const versions=await getJson(q),latest=(versions||[]).find(v=>(v.files||[]).some(f=>/\.mrpack$/i.test(f.filename)));
 return {supported:true,available:!!latest&&latest.id!==pack.version,current:pack.version,latest:latest?latest.id:null,version:latest?latest.version_number:null};
}
async function updateModrinthPack(id){
 const m=meta[id],pack=m.modpack;if(!pack||pack.platform!=='modrinth'||!pack.projectId)throw new Error('Automatisches Update für dieses Modpack nicht verfügbar');
 const loaders=['fabric','forge','neoforge','quilt'].includes(m.software)?[m.software]:[];
 const query=MODRINTH+'/project/'+encodeURIComponent(pack.projectId)+'/version?game_versions='+encodeURIComponent(JSON.stringify([m.version]))+(loaders.length?'&loaders='+encodeURIComponent(JSON.stringify(loaders)):'');
 const versions=await getJson(query);
 const latest=(versions||[]).find(v=>(v.files||[]).some(f=>/\.mrpack$/i.test(f.filename)));
 if(!latest||latest.id===pack.version)return {updated:false};
 const file=latest.files.find(f=>/\.mrpack$/i.test(f.filename)),tmp=path.join(SRV,id,'.modpack-update.mrpack');
 await download(file.url,tmp,file.hashes&&file.hashes.sha1);
 try{const r=await applyModrinthPack(id,{archiveBase64:fs.readFileSync(tmp).toString('base64'),projectId:pack.projectId});return Object.assign({updated:true},r)}
 finally{fs.rmSync(tmp,{force:true})}
}

function libraryManifest(id){const f=path.join(SRV,id,'.mineforge-library.json');try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){return {items:[]}}}
function saveLibraryManifest(id,m){fs.writeFileSync(path.join(SRV,id,'.mineforge-library.json'),JSON.stringify(m,null,2))}
function safeJarName(name){const n=path.basename(String(name||''));if(!/^[a-z0-9_. -]+\.jar$/i.test(n))throw new Error('Ungültiger JAR-Dateiname');return n}
async function versionForProject(projectId,sw,gameVersion,type){const loaders=type==='plugin'?['paper']:[sw];const q=`${MODRINTH}/project/${encodeURIComponent(projectId)}/version?loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;const vs=await getJson(q);return vs[0]||null}
async function installLibraryProject(id,projectId,type,seen,depth){
 if(depth>12)throw new Error('Abhängigkeitskette ist zu tief');if(seen.has(projectId))return;seen.add(projectId);if(seen.size>80)throw new Error('Zu viele Abhängigkeiten (Limit 80)');
 const m=meta[id],sw=String(m.software||'paper').toLowerCase(),allowed=type==='plugin'?['paper','purpur','folia','spigot']:['fabric','forge','neoforge','quilt'];
 if(!allowed.includes(sw))throw new Error(type==='plugin'?'Plugins benötigen Paper/Purpur/Folia.':'Mods benötigen Fabric/Forge/NeoForge/Quilt.');
 const ver=await versionForProject(projectId,sw,m.version,type);if(!ver)throw new Error('Keine kompatible Version für Abhängigkeit '+projectId+' gefunden');
 const file=(ver.files||[]).find(x=>x.primary)||(ver.files||[])[0];if(!file||!file.url)throw new Error('Download-Datei fehlt für '+projectId);
 const dir=path.join(SRV,id,type==='plugin'?'plugins':'mods');fs.mkdirSync(dir,{recursive:true});const filename=safeJarName(file.filename),dest=path.join(dir,filename);
 if(!fs.existsSync(dest))await download(file.url,dest,file.hashes&&file.hashes.sha512?file.hashes.sha512:(file.hashes&&file.hashes.sha256));
 const manifest=libraryManifest(id);if(!manifest.items.some(x=>x.projectId===projectId))manifest.items.push({projectId,slug:ver.project_id||projectId,versionId:ver.id,version:ver.version_number,file:filename,type,installedAt:Date.now(),automatic:depth>0});saveLibraryManifest(id,manifest);
 for(const dep of (ver.dependencies||[])){if(dep.dependency_type!=='required')continue;const depId=dep.project_id;if(!depId)continue;await installLibraryProject(id,depId,type,seen,depth+1)}
}
async function installLibrary(id,body){const slug=String(body.slug||''),type=body.type==='mod'?'mod':'plugin';if(!/^[a-z0-9_-]{2,80}$/i.test(slug))throw new Error('Ungültige Modrinth-Projekt-ID');const pr=await getJson(`${MODRINTH}/project/${encodeURIComponent(slug)}`);if(!pr||!pr.id)throw new Error('Modrinth-Projekt nicht gefunden');const seen=new Set();await installLibraryProject(id,pr.id,type,seen,0);return {ok:true,installedProjects:seen.size,requiresRestart:true}}
async function checkLibraryUpdates(id){const m=meta[id],manifest=libraryManifest(id),updates=[];for(const item of manifest.items){const latest=await versionForProject(item.projectId,String(m.software||'paper').toLowerCase(),m.version,item.type);if(latest&&latest.id!==item.versionId){const file=(latest.files||[]).find(x=>x.primary)||(latest.files||[])[0];updates.push({projectId:item.projectId,oldVersion:item.version,newVersion:latest.version_number,file:file&&file.filename,type:item.type})}}return {updates,count:updates.length}}
async function updateLibraryProject(id,projectId){const m=meta[id],manifest=libraryManifest(id),old=manifest.items.find(x=>x.projectId===projectId);if(!old)throw new Error('Projekt ist nicht in der Bibliothek registriert');const latest=await versionForProject(projectId,String(m.software||'paper').toLowerCase(),m.version,old.type);if(!latest||latest.id===old.versionId)return {updated:false};const file=(latest.files||[]).find(x=>x.primary)||(latest.files||[])[0];if(!file||!file.url)throw new Error('Neue Datei fehlt');const dir=path.join(SRV,id,old.type==='plugin'?'plugins':'mods');fs.mkdirSync(dir,{recursive:true});const filename=safeJarName(file.filename),tmp=path.join(dir,'.update-'+crypto.randomBytes(6).toString('hex')+'.jar');await download(file.url,tmp,file.hashes&&file.hashes.sha512?file.hashes.sha512:(file.hashes&&file.hashes.sha256));const dest=path.join(dir,filename);try{fs.rmSync(dest,{force:true})}catch(e){};fs.renameSync(tmp,dest);if(old.file!==filename)try{fs.rmSync(path.join(dir,old.file),{force:true})}catch(e){};old.versionId=latest.id;old.version=latest.version_number;old.file=filename;old.installedAt=Date.now();saveLibraryManifest(id,manifest);for(const dep of (latest.dependencies||[])){if(dep.dependency_type==='required'&&dep.project_id)await installLibraryProject(id,dep.project_id,old.type,new Set([projectId]),1)}return {updated:true,version:latest.version_number,file:filename}}
async function install(id){const m=meta[id],dir=path.join(SRV,id);
 try{await installBase(m,dir);await installCrossplay(m,dir);m.installed=true;delete m.error;}
 catch(e){m.installed=false;m.error='Installation fehlgeschlagen: '+e.message}
 saveMeta()}
function start(id){const m=meta[id];if(!m||!m.installed)throw new Error('Nicht installiert');
 const r=run[id];if(r&&r.proc)throw new Error('Läuft bereits');
 const free=os.totalmem()/1048576*0.5-usedRam();if(m.ram>free)throw new Error('Nicht genug freier Arbeitsspeicher');
 const dir=path.join(SRV,id);
 fs.writeFileSync(path.join(dir,'eula.txt'),'eula=true\n');
 const pf=path.join(dir,'server.properties');let p={};try{fs.readFileSync(pf,'utf8').split(/\r?\n/).forEach(l=>{const i=l.indexOf('=');if(i>0&&l[0]!=='#')p[l.slice(0,i)]=l.slice(i+1)})}catch(e){}
 p['server-port']=String(m.port);p['max-players']=String(m.maxPlayers);p['motd']=m.motd;
 fs.writeFileSync(pf,Object.entries(p).map(([k,v])=>k+'='+v).join('\n')+'\n');
 const st=run[id]=run[id]||{log:[],restarts:0};st.status='starting';st.stopping=false;st.startedAt=Date.now();
 const args=['-Xms256M','-Xmx'+m.ram+'M'];if(m.launchArgsFile){args.push('@'+m.launchArgsFile,'nogui')}else{args.push('-jar','server.jar','nogui')}const proc=spawn(JAVA,args,{cwd:dir,stdio:['pipe','pipe','pipe'],windowsHide:true});
 st.proc=proc;
 const onData=d=>{log(id,d);if(/Done \(/.test(String(d)))st.status='running'};
 proc.stdout.on('data',onData);proc.stderr.on('data',d=>log(id,d));
 proc.on('error',e=>{log(id,'Startfehler: '+e.message);st.proc=null;st.status='crashed'});
 proc.on('exit',code=>{st.proc=null;if(st.stopping||code===0){st.status='stopped';st.restarts=0}else if(st.restarts<3){st.restarts++;st.status='restarting';log(id,'[Agent] Absturz (Code '+code+'), Neustart '+st.restarts+'/3');setTimeout(()=>{try{start(id)}catch(e){st.status='crashed'}},5000)}else{st.status='crashed';log(id,'[Agent] Zu viele Abstürze, Server bleibt aus')}})}
function send(id,cmd){const r=run[id];if(!r||!r.proc)throw new Error('Server läuft nicht');r.proc.stdin.write(cmd+'\n')}
function stop(id){const r=run[id];if(!r||!r.proc)return;r.stopping=true;r.status='stopping';send(id,'stop');setTimeout(()=>{if(r.proc)r.proc.kill()},30000)}
async function backup(id){const r=run[id];if(r&&r.proc){send(id,'save-off');send(id,'save-all');await new Promise(x=>setTimeout(x,4000))}
 const out=path.join(BAK,id+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.tar.gz');
 const t=spawnSync('tar',['-czf',out,'--exclude','logs','-C',path.join(SRV,id),'.'],{timeout:600000});
 if(r&&r.proc)send(id,'save-on');if(t.status!==0)throw new Error('Backup fehlgeschlagen');return path.basename(out)}
const json=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
const body=(req,max=2*1024*1024)=>new Promise((ok,no)=>{let s='';req.on('data',c=>{s+=c;if(s.length>max){no(new Error('Anfrage zu groß'));req.destroy()}});req.on('end',()=>{try{ok(JSON.parse(s||'{}'))}catch(e){no(e)}})});
http.createServer(async(req,res)=>{
 try{
  const a=Buffer.from(req.headers.authorization||''),t=Buffer.from('Bearer '+cfg.token);
  if(a.length!==t.length||!crypto.timingSafeEqual(a,t))return json(res,401,{error:'Token ungültig'});
  const u=new URL(req.url,'http://x'),seg=u.pathname.split('/').filter(Boolean),id=seg[1];
  if(seg[0]==='library'&&req.method==='GET'){
   const rawType=u.searchParams.get('type'),type=['mod','plugin','modpack'].includes(rawType)?rawType:'plugin',q=String(u.searchParams.get('query')||'').slice(0,80);
   const facets=encodeURIComponent(JSON.stringify([[`project_type:${type}`]]));
   const url=`${MODRINTH}/search?query=${encodeURIComponent(q)}&facets=${facets}&limit=12&index=relevance`;
   const j=await getJson(url);return json(res,200,{hits:(j.hits||[]).map(x=>({project_id:x.project_id,slug:x.slug,title:x.title,description:x.description,downloads:x.downloads,icon_url:x.icon_url,client_side:x.client_side,server_side:x.server_side}))});
  }

  if(seg[0]==='servers'&&seg[1]&&seg[2]==='modpack'&&(['POST'].includes(req.method)||seg[3]==='updates'&&req.method==='GET')){
   const id=seg[1];if(!ID.test(id)||!meta[id])return json(res,404,{error:'Server nicht gefunden'});
   if(seg[3]==='updates'&&req.method==='GET')return json(res,200,await checkModpackUpdate(id));
   const b=await body(req,360*1024*1024);
   if(seg[3]==='modrinth')return json(res,200,await applyModrinthPack(id,b));
   if(seg[3]==='curseforge')return json(res,200,await applyCurseForgePack(id,b));
   if(seg[3]==='modrinth-project')return json(res,200,await installModrinthProject(id,String(b.slug||'')));
   if(seg[3]==='curseforge-project')return json(res,200,await installCurseForgeProject(id,String(b.projectId||''),String(b.fileId||'')));
   if(seg[3]==='update')return json(res,200,await updateModrinthPack(id));
   return json(res,404,{error:'Modpack-Plattform unbekannt'});
  }

  if(seg[0]==='curseforge'&&seg[1]==='modpacks'&&req.method==='GET'){
   const key=process.env.CURSEFORGE_API_KEY;if(!key)return json(res,503,{error:'CURSEFORGE_API_KEY fehlt'});
   const q=String(u.searchParams.get('query')||'').slice(0,80);
   const endpoint='https://api.curseforge.com/v1/mods/search?gameId=432&classId=4471&pageSize=12&sortField=2&sortOrder=desc&searchFilter='+encodeURIComponent(q);
   const r=await fetch(endpoint,{headers:{'x-api-key':key,'Accept':'application/json'},signal:AbortSignal.timeout(30000)});
   if(!r.ok)throw new Error('CurseForge-Suche HTTP '+r.status);
   const j=await r.json();return json(res,200,{hits:(j.data||[]).map(x=>({id:x.id,name:x.name,summary:x.summary,logo:x.logo&&x.logo.url,latestFiles:(x.latestFiles||[]).slice(0,3).map(f=>({id:f.id,displayName:f.displayName,fileName:f.fileName}))}))});
  }
  if(seg[0]==='health')return json(res,200,{ok:true,java:javaInfo(),totalMemMB:Math.round(os.totalmem()/1048576),freeMemMB:Math.round(os.freemem()/1048576),usedRamMB:usedRam(),servers:Object.keys(meta).length});
  if(seg[0]!=='servers')return json(res,404,{error:'Unbekannt'});
  if(!id&&req.method==='GET')return json(res,200,{servers:Object.keys(meta).map(info)});
  if(!id&&req.method==='POST'){
   const b=await body(req);
   if(!ID.test(b.id||'')||meta[b.id])return json(res,400,{error:'Ungültige oder doppelte ID'});
   if(b.acceptEula!==true)return json(res,400,{error:'EULA muss akzeptiert werden'});
   if(!['paper','purpur','vanilla','fabric','quilt','folia','forge','neoforge','spigot'].includes(String(b.software||'').toLowerCase()))return json(res,400,{error:'Server-Software nicht unterstützt'});
   if(!/^1\.\d{1,2}(\.\d{1,2})?$/.test(b.version||''))return json(res,400,{error:'Version ungültig (z. B. 1.21.4)'});
   const ram=+b.ram,maxRam=Math.min(8192,Math.floor(os.totalmem()/1048576*0.5));
   if(!(ram>=512&&ram<=maxRam))return json(res,400,{error:'RAM muss zwischen 512 und '+maxRam+' MB liegen'});
   if(Object.keys(meta).length>=MAX_SERVERS)return json(res,400,{error:'Maximal '+MAX_SERVERS+' Server auf diesem Node'});
   const mp=Math.min(100,Math.max(1,parseInt(b.maxPlayers,10)||10));
   const used=Object.values(meta).map(x=>x.port);let port=25565;while(used.includes(port))port++;
   meta[b.id]={name:String(b.name||'Server').slice(0,40),software:String(b.software||'paper').toLowerCase(),version:b.version,ram,port,maxPlayers:mp,motd:String(b.motd||b.name||'MINEFORGE').replace(/[\r\n=]/g,' ').slice(0,60),crossplay:b.crossplay===true};
   fs.mkdirSync(path.join(SRV,b.id),{recursive:true});saveMeta();install(b.id);return json(res,202,{server:info(b.id)});
  }
  if(!ID.test(id||'')||!meta[id])return json(res,404,{error:'Server nicht gefunden'});
  const act=seg[2];
  if(req.method==='GET'&&act==='log'){const r=run[id];return json(res,200,{log:r?r.log.slice(-200):[],server:info(id)})}
  if(req.method==='GET'&&!act)return json(res,200,{server:info(id)});
  if(act==='library'&&req.method==='POST'){
   const b=await body(req);if(run[id]&&run[id].proc)throw new Error('Server vor der Installation stoppen');
   const result=await installLibrary(id,b);return json(res,200,result)
  }
  if(act==='updates'&&req.method==='GET'){
   return json(res,200,await checkLibraryUpdates(id))
  }
  if(act==='update'&&req.method==='POST'){
   if(run[id]&&run[id].proc)throw new Error('Server vor Updates stoppen');const b=await body(req),projectId=String(b.projectId||'');
   if(!/^[a-z0-9_-]{3,64}$/i.test(projectId))throw new Error('Ungültige Projekt-ID');return json(res,200,await updateLibraryProject(id,projectId))
  }
  if(act==='crossplay'){
   if(run[id]&&run[id].proc)throw new Error('Server vor Plugin-Installation stoppen');
   if(!['paper','purpur','folia','spigot'].includes(String(meta[id].software||'paper')))throw new Error('Crossplay nur mit Paper/Purpur/Folia/Spigot möglich');
   meta[id].crossplay=true;await installCrossplay(meta[id],path.join(SRV,id));saveMeta();return json(res,200,{ok:true,installed:true})
  }
  if(act==='start'){start(id);return json(res,200,{server:info(id)})}
  if(act==='stop'){stop(id);return json(res,200,{server:info(id)})}
  if(act==='backup')return json(res,200,{file:await backup(id)});
  if(act==='command'){const b=await body(req),c=String(b.cmd||'').trim();
   if(!c||/[\r\n]/.test(c)||c.length>200||!CMDS.includes(c.split(/\s+/)[0].toLowerCase()))return json(res,400,{error:'Befehl nicht erlaubt'});
   send(id,c);return json(res,200,{ok:true})}

  if(act==='restart'){
   const r=run[id];if(!r||!r.proc){start(id);return json(res,200,{server:info(id)})}
   stop(id);let tries=0;const wait=()=>{if(!run[id]||!run[id].proc){try{start(id);log(id,'[Agent] Neustart abgeschlossen')}catch(e){log(id,'Neustart fehlgeschlagen: '+e.message)}return}
    if(++tries<60)setTimeout(wait,500);else log(id,'Neustart abgebrochen: Stoppen dauerte zu lange')};setTimeout(wait,500);
   return json(res,202,{ok:true})
  }
  if(act==='delete'){
   stop(id);const dir=path.join(SRV,id);try{fs.rmSync(dir,{recursive:true,force:true});}catch(e){throw new Error('Serverdateien konnten nicht gelöscht werden')}
   delete meta[id];delete run[id];saveMeta();return json(res,200,{ok:true})
  }
  if(act==='rename'){
   const b=await body(req),name=String(b.name||'').trim();if(!name||name.length>40)throw new Error('Name muss 1–40 Zeichen lang sein');
   meta[id].name=name;meta[id].motd=name;saveMeta();return json(res,200,{server:info(id)})
  }
  if(act==='resources'){
   const b=await body(req),ram=Number(b.ram),mp=Number(b.maxPlayers);
   const maxRam=Math.min(8192,Math.floor(os.totalmem()/1048576*0.5));
   if(!Number.isInteger(ram)||ram<512||ram>maxRam)throw new Error('RAM außerhalb des erlaubten Bereichs (512–'+maxRam+' MB)');
   if(!Number.isInteger(mp)||mp<1||mp>1000)throw new Error('Maximalspieler muss 1–1000 sein');
   if(run[id]&&run[id].proc)throw new Error('Server zum Ändern der RAM-Zuweisung zuerst stoppen');
   meta[id].ram=ram;meta[id].maxPlayers=mp;saveMeta();
   return json(res,200,{server:info(id)})
  }
  if(act==='properties'){
   const dir=path.join(SRV,id),pf=path.join(dir,'server.properties');
   if(req.method==='GET'){
    let p={};try{fs.readFileSync(pf,'utf8').split(/\r?\n/).forEach(l=>{let n=l.indexOf('=');if(n>0&&l[0]!=='#')p[l.slice(0,n)]=l.slice(n+1)})}catch(e){}
    return json(res,200,{properties:p,editable:['motd','difficulty','gamemode','pvp','max-players','white-list','online-mode','spawn-protection','view-distance','simulation-distance','allow-flight']})
   }
   const b=await body(req),allowed=['motd','difficulty','gamemode','pvp','max-players','white-list','spawn-protection','view-distance','simulation-distance','allow-flight'];
   const p={};try{fs.readFileSync(pf,'utf8').split(/\r?\n/).forEach(l=>{let n=l.indexOf('=');if(n>0&&l[0]!=='#')p[l.slice(0,n)]=l.slice(n+1)})}catch(e){}
   for(const k of Object.keys(b)){if(!allowed.includes(k))throw new Error('Einstellung nicht erlaubt: '+k);let v=String(b[k]);if(v.length>120||/[\r\n]/.test(v))throw new Error('Ungültiger Wert');p[k]=v}
   fs.writeFileSync(pf,Object.entries(p).map(([k,v])=>k+'='+v).join('\n')+'\n');return json(res,200,{ok:true,properties:p,restartRequired:!!(run[id]&&run[id].proc)})
  }
  if(act==='players'){
   const r=run[id];if(!r||!r.proc)return json(res,200,{online:false,players:[],message:'Server ist nicht gestartet'});
   send(id,'list');await new Promise(x=>setTimeout(x,700));
   const lines=r.log.slice(-30).join('\n'),m=lines.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online(?::\s*(.*))?/i);
   if(m)recordPlayers(id);
   return json(res,200,{online:true,count:m?+m[1]:null,max:m?+m[2]:meta[id].maxPlayers,players:m&&m[3]?m[3].split(',').map(x=>x.trim()).filter(Boolean):[],raw:m?null:'Spielerliste wird vom Server noch nicht gemeldet'})
  }
  if(act==='players-history')return json(res,200,{history:(meta[id].playerHistory||[]).slice(-240)});
  if(act==='backups'){
   const files=fs.readdirSync(BAK).filter(f=>f.startsWith(id+'-')&&f.endsWith('.tar.gz')).map(f=>{const s=fs.statSync(path.join(BAK,f));return{name:f,size:s.size,created:s.mtimeMs}}).sort((x,y)=>y.created-x.created);
   return json(res,200,{backups:files})
  }

  if(act==='backup-download'){
   const b=await body(req),f=String(b.file||'');if(path.basename(f)!==f||!f.startsWith(id+'-')||!f.endsWith('.tar.gz'))throw new Error('Ungültiger Backup-Dateiname');
   const fp=path.join(BAK,f);if(!fs.existsSync(fp))throw new Error('Backup nicht gefunden');
   const st=fs.statSync(fp);if(st.size>25*1024*1024)throw new Error('Backup größer als 25 MB; Download über den lokalen Backup-Ordner');
   return json(res,200,{file:f,data:fs.readFileSync(fp).toString('base64')})
  }

  if(act==='backup-delete'){
   const b=await body(req),f=String(b.file||'');if(path.basename(f)!==f||!f.startsWith(id+'-')||!f.endsWith('.tar.gz'))throw new Error('Ungültiger Backup-Dateiname');
   fs.rmSync(path.join(BAK,f),{force:true});return json(res,200,{ok:true})
  }
  if(act==='backup-restore'){
   const b=await body(req),f=String(b.file||'');if(path.basename(f)!==f||!f.startsWith(id+'-')||!f.endsWith('.tar.gz'))throw new Error('Ungültiger Backup-Dateiname');
   if(run[id]&&run[id].proc)throw new Error('Server vor Wiederherstellung stoppen');
   const fp=path.join(BAK,f);if(!fs.existsSync(fp))throw new Error('Backup nicht gefunden');
   const dir=path.join(SRV,id),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-restore-')),oldJar=path.join(dir,'server.jar');
   const t=spawnSync('tar',['-xzf',fp,'-C',tmp],{timeout:600000});
   if(t.status!==0){fs.rmSync(tmp,{recursive:true,force:true});throw new Error('Wiederherstellung fehlgeschlagen: '+String(t.stderr||'').slice(0,300))}
   if(!fs.existsSync(path.join(tmp,'server.jar'))&&fs.existsSync(oldJar))fs.copyFileSync(oldJar,path.join(tmp,'server.jar'));
   fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});fs.cpSync(tmp,dir,{recursive:true,force:true});fs.rmSync(tmp,{recursive:true,force:true});
   return json(res,200,{ok:true})
  }
  if(act==='metrics'){
   const r=run[id],dir=path.join(SRV,id);let bytes=0;
   function walk(d){for(const x of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,x.name);if(x.isDirectory())walk(f);else bytes+=fs.statSync(f).size}}
   try{walk(dir)}catch(e){}
   return json(res,200,{status:r&&r.status||'stopped',ramAssignedMB:meta[id].ram,hostTotalMemMB:Math.round(os.totalmem()/1048576),hostFreeMemMB:Math.round(os.freemem()/1048576),diskBytes:bytes,uptimeMs:r&&r.startedAt&&r.proc?Date.now()-r.startedAt:0,cpuPercent:sampleCpu(id),playerHistory:(meta[id].playerHistory||[]).slice(-60),measuredAt:Date.now(),note:'CPU wird aus Prozesszeit geschätzt; Spielerverlauf enthält nur erfolgreiche /list-Abfragen.'})
  }
  if(act==='file-write'&&req.method==='POST'){
   const b=await body(req),rel=String(b.path||''),root=path.resolve(SRV,id),target=path.resolve(root,rel);
   if(!rel||target===root||!target.startsWith(root+path.sep))throw new Error('Ungültiger Dateipfad');
   if(Buffer.byteLength(String(b.content||''),'utf8')>1024*1024)throw new Error('Datei zu groß (max. 1 MB)');
   if(run[id]&&run[id].proc)throw new Error('Server vor Dateiänderungen stoppen');
   fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,String(b.content||''),'utf8');return json(res,200,{ok:true,path:rel});
  }

  if(act==='file-upload'&&req.method==='POST'){
   const b=await body(req,140*1024*1024),rel=String(b.path||''),data=String(b.dataBase64||'');
   const root=path.resolve(SRV,id),target=path.resolve(root,rel);
   if(!rel||target===root||!target.startsWith(root+path.sep)||/[\r\n]/.test(rel))throw new Error('Ungültiger Dateipfad');
   if(!data||data.length>135*1024*1024)throw new Error('Datei fehlt oder ist größer als 100 MB');
   if(run[id]&&run[id].proc)throw new Error('Server vor Datei-Upload stoppen');
   const buf=Buffer.from(data,'base64');if(buf.length>100*1024*1024)throw new Error('Datei größer als 100 MB');
   fs.mkdirSync(path.dirname(target),{recursive:true});const tmp=target+'.upload-'+crypto.randomBytes(5).toString('hex');fs.writeFileSync(tmp,buf);fs.renameSync(tmp,target);return json(res,200,{ok:true,path:rel,size:buf.length})
  }
  if(act==='file-download'&&req.method==='GET'){
   const rel=String(u.searchParams.get('path')||''),root=path.resolve(SRV,id),target=path.resolve(root,rel);
   if(!rel||target===root||!target.startsWith(root+path.sep))throw new Error('Ungültiger Dateipfad');
   const st=fs.statSync(target);if(!st.isFile()||st.size>100*1024*1024)throw new Error('Nur Dateien bis 100 MB können heruntergeladen werden');
   return json(res,200,{path:rel,name:path.basename(target),size:st.size,dataBase64:fs.readFileSync(target).toString('base64')})
  }
  if(act==='files'&&req.method==='GET'){
   const rel=String(u.searchParams.get('path')||'.'),root=path.resolve(SRV,id),target=path.resolve(root,rel);
   if(target!==root&&!target.startsWith(root+path.sep))throw new Error('Pfad außerhalb des Servers');
   const st=fs.statSync(target);if(st.isDirectory())return json(res,200,{directory:true,path:rel,items:fs.readdirSync(target,{withFileTypes:true}).map(x=>({name:x.name,type:x.isDirectory()?'directory':'file'}))});
   if(st.size>1024*1024)throw new Error('Datei zu groß für Textansicht (max. 1 MB)');
   return json(res,200,{directory:false,path:rel,content:fs.readFileSync(target,'utf8')})
  }

  json(res,404,{error:'Unbekannt'});
 }catch(e){json(res,400,{error:e.message})}
}).listen(PORT,HOST,()=>console.log('NEXUSCRAFT-Agent läuft auf '+HOST+':'+PORT+' | Java: '+JSON.stringify(javaInfo())));
setInterval(()=>{for(const i in run)if(run[i].proc&&run[i].status==='running')try{send(i,'save-all')}catch(e){}},600000);
setInterval(()=>{for(const i in run)if(run[i].proc&&run[i].status==='running')try{send(i,'list');setTimeout(()=>recordPlayers(i),900)}catch(e){}},30000);
// Automatische tägliche Backups; maximal sieben automatische Sicherungen je Server behalten.
setInterval(async()=>{for(const id of Object.keys(meta)){try{const m=meta[id];if(!m.installed)continue;const now=Date.now();if(now-(m.lastScheduledBackup||0)<24*60*60*1000)continue;const file=await backup(id);const autoName=id+'-auto-'+new Date(now).toISOString().replace(/[:.]/g,'-')+'.tar.gz';fs.renameSync(path.join(BAK,file),path.join(BAK,autoName));m.lastScheduledBackup=now;m.lastScheduledBackupFile=autoName;saveMeta();const old=fs.readdirSync(BAK).filter(x=>x.startsWith(id+'-auto-')&&x.endsWith('.tar.gz')).sort();while(old.length>=7){fs.rmSync(path.join(BAK,old.shift()),{force:true})}}catch(e){console.error('[Auto-Backup '+id+'] '+e.message)}}},60*60*1000);
function shutdown(){const ids=Object.keys(run).filter(i=>run[i].proc);ids.forEach(i=>{try{stop(i)}catch(e){}});setTimeout(()=>process.exit(0),ids.length?20000:0)}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
