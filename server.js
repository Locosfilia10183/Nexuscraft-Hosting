'use strict';
try{require('dotenv').config()}catch(e){}
// NEXUSCRAFT Control Plane – Node.js 20+; optionale SMTP-/ZIP-Pakete.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
let nodemailer=null;try{nodemailer=require('nodemailer')}catch(e){}
const PORT=process.env.PORT||3000, DATA=process.env.DATA_FILE||path.join(__dirname,'data.json'), NODES_FILE=process.env.NODES_FILE||path.join(__dirname,'nodes.json');
const PUB=path.join(__dirname,'public'), ROLES=['user','moderator','admin','owner'];
let db={users:[],drafts:[],sessions:{},servers:[],audit:[],settings:{userServerLimit:2,defaultCredits:10000}};
try{db=JSON.parse(fs.readFileSync(DATA,'utf8'))}catch(e){}
function save(){const t=DATA+'.tmp';fs.writeFileSync(t,JSON.stringify(db));fs.renameSync(t,DATA)}
const sha=s=>crypto.createHash('sha256').update(s).digest('hex'), uid=()=>crypto.randomBytes(9).toString('hex');
function hashPw(pw,salt){return crypto.scryptSync(pw,salt,64).toString('hex')}
const AGENT=process.env.AGENT_URL||'http://127.0.0.1:3100';
let ATOKEN=process.env.AGENT_TOKEN||'';
if(!ATOKEN){try{ATOKEN=JSON.parse(fs.readFileSync(path.join(__dirname,'agent','agent-config.json'),'utf8')).token}catch(e){}}
let nodes=[];try{nodes=JSON.parse(fs.readFileSync(NODES_FILE,'utf8'))}catch(e){}
function nodeById(id){return nodes.find(n=>n.id===id)||null}
function agent(m,p,b,ms,nodeId){const n=nodeId?nodeById(nodeId):null;const endpoint=n?n.url:AGENT,token=n?n.token:ATOKEN;if(!endpoint||!token)throw new Error('Kein Hosting-Node konfiguriert');return fetch(endpoint.replace(/\/$/,'')+p,{method:m,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined,signal:AbortSignal.timeout(ms||15000)}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error||'Agent-Fehler');return j})}
function saveNodes(){const tmp=NODES_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(nodes,null,2),{mode:0o600});fs.renameSync(tmp,NODES_FILE)}
function sortedNodes(){return nodes.filter(n=>n.enabled!==false).slice().sort((a,b)=>db.servers.filter(x=>x.nodeId===a.id).length-db.servers.filter(x=>x.nodeId===b.id).length)}
function chooseNode(){return sortedNodes()[0]||null}
async function chooseOnlineNode(){const list=sortedNodes();if(!list.length)return null;for(const n of list){try{const h=await agent('GET','/health',null,6000,n.id);if(h&&h.ok)return n}catch(e){}}throw new Error('Kein registrierter Hosting-Node ist erreichbar. Prüfe Node, HTTPS und Firewall.')}
db.servers=db.servers||[];db.audit=db.audit||[];db.processedPayments=db.processedPayments||[];db.passwordResets=db.passwordResets||{};db.settings=Object.assign({userServerLimit:2,defaultCredits:10000},db.settings||{});
function audit(actor,action,target,details){db.audit.unshift({id:uid(),at:Date.now(),actor:actor?actor.username:'system',action,target:target||'',details:details||''});db.audit=db.audit.slice(0,1000);save()}
const hits=new Map();
function limited(ip,max,ms){const n=Date.now(),a=(hits.get(ip)||[]).filter(t=>n-t<ms);a.push(n);hits.set(ip,a);return a.length>max}
function send(res,code,obj,extra){res.writeHead(code,Object.assign({'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},extra||{}));res.end(JSON.stringify(obj))}
function body(req,max=2*1024*1024){return new Promise((ok,no)=>{let s='';req.on('data',c=>{s+=c;if(s.length>max){no(new Error('Anfrage zu groß'));req.destroy()}});req.on('end',()=>{try{ok(JSON.parse(s||'{}'))}catch(e){no(e)}});req.on('error',no)})}
function rawBody(req,max=1024*1024){return new Promise((ok,no)=>{const chunks=[];let size=0;req.on('data',c=>{size+=c.length;if(size>max){no(new Error('Anfrage zu groß'));req.destroy()}else chunks.push(c)});req.on('end',()=>ok(Buffer.concat(chunks)));req.on('error',no)})}
function mailer(){if(!nodemailer)throw new Error('nodemailer fehlt – bitte npm install ausführen');if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS)throw new Error('SMTP_HOST, SMTP_USER und SMTP_PASS müssen eingerichtet sein');return nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false')==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}})}
function cookie(req,n){const m=(req.headers.cookie||'').split(/;\s*/).find(x=>x.startsWith(n+'='));return m?m.slice(n.length+1):null}
function me(req){const t=cookie(req,'mf');if(!t)return null;const s=db.sessions[sha(t)];if(!s||s.exp<Date.now())return null;return db.users.find(u=>u.id===s.uid&&!u.banned)||null}
function pub(u){return{id:u.id,email:u.email,username:u.username,role:u.role,credits:u.credits||0,premium:!!u.premium,premiumUntil:u.premiumUntil||null}}
function setCookie(req,v,age){const sec=(req.headers['x-forwarded-proto']==='https')?'; Secure':'';return{'Set-Cookie':`mf=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${sec}`}}
const str=(v,min,max)=>typeof v==='string'&&v.trim().length>=min&&v.trim().length<=max;
async function api(req,res,url){
 const ip=req.socket.remoteAddress||'?';
 if(req.method!=='GET'){
  const o=req.headers.origin;if(o&&new URL(o).host!==req.headers.host)return send(res,403,{error:'Ungültiger Ursprung'});
  if(!(req.headers['content-type']||'').startsWith('application/json'))return send(res,415,{error:'JSON erwartet'});
 }
 const u=me(req),p=url.pathname;
 if(p==='/api/register'&&req.method==='POST'){
  if(limited('r'+ip,10,3600000))return send(res,429,{error:'Zu viele Versuche'});
  const b=await body(req);
  if(!str(b.email,5,120)||!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email))return send(res,400,{error:'E-Mail ungültig'});
  if(!/^[A-Za-z0-9_]{3,20}$/.test(b.username||''))return send(res,400,{error:'Benutzername: 3–20 Zeichen (Buchstaben, Zahlen, _)'});
  if(typeof b.password!=='string'||b.password.length<8||b.password.length>100)return send(res,400,{error:'Passwort: mindestens 8 Zeichen'});
  const em=b.email.trim().toLowerCase();
  if(db.users.some(x=>x.email===em||x.username.toLowerCase()===b.username.toLowerCase()))return send(res,409,{error:'E-Mail oder Benutzername schon vergeben'});
  const salt=crypto.randomBytes(16).toString('hex');
  const nu={id:uid(),email:em,username:b.username,salt,hash:hashPw(b.password,salt),role:db.users.length?'user':'owner',created:Date.now(),credits:db.settings.defaultCredits,premium:false};
  db.users.push(nu);audit(nu,'register',nu.id,'Neues Konto; Startguthaben '+nu.credits+' Credits');return login(req,res,nu);
 }
 if(p==='/api/login'&&req.method==='POST'){
  if(limited('l'+ip,10,600000))return send(res,429,{error:'Zu viele Versuche, bitte später erneut'});
  const b=await body(req),em=String(b.email||'').trim().toLowerCase(),x=db.users.find(y=>y.email===em);
  const h=hashPw(String(b.password||''),x?x.salt:'0'.repeat(32));
  if(!x||x.banned||!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(x.hash)))return send(res,401,{error:'Login fehlgeschlagen'});
  return login(req,res,x);
 }
 if(p==='/api/logout'&&req.method==='POST'){const t=cookie(req,'mf');if(t){delete db.sessions[sha(t)];save()}return send(res,200,{ok:1},setCookie(req,'',0))}
 if(p==='/api/me')return send(res,200,{user:u?Object.assign(pub(u),{credits:u.credits||0,premium:!!u.premium,premiumUntil:u.premiumUntil||null}):null});
 if(p==='/api/auth/forgot'&&req.method==='POST'){
  if(limited('forgot'+ip,5,3600000))return send(res,429,{error:'Zu viele Anfragen. Bitte später erneut versuchen.'});
  const b=await body(req),email=String(b.email||'').trim().toLowerCase(),target=db.users.find(x=>x.email===email);
  if(target){const token=crypto.randomBytes(32).toString('hex');db.passwordResets[sha(token)]={uid:target.id,exp:Date.now()+3600000};save();
   try{const link=(process.env.PUBLIC_URL||'http://localhost:'+PORT)+'/#reset='+token;await mailer().sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to:target.email,subject:'NEXUSCRAFT Passwort zurücksetzen',text:'Du hast eine Passwortzurücksetzung angefordert. Öffne innerhalb einer Stunde: '+link+'\\nWenn du das nicht warst, ignoriere diese E-Mail.'})}
   catch(e){delete db.passwordResets[sha(token)];save();return send(res,503,{error:'E-Mail konnte nicht versendet werden: '+e.message})}
  }
  return send(res,200,{ok:true,message:'Falls ein Konto existiert, wurde eine E-Mail versendet.'});
 }
 if(p==='/api/auth/reset'&&req.method==='POST'){
  const b=await body(req),token=String(b.token||''),entry=db.passwordResets[sha(token)];
  if(!entry||entry.exp<Date.now()||typeof b.password!=='string'||b.password.length<8||b.password.length>100)return send(res,400,{error:'Reset-Link ungültig/abgelaufen oder Passwort ungültig'});
  const target=db.users.find(x=>x.id===entry.uid);if(!target)return send(res,400,{error:'Konto nicht gefunden'});
  target.salt=crypto.randomBytes(16).toString('hex');target.hash=hashPw(b.password,target.salt);delete db.passwordResets[sha(token)];
  for(const k of Object.keys(db.sessions))if(db.sessions[k].uid===target.id)delete db.sessions[k];audit(target,'password_reset',target.id,'Passwort zurückgesetzt');save();return send(res,200,{ok:true});
 }
 if(p==='/api/shop/catalog'&&req.method==='GET')return send(res,200,{currency:'eur',products:[
  {id:'credits_1000',name:'1.000 Credits',amount:499,credits:1000},
  {id:'credits_5000',name:'5.000 Credits',amount:1999,credits:5000},
  {id:'premium_30',name:'Premium – 30 Tage',amount:499,premiumDays:30}
 ]});
 if(p==='/api/billing/webhook'&&req.method==='POST'){
  const secret=process.env.STRIPE_WEBHOOK_SECRET;if(!secret)return send(res,503,{error:'Stripe-Webhook nicht konfiguriert'});
  const raw=await rawBody(req,2*1024*1024),sig=String(req.headers['stripe-signature']||''),parts=sig.split(',').map(x=>x.split('=')),ts=(parts.find(x=>x[0]==='t')||[])[1],v1=(parts.find(x=>x[0]==='v1')||[])[1];
  if(!ts||!v1||Math.abs(Date.now()/1000-Number(ts))>300)return send(res,400,{error:'Stripe-Signatur ungültig/abgelaufen'});
  const expected=crypto.createHmac('sha256',secret).update(ts+'.').update(raw).digest('hex');
  if(expected.length!==v1.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(v1)))return send(res,400,{error:'Stripe-Signatur stimmt nicht'});
  const event=JSON.parse(raw.toString('utf8'));if(event.type==='checkout.session.completed'){
   const session=event.data&&event.data.object||{},meta=session.metadata||{},user=db.users.find(x=>x.id===meta.userId);
   if(user&&session.payment_status==='paid'&&!db.processedPayments.includes(event.id)){if(meta.kind==='credits')user.credits=(user.credits||0)+Number(meta.credits||0);if(meta.kind==='premium'){user.premium=true;user.premiumUntil=Date.now()+Number(meta.days||30)*864e5}db.processedPayments.push(event.id);db.processedPayments=db.processedPayments.slice(-2000);audit(user,'payment_complete',session.id,meta.kind||'purchase');save()}
  }
  return send(res,200,{received:true});
 }

 if(p==='/api/library'&&req.method==='GET'){try{const n=await chooseOnlineNode();return send(res,200,await agent('GET','/library?type='+encodeURIComponent(url.searchParams.get('type')||'plugin')+'&query='+encodeURIComponent(url.searchParams.get('query')||''),null,30000,n&&n.id))}catch(e){return send(res,502,{error:'Modrinth gerade nicht erreichbar: '+e.message})}}
 if(p==='/api/curseforge/modpacks'&&req.method==='GET'){try{const n=await chooseOnlineNode();return send(res,200,await agent('GET','/curseforge/modpacks?query='+encodeURIComponent(url.searchParams.get('query')||''),null,30000,n&&n.id))}catch(e){return send(res,502,{error:e.message})}}
 if(!u)return send(res,401,{error:'Nicht angemeldet'});

 if(p==='/api/shop/upgrade'&&req.method==='POST'){
  const b=await body(req),sv=db.servers.find(x=>x.id===b.serverId&&(x.uid===u.id||['admin','owner'].includes(u.role)));
  if(!sv)return send(res,404,{error:'Server nicht gefunden'});
  const ramAdd=Number(b.ramAdd||0),slotsAdd=Number(b.slotsAdd||0);
  if(!Number.isInteger(ramAdd)||ramAdd<0||ramAdd>8192||ramAdd%512!==0||!Number.isInteger(slotsAdd)||slotsAdd<0||slotsAdd>100)return send(res,400,{error:'Ungültiges Upgrade'});
  if(!ramAdd&&!slotsAdd)return send(res,400,{error:'Kein Upgrade gewählt'});
  const cost=Math.ceil(ramAdd/512)*500+Math.ceil(slotsAdd/10)*200;
  if((u.credits||0)<cost)return send(res,400,{error:'Nicht genügend Credits. Benötigt: '+cost});
  try{const current=(await agent('GET','/servers/'+sv.id,null,15000,sv.nodeId)).server;
   await agent('POST','/servers/'+sv.id+'/resources',{ram:current.ram+ramAdd,maxPlayers:current.maxPlayers+slotsAdd},15000,sv.nodeId);
   u.credits-=cost;audit(u,'credit_upgrade',sv.id,'RAM +'+ramAdd+' MB, Slots +'+slotsAdd+', Kosten '+cost);save();return send(res,200,{ok:true,cost,credits:u.credits})
  }catch(e){return send(res,400,{error:e.message})}
 }
 if(p==='/api/shop/checkout'&&req.method==='POST'){
  const secret=process.env.STRIPE_SECRET_KEY;if(!secret)return send(res,503,{error:'STRIPE_SECRET_KEY fehlt. Zahlungsanbieter zuerst konfigurieren.'});
  const b=await body(req),catalog={credits_1000:{kind:'credits',amount:499,credits:1000,name:'1.000 Credits'},credits_5000:{kind:'credits',amount:1999,credits:5000,name:'5.000 Credits'},premium_30:{kind:'premium',amount:499,days:30,name:'Premium – 30 Tage'}},item=catalog[String(b.product||'')];
  if(!item)return send(res,400,{error:'Produkt unbekannt'});
  const form=new URLSearchParams();form.set('mode','payment');form.set('success_url',(process.env.PUBLIC_URL||'http://localhost:'+PORT)+'/#dashboard');form.set('cancel_url',(process.env.PUBLIC_URL||'http://localhost:'+PORT)+'/#dashboard');form.set('customer_email',u.email);
  form.set('line_items[0][quantity]','1');form.set('line_items[0][price_data][currency]','eur');form.set('line_items[0][price_data][unit_amount]',String(item.amount));form.set('line_items[0][price_data][product_data][name]',item.name);
  form.set('metadata[userId]',u.id);form.set('metadata[kind]',item.kind);if(item.credits)form.set('metadata[credits]',String(item.credits));if(item.days)form.set('metadata[days]',String(item.days));
  const r=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/x-www-form-urlencoded'},body:form.toString(),signal:AbortSignal.timeout(20000)});
  const j=await r.json();if(!r.ok)return send(res,502,{error:j.error&&j.error.message||'Stripe Checkout konnte nicht erstellt werden'});
  return send(res,200,{url:j.url,sessionId:j.id});
 }

 if(p==='/api/drafts'&&req.method==='GET')return send(res,200,{drafts:db.drafts.filter(d=>d.uid===u.id)});
 if(p==='/api/drafts'&&req.method==='POST'){
  const b=await body(req),ED=['Java','Java + Bedrock','Bedrock'],SW=['Paper','Purpur','Vanilla','Fabric','Forge','NeoForge','Quilt','Spigot','Folia'];
  const pl=parseInt(b.pl,10);
  if(!str(b.name,1,40)||!ED.includes(b.ed)||!SW.includes(b.sw)||!(pl>=1&&pl<=100)||String(b.ver||'').length>16||String(b.desc||'').length>120)return send(res,400,{error:'Ungültige Eingabe'});
  if(db.drafts.filter(d=>d.uid===u.id).length>=20)return send(res,400,{error:'Maximal 20 Entwürfe'});
  const d={id:uid(),uid:u.id,name:b.name.trim(),desc:String(b.desc||''),ed:b.ed,sw:b.sw,ver:String(b.ver||'').trim(),pl,created:Date.now()};
  db.drafts.push(d);save();return send(res,200,{draft:d});
 }
 if(p.startsWith('/api/drafts/')&&req.method==='DELETE'){
  const id=p.slice(12),i=db.drafts.findIndex(d=>d.id===id&&d.uid===u.id);
  if(i<0)return send(res,404,{error:'Nicht gefunden'});db.drafts.splice(i,1);save();return send(res,200,{ok:1});
 }
 if(p.startsWith('/api/admin/')){
  if(!['admin','owner'].includes(u.role))return send(res,403,{error:'Kein Zugriff'});

  if(p==='/api/admin/nodes'&&req.method==='GET'){const out=[];for(const n of nodes){let health=null;try{health=await agent('GET','/health',null,5000,n.id)}catch(e){}out.push({id:n.id,name:n.name,url:n.url,enabled:n.enabled!==false,serverCount:db.servers.filter(x=>x.nodeId===n.id).length,online:!!health,java:health&&health.java&&health.java.version,freeMemMB:health&&health.freeMemMB})}return send(res,200,{nodes:out})}
  if(p==='/api/admin/nodes'&&req.method==='POST'){
   if(u.role!=='owner')return send(res,403,{error:'Nur Owner darf Nodes verbinden'});
   const b=await body(req),name=String(b.name||'').trim(),endpoint=String(b.url||'').replace(/\/$/,'').trim(),token=String(b.token||'').trim();
   if(!str(name,2,50)||!/^https:\/\//.test(endpoint)||endpoint.length>250||token.length<24||token.length>200)return send(res,400,{error:'Name, HTTPS-URL und Agent-Token (mindestens 24 Zeichen) erforderlich'});
   const id=uid();try{const r=await fetch(endpoint+'/health',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error('HTTP '+r.status);const health=await r.json();if(!health.ok)throw new Error('Agent-Healthcheck fehlgeschlagen');nodes.push({id,name,url:endpoint,token,enabled:true,addedAt:Date.now()});saveNodes();audit(u,'node_add',id,name);return send(res,200,{ok:true,node:{id,name,url:endpoint,health}})}catch(e){return send(res,400,{error:'Node nicht erreichbar: '+e.message})}
  }
  const nd=/^\/api\/admin\/nodes\/([a-f0-9]+)$/.exec(p);
  if(nd&&req.method==='DELETE'){if(u.role!=='owner')return send(res,403,{error:'Nur Owner'});if(db.servers.some(x=>x.nodeId===nd[1]))return send(res,409,{error:'Node hat noch zugewiesene Server'});nodes=nodes.filter(n=>n.id!==nd[1]);saveNodes();audit(u,'node_remove',nd[1],'');return send(res,200,{ok:true})}
  if(p==='/api/admin/users'&&req.method==='GET')return send(res,200,{users:db.users.map(x=>Object.assign(pub(x),{banned:!!x.banned,credits:x.credits||0,premium:!!x.premium,premiumUntil:x.premiumUntil||null}))});
  if(p==='/api/admin/audit'&&req.method==='GET')return send(res,200,{entries:db.audit.slice(0,250)});
  if(p==='/api/admin/settings'&&req.method==='GET')return send(res,200,{settings:db.settings});
  if(p==='/api/admin/settings'&&req.method==='POST'){
   if(u.role!=='owner')return send(res,403,{error:'Nur Owner'});const b=await body(req),lim=Number(b.userServerLimit),cred=Number(b.defaultCredits);
   if(!Number.isInteger(lim)||lim<1||lim>100||!Number.isInteger(cred)||cred<0||cred>10000000)return send(res,400,{error:'Ungültige Limits'});
   db.settings.userServerLimit=lim;db.settings.defaultCredits=cred;audit(u,'settings','system','Serverlimit '+lim+', Start-Credits '+cred);return send(res,200,{settings:db.settings});
  }
  if(p==='/api/admin/grant'&&req.method==='POST'){
   const b=await body(req),t=db.users.find(x=>x.id===b.id);if(!t||t.role==='owner')return send(res,404,{error:'Nutzer nicht gefunden'});
   if(b.credits!==undefined){const n=Number(b.credits);if(!Number.isInteger(n)||n<0||n>10000000)return send(res,400,{error:'Credits ungültig'});t.credits=(t.credits||0)+n;}
   if(b.premium!==undefined){t.premium=!!b.premium;t.premiumUntil=t.premium?(b.days?Date.now()+Math.min(3650,Math.max(1,Number(b.days)))*864e5:null):null;}
   audit(u,'grant',t.id,'Credits/Premium geändert');save();return send(res,200,{ok:true,user:Object.assign(pub(t),{credits:t.credits||0,premium:!!t.premium,premiumUntil:t.premiumUntil||null})});
  }
  if(p==='/api/admin/role'&&req.method==='POST'){
   if(u.role!=='owner')return send(res,403,{error:'Nur der Owner darf Rollen ändern'});
   const b=await body(req),t=db.users.find(x=>x.id===b.id);
   if(!t||!ROLES.includes(b.role)||b.role==='owner'||t.role==='owner')return send(res,400,{error:'Ungültig'});
   t.role=b.role;audit(u,'role_change',t.id,b.role);return send(res,200,{ok:1});
  }
  if(p==='/api/admin/ban'&&req.method==='POST'){
   const b=await body(req),t=db.users.find(x=>x.id===b.id);
   if(!t||t.role==='owner'||t.id===u.id||(t.role==='admin'&&u.role!=='owner'))return send(res,400,{error:'Ungültig'});
   t.banned=!!b.banned;audit(u,t.banned?'user_ban':'user_unban',t.id,'');if(t.banned)for(const k of Object.keys(db.sessions))if(db.sessions[k].uid===t.id)delete db.sessions[k];
   save();return send(res,200,{ok:1});
  }
 }
 const adm=['admin','owner'].includes(u.role);
 if(p==='/api/node'){const target=nodes.length?nodes[0].id:undefined;try{const h=await agent('GET','/health',null,8000,target);return send(res,200,Object.assign({online:true,java:h.java.found,javaVersion:h.java.version,nodeCount:nodes.length},adm?{totalMemMB:h.totalMemMB,freeMemMB:h.freeMemMB,usedRamMB:h.usedRamMB}:{}))}catch(e){return send(res,200,{online:false,nodeCount:nodes.length})}}
 if(p==='/api/servers'&&req.method==='GET'){
  const mine=db.servers.filter(s=>s.uid===u.id||adm),infos={};let online=false;
  const buckets=[...new Set(mine.map(x=>x.nodeId||''))];
  for(const nid of buckets){try{const data=(await agent('GET','/servers',null,15000,nid||undefined)).servers||[];online=true;data.forEach(x=>infos[x.id]=x)}catch(e){}}
  return send(res,200,{online,servers:mine.map(s=>({id:s.id,name:s.name,info:infos[s.id]||null,nodeId:s.nodeId||null}))});
 }
 if(p==='/api/servers'&&req.method==='POST'){
  const b=await body(req),d=db.drafts.find(x=>x.id===b.draftId&&x.uid===u.id);
  if(!d)return send(res,404,{error:'Entwurf nicht gefunden'});
  const software=String(d.sw||'Paper').toLowerCase();
  if(software==='spigot')return send(res,400,{error:'Spigot benötigt BuildTools; bitte Paper/Purpur verwenden oder Spigot separat bauen.'});
  if(b.acceptEula!==true)return send(res,400,{error:'Bitte die Minecraft-EULA akzeptieren'});
  const ram=parseInt(b.ram,10);if(!(ram>=512&&ram<=(adm?8192:4096)))return send(res,400,{error:'RAM ungültig'});
  if(!adm&&db.servers.filter(x=>x.uid===u.id).length>=(u.premium?Math.max(5,db.settings.userServerLimit):db.settings.userServerLimit))return send(res,400,{error:'Serverlimit erreicht'});
  const id=uid(),node=await chooseOnlineNode();
  try{await agent('POST','/servers',{id,name:d.name,software,version:d.ver,ram,maxPlayers:d.pl,motd:d.name,crossplay:d.ed==='Java + Bedrock',acceptEula:true},120000,node&&node.id)}catch(e){return send(res,400,{error:e.message.includes('fetch')?'Kein Hosting-Node erreichbar':e.message})}
  db.servers.push({id,uid:u.id,name:d.name,nodeId:node?node.id:null});if(node)node.serverCount=(node.serverCount||0)+1;audit(u,'server_create',id,d.name);db.drafts=db.drafts.filter(x=>x.id!==d.id);save();
  return send(res,200,{id});
 }


 const mp=/^\/api\/servers\/([a-f0-9]{1,32})\/modpack\/(modrinth|curseforge|modrinth-project|curseforge-project|updates|update)$/.exec(p);
 if(mp&&(['POST'].includes(req.method)||mp[2]==='updates'&&req.method==='GET')){
  const sv=db.servers.find(x=>x.id===mp[1]&&(x.uid===u.id||adm));if(!sv)return send(res,404,{error:'Server nicht gefunden'});
  try{const b=req.method==='POST'?await body(req,360*1024*1024):null;return send(res,200,await agent(req.method,'/servers/'+sv.id+'/modpack/'+mp[2],b,900000,sv.nodeId))}
  catch(e){return send(res,400,{error:e.message})}
 }
 const lib=/^\/api\/servers\/([a-f0-9]{1,32})\/library$/.exec(p);
 if(lib&&req.method==='POST'){
  const sv=db.servers.find(x=>x.id===lib[1]&&(x.uid===u.id||adm));if(!sv)return send(res,404,{error:'Server nicht gefunden'});
  try{return send(res,200,await agent('POST','/servers/'+sv.id+'/library',await body(req),120000,sv.nodeId))}catch(e){return send(res,400,{error:e.message})}
 }
 const sx=/^\/api\/servers\/([a-f0-9]{1,32})\/(restart|delete|rename|resources|properties|players|players-history|backups|backup-download|backup-delete|backup-restore|metrics|files|file-write|file-upload|file-download|crossplay|updates|update)$/.exec(p);
 if(sx){
  const sv=db.servers.find(x=>x.id===sx[1]&&(x.uid===u.id||adm));if(!sv)return send(res,404,{error:'Server nicht gefunden'});
  const act=sx[2],method=req.method;
  const allowed=(act==='properties'||act==='file-write')?['GET','POST']:(act==='file-upload')?['POST']:(act==='players'||act==='players-history'||act==='backups'||act==='metrics'||act==='files'||act==='file-download'||act==='updates')?['GET']:['POST'];
  if(!allowed.includes(method))return send(res,405,{error:'Nicht erlaubt'});
  try{
   const b=method==='POST'?await body(req,act==='file-upload'?140*1024*1024:2*1024*1024):null;
   if(act==='delete'){
    if(sv.uid!==u.id&&!adm)return send(res,403,{error:'Kein Zugriff'});
    await agent('POST','/servers/'+sv.id+'/delete',null,15000,sv.nodeId);db.servers=db.servers.filter(x=>x.id!==sv.id);audit(u,'server_delete',sv.id,sv.name);save();return send(res,200,{ok:true})
   }
   if(act==='rename'||act==='resources'||act==='properties'||act==='backup-download'||act==='backup-delete'||act==='backup-restore'||act==='update'){ 
    const result=await agent(method,'/servers/'+sv.id+'/'+act,b,15000,sv.nodeId);return send(res,200,result)
   }
   if(act==='files'||act==='file-download'){
    const q=url.searchParams.get('path')||'.';
    return send(res,200,await agent('GET','/servers/'+sv.id+'/'+act+'?path='+encodeURIComponent(q),null,15000,sv.nodeId))
   }
   if(act==='file-write'||act==='file-upload'){return send(res,200,await agent('POST','/servers/'+sv.id+'/'+act,b,act==='file-upload'?180000:15000,sv.nodeId))}
   return send(res,200,await agent('GET','/servers/'+sv.id+'/'+act,null,15000,sv.nodeId))
  }catch(e){return send(res,400,{error:e.message.includes('fetch')?'Hosting-Node nicht erreichbar':e.message})}
 }

 const mm=/^\/api\/servers\/([a-f0-9]{1,32})\/(start|stop|backup|command|log)$/.exec(p);
 if(mm){
  const sv=db.servers.find(x=>x.id===mm[1]&&(x.uid===u.id||adm));if(!sv)return send(res,404,{error:'Server nicht gefunden'});
  try{
   if(mm[2]==='log'&&req.method==='GET')return send(res,200,await agent('GET','/servers/'+sv.id+'/log',null,15000,sv.nodeId));
   if(req.method!=='POST')return send(res,405,{error:'Nicht erlaubt'});
   if(mm[2]==='command'){const b=await body(req);return send(res,200,await agent('POST','/servers/'+sv.id+'/command',{cmd:String(b.cmd||'')},15000,sv.nodeId))}
   return send(res,200,await agent('POST','/servers/'+sv.id+'/'+mm[2],null,mm[2]==='backup'?300000:15000,sv.nodeId));
  }catch(e){return send(res,400,{error:e.message.includes('fetch')?'Hosting-Node nicht erreichbar (PC aus oder Agent nicht gestartet)':e.message})}
 }

 send(res,404,{error:'Unbekannt'});
}
function login(req,res,u){const t=crypto.randomBytes(32).toString('hex');
 for(const k of Object.keys(db.sessions))if(db.sessions[k].exp<Date.now())delete db.sessions[k];
 db.sessions[sha(t)]={uid:u.id,exp:Date.now()+30*864e5};save();return send(res,200,{user:pub(u)},setCookie(req,t,30*86400))}
const TYPES={'.html':'text/html; charset=utf-8','.json':'application/json','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png'};
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://x');
  if(url.pathname.startsWith('/api/'))return await api(req,res,url);
  let f=url.pathname==='/'?'/index.html':url.pathname;f=path.normalize(f).replace(/^(\.\.[\/\\])+/,'');
  const fp=path.join(PUB,f);if(!fp.startsWith(PUB)||!fs.existsSync(fp)||fs.statSync(fp).isDirectory()){res.writeHead(404);return res.end('Not found')}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(fp)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'});fs.createReadStream(fp).pipe(res);
 }catch(e){if(!res.headersSent)send(res,400,{error:'Fehler bei der Anfrage'});else res.end()}
}).listen(PORT,()=>console.log('MINEFORGE läuft auf Port '+PORT));
