'use strict';
// Node 22+. Sin dependencias externas. Solo --listen/--loop o --once explícito.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const TZ = 'America/Guayaquil';
const REMINDERS = [
  { key: '3h', ms: 3 * 3600e3, label: 'Vence en menos de 3 horas' },
  { key: '24h', ms: 24 * 3600e3, label: 'Vence en menos de 24 horas' },
  { key: '72h', ms: 72 * 3600e3, label: 'Vence en menos de 3 días' },
];
const TIPOS = {
  assign: 'Tarea', quiz: 'Cuestionario', lesson: 'Lección', resource: 'Archivo',
  folder: 'Carpeta', url: 'Enlace', page: 'Página', forum: 'Foro', label: 'Aviso',
  choice: 'Consulta', feedback: 'Encuesta', workshop: 'Taller', glossary: 'Glosario',
  bigbluebuttonbn: 'Clase virtual', zoom: 'Zoom', h5pactivity: 'H5P', scorm: 'SCORM',
  data: 'Base de datos', book: 'Libro',
};

/* ---------------- utilidades ---------------- */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const short = (s, n = 90) => { s = stripHtml(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmt = (ts) => new Date(ts * 1000).toLocaleString('es-EC', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
});
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const hourNow = () => Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }));

function remaining(ts) {
  const ms = ts * 1000 - Date.now();
  if (ms < 0) return 'vencida';
  const h = Math.floor(ms / 3600e3);
  if (h < 1) return `faltan ${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 48) return `faltan ${h} h`;
  return `faltan ${Math.floor(h / 24)} días`;
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out);
    else out[key] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return out;
}


function numberSetting(env, key, fallback, min, max) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isFinite(value) || value < min || value > max || String(env[key] ?? fallback).trim() === '') {
    throw new Error(`${key}: debe ser un número entre ${min} y ${max}.`);
  }
  return value;
}
function parseToken(raw) {
  let token = String(raw || '').trim();
  const match = token.match(/token=([A-Za-z0-9+/=_-]+)/);
  if (match) token = match[1];
  if (!/^[0-9a-f]{32}$/i.test(token)) {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    if (decoded.includes(':::')) token = decoded.split(':::')[1];
  }
  if (!/^[0-9a-f]{32}$/i.test(token)) throw new Error('MOODLE_TOKEN: formato inválido.');
  return token;
}
function readConfig(env = process.env) {
  const url = new URL(env.MOODLE_URL || 'https://www217.ucsg.edu.ec');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('MOODLE_URL debe ser una dirección HTTPS sin credenciales ni parámetros.');
  }
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chat = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Falta TELEGRAM_BOT_TOKEN o su formato es inválido.');
  if (!/^-?\d+$/.test(chat)) throw new Error('TELEGRAM_CHAT_ID debe ser un número de chat.');
  const moodleToken = env.MOODLE_TOKEN === undefined ? null : parseToken(env.MOODLE_TOKEN);
  if (!moodleToken && (!env.MOODLE_USER || !env.MOODLE_PASS)) throw new Error('Falta MOODLE_TOKEN (o MOODLE_USER y MOODLE_PASS).');
  const stateFile = env.STATE_FILE || path.join(__dirname, 'data', 'state.json');
  if (!path.isAbsolute(stateFile)) throw new Error('STATE_FILE debe ser una ruta absoluta.');
  const checkMin = numberSetting(env, 'CHECK_MIN', 55, 1, 1440);
  const digestHour = numberSetting(env, 'DIGEST_HOUR', 7, 0, 23);
  const port = env.PORT === undefined ? null : numberSetting(env, 'PORT', 0, 1, 65535);
  if (!Number.isInteger(digestHour) || (port !== null && !Number.isInteger(port))) throw new Error('DIGEST_HOUR y PORT deben ser enteros.');
  return { moodleUrl: url.href.replace(/\/$/, ''), moodleToken, moodleUser: env.MOODLE_USER,
    moodlePass: env.MOODLE_PASS, token, chat, stateFile, checkMin, digestHour, port,
    ip: env.IP || env.HOST || '0.0.0.0', requestMs: 30000, pollMs: 65000, retryMs: 600000 };
}
function initialState() {
  return { initialized: false, events: {}, modules: {}, notifs: [], lastDigest: '', lastErrorDay: '',
    paused: false, tgOffset: 0, outbox: [], lastCheck: 0, lastAttempt: 0, lastResult: 'starting', components: {} };
}
function validState(value) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || typeof value.initialized !== 'boolean' || !object(value.events) || !object(value.modules) || !Array.isArray(value.notifs)) {
    throw new Error('Estructura de estado inválida.');
  }
  if (Object.values(value.events).some(e => !object(e) || !Array.isArray(e.sent) || e.sent.some(x=>typeof x !== 'string')) ||
      Object.values(value.modules).some(v=>!Array.isArray(v)) || value.notifs.some(v=>typeof v !== 'string')) throw new Error('Historial de estado inválido.');
  if (value.paused !== undefined && typeof value.paused !== 'boolean') throw new Error('Pausa de estado inválida.');
  if (value.tgOffset !== undefined && (!Number.isSafeInteger(value.tgOffset) || value.tgOffset < 0)) throw new Error('Cursor de estado inválido.');
  if (value.outbox !== undefined && (!Array.isArray(value.outbox) || value.outbox.some(m=>!object(m) || typeof m.text !== 'string' || !Number.isSafeInteger(m.next) || m.next < 0))) {
    throw new Error('Cola de estado inválida.');
  }
  for (const key of ['lastCheck','lastAttempt']) if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0)) throw new Error('Fecha de estado inválida.');
  return { ...initialState(), ...value };
}
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 1));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}
class StateStore {
  constructor(file, logger = console) {
    this.file = file; this.exists = false; this.value = initialState();
    try { this.value = validState(JSON.parse(fs.readFileSync(file, 'utf8'))); this.exists = true; }
    catch (err) {
      if (err.code === 'ENOENT' && !fs.existsSync(`${file}.bak`)) return;
      try {
        this.value = validState(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')));
        atomicWrite(file, this.value); this.exists = true;
        logger.warn('Estado recuperado desde la copia de seguridad; revisa el almacenamiento.');
      } catch { throw new Error('No se pudo leer el estado ni su copia. Se detiene para no perder el historial.'); }
    }
  }
  update(change) {
    const next = structuredClone(this.value);
    change(next); validState(next);
    if (this.exists) atomicWrite(`${this.file}.bak`, this.value);
    atomicWrite(this.file, next);
    this.value = next; this.exists = true;
  }
}
function plainText(html) {
  return String(html).replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
function telegramChunks(html, max = 3900) {
  const chunks = []; let text = plainText(html);
  while (text.length > max) {
    let end = text.lastIndexOf('\n', max);
    if (end < max / 2) end = max;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end)); text = text.slice(end);
    if (text.startsWith('\n')) text = text.slice(1);
  }
  if (text) chunks.push(text);
  return chunks;
}
const line = (e) =>
  `• <b>${esc(e.name)}</b>${e.course ? `\n   ${esc(e.course)}` : ''}\n   📅 ${fmt(e.ts)} (${remaining(e.ts)})` +
  (e.url ? `\n   <a href="${esc(e.url)}">Abrir en Moodle</a>` : '');

function digest(events) {
  const now = Date.now() / 1000;
  const vencidas = events.filter((e) => e.actionable && e.ts < now).sort((a, b) => a.ts - b.ts);
  const proximas = events.filter((e) => e.ts >= now && e.ts < now + 14 * 86400).sort((a, b) => a.ts - b.ts);
  let t = `📋 <b>Resumen del día</b> (${new Date().toLocaleDateString('es-EC', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })})\n`;
  if (!vencidas.length && !proximas.length) return t + '\nNo tienes actividades pendientes en las próximas 2 semanas. 🎉';
  if (vencidas.length) t += `\n⚠️ <b>Vencidas y aún abiertas</b>\n${vencidas.map(line).join('\n')}\n`;
  if (proximas.length) t += `\n🗓 <b>Próximas 2 semanas</b>\n${proximas.map(line).join('\n')}`;
  return t;
}


const COMANDOS = [
  { command: 'pendientes', description: 'Todo lo que tienes por entregar' },
  { command: 'hoy', description: 'Lo que vence hoy' },
  { command: 'semana', description: 'Lo que vence en los próximos 7 días' },
  { command: 'materia', description: 'Pendientes: /materia calculo' },
  { command: 'cursos', description: 'Tus materias y pendientes' },
  { command: 'pausar', description: 'Detener todas las consultas a Moodle' },
  { command: 'reanudar', description: 'Volver a revisar Moodle' },
  { command: 'estado', description: 'Pausa, revisión y avisos pendientes' },
  { command: 'ayuda', description: 'Ver los comandos' },
];
const AYUDA = '🤖 <b>Comandos</b>\n' + COMANDOS.map(c=>`/${c.command} — ${esc(c.description)}`).join('\n') +
  '\n\nDurante /pausar no se consulta Moodle, tampoco con /pendientes. La pausa se conserva al reiniciar.';
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const lista = (titulo, evs, vacio = 'Nada pendiente. 🎉') =>
  `${titulo}\n` + (evs.length ? evs.map(line).join('\n') : vacio);

function responder(texto, ctx, moodleUrl) {
  const t = texto.trim();
  let [cmd, ...resto] = t.split(/\s+/);
  cmd = cmd.toLowerCase().replace(/@\w+$/, '');
  let arg = resto.join(' ');
  if (!cmd.startsWith('/')) { cmd = '/materia'; arg = t; }

  const now = Date.now() / 1000;
  const finDia = Date.parse(`${todayStr()}T23:59:59-05:00`) / 1000; // Ecuador: UTC-5 sin horario de verano
  const pend = ctx.events.filter((e) => e.ts >= now || e.actionable).sort((a, b) => a.ts - b.ts);
  const deCurso = (c) => pend.filter((e) => e.courseid === c.id || (!e.courseid && e.course === c.fullname));
  const cursos = () => ctx.courses.map((c) => `• ${esc(c.fullname)} (${deCurso(c).length})`).join('\n');

  switch (cmd) {
    case '/start': case '/ayuda': case '/help': return AYUDA;
    case '/pendientes': return lista('📋 <b>Pendientes</b>', pend);
    case '/hoy': return lista('📅 <b>Vence hoy</b>', pend.filter((e) => e.ts <= finDia), 'Nada vence hoy. 🎉');
    case '/semana': return lista('🗓 <b>Próximos 7 días</b>', pend.filter((e) => e.ts <= now + 7 * 86400), 'Nada vence esta semana. 🎉');
    case '/cursos': return `📚 <b>Tus materias</b> (pendientes)\n${cursos()}`;
    case '/materia': {
      if (!arg) return `Escribe el nombre, por ejemplo: /materia calculo\n\n📚 <b>Tus materias</b>\n${cursos()}`;
      const palabras = norm(arg).split(/\s+/);
      const hits = ctx.courses.filter((c) => {
        const n = norm(`${c.fullname} ${c.shortname}`);
        return palabras.every((p) => n.includes(p));
      });
      if (!hits.length) return `No encontré una materia con "<b>${esc(arg)}</b>".\n\n📚 <b>Tus materias</b>\n${cursos()}`;
      return hits.map((c) => lista(`📘 <b>${esc(c.fullname)}</b>\n<a href="${moodleUrl}/course/view.php?id=${c.id}">Abrir curso</a>`,
        deCurso(c), 'Sin pendientes en esta materia. 🎉')).join('\n\n');
    }
    default: return `No conozco ese comando.\n\n${AYUDA}`;
  }
}


class Monitor {
  constructor(config, { store, fetchImpl = globalThis.fetch, logger = console, sleep = delay } = {}) {
    this.config = config; this.store = store || new StateStore(config.stateFile, logger);
    this.fetchImpl = fetchImpl; this.logger = logger; this.sleep = sleep;
    this.shutdown = new AbortController(); this.scopes = new Set(); this.epoch = 0;
    this.reviewing = false; this.lastPoll = 0; this.lastTgSend = 0; this.lastTgError = 0;
    this.forceCheck = false; this.deliveryRetryAt = 0; this.delivering = null;
    this.startTime = Date.now();
  }
  get state() { return this.store.value; }
  persist(change) {
    try { this.store.update(change); }
    catch (err) { this.fatalError = new Error('No se pudo guardar el estado. Se detiene para proteger el historial.'); this.stop(); throw this.fatalError; }
  }
  errorText(err) {
    let text = String(err?.message || err).slice(0, 1000);
    for (const secret of [this.config.token, this.config.moodleToken, this.config.moodlePass]) if (secret) text = text.split(secret).join('[oculto]');
    return text.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[oculto]').replace(/[0-9a-f]{32}/gi, '[oculto]').slice(0, 300);
  }
  async json(url, options, timeout, signal) {
    const signals = [this.shutdown.signal, AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    try {
      const res = await this.fetchImpl(url, { ...options, signal: AbortSignal.any(signals) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (signal?.aborted || this.shutdown.signal.aborted) throw new Error('Consulta cancelada.');
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error('Tiempo de espera agotado.');
      // Los errores de fetch pueden incluir direcciones autenticadas; no se imprimen.
      if (/^HTTP \d+$/.test(err.message)) throw err;
      throw new Error('No se pudo completar la petición de red.');
    }
  }
  async moodleScope(fn) {
    if (this.state.paused || this.shutdown.signal.aborted) throw new Error('Monitor pausado. Usa /reanudar.');
    const controller = new AbortController();
    const scope = { controller, done: null };
    scope.done = Promise.resolve().then(()=>fn(controller.signal));
    this.scopes.add(scope);
    try { return await scope.done; } finally { this.scopes.delete(scope); }
  }
  async getToken(signal) {
    if (this.config.moodleToken) return this.config.moodleToken;
    const data = await this.json(`${this.config.moodleUrl}/login/token.php`, {
      method: 'POST', body: new URLSearchParams({ username: this.config.moodleUser, password: this.config.moodlePass, service: 'moodle_mobile_app' }),
    }, this.config.requestMs, signal);
    if (!data.token) throw new Error('Moodle no pudo autenticar la cuenta.');
    return parseToken(data.token);
  }
  async ws(token, fn, params = {}, signal) {
    if (this.state.paused || signal?.aborted) throw new Error('Consulta cancelada por pausa.');
    const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json', ...flatten(params) });
    const data = await this.json(`${this.config.moodleUrl}/webservice/rest/server.php`, { method: 'POST', body }, this.config.requestMs, signal);
    if (data?.exception) throw new Error(`${fn}: ${String(data.errorcode || 'error').replace(/[^\w-]/g, '').slice(0, 70)}`);
    return data;
  }
  async events(token, signal) {
    const now = Math.floor(Date.now()/1000), map = new Map();
    const a = await this.ws(token, 'core_calendar_get_action_events_by_timesort', { timesortfrom: now - 7*86400, limitnum: 50, limittononsuspendedevents: 1 }, signal);
    if (!Array.isArray(a.events)) throw new Error('Calendario de actividades: respuesta inválida.');
    if (a.events.length >= 50) throw new Error('Calendario incompleto: se alcanzó el límite de 50 actividades.');
    for (const e of a.events) map.set(String(e.id), { ...e, _action: true });
    const u = await this.ws(token, 'core_calendar_get_calendar_upcoming_view', {}, signal);
    if (!Array.isArray(u.events)) throw new Error('Calendario próximo: respuesta inválida.');
    for (const e of u.events) if (!e.modulename && !map.has(String(e.id))) map.set(String(e.id), e);
    return [...map.values()].map(e=>({id:String(e.id),courseid:e.course?.id,name:e.activityname||e.name,
      course:e.course?.fullname||e.course?.shortname||'',ts:e.timesort||e.timestart,url:e.url||e.viewurl||'',
      actionable:!!e._action && e.action?.actionable !== false})).filter(e=>e.ts);
  }
  async modules(token, courseid, signal) {
    const sections = await this.ws(token, 'core_course_get_contents', { courseid }, signal);
    if (!Array.isArray(sections)) throw new Error('Contenido del curso: respuesta inválida.');
    return sections.flatMap(s=>(s.modules||[]).filter(m=>m.visible!==0 && m.uservisible!==false)
      .map(m=>({id:String(m.id),name:m.name,mod:m.modname,url:m.url||''})));
  }
  async context() {
    return this.moodleScope(async signal=>{
      const token = await this.getToken(signal);
      const info = await this.ws(token, 'core_webservice_get_site_info', {}, signal);
      const events = await this.events(token, signal);
      const courses = await this.ws(token, 'core_enrol_get_users_courses', {userid:info.userid}, signal);
      if (!Array.isArray(courses)) throw new Error('Cursos: respuesta inválida.');
      return {events,courses:courses.filter(c=>c.visible!==0)};
    });
  }
  async tgApi(method, params = {}) {
    try {
      const result = await this.json(`https://api.telegram.org/bot${this.config.token}/${method}`, {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params),
      }, method==='getUpdates' ? this.config.pollMs : this.config.requestMs);
      if (!result.ok) throw new Error(`Telegram ${method}: código ${result.error_code || 'desconocido'}`);
      if (method==='getUpdates') this.lastPoll=Date.now();
      if (method==='sendMessage') this.lastTgSend=Date.now();
      return result.result;
    } catch(err) { this.lastTgError=Date.now(); throw err; }
  }
  async send(text) {
    for (const chunk of telegramChunks(text)) {
      await this.tgApi('sendMessage',{chat_id:this.config.chat,text:chunk,disable_web_page_preview:true});
      await this.sleep(400, undefined, {signal:this.shutdown.signal});
    }
  }
  async setupCommands() {
    const webhook = await this.tgApi('getWebhookInfo');
    if (webhook.url) throw new Error('Telegram tiene un webhook activo; no se iniciará otro receptor.');
    await this.tgApi('setMyCommands',{commands:COMANDOS});
  }
  async pause() {
    this.persist(s=>{s.paused=true;}); this.epoch++;
    const scopes=[...this.scopes];
    for (const scope of scopes) scope.controller.abort();
    await Promise.allSettled(scopes.map(s=>s.done));
    if (this.delivering) await this.delivering.catch(()=>{});
  }
  resume() { this.persist(s=>{s.paused=false;}); this.forceCheck=true; }
  statusText() {
    return `${this.state.paused?'⏸ Monitor pausado':'▶️ Monitor activo'}\n`+
      `Última revisión completa: ${this.state.lastCheck ? fmt(this.state.lastCheck/1000) : 'todavía ninguna'}\n`+
      `Resultado: ${this.state.lastResult}. Avisos en cola: ${this.state.outbox.length}.`;
  }
  async handleCommand(text) {
    const cmd=text.trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/,'');
    if (['/start','/help','/ayuda'].includes(cmd)) return this.send(AYUDA);
    if (cmd==='/estado') return this.send(this.statusText());
    if (cmd==='/pausar') {
      await this.pause();
      return this.send('⏸ Monitor pausado. No consultaré Moodle ni enviaré recordatorios hasta /reanudar. La pausa se conserva al reiniciar.');
    }
    if (cmd==='/reanudar') {
      this.resume();
      return this.send('▶️ Monitor reanudado. Haré una revisión de Moodle y volveré a enviar avisos.');
    }
    if (this.state.paused) return this.send('⏸ Monitor pausado: no consultaré Moodle. Usa /reanudar para activarlo.');
    try { await this.send(responder(text,await this.context(),this.config.moodleUrl)); }
    catch(err) { await this.send(`⚠️ No pude consultar tus pendientes: ${esc(this.errorText(err))}\nNo significa que no tengas tareas.`); }
  }
  async processUpdates(updates) {
    if (!Array.isArray(updates)) throw new Error('Telegram: respuesta de actualizaciones inválida.');
    for (const update of updates) {
      if (update.update_id < this.state.tgOffset) continue;
      const m=update.message;
      if (m?.text && String(m.chat.id)===this.config.chat && Date.now()/1000-m.date<6*3600) await this.handleCommand(m.text);
      // Confirmar únicamente tras procesar y responder; se conserva al reiniciar.
      this.persist(s=>{s.tgOffset=update.update_id+1;});
    }
  }
  async collectReview(signal) {
    const draft=structuredClone(this.state), first=!draft.initialized;
    const token=await this.getToken(signal);
    const info=await this.ws(token,'core_webservice_get_site_info',{},signal);
    const events=await this.events(token,signal);
    const courses=await this.ws(token,'core_enrol_get_users_courses',{userid:info.userid},signal);
    if (!Array.isArray(courses)) throw new Error('Cursos: respuesta inválida.');
    const notices=[], warnings=[]; const now=Date.now();
    for (const e of events) {
      const st=(draft.events[e.id] ||= {sent:[]}); st.ts=e.ts;
      const due=e.ts*1000-now;
      if (!st.sent.includes('new')) { st.sent.push('new'); if(!first && due>0) notices.push(`🆕 <b>Nueva actividad</b>\n${line(e)}`); }
      const win=REMINDERS.find(r=>due>0 && due<=r.ms);
      if (win && !st.sent.includes(win.key)) {
        for (const r of REMINDERS) if(r.ms>=win.ms && !st.sent.includes(r.key)) st.sent.push(r.key);
        notices.push(`⏰ <b>${win.label}</b>\n${line(e)}`);
      }
    }
    for (const [id,st] of Object.entries(draft.events)) if(st.ts && st.ts*1000<now-14*86400e3) delete draft.events[id];
    for (const c of courses) {
      if(c.visible===0) continue;
      try {
        const mods=await this.modules(token,c.id,signal), known=draft.modules[c.id];
        if(known) {
          const set=new Set(known), nuevos=mods.filter(m=>!set.has(m.id));
          if(nuevos.length) notices.push(`📂 <b>Nuevo en ${esc(c.fullname)}</b>\n`+nuevos.map(m=>
            `• ${esc(TIPOS[m.mod]||m.mod)}: ${m.url?`<a href="${esc(m.url)}">${esc(short(m.name))}</a>`:esc(short(m.name))}`).join('\n'));
        }
        draft.modules[c.id]=mods.map(m=>m.id);
      } catch(err) { if(signal.aborted) throw err; warnings.push('contenido de un curso'); this.logger.warn(this.errorText(err)); }
    }
    let notificationsOk=true;
    try {
      const n=await this.ws(token,'message_popup_get_popup_notifications',{useridto:info.userid,newestfirst:1,limit:30,offset:0},signal);
      if(!Array.isArray(n.notifications)) throw new Error('Notificaciones: respuesta inválida.');
      const seen=new Set(draft.notifs), fresh=n.notifications.filter(x=>!seen.has(String(x.id))).reverse();
      if(!first) for(const x of fresh) notices.push(`🔔 <b>${esc(x.subject)}</b>\n${esc(short(x.smallmessage||x.fullmessage,300))}`+
        (x.contexturl?`\n<a href="${esc(x.contexturl)}">Ver en Moodle</a>`:''));
      draft.notifs=[...new Set([...n.notifications.map(x=>String(x.id)),...draft.notifs])].slice(0,300);
    } catch(err) { if(signal.aborted) throw err; notificationsOk=false; warnings.push('notificaciones'); this.logger.warn(this.errorText(err)); }
    if(first || (hourNow()>=this.config.digestHour && draft.lastDigest!==todayStr())) {
      draft.lastDigest=todayStr();
      notices.unshift((first?`✅ <b>Monitor de Moodle activado</b> para ${esc(info.fullname)}\n\n`:'')+digest(events));
    }
    if(warnings.length) notices.push(`⚠️ Revisión parcial: no se pudo comprobar ${warnings.join(' y ')}. Volveré a intentarlo; los datos pueden estar incompletos.`);
    return {draft,notices,complete:!warnings.length,components:{calendar:true,courses:true,materials:!warnings.includes('contenido de un curso'),notifications:notificationsOk},eventCount:events.length,courseCount:courses.length};
  }
  async review() {
    if(this.reviewing || this.state.paused) return false;
    this.reviewing=true; const epoch=this.epoch;
    this.persist(s=>{s.lastAttempt=Date.now();});
    try {
      const result=await this.moodleScope(signal=>this.collectReview(signal));
      if(this.state.paused || epoch!==this.epoch || this.shutdown.signal.aborted) return false;
      this.persist(s=>{
        for(const key of ['events','modules','notifs','lastDigest']) s[key]=result.draft[key];
        s.initialized=true; s.lastAttempt=Date.now(); s.lastResult=result.complete?'complete':'partial'; s.components=result.components;
        if(result.complete) s.lastCheck=Date.now();
        for(const text of result.notices) s.outbox.push({id:crypto.randomUUID(),text,next:0});
      });
      this.logger.log(`${result.complete?'OK':'PARCIAL'} ${new Date().toISOString()} — ${result.eventCount} eventos, ${result.courseCount} cursos, ${result.notices.length} avisos`);
      return result.complete;
    } catch(err) {
      if(this.state.paused || epoch!==this.epoch || this.shutdown.signal.aborted) return false;
      const message=this.errorText(err); this.logger.error(message);
      this.persist(s=>{
        s.lastResult='failed'; s.lastAttempt=Date.now(); s.components={calendar:false,courses:false,materials:false,notifications:false};
        if(s.lastErrorDay!==todayStr()) {s.lastErrorDay=todayStr();s.outbox.push({id:crypto.randomUUID(),next:0,text:`⚠️ No pude completar la revisión de Moodle: ${esc(message)}\nNo significa que no tengas pendientes. Reintentaré en 10 minutos.`});}
      });
      return false;
    } finally { this.reviewing=false; }
  }
  async drainOutbox() {
    if(this.delivering) return this.delivering;
    this.delivering=this.deliver();
    try { await this.delivering; } finally {this.delivering=null;}
  }
  async deliver() {
    while(!this.state.paused && this.state.outbox.length && !this.shutdown.signal.aborted) {
      const item=this.state.outbox[0], chunks=telegramChunks(item.text);
      if(item.next>=chunks.length) { this.persist(s=>{s.outbox.shift();}); continue; }
      await this.tgApi('sendMessage',{chat_id:this.config.chat,text:chunks[item.next],disable_web_page_preview:true});
      this.persist(s=>{s.outbox[0].next++;});
      await this.sleep(400,undefined,{signal:this.shutdown.signal});
    }
  }
  async schedulerTick() {
    if(this.state.paused) return;
    const now=Date.now();
    const due=this.forceCheck || (this.state.lastResult==='complete' ? now-this.state.lastCheck>=this.config.checkMin*60000 : now-this.state.lastAttempt>=this.config.retryMs);
    if(due || !this.state.lastAttempt) {this.forceCheck=false;await this.review();}
    if(!this.state.paused && now>=this.deliveryRetryAt) {
      try {await this.drainOutbox();this.deliveryRetryAt=0;}
      catch(err) {this.deliveryRetryAt=Date.now()+60000;this.logger.error(this.errorText(err));}
    }
  }
  health() {
    const now=Date.now(), paused=this.state.paused;
    const telegramOk=this.lastPoll>0 && now-this.lastPoll<90000 && this.lastTgError<=Math.max(this.lastPoll,this.lastTgSend);
    const stale=!this.state.lastCheck || now-this.state.lastCheck>(this.config.checkMin+10)*60000;
    const moodleOk=!stale && this.state.lastResult==='complete';
    const healthy=!this.fatalError && telegramOk && (paused || moodleOk) && (paused || this.state.outbox.length===0);
    return {healthy,status:paused?'paused':healthy?'active':this.state.lastResult==='starting'?'starting':'degraded',paused,
      lastCheck:this.state.lastCheck?new Date(this.state.lastCheck).toISOString():null,
      lastResult:this.state.lastResult,stale,telegramOk,pendingMessages:this.state.outbox.length,components:this.state.components};
  }
  async poll() {
    const updates=await this.tgApi('getUpdates',{timeout:50,offset:this.state.tgOffset||undefined,allowed_updates:['message']});
    await this.processUpdates(updates);
  }
  async loop(job, interval) {
    while(!this.shutdown.signal.aborted) {
      let failed=false;
      try {await job();} catch(err) {failed=true;if(!this.shutdown.signal.aborted) this.logger.error(this.errorText(err));}
      try {await this.sleep(failed?15000:interval,undefined,{signal:this.shutdown.signal});} catch {break;}
    }
  }
  stop() {
    this.shutdown.abort();
    for(const scope of this.scopes) scope.controller.abort();
  }
}
async function acquireLock(key) {
  // Puerto local estable: el SO lo libera incluso si el proceso termina abruptamente.
  // Espacios separados para el bot y el estado; ante colisión se detiene por seguridad.
  const hash=crypto.createHash('sha256').update(key).digest('hex');
  const port=(key.startsWith('state:')?40000:20000)+parseInt(hash.slice(0,8),16)%20000;
  const server=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    server.once('error',err=>reject(new Error(err.code==='EADDRINUSE'
      ?'Otra instancia o un servicio local ocupa el bloqueo del bot. No se iniciará un segundo proceso.'
      :'No se pudo reservar el bloqueo local: '+String(err.code || 'error'))));
    server.listen({host:'127.0.0.1',port,exclusive:true},resolve);
  });
  return server;
}
async function listenHttp(monitor) {
  if(monitor.config.port === null) return null;
  const server=http.createServer((req,res)=>{
    const state=monitor.health(), health=req.url?.split('?')[0]==='/healthz';
    res.writeHead(health && !state.healthy?503:200,{'Content-Type':health?'application/json; charset=utf-8':'text/plain; charset=utf-8','Cache-Control':'no-store'});
    res.end(health?JSON.stringify(state):`Monitor de Moodle: ${state.status}. Última revisión completa: ${state.lastCheck||'aún no'}.\n`);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(monitor.config.port,monitor.config.ip,resolve);});
  return server;
}
async function main(args=process.argv.slice(2)) {
  if(!args.some(a=>['--listen','--loop','--once','--check-config'].includes(a))) throw new Error('Usa node monitor.js --listen. Las revisiones aisladas requieren --once y ALLOW_ONCE=1.');
  if(Number(process.versions.node.split('.')[0])<22) throw new Error('Se requiere Node 22 o superior.');
  const config=readConfig();
  if(args.includes('--check-config')) {console.log('Configuración válida (sin mostrar credenciales).');return;}
  const once=args.includes('--once');
  if(once && process.env.ALLOW_ONCE!=='1') throw new Error('Modo aislado deshabilitado: requiere ALLOW_ONCE=1 y detener antes el bot permanente.');
  const locks=[]; let monitor,server;
  try {
    locks.push(await acquireLock(`bot:${config.token}`));
    locks.push(await acquireLock(`state:${path.resolve(config.stateFile)}`));
    monitor=new Monitor(config); server=await listenHttp(monitor);
    const stop=()=>monitor.stop();
    for(const signal of ['SIGTERM','SIGINT','SIGHUP']) process.once(signal,stop);
    try {
      console.log(`Monitor iniciado; revisión cada ${config.checkMin} min. Pausado: ${monitor.state.paused}.`);
      if(once) {const ok=await monitor.review();await monitor.drainOutbox();if(!ok) process.exitCode=1;return;}
      while(!monitor.shutdown.signal.aborted) {
        try { await monitor.setupCommands(); break; }
        catch(err) {
          if(err.message.includes('webhook activo')) throw err;
          console.error(monitor.errorText(err));
          try {await delay(15000,undefined,{signal:monitor.shutdown.signal});} catch {break;}
        }
      }
      // El planificador nunca bloquea el long polling ni los comandos locales.
      await Promise.all([monitor.loop(()=>monitor.schedulerTick(),1000),monitor.loop(()=>monitor.poll(),1000)]);
      if(monitor.fatalError) throw monitor.fatalError;
    } finally {for(const signal of ['SIGTERM','SIGINT','SIGHUP']) process.removeListener(signal,stop);}
  } finally {
    monitor?.stop();
    if(server) await new Promise(resolve=>server.close(resolve));
    for(const lock of locks) await new Promise(resolve=>lock.close(resolve));
  }
}
module.exports={Monitor,StateStore,readConfig,parseToken,telegramChunks,acquireLock,listenHttp,initialState};
if(require.main===module) main().catch(err=>{console.error(String(err.message));process.exitCode=1;});
