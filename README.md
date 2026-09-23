# Asistente WhatsApp (IA local)

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
- **Librería oficial:** usa `baileys` en una versión fija (7.0.0-rc14, de WhiskeySockets). No instales forks: en 2025 un clon llamado *lotusbail* robaba cuentas de WhatsApp.
- **Nunca envía nada:** el código de WhatsApp no llama a ninguna función de envío ni de "marcar como leído". Una prueba automática en GitHub lo comprueba en cada cambio.
- **Panel:** solo escucha en `127.0.0.1` y rechaza peticiones de otras webs. Las tablas se ven en modo solo lectura.
- **IA:** Ollama funciona dentro del Huawei, sin internet.
- **Telegram:** en modo "aviso" no manda nombres ni contenido. El modo "completo" es opcional y avisa de que el texto queda en los servidores de Telegram.
- **La llave de WhatsApp:** `%LOCALAPPDATA%\asistente-whatsapp\auth-whatsapp` da acceso a tu cuenta. Si pierdes el portátil: WhatsApp → Dispositivos vinculados → cierra la sesión del equipo.
- **Más de 14 días apagado:** WhatsApp desvincula el ordenador y el asistente muestra un QR nuevo.

## Próximas fases
3. Contexto de Google Calendar, Gmail y Drive, e historial de Chrome.
4. Aprendizaje a partir de tus correcciones y transcripción de notas de voz.
