'use strict';
/**
 * Monitor de Moodle UCSG → Telegram
 * Revisa actividades pendientes, material nuevo y notificaciones,
 * y te avisa por Telegram. Sin dependencias (Node 18+).
 *
 * Uso:
 *   node monitor.js          → una revisión (para GitHub Actions / cron)
 *   node monitor.js --loop   → se queda corriendo y revisa cada INTERVAL_MIN minutos
 */
const fs = require('fs');
const path = require('path');

const MOODLE_URL = (process.env.MOODLE_URL || 'https://www217.ucsg.edu.ec').replace(/\/$/, '');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR || 7); // hora del resumen diario (Ecuador)
const TZ = 'America/Guayaquil';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');

// Recordatorios antes del vencimiento
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

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { initialized: false, events: {}, modules: {}, notifs: [], lastDigest: '', lastErrorDay: '' }; }
}
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));

/* ---------------- Moodle ---------------- */
async function getToken() {
  if (process.env.MOODLE_TOKEN) {
    // Acepta el token (32 caracteres) o el texto "moodlemobile://token=BASE64" copiado del navegador
    let t = process.env.MOODLE_TOKEN.trim();
    const m = t.match(/token=([A-Za-z0-9+/=_-]+)/);
    if (m) t = m[1];
    if (!/^[0-9a-f]{32}$/i.test(t)) {
      const dec = Buffer.from(t, 'base64').toString('utf8');
      if (dec.includes(':::')) t = dec.split(':::')[1];
    }
    return t;
  }
  const username = process.env.MOODLE_USER, password = process.env.MOODLE_PASS;
  if (!username || !password) throw new Error('Falta MOODLE_TOKEN (o MOODLE_USER y MOODLE_PASS).');
  const res = await fetch(`${MOODLE_URL}/login/token.php`, {
    method: 'POST', body: new URLSearchParams({ username, password, service: 'moodle_mobile_app' }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`No se pudo obtener el token: ${data.error || JSON.stringify(data)}`);
  return data.token;
}

async function ws(token, fn, params = {}) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json', ...flatten(params) });
  const res = await fetch(`${MOODLE_URL}/webservice/rest/server.php`, { method: 'POST', body });
  if (!res.ok) throw new Error(`${fn}: HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.exception) throw new Error(`${fn}: ${data.errorcode} - ${data.message}`);
  return data;
}

async function getEvents(token) {
  const now = Math.floor(Date.now() / 1000);
  const map = new Map();
  // Actividades que requieren acción (tareas, lecciones, cuestionarios). Desaparecen al entregarlas.
  try {
    const a = await ws(token, 'core_calendar_get_action_events_by_timesort', {
      timesortfrom: now - 7 * 86400, limitnum: 50, limittononsuspendedevents: 1,
    });
    for (const e of a.events || []) map.set(String(e.id), { ...e, _action: true });
  } catch (err) { console.warn(err.message); }
  // Otros eventos del calendario (clases, eventos del curso) que no son actividades.
  try {
    const u = await ws(token, 'core_calendar_get_calendar_upcoming_view', {});
    for (const e of u.events || []) if (!e.modulename && !map.has(String(e.id))) map.set(String(e.id), e);
  } catch (err) { console.warn(err.message); }

  return [...map.values()].map((e) => ({
    id: String(e.id),
    courseid: e.course?.id,
    name: e.activityname || e.name,
    course: e.course?.fullname || e.course?.shortname || '',
    ts: e.timesort || e.timestart,
    url: e.url || e.viewurl || '',
    actionable: !!e._action && e.action?.actionable !== false,
  })).filter((e) => e.ts);
}

async function getModules(token, courseid) {
  const sections = await ws(token, 'core_course_get_contents', { courseid });
  const mods = [];
  for (const s of sections) for (const m of s.modules || []) {
    if (m.visible === 0 || m.uservisible === false) continue;
    mods.push({ id: String(m.id), name: m.name, mod: m.modname, url: m.url || '' });
  }
  return mods;
}

/* ---------------- Telegram ---------------- */
function split(text, max = 3900) {
  const parts = []; let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) parts.push(cur);
  return parts;
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[Telegram no configurado]\n' + text + '\n'); return; }
  for (const chunk of split(text)) {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: chunk, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const d = await res.json();
    if (!d.ok) throw new Error('Telegram: ' + d.description);
    await sleep(400);
  }
}

/* ---------------- mensajes ---------------- */
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

/* ---------------- revisión principal ---------------- */
async function runOnce() {
  const state = loadState();
  state.events ||= {}; state.modules ||= {}; state.notifs ||= [];
  const first = !state.initialized;
  const token = await getToken();
  const info = await ws(token, 'core_webservice_get_site_info');
  const userid = info.userid;
  const avisos = [];

  // 1) Actividades y recordatorios
  const events = await getEvents(token);
  const now = Date.now();
  for (const e of events) {
    const st = (state.events[e.id] ||= { sent: [] });
    st.ts = e.ts;
    const dueMs = e.ts * 1000 - now;
    if (!st.sent.includes('new')) {
      st.sent.push('new');
      if (!first && dueMs > 0) avisos.push(`🆕 <b>Nueva actividad</b>\n${line(e)}`);
    }
    if (e.actionable || dueMs > 0) {
      const win = REMINDERS.find((r) => dueMs > 0 && dueMs <= r.ms);
      if (win && !st.sent.includes(win.key)) {
        for (const r of REMINDERS) if (r.ms >= win.ms && !st.sent.includes(r.key)) st.sent.push(r.key);
        avisos.push(`⏰ <b>${win.label}</b>\n${line(e)}`);
      }
    }
  }
  for (const [id, st] of Object.entries(state.events)) {
    if (st.ts && st.ts * 1000 < now - 14 * 86400e3) delete state.events[id];
  }

  // 2) Material nuevo en los cursos
  const courses = await ws(token, 'core_enrol_get_users_courses', { userid });
  for (const c of courses) {
    if (c.visible === 0) continue;
    let mods;
    try { mods = await getModules(token, c.id); } catch (err) { console.warn(`Curso ${c.id}: ${err.message}`); continue; }
    const known = state.modules[c.id];
    if (known) {
      const set = new Set(known);
      const nuevos = mods.filter((m) => !set.has(m.id));
      if (nuevos.length) {
        avisos.push(`📂 <b>Nuevo en ${esc(c.fullname)}</b>\n` +
          nuevos.slice(0, 10).map((m) => `• ${esc(TIPOS[m.mod] || m.mod)}: ` +
            (m.url ? `<a href="${esc(m.url)}">${esc(short(m.name))}</a>` : esc(short(m.name)))).join('\n') +
          (nuevos.length > 10 ? `\n…y ${nuevos.length - 10} más` : ''));
      }
    }
    state.modules[c.id] = mods.map((m) => m.id);
  }

  // 3) Notificaciones de Moodle (calificaciones, foros, avisos, etc.)
  try {
    const n = await ws(token, 'message_popup_get_popup_notifications', { useridto: userid, newestfirst: 1, limit: 30, offset: 0 });
    const lista = n.notifications || [];
    const seen = new Set(state.notifs);
    const nuevas = lista.filter((x) => !seen.has(String(x.id))).reverse();
    if (!first) for (const x of nuevas) {
      avisos.push(`🔔 <b>${esc(x.subject)}</b>\n${esc(short(x.smallmessage || x.fullmessage, 300))}` +
        (x.contexturl ? `\n<a href="${esc(x.contexturl)}">Ver en Moodle</a>` : ''));
    }
    state.notifs = [...new Set([...lista.map((x) => String(x.id)), ...state.notifs])].slice(0, 300);
  } catch (err) { console.warn(err.message); }

  // 4) Resumen diario (y uno de bienvenida en la primera ejecución)
  if (first || (hourNow() >= DIGEST_HOUR && state.lastDigest !== todayStr())) {
    state.lastDigest = todayStr();
    const intro = first ? `✅ <b>Monitor de Moodle activado</b> para ${esc(info.fullname)}\n\n` : '';
    await tg(intro + digest(events));
  }
  if (avisos.length) await tg(avisos.join('\n\n'));

  state.initialized = true;
  state.lastCheck = Date.now();
  saveState(state);
  console.log(`OK ${new Date().toISOString()} — ${events.length} eventos, ${courses.length} cursos, ${avisos.length} avisos`);
}

async function safeRun() {
  try { await runOnce(); return true; }
  catch (err) {
    console.error(err);
    const state = loadState();
    if (state.lastErrorDay !== todayStr()) { // máximo un aviso de error por día
      state.lastErrorDay = todayStr(); saveState(state);
      try { await tg(`⚠️ El monitor de Moodle falló:\n<code>${esc(err.message)}</code>\nSi dice "invalidtoken", genera un token nuevo.`); } catch {}
    }
    return false;
  }
}

/* ---------------- comandos del bot ---------------- */
const COMANDOS = [
  { command: 'pendientes', description: 'Todo lo que tienes por entregar' },
  { command: 'hoy', description: 'Lo que vence hoy' },
  { command: 'semana', description: 'Lo que vence en los próximos 7 días' },
  { command: 'materia', description: 'Pendientes de una materia: /materia calculo' },
  { command: 'cursos', description: 'Tus materias y cuántos pendientes tienen' },
  { command: 'ayuda', description: 'Ver los comandos' },
];
const AYUDA = '🤖 <b>Comandos</b>\n' + COMANDOS.map((c) => `/${c.command} — ${esc(c.description)}`).join('\n') +
  '\n\nTambién puedes escribir solo el nombre de una materia (ej: <i>calculo</i>).';
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

async function tgApi(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(`Telegram ${method}: ${d.description}`);
  return d.result;
}

async function loadCtx() {
  const token = await getToken();
  const info = await ws(token, 'core_webservice_get_site_info');
  const [events, courses] = await Promise.all([
    getEvents(token), ws(token, 'core_enrol_get_users_courses', { userid: info.userid }),
  ]);
  return { events, courses: courses.filter((c) => c.visible !== 0) };
}

const lista = (titulo, evs, vacio = 'Nada pendiente. 🎉') =>
  `${titulo}\n` + (evs.length ? evs.map(line).join('\n') : vacio);

function responder(texto, ctx) {
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
      return hits.map((c) => lista(`📘 <b>${esc(c.fullname)}</b>\n<a href="${MOODLE_URL}/course/view.php?id=${c.id}">Abrir curso</a>`,
        deCurso(c), 'Sin pendientes en esta materia. 🎉')).join('\n\n');
    }
    default: return `No conozco ese comando.\n\n${AYUDA}`;
  }
}

async function setupCommands() {
  const state = loadState();
  if (state.commandsSet) return;
  await tgApi('setMyCommands', { commands: COMANDOS });
  state.commandsSet = true; saveState(state);
}

async function checkCommands() {
  if (!TG_TOKEN || !TG_CHAT) return;
  await setupCommands();
  const updates = await tgApi('getUpdates', { timeout: 0, allowed_updates: ['message'] });
  if (!updates.length) return;
  // Confirmar primero, para no responder dos veces si algo falla
  await tgApi('getUpdates', { offset: updates[updates.length - 1].update_id + 1, timeout: 0 });
  await answerUpdates(updates);
}

async function answerUpdates(updates) {
  const msgs = updates.map((u) => u.message)
    .filter((m) => m && m.text && String(m.chat.id) === String(TG_CHAT) && Date.now() / 1000 - m.date < 6 * 3600);
  let ctx = null;
  for (const m of msgs) {
    try { ctx ||= await loadCtx(); await tg(responder(m.text, ctx)); }
    catch (err) { console.error(err); try { await tg(`⚠️ No pude responder: <code>${esc(err.message)}</code>`); } catch {} }
  }
  console.log(`Comandos respondidos: ${msgs.length}`);
}

async function main() {
  try { await checkCommands(); } catch (err) { console.error(err); }
  const state = loadState();
  const everyMin = Number(process.env.CHECK_MIN || 55);
  const due = !state.initialized || process.env.FORCE_CHECK === '1' || Date.now() - (state.lastCheck || 0) >= everyMin * 60e3;
  return due ? safeRun() : true;
}

/* Modo servidor 24/7: escucha Telegram en vivo (long polling) y revisa Moodle cada CHECK_MIN minutos */
async function listen() {
  if (!TG_TOKEN || !TG_CHAT) throw new Error('Faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
  const everyMin = Number(process.env.CHECK_MIN || 55);
  let offset, retryAt = 0;
  console.log(`Escuchando Telegram; revisión de Moodle cada ${everyMin} min. Estado: ${STATE_FILE}`);
  if (process.env.PORT) { // hosting tipo "sitio web" (alwaysdata, etc.): responde una página de estado
    require('http').createServer((req, res) => {
      const st = loadState();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Monitor de Moodle activo. Última revisión: ${st.lastCheck ? new Date(st.lastCheck).toISOString() : 'aún no'}\n`);
    }).listen(Number(process.env.PORT), process.env.IP || '0.0.0.0');
  }
  try { await setupCommands(); } catch (err) { console.error(err.message); }
  for (;;) {
    try {
      const st = loadState();
      if (Date.now() >= retryAt && (!st.initialized || Date.now() - (st.lastCheck || 0) >= everyMin * 60e3)) {
        if (!(await safeRun())) retryAt = Date.now() + 10 * 60e3; // si falla, reintenta en 10 min
      }
      const updates = await tgApi('getUpdates', { timeout: 50, offset, allowed_updates: ['message'] });
      if (updates.length) {
        offset = updates[updates.length - 1].update_id + 1;
        await answerUpdates(updates);
      }
    } catch (err) { console.error(new Date().toISOString(), err.message); await sleep(15000); }
  }
}

if (process.argv.includes('--listen') || process.argv.includes('--loop')) {
  listen();
} else {
  main().then((ok) => process.exit(ok ? 0 : 1));
}
