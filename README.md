# Asistente WhatsApp (IA local)

Lee tu WhatsApp **en modo solo lectura**, lo guarda en PostgreSQL y, en las siguientes fases, prepara borradores de respuesta con una IA local (Ollama). **Nunca envía nada**: el que envía eres tú.

## Fase 1 (esta versión)
- Vincula el Huawei como dispositivo de WhatsApp (igual que WhatsApp Web).
- Carga los últimos 6 meses de chats y grupos en PostgreSQL.
- Guarda en tiempo real todo lo que llega, incluidos los mensajes recibidos con el ordenador apagado.
- Arranca solo al iniciar sesión en Windows y se reinicia si se cae.
- `pendientes.cmd` muestra los chats en los que el último mensaje no es tuyo.

## Instalar o actualizar (en el Huawei)
Abre PowerShell (tecla Windows → escribe PowerShell → Enter), pega esta línea y pulsa Enter. Cuando Windows pregunte, pulsa **Sí**:
```
[Net.ServicePointManager]::SecurityProtocol='Tls12'; $d=Join-Path ([Environment]::GetFolderPath('Desktop')) 'asistente-whatsapp'; $z="$env:TEMP\aw.zip"; $t="$env:TEMP\aw"; Invoke-WebRequest 'https://github.com/mathieutellene/asistente-whatsapp/archive/refs/heads/main.zip' -OutFile $z -UseBasicParsing; Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive $z $t -Force; New-Item -ItemType Directory -Force $d | Out-Null; Copy-Item "$t\asistente-whatsapp-main\*" $d -Recurse -Force; Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$d\scripts\setup.ps1`""
```
Se instala todo solo y al final aparece el QR para vincular WhatsApp. Para actualizar a una fase nueva, se usa la misma línea: tus datos y tu sesión se mantienen.

## Dónde está cada cosa
- **Escritorio\asistente-whatsapp**: el programa. `iniciar.cmd` lo arranca (ya lo hace solo al iniciar sesión) y `pendientes.cmd` muestra lo que tienes sin contestar.
- **%LOCALAPPDATA%\asistente-whatsapp**: la sesión de WhatsApp, la contraseña de administrador de PostgreSQL y el registro de la instalación. Está fuera del escritorio para que OneDrive no la sincronice.

## Seguridad
- Solo usa la librería oficial `baileys` en una versión fija (7.0.0-rc14, publicada por WhiskeySockets). No instales nunca forks ni "versiones mejoradas": en 2025 un clon llamado *lotusbail* robaba cuentas de WhatsApp.
- El código no llama a ninguna función de envío ni de "marcar como leído". No apareces "en línea" y el móvil sigue recibiendo las notificaciones.
- **`%LOCALAPPDATA%\asistente-whatsapp\auth-whatsapp` es la llave de tu WhatsApp.** No la compartas. Si pierdes el portátil: WhatsApp → Dispositivos vinculados → cierra la sesión del equipo.
- PostgreSQL solo acepta conexiones desde el propio Huawei y usa contraseñas aleatorias.
- Si el ordenador pasa **más de 14 días apagado**, WhatsApp lo desvincula. El asistente muestra un QR nuevo para volver a vincularlo.

## Reinstalar a mano
PowerShell como administrador, dentro de la carpeta:
```
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

## Próximas fases
2. Perfil de tono por persona o grupo + borradores (Ollama) + panel local con el botón "Abrir en WhatsApp".
3. Contexto de Google Calendar, Gmail, Drive e historial de Chrome.
4. Aprendizaje a partir de tus correcciones y transcripción de notas de voz.
