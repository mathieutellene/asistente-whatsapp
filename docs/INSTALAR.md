# Asistente WhatsApp (IA local): guía en español

Resumen del proyecto en inglés: [README](../README.md).

Lee tu WhatsApp **en modo solo lectura**, lo guarda en PostgreSQL y prepara **borradores** de respuesta con una IA que funciona dentro de tu ordenador (Ollama). **Nunca envía nada**: el que envía eres tú.

## Qué hace
- **WhatsApp (solo lectura):** vincula el Huawei como dispositivo, igual que WhatsApp Web. Carga los últimos 6 meses y después guarda en tiempo real todo lo que llega, incluido lo recibido con el ordenador apagado.
- **Borradores:** cuando te escriben, la IA local redacta una respuesta imitando cómo escribes tú con esa persona, a partir de tus mensajes reales.
  - Chats individuales: siempre.
  - Grupos: solo si te mencionan o responden a un mensaje tuyo. En cualquier chat también puedes pedirlo a mano.
  - Descarta mensajes triviales ("ok", stickers, notas de voz).
- **Panel de control** (`panel.cmd`), también desde el iPhone:
  - Últimos mensajes recibidos, borradores, chats pendientes y estado de cada herramienta.
  - Las tablas de PostgreSQL, en modo solo lectura.
- **Avisos por Telegram (opcional):** por defecto solo dicen "Tienes N borradores", sin nombres ni contenido.

## Cómo aprende tu tono con cada chat
- **Estadísticas de tus mensajes:** en ese chat calcula el largo habitual, los emojis, si tratas de usted, si te ríes por escrito…
- **Tus respuestas reales:** hasta 8 del mismo chat, eligiendo las más parecidas al mensaje que te acaban de mandar.
- **Perfil del chat:** la IA lee vuestro historial en segundo plano y resume la relación, el tono, cómo escribes ahí, los temas, datos útiles y qué evitar. Lo hace con tus 40 chats más activos y lo repite cada 14 días o cada 150 mensajes nuevos.
- **Tus notas por chat** (botón "Perfil y notas"), por ejemplo "es mi jefa, trátala de usted". La IA las cumple siempre.
- **Varias opciones:** cada borrador trae hasta 3 alternativas para elegir.

## Contexto para los borradores (solo lectura; se activa y desactiva en Herramientas)
| Fuente | Qué mira |
|---|---|
| Otros chats de WhatsApp | Si el tema salió en otra conversación tuya. Solo en chats individuales. |
| Google Calendar | Tus próximos 7 días y los eventos relacionados. |
| Gmail | Correos con esa persona (su email sale de tus Contactos) o sobre el tema. |
| Google Drive | Solo los nombres de los archivos. |
| Historial de Chrome | Títulos de las páginas de los últimos 3 días. |
| Internet | Solo si el mensaje pide un dato público. Al buscador (DuckDuckGo) solo llega una consulta corta que redacta la IA, sin nombres, teléfonos ni correos. En cada borrador ves qué se buscó. |

Google se conecta una vez desde **Herramientas → Google**, con tu propio proyecto gratuito de Google Cloud (los pasos están en el panel) y tu Gmail personal. Solo pide permisos de lectura.

## Modelo de IA
En **Herramientas → Modelo** puedes elegir entre modelos que caben en 8 GB, descargarlos, borrarlos y **compararlos** con tus propios chats:
- `qwen3:4b-instruct`: el más rápido.
- `qwen3.5:4b`: recomendado.
- `gemma3:4b`.
- `gemma4:e2b-it-qat`: el más pesado.

Modelos grandes como Kimi K2 necesitan cientos de GB de memoria y no pueden funcionar en local.

## Instalar o actualizar (en el Huawei)
Abre PowerShell (tecla Windows → escribe PowerShell → Enter), pega esta línea y pulsa Enter. Cuando Windows pregunte, pulsa **Sí**:
```
[Net.ServicePointManager]::SecurityProtocol='Tls12'; $d=Join-Path ([Environment]::GetFolderPath('Desktop')) 'asistente-whatsapp'; $z="$env:TEMP\aw.zip"; $t="$env:TEMP\aw"; Invoke-WebRequest 'https://github.com/mathieutellene/asistente-whatsapp/archive/refs/heads/main.zip' -OutFile $z -UseBasicParsing; Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive $z $t -Force; New-Item -ItemType Directory -Force $d | Out-Null; Copy-Item "$t\asistente-whatsapp-main\*" $d -Recurse -Force; Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$d\scripts\setup.ps1`""
```
Para actualizar se usa la misma línea: tus datos y tu sesión de WhatsApp se mantienen. La primera vez, el asistente descarga además el modelo de IA (`qwen3:4b`, unos 2,5 GB).

## Accesos directos (carpeta del escritorio)
| Archivo | Para qué |
|---|---|
| `iniciar.cmd` | Arranca el asistente. Ya se abre solo al iniciar sesión en Windows. |
| `panel.cmd` | Abre el panel en el navegador (`http://localhost:8787`). |
| `movil.cmd` | Prepara el acceso desde el iPhone (Tailscale) y muestra un QR para abrirlo. |
| `excluir.cmd` | Números que no se guardan ni se usan **nunca**. |
| `pendientes.cmd` | Resumen rápido en la ventana. |

## Desde el iPhone
1. En el Huawei: doble clic en `movil.cmd`. Inicia sesión en Tailscale, por ejemplo con tu Google personal.
2. En el iPhone: instala **Tailscale** (App Store), entra con la **misma cuenta** y actívalo.
3. Escanea con la cámara el QR que muestra `movil.cmd`. En Safari: Compartir → **Añadir a pantalla de inicio**.
4. En cada borrador, **"Abrir en WhatsApp"** abre la app con el texto ya escrito. Lo revisas y pulsas enviar tú.

Tailscale es una red privada solo entre tus aparatos: el panel **no** se publica en internet. El Huawei tiene que estar encendido.

## Números excluidos
Doble clic en **`excluir.cmd`**. Escribe un número por línea con prefijo de país (`34600111222` o `+34 600 111 222`), guarda y cierra el Bloc de notas.
- **En memoria:** sus mensajes se descartan antes de escribir nada en disco, tanto en chats como en grupos y menciones.
- **Lo ya guardado:** se borra todo lo suyo y se compacta la base de datos.
- **Nada de IA:** nunca se generan borradores ni se usa contexto suyo.
- **Dónde está la lista:** `%LOCALAPPDATA%\asistente-whatsapp\excluidos.txt`, solo en este ordenador y fuera de OneDrive y de GitHub.

## Dónde está cada cosa
| Qué | Dónde |
|---|---|
| Mensajes, chats, contactos y borradores | PostgreSQL en el Huawei (`C:\Program Files\PostgreSQL\16\data`). Solo acepta conexiones del propio equipo. |
| La llave de tu WhatsApp | `%LOCALAPPDATA%\asistente-whatsapp\auth-whatsapp` |
| Ajustes (Telegram), lista de excluidos, registro de instalación | `%LOCALAPPDATA%\asistente-whatsapp\` |
| El programa | `Escritorio\asistente-whatsapp` (sin conversaciones) |

No se descargan fotos, vídeos, audios ni documentos: solo se apunta una etiqueta, por ejemplo `[foto] pie de foto`.

## Seguridad
- **Librería original, no oficial:** usa `baileys` (de WhiskeySockets) en una versión fija, 7.0.0-rc14. No es una librería de WhatsApp: se conecta como WhatsApp Web. No instales forks: en 2025 un clon llamado *lotusbail* robaba cuentas de WhatsApp.
- **Nunca envía nada:** el código de WhatsApp no llama a ninguna función de envío ni de "marcar como leído". Una prueba automática en GitHub lo comprueba en cada cambio.
- **Panel:** solo escucha en `127.0.0.1` y rechaza peticiones de otras webs. Las tablas se ven en modo solo lectura.
- **IA:** Ollama funciona dentro del Huawei, sin internet.
- **La IA no puede tocar tus cuentas.** Solo recibe texto y devuelve texto: no tiene acceso a ninguna herramienta ni a Google. Las consultas a Google las hace el programa, siempre las mismas y de solo lectura.
- **Google es de solo lectura, con tres candados:**
  1. Solo se piden permisos de lectura. Si Google concediera cualquier otro, la conexión se rechaza y el permiso se revoca, y se vuelve a comprobar antes de cada uso.
  2. Con tus datos solo se hacen lecturas (GET) y solo a los servidores de Gmail, Calendar, Drive y Contactos.
  3. Las pruebas automáticas fallan si el código pidiera un permiso de escritura o hiciera una petición que no sea de lectura.

  Puedes revisar o quitar el acceso cuando quieras en myaccount.google.com/permissions.
- **Telegram:** en modo "aviso" no manda nombres ni contenido. El modo "completo" es opcional y avisa de que el texto queda en los servidores de Telegram.
- **La llave de WhatsApp:** `%LOCALAPPDATA%\asistente-whatsapp\auth-whatsapp` da acceso a tu cuenta. Si pierdes el portátil: WhatsApp → Dispositivos vinculados → cierra la sesión del equipo.
- **Más de 14 días apagado:** WhatsApp desvincula el ordenador y el asistente muestra un QR nuevo.

## Próximas ideas
- Aprender de tus correcciones: comparar el borrador con lo que acabas enviando (ya se guarda en `drafts.my_reply`).
- Transcribir notas de voz en local.
