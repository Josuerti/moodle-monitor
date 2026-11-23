# Monitor de Moodle UCSG → Telegram

Revisa tu Moodle (`https://www217.ucsg.edu.ec`) cada hora y te avisa por Telegram de:

- 🆕 Actividades nuevas (tareas, lecciones, cuestionarios)
- ⏰ Recordatorios a 3 días, 24 horas y 3 horas del vencimiento (se detienen al entregar)
- 📂 Material nuevo subido a cada curso
- 🔔 Notificaciones de Moodle (calificaciones, foros, avisos)
- 📋 Resumen diario a las 7:00 con todo lo pendiente

## Dónde corre
El bot corre 24/7 en **alwaysdata** (cuenta `moodlealberto`, sitio Node.js `https://moodlealberto.alwaysdata.net`, *Idle time* = 0). Al arrancar, el sitio clona/actualiza este repo y ejecuta `node monitor.js --listen`. Los tokens están en *Web → Sites → Modificar → Environment*. Después de cambiar el código: `git push` y reiniciar el sitio en el panel.

El workflow `despertar.yml` visita la página cada 30 min para que no se apague. `moodle.yml` quedó solo manual: no lo ejecutes mientras el sitio esté activo, porque responderían dos bots a la vez.

## Preguntarle al bot
Escríbele al bot en Telegram (responde al instante):

| Comando | Qué hace |
|---|---|
| `/pendientes` | Todo lo que tienes por entregar |
| `/hoy` | Lo que vence hoy |
| `/semana` | Lo que vence en los próximos 7 días |
| `/materia calculo` | Pendientes de esa materia (o escribe solo `calculo`) |
| `/cursos` | Tus materias y cuántos pendientes tiene cada una |
| `/ayuda` | Lista de comandos |

Solo responde a tu chat (`TELEGRAM_CHAT_ID`); ignora a cualquier otra persona.

## 1. Crear el bot de Telegram
1. En Telegram abre **@BotFather** → `/newbot` → ponle nombre. Copia el **token**.
2. Abre tu bot nuevo y envíale `/start`.
3. Abre **@userinfobot**, te responde con tu **Id** (número). Ese es tu `TELEGRAM_CHAT_ID`.

## 2. Obtener el token de Moodle
**Opción A (recomendada, sin contraseña):**
1. Instala la app **Moodle** en el celular e inicia sesión en `https://www217.ucsg.edu.ec` (con Microsoft si así entras).
2. En el navegador entra a `https://www217.ucsg.edu.ec/user/managetoken.php`
   (Perfil → Preferencias → Claves de seguridad).
3. Copia la clave de **"Moodle mobile web service"**. Ese es tu `MOODLE_TOKEN`.

**Opción B:** si entras con usuario y contraseña (no con Microsoft), puedes usar los secretos `MOODLE_USER` y `MOODLE_PASS` en lugar del token.

> El token da acceso a tu cuenta: no lo publiques ni lo pegues en el código.

## 3. Subirlo a GitHub (gratis, corre 24/7 sin tu PC)
1. Crea un repositorio **privado** y sube estos archivos (incluida la carpeta `.github`).
2. *Settings → Secrets and variables → Actions → New repository secret*, crea:
   - `MOODLE_TOKEN`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. *Actions → Monitor Moodle → Run workflow* para probar. Te debe llegar "✅ Monitor de Moodle activado" con el resumen.

Desde ahí corre solo cada hora. La primera ejecución solo registra lo que ya existe; desde la segunda te avisa de lo nuevo.

## Alternativa: correrlo en tu PC
```bash
# Windows (PowerShell)
$env:MOODLE_TOKEN="..."; $env:TELEGRAM_BOT_TOKEN="..."; $env:TELEGRAM_CHAT_ID="..."
node monitor.js --listen    # responde al instante y revisa Moodle cada 55 min (CHECK_MIN)
```
Requiere Node 18 o superior.

## Ajustes
- Hora del resumen: `DIGEST_HOUR` en el workflow.
- Frecuencia: el workflow corre cada 5 min (`cron`) para responder comandos; la revisión completa de Moodle es cada 55 min (`CHECK_MIN`).
- Recordatorios: arreglo `REMINDERS` en `monitor.js`.
