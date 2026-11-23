'use strict';
const {test,afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Monitor,StateStore,readConfig,parseToken,telegramChunks,acquireLock,listenHttp} = require('../monitor');
const dirs=[];
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
const quiet={log(){},warn(){},error(){}};
function harness({moodle,telegram,state,config={}}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moodle-test-'));dirs.push(dir);
  const cfg={...readConfig({MOODLE_TOKEN:'0'.repeat(32),TELEGRAM_BOT_TOKEN:'123:TEST_ONLY',TELEGRAM_CHAT_ID:'123',STATE_FILE:path.join(dir,'data','state.json')}),...config};
  const store=new StateStore(cfg.stateFile,quiet);
  if(state)store.update(s=>Object.assign(s,state));
  const calls=[],sent=[];
  const fetchImpl=async(url,opts)=>{
    const tg=url.startsWith('https://api.telegram.org/');
    const method=tg?url.split('/').at(-1):opts.body.get('wsfunction');
    const body=tg?JSON.parse(opts.body):Object.fromEntries(opts.body);
    calls.push({tg,method,body,signal:opts.signal});
    if(tg) {
      if(method==='sendMessage')sent.push(body.text);
      const custom=await telegram?.(method,body,opts);
      return {ok:true,json:async()=>custom||{ok:true,result:method==='getWebhookInfo'?{url:''}:[]}};
    }
    const custom=await moodle?.(method,body,opts);
    if(custom!==undefined)return {ok:true,json:async()=>custom};
    const data={
      core_webservice_get_site_info:{userid:1,fullname:'Synthetic Student'},
      core_calendar_get_action_events_by_timesort:{events:[]},
      core_calendar_get_calendar_upcoming_view:{events:[]},
      core_enrol_get_users_courses:[],core_course_get_contents:[],
      message_popup_get_popup_notifications:{notifications:[]},
    }[method];
    if(data===undefined)throw new Error('Unexpected fake request: '+method);
    return {ok:true,json:async()=>data};
  };
  const monitor=new Monitor(cfg,{store,fetchImpl,logger:quiet,sleep:async()=>{}});
  return {monitor,store,cfg,calls,sent,fetchImpl};
}
const update=(text,id=1,chat=123)=>({update_id:id,message:{text,date:Math.floor(Date.now()/1000),chat:{id:chat}}});
test('rechaza configuración peligrosa y valida token final sin divulgarlo',()=>{
  const base={MOODLE_TOKEN:'0'.repeat(32),TELEGRAM_BOT_TOKEN:'123:TEST_ONLY',TELEGRAM_CHAT_ID:'123'};
  for(const CHECK_MIN of ['0','-1','NaN','','Infinity'])assert.throws(()=>readConfig({...base,CHECK_MIN}));
  assert.throws(()=>readConfig({...base,MOODLE_TOKEN:'   '}),/formato/);
  assert.throws(()=>readConfig({...base,STATE_FILE:'relative.json'}),/absoluta/);
  assert.throws(()=>readConfig({...base,MOODLE_URL:'http://example.com'}),/HTTPS/);
  assert.throws(()=>readConfig({...base,TELEGRAM_CHAT_ID:'@someone'}),/número/);
  assert.equal(readConfig({...base,DIGEST_HOUR:'0'}).digestHour,0);
  assert.equal(parseToken('moodlemobile://token='+Buffer.from('site:::'+'a'.repeat(32)+':::private').toString('base64')),'a'.repeat(32));
});
test('las dos APIs de calendario fallidas nunca producen resumen vacío ni lastCheck nuevo',async()=>{
  const h=harness({moodle:async fn=>{if(fn.includes('calendar'))return {exception:'error',errorcode:'invalidtoken'};}});
  assert.equal(await h.monitor.review(),false);
  assert.equal(h.monitor.state.lastCheck,0);
  assert.equal(h.monitor.state.lastResult,'failed');
  assert.equal(h.monitor.state.initialized,false);
  assert(h.monitor.state.outbox.every(m=>!m.text.includes('No tienes actividades pendientes')));
  assert(h.monitor.state.outbox.some(m=>m.text.includes('No significa que no tengas pendientes')));
});
test('no presenta como completo un calendario truncado por el límite de 50',async()=>{
  const h=harness({moodle:async fn=>fn==='core_calendar_get_action_events_by_timesort'?{events:Array.from({length:50},(_,id)=>({id}))}:undefined});
  assert.equal(await h.monitor.review(),false);assert.equal(h.monitor.state.lastCheck,0);
});
test('fallo de material o notificaciones queda como revisión parcial y conserva último éxito',async()=>{
  for(const failed of ['core_course_get_contents','message_popup_get_popup_notifications']){
    const h=harness({state:{lastCheck:100},moodle:async fn=>{
      if(fn==='core_enrol_get_users_courses')return [{id:1,fullname:'Synthetic course'}];
      if(fn===failed)throw new Error('Synthetic failure');
    }});
    assert.equal(await h.monitor.review(),false);
    assert.equal(h.monitor.state.lastCheck,100);assert.equal(h.monitor.state.lastResult,'partial');
    assert(h.monitor.state.outbox.some(m=>m.text.includes('Revisión parcial')));
  }
});
test('/ayuda y /estado no necesitan Moodle, incluso si Moodle falla',async()=>{
  const h=harness({moodle:async()=>{throw new Error('Must not call Moodle');}});
  await h.monitor.processUpdates([update('/ayuda'),update('/estado',2)]);
  assert.equal(h.calls.filter(c=>!c.tg).length,0);
  assert(h.sent.some(t=>t.includes('/pausar')));assert(h.sent.some(t=>t.includes('Última revisión')));
});
test('/pausar aborta la consulta activa y se confirma después de cancelarla',async()=>{
  let reached;const waiting=new Promise(r=>{reached=r;});let cancelled=false;
  const h=harness({moodle:async(fn,body,opts)=>{
    if(fn==='core_calendar_get_action_events_by_timesort')return new Promise((resolve,reject)=>{
      reached();opts.signal.addEventListener('abort',()=>{cancelled=true;reject(new Error('aborted'));},{once:true});
    });
  }});
  const review=h.monitor.review();await waiting;
  await h.monitor.processUpdates([update('/pausar')]);await review;
  assert(cancelled);assert(h.monitor.state.paused);assert.equal(h.monitor.state.lastCheck,0);
  assert.equal(h.monitor.state.tgOffset,2);assert(h.sent.some(t=>t.includes('Monitor pausado')));
  const count=h.calls.filter(c=>!c.tg).length;
  await h.monitor.handleCommand('/pendientes');await h.monitor.schedulerTick();
  assert.equal(h.calls.filter(c=>!c.tg).length,count);
});
test('pausa y cursor sobreviven reinicio; /reanudar fuerza una revisión',async()=>{
  const h=harness();await h.monitor.processUpdates([update('/pausar',15)]);
  const restarted=new Monitor(h.cfg,{fetchImpl:h.fetchImpl,logger:quiet,sleep:async()=>{}});
  assert(restarted.state.paused);assert.equal(restarted.state.tgOffset,16);
  await restarted.schedulerTick();assert.equal(h.calls.filter(c=>!c.tg).length,0);
  await restarted.processUpdates([update('/reanudar',16)]);await restarted.schedulerTick();
  assert.equal(restarted.state.paused,false);assert(restarted.state.lastCheck>0);
});
test('un chat ajeno no puede pausar, reanudar ni consultar datos',async()=>{
  const h=harness();await h.monitor.processUpdates([update('/pausar',1,456),update('/pendientes',2,456)]);
  assert.equal(h.monitor.state.paused,false);assert.equal(h.calls.length,0);assert.equal(h.monitor.state.tgOffset,3);
});
test('no confirma comando si Telegram no aceptó la respuesta',async()=>{
  let fail=true;const h=harness({telegram:async method=>method==='sendMessage'&&fail?{ok:false,error_code:503}:undefined});
  await assert.rejects(h.monitor.processUpdates([update('/ayuda',10)]));assert.equal(h.monitor.state.tgOffset,0);
  fail=false;await h.monitor.processUpdates([update('/ayuda',10)]);assert.equal(h.monitor.state.tgOffset,11);
  const count=h.sent.length;await h.monitor.processUpdates([update('/ayuda',10)]);assert.equal(h.sent.length,count);
});
test('cola durable conserva avisos al fallar Telegram y los recupera después del reinicio',async()=>{
  let fail=true;const h=harness({telegram:async method=>method==='sendMessage'&&fail?{ok:false,error_code:503}:undefined});
  assert.equal(await h.monitor.review(),true);const pending=h.monitor.state.outbox.length;assert(pending>0);
  await assert.rejects(h.monitor.drainOutbox());assert.equal(h.monitor.state.outbox.length,pending);
  fail=false;const restarted=new Monitor(h.cfg,{fetchImpl:h.fetchImpl,logger:quiet,sleep:async()=>{}});
  await restarted.drainOutbox();assert.equal(restarted.state.outbox.length,0);assert(restarted.state.initialized);
});
test('reanuda una entrega larga desde el fragmento pendiente',async()=>{
  let attempts=0;const h=harness({state:{outbox:[{id:'synthetic',text:'x'.repeat(8000),next:0}]},telegram:async method=>{
    if(method==='sendMessage'&&++attempts===2)return {ok:false,error_code:503};
  }});
  await assert.rejects(h.monitor.drainOutbox());assert.equal(h.monitor.state.outbox[0].next,1);
  const restarted=new Monitor(h.cfg,{fetchImpl:h.fetchImpl,logger:quiet,sleep:async()=>{}});
  await restarted.drainOutbox();assert.equal(restarted.state.outbox.length,0);assert.equal(attempts,4);
});
test('estado truncado recupera copia válida; sin copia se detiene sin reiniciar historial',()=>{
  const h=harness();h.store.update(s=>{s.paused=true;});h.store.update(s=>{s.tgOffset=8;});
  fs.writeFileSync(h.cfg.stateFile,'{truncated');
  const recovered=new StateStore(h.cfg.stateFile,quiet);assert.equal(recovered.value.paused,true);
  fs.writeFileSync(h.cfg.stateFile,'bad');fs.writeFileSync(h.cfg.stateFile+'.bak','bad');
  assert.throws(()=>new StateStore(h.cfg.stateFile,quiet),/Se detiene/);
});
test('estado legacy conserva historial y migra nuevos campos sin volver a inicializar',()=>{
  const h=harness();fs.mkdirSync(path.dirname(h.cfg.stateFile),{recursive:true});
  fs.writeFileSync(h.cfg.stateFile,JSON.stringify({initialized:true,events:{'1':{sent:['new']}},modules:{'2':['3']},notifs:['4'],lastCheck:100}));
  const store=new StateStore(h.cfg.stateFile,quiet);assert(store.value.initialized);assert.equal(store.value.events['1'].sent[0],'new');assert.equal(store.value.paused,false);
});
test('escritura atómica deja permisos privados y ninguna escritura temporal pendiente',()=>{
  const h=harness();h.store.update(s=>{s.paused=true;});h.store.update(s=>{s.tgOffset=3;});
  assert.equal(fs.statSync(h.cfg.stateFile).mode&0o777,0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(h.cfg.stateFile)).sort(),['state.json','state.json.bak']);
  assert.equal(JSON.parse(fs.readFileSync(h.cfg.stateFile+'.bak')).paused,true);
});
test('fallo de disco detiene al monitor en lugar de confirmar una pausa no guardada',async()=>{
  const h=harness();h.store.update=()=>{throw new Error('Disk full');};
  await assert.rejects(h.monitor.handleCommand('/pausar'),/guardar el estado/);
  assert(h.monitor.shutdown.signal.aborted);assert.equal(h.sent.length,0);assert.equal(h.monitor.health().healthy,false);
});
test('petición lenta se cancela al agotar el plazo de la aplicación',async()=>{
  const h=harness({config:{requestMs:15},moodle:async(fn,body,opts)=>new Promise((resolve,reject)=>{
    opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});
  })});
  const keepAlive=setTimeout(()=>{},1000);
  try {assert.equal(await h.monitor.review(),false);assert.equal(h.monitor.state.lastCheck,0);}
  finally{clearTimeout(keepAlive);}
});
test('health distingue pausa, estado obsoleto y error; no expone identidad ni secretos',()=>{
  const h=harness();h.monitor.lastPoll=Date.now();assert.equal(h.monitor.health().healthy,false);
  h.store.update(s=>{s.lastCheck=Date.now();s.lastResult='complete';});assert(h.monitor.health().healthy);
  h.store.update(s=>{s.lastCheck=1;});assert.equal(h.monitor.health().healthy,false);
  h.store.update(s=>{s.paused=true;});assert(h.monitor.health().healthy);assert.equal(h.monitor.health().status,'paused');
  const publicData=JSON.stringify(h.monitor.health());assert(!publicData.includes(h.cfg.token));assert(!publicData.includes(h.cfg.moodleToken));assert(!publicData.includes(h.cfg.stateFile));
});
test('/healthz responde 503 al degradarse; la página de vida sigue disponible',async()=>{
  const h=harness({config:{port:0,ip:'127.0.0.1'}});const server=await listenHttp(h.monitor);
  const url='http://127.0.0.1:'+server.address().port;
  try {
    assert.equal((await fetch(url+'/healthz')).status,503);assert.equal((await fetch(url+'/')).status,200);
    h.monitor.lastPoll=Date.now();h.store.update(s=>{s.paused=true;});
    const response=await fetch(url+'/healthz');assert.equal(response.status,200);assert.equal((await response.json()).paused,true);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('bloqueo rechaza un segundo proceso y se libera al cerrar la instancia',async()=>{
  const key='test:'+process.pid+':'+Date.now();const lock=await acquireLock(key);
  try{await assert.rejects(acquireLock(key),/Otra instancia/);}finally{await new Promise(r=>lock.close(r));}
  const again=await acquireLock(key);await new Promise(r=>again.close(r));
});
test('registro de comandos se actualiza aunque el estado antiguo diga commandsSet',async()=>{
  const h=harness({state:{commandsSet:true}});await h.monitor.setupCommands();
  assert(h.calls.some(c=>c.method==='setMyCommands'&&c.body.commands.some(cmd=>cmd.command==='pausar')));
});
test('webhook existente impide iniciar otro receptor sin modificar su configuración',async()=>{
  const h=harness({telegram:async method=>method==='getWebhookInfo'?{ok:true,result:{url:'https://example.invalid/webhook'}}:undefined});
  await assert.rejects(h.monitor.setupCommands(),/webhook/);assert(!h.calls.some(c=>c.method==='deleteWebhook'));
});
test('fragmenta líneas largas y conserva enlaces sin HTML inválido ni pares Unicode cortados',()=>{
  const text='😀'.repeat(4500);const chunks=telegramChunks('<b>'+text+'</b>');
  assert(chunks.every(c=>c.length<=3900&&!/[\uD800-\uDBFF]$/.test(c)));assert.equal(chunks.join(''),text);
  assert.equal(telegramChunks('<a href="https://example.com/?a=1&amp;b=2">Curso</a>')[0],'Curso (https://example.com/?a=1&b=2)');
});
test('los errores registrados eliminan tokens y contraseñas',()=>{
  const h=harness();const sanitized=h.monitor.errorText(new Error('failure '+h.cfg.token+' '+h.cfg.moodleToken));
  assert(!sanitized.includes(h.cfg.token));assert(!sanitized.includes(h.cfg.moodleToken));
});
test('un comando procesado durante una revisión no pierde su cursor al guardar el resultado',async()=>{
  let reached,release;const waiting=new Promise(r=>{reached=r;}),barrier=new Promise(r=>{release=r;});
  const h=harness({moodle:async fn=>{if(fn==='core_calendar_get_action_events_by_timesort'){reached();await barrier;return {events:[]};}}});
  const review=h.monitor.review();await waiting;await h.monitor.processUpdates([update('/estado',40)]);release();
  assert(await review);assert.equal(h.monitor.state.tgOffset,41);
});
test('la pausa espera el envío ya iniciado antes de confirmar y conserva el resto de la cola',async()=>{
  let reached,release;const waiting=new Promise(r=>{reached=r;}),barrier=new Promise(r=>{release=r;});let first=true;
  const h=harness({state:{outbox:[{id:'one',text:'x'.repeat(8000),next:0}]},telegram:async method=>{
    if(method==='sendMessage'&&first){first=false;reached();await barrier;}
  }});
  const delivering=h.monitor.drainOutbox();await waiting;
  let confirmed=false;const pause=h.monitor.handleCommand('/pausar').then(()=>{confirmed=true;});
  await new Promise(r=>setImmediate(r));assert.equal(confirmed,false);release();await pause;await delivering;
  assert(h.monitor.state.paused);assert.equal(h.monitor.state.outbox[0].next,1);assert.equal(h.sent.length,2);
});
test('caída abrupta libera bloqueos y el proceso siguiente recupera estado y termina con SIGTERM',async()=>{
  const {spawn}=require('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moodle-cli-'));dirs.push(dir);
  const cfg={MOODLE_TOKEN:'1'.repeat(32),TELEGRAM_BOT_TOKEN:'999:CLI_TEST_'+Date.now(),TELEGRAM_CHAT_ID:'123',STATE_FILE:path.join(dir,'state.json')};
  function launch() {
    const child=spawn(process.execPath,['--require',path.join(__dirname,'..','test-support','fake-api.cjs'),path.join(__dirname,'..','monitor.js'),'--listen'],{env:cfg,stdio:['ignore','pipe','pipe']});
    let output='';const listeners=new Set();
    child.stdout.on('data',d=>{output+=d;for(const check of listeners)check();});child.stderr.on('data',d=>{output+=d;});
    const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
    const waitFor=pattern=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{listeners.delete(check);reject(new Error('CLI timeout: '+output));},5000);
      const check=()=>{if(pattern.test(output)){clearTimeout(timer);listeners.delete(check);resolve();}};
      listeners.add(check);check();
    });
    return {child,exited,waitFor,output:()=>output};
  }
  const first=launch();let second;
  try {
    await first.waitFor(/OK .* eventos/);first.child.kill('SIGKILL');await first.exited;
    assert(JSON.parse(fs.readFileSync(cfg.STATE_FILE)).initialized);
    second=launch();await second.waitFor(/TEST_POLL_READY/);second.child.kill('SIGTERM');
    assert.equal((await second.exited).code,0);
    const state=JSON.parse(fs.readFileSync(cfg.STATE_FILE));assert(state.initialized);assert(state.lastCheck>0);
    assert(!second.output().includes(cfg.MOODLE_TOKEN));assert(!second.output().includes(cfg.TELEGRAM_BOT_TOKEN));
  } finally {first.child.kill('SIGKILL');second?.child.kill('SIGKILL');}
});
