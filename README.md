# Monitor de Moodle UCSG → Telegram

Consulta cursos, actividades pendientes, material y notificaciones de Moodle. Envía avisos y recordatorios de vencimiento a 72, 24 y 3 horas, además de un resumen diario desde las 07:00 de Ecuador. La revisión automática predeterminada es cada 55 minutos. Requiere **Node 22 o superior**, sin dependencias externas.

## Comandos de Telegram

Solo se atienden mensajes del chat configurado en `TELEGRAM_CHAT_ID`.

| Comando | Acción |
|---|---|
| `/pendientes`, `/hoy`, `/semana` | Consultar pendientes y vencimientos |
| `/cursos` | Ver cursos y número de pendientes |
| `/materia calculo` o `calculo` | Consultar una materia |
| `/pausar` | Detener todas las consultas a Moodle y los avisos automáticos |
| `/reanudar` | Activar consultas y solicitar una revisión inmediata |
| `/estado` | Ver pausa, último resultado y avisos en cola |
| `/ayuda` | Ver comandos, incluso cuando Moodle está caído |

**La pausa es persistente:** reiniciar el sitio o recibir un ping no la elimina. Mientras está pausado, `/pendientes` y los demás comandos de datos tampoco consultan Moodle. `/pausar` cancela las consultas activas y espera su finalización antes de confirmar. Una petición que Moodle ya recibió no puede deshacerse. El bot mantiene la conexión con Telegram para recibir `/reanudar`.

## Despliegue en alwaysdata

El sitio Node.js es `https://moodlealberto.alwaysdata.net`. Configurar **Web → Sites → Modify → Environment**; los secretos de GitHub Actions y los archivos `.env` no se cargan automáticamente en el servidor.

| Variable | Configuración |
|---|---|
| `MOODLE_TOKEN` | Token propio de Moodle Mobile, 32 caracteres hexadecimales; también acepta el enlace `moodlemobile://token=...` |
| `TELEGRAM_BOT_TOKEN` | Token del bot creado con BotFather |
| `TELEGRAM_CHAT_ID` | Identificador numérico de tu chat; enviar primero `/start` al bot |
| `STATE_FILE` | Ruta absoluta persistente **fuera del checkout**; en esta instalación: `/home/moodlealberto/moodle-state.json` |
| `MOODLE_URL` | `https://www217.ucsg.edu.ec` por defecto; siempre HTTPS |
| `CHECK_MIN` | Minutos entre revisiones completas: 55 por defecto, de 1 a 1440 |
| `DIGEST_HOUR` | Hora de Ecuador para el resumen: 7 por defecto, entero de 0 a 23 |
| `IP` / `HOST`, `PORT` | Dirección y puerto asignados por alwaysdata; no sustituirlos por valores arbitrarios |

Como alternativa al token se admiten `MOODLE_USER` y `MOODLE_PASS` para obtenerlo mediante el servicio móvil. No sirve para cuentas que solo permiten acceso Microsoft. Un `MOODLE_TOKEN` definido pero inválido se rechaza sin intentar otra autenticación.

El token da acceso a las funciones permitidas para la cuenta: guardarlo solo en el entorno privado. No copiarlo a código, chats, capturas, argumentos de comandos ni logs. Las consultas del bot no abren intentos de examen ni envían respuestas.

El comando final de arranque debe ejecutar **en primer plano**:

```sh
node /ruta/al/checkout/monitor.js --listen
```

`--loop` es un alias. Si existe un script que actualiza el repositorio antes de arrancar, conservarlo y terminar con `exec node monitor.js --listen`. Actualizar el código no actualiza un proceso ya arrancado: reiniciar el sitio tras publicar los cambios. No lanzar otro proceso por SSH ni una tarea programada con el mismo bot.

Antes de la primera actualización a esta versión, asegurar que `STATE_FILE` apunta al estado existente y hacer una copia privada. Esta instalación ya usa el archivo externo anterior. El antiguo `state.json` se retiró del seguimiento de Git; no restaurarlo desde un commit para reemplazar el estado vivo. Sin `STATE_FILE`, las nuevas instalaciones usan `data/state.json`, ignorado por Git.

Usar *Idle time* = 0 para evitar la suspensión por inactividad. Esto no garantiza ejecución permanente frente a mantenimiento: alwaysdata recomienda un servicio supervisado para necesidades estrictas de 24/7; esa función requiere un plan compatible. El ping es una ayuda de arranque y monitorización, no una garantía de disponibilidad.

## Estado y recuperación

- `/` muestra el proceso disponible y su estado: `starting`, `active`, `degraded` o `paused`.
- `/healthz` devuelve JSON sin datos académicos ni credenciales. Responde **503** si Telegram no está operativo, la revisión está incompleta/obsoleta o quedan envíos pendientes. Una pausa solicitada y con Telegram disponible responde 200 con `status: "paused"`; no requiere consultar Moodle.
- `lastCheck` solo avanza tras una revisión completa. Los fallos de calendario nunca se convierten en «no hay pendientes». Si falla un curso o las notificaciones, el resultado es parcial y se informa; se reintenta en 10 minutos.
- Cada petición tiene un plazo: 30 segundos para consultas y envíos, 65 segundos para long polling. Telegram se escucha de forma independiente de las revisiones.
- El estado se escribe mediante archivo temporal, sincronización y renombrado; se mantiene una copia `.bak`, ambos privados. Si el principal se corrompe se recupera la copia; si ninguna es válida se detiene para proteger el historial. Un fallo al guardar también detiene al proceso.
- Los avisos se guardan en una cola antes de enviarlos y se recuperan tras un reinicio. El cursor de comandos se conserva después de responder. Existe una pequeña ventana inevitable de repetición si Telegram acepta un envío y el proceso cae antes de guardar la confirmación; no se promete entrega exactamente una vez.
- Los bloqueos locales del sistema impiden otra instancia con el mismo bot o archivo de estado en el mismo servidor. Usan puertos de loopback derivados de una huella, sin aceptar datos. Una colisión con otro servicio detiene el arranque por seguridad. No coordinan servidores distintos: mantener un único despliegue activo.
- Si Telegram tiene un webhook, el proceso no inicia otro receptor ni lo elimina automáticamente. Un webhook y `getUpdates` son métodos excluyentes.
- Para evitar afirmar que se consultaron todas las actividades cuando Moodle devuelve el límite de 50, esa respuesta se trata como incompleta. El calendario no incluye todas las tareas antiguas ni sustituye revisar directamente Moodle.

## Workflows

- `moodle.yml` **solo valida sintaxis y ejecuta pruebas simuladas**. No recibe secretos, no consulta Moodle/Telegram, no escribe estado y no ejecuta el bot de producción. Puede correrse con el sitio activo.
- `despertar.yml` solicita `/` y `/healthz` cada 30 minutos (minutos 7 y 37). Una alerta indica que hay que inspeccionar el estado; no arranca una segunda instancia ni elimina una pausa. GitHub puede retrasar u omitir ejecuciones programadas.

## Pruebas seguras

```sh
node --check monitor.js
node --test
```

Las pruebas usan datos ficticios y peticiones Moodle/Telegram simuladas. Solo los tests de HTTP y bloqueo abren sockets locales de prueba. No se necesitan credenciales reales.

En producción, comprobar `/healthz` y enviar personalmente `/ayuda`, `/estado` y `/pendientes`; contrastar un pendiente conocido con Moodle. Probar `/pausar`, reiniciar una sola vez y verificar que `/estado` conserva la pausa. Después enviar `/reanudar` y comprobar una revisión nueva. No publicar datos personales de las respuestas ni los logs completos.

Una revisión aislada está bloqueada por defecto. Solo se permite con `ALLOW_ONCE=1 node monitor.js --once`, después de detener cualquier otro despliegue. Ejecutar `node monitor.js` sin modo no inicia consultas. `node monitor.js --check-config` valida el entorno sin mostrar sus valores y sin conectarse a las APIs.
