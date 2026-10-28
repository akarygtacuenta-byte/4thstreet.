# STREET CONTROL — Proyecto completo

Incluye:
- Bot Discord en `bot.js`: comandos slash, moderación básica, tickets, bienvenida/despedida, logs y eventos con botones Voy/No puedo.
- Panel web en `web/public/index.html`: inicio con Google/Firebase, configuración de módulos y formulario para crear eventos.
- Eventos: fecha/hora, canal, rol opcional, respuestas de asistencia en Firebase y recordatorio 15 minutos antes.
- Endpoint `/health` para comprobar el servicio en Render.

## Antes de usar
Este proyecto es una base funcional que debes configurar y probar en tu servidor. No contiene tokens ni credenciales privadas.

## 1. Crear/configurar aplicación Discord
1. En Discord Developer Portal crea una aplicación y un Bot.
2. Copia el token y guárdalo solo en las variables privadas de Render; no lo publiques en GitHub.
3. En OAuth2 copia el Application ID (`CLIENT_ID`).
4. En Bot activa **Server Members Intent** y **Message Content Intent** si vas a usar los módulos que los requieren.
5. Invita el bot al servidor con `bot` y `applications.commands`; dale solo los permisos necesarios (administrar mensajes, moderar miembros, expulsar/banear si usarás esos comandos, gestionar canales y enviar mensajes).
6. Asegúrate de que el rol del bot esté por encima de los roles que moderará.

## 2. Configurar Firebase
1. Crea un proyecto Firebase y habilita Realtime Database.
2. Habilita Authentication → Sign-in method → Google.
3. En Authentication → Settings → Authorized domains añade el dominio donde publiques la web.
4. Descarga una clave de cuenta de servicio desde Configuración del proyecto → Cuentas de servicio. No la subas al repositorio.
5. Copia la URL de Realtime Database y la credencial JSON completa para las variables de Render.
6. Pega la configuración web de Firebase en `web/public/index.html` (objeto `firebaseConfig`). Usa tu propia configuración.
7. Publica `firebase.database.rules.json` en Realtime Database Rules. Revisa las reglas antes de producción. La web solo debe escribir en la ruta de su usuario autenticado.

## 3. Configurar variables de Render
Crea un Web Service desde tu repositorio y configura:
- `DISCORD_TOKEN`: token privado del bot.
- `CLIENT_ID`: Application ID de Discord.
- `GUILD_ID`: ID del servidor.
- `OWNER_UID`: UID del usuario que inicia sesión con Google en Firebase Authentication.
- `FIREBASE_DATABASE_URL`: URL de tu Realtime Database.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: contenido JSON completo de la cuenta de servicio en una sola variable.

Usa Node 20 o superior. Build: `npm install`; Start: `npm start`. La ruta `/health` informa si el bot está listo. En plan gratuito el servicio puede dormir o reiniciarse; no se garantiza 24/7.

## 4. Publicar la web
Publica la carpeta `web/public` en Firebase Hosting o un hosting estático. El panel usa Firebase Authentication Google y Realtime Database. La primera vez, inicia sesión, entra a Bienvenidas, pega el ID de tu servidor y pulsa cargar/recargar.

## Comandos incluidos
- `/ping`
- `/limpiar`
- `/expulsar`
- `/banear`
- `/panel-tickets`
- `/evento` con título, fecha `AAAA-MM-DD HH:mm`, descripción, canal y rol opcional.

## Eventos desde la web
En Actividades, completa el título, fecha, hora, ID de canal, descripción y opcionalmente ID de rol. Pulsa Crear evento. El bot debe estar en línea y tener permisos para enviar mensajes y mencionar el rol. Publica un embed con botones Voy/No puedo y envía un recordatorio 15 minutos antes.

## Importante
- La hora se interpreta como hora de Chile con UTC-03:00 en el código inicial. Si lo usarás durante el horario de invierno chileno, revisa el desfase antes de programar eventos.
- Los eventos se guardan bajo `users/OWNER_UID/guilds/GUILD_ID/config/events`.
- No compartas tu token ni el JSON de cuenta de servicio.
- Prueba primero en un servidor privado. Algunas funciones dependen de permisos e intents de Discord.
