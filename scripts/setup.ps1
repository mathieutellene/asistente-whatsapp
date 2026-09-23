#Requires -RunAsAdministrator
# Instalacion automatica: Node.js, PostgreSQL y Ollama + base de datos + arranque automatico.
# Lo lanza la linea de instalacion del README. Tambien se puede ejecutar a mano:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# Los secretos (sesion de WhatsApp, contrasena de admin) van FUERA del escritorio,
# por si el escritorio se sincroniza con OneDrive.
$secrets = Join-Path $env:LOCALAPPDATA 'asistente-whatsapp'
New-Item -ItemType Directory -Force $secrets | Out-Null
Start-Transcript -Path (Join-Path $secrets 'instalacion.log') -Force | Out-Null

function Install-Pkg([string]$id, [string[]]$extra = @()) {
    Write-Host "  - $id" -ForegroundColor Cyan
    $wgArgs = @('install', '--id', $id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements') + $extra
    & winget @wgArgs
    # winget devuelve error si ya estaba instalado: no lo tratamos como fallo
}

function Find-Psql {
    Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
        Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName
}

function New-Password([int]$n) {
    -join ((48..57) + (65..90) + (97..122) | Get-Random -Count $n | ForEach-Object { [char]$_ })
}

try {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Falta winget. Instala "App Installer" desde la Microsoft Store y vuelve a lanzar el comando.'
    }

    # Si es una actualizacion, cerrar la copia que ya este corriendo
    # (dos a la vez chocarian en WhatsApp y bloquearian la reinstalacion de dependencias)
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*iniciar.cmd*' -or $_.CommandLine -like '*src/index.js*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    Write-Host "`n[1/5] Instalando Node.js y Ollama (fuentes oficiales)..." -ForegroundColor Green
    Install-Pkg 'OpenJS.NodeJS.LTS'
    Install-Pkg 'Ollama.Ollama'
    Install-Pkg 'Tailscale.Tailscale'   # red privada para abrir el panel desde el movil

    if (Test-Path "$root\.env") {
        Write-Host "`n[2/5] Ya existe .env: la base de datos ya estaba creada." -ForegroundColor Yellow
    } else {
        Write-Host "`n[2/5] Instalando y configurando PostgreSQL..." -ForegroundColor Green
        $superFile = Join-Path $secrets 'postgres-admin.txt'
        if (Test-Path $superFile) { $pgSuper = (Get-Content $superFile -Raw).Trim() }
        else { $pgSuper = New-Password 20; Set-Content -Path $superFile -Value $pgSuper -Encoding ascii }

        $psql = Find-Psql
        if (-not $psql) {
            Install-Pkg 'PostgreSQL.PostgreSQL.16' @('--override', "--mode unattended --unattendedmodeui minimal --superpassword $pgSuper --serverport 5432 --disable-components stackbuilder")
            $psql = Find-Psql
            if (-not $psql) { throw 'No encuentro psql.exe tras instalar PostgreSQL.' }
        }

        # Solo aceptar conexiones desde este mismo equipo
        $conf = Join-Path (Split-Path (Split-Path $psql -Parent) -Parent) 'data\postgresql.conf'
        if (Test-Path $conf) {
            $lines = (Get-Content $conf) -replace "^\s*#?\s*listen_addresses\s*=.*", "listen_addresses = 'localhost'"
            [IO.File]::WriteAllLines($conf, $lines)
            Get-Service 'postgresql*' | Restart-Service
            Start-Sleep -Seconds 5
        }

        $appPass = New-Password 24
        $env:PGPASSWORD = $pgSuper
        $exists = & $psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_roles WHERE rolname='asistente'"
        if ($LASTEXITCODE -ne 0) {
            throw "No puedo entrar en PostgreSQL. Si ya lo tenias instalado de antes, escribe su contrasena de administrador en $superFile y vuelve a lanzar el comando."
        }
        if ("$exists".Trim() -eq '1') {
            & $psql -U postgres -h localhost -c "ALTER ROLE asistente WITH LOGIN PASSWORD '$appPass';" | Out-Null
        } else {
            & $psql -U postgres -h localhost -c "CREATE ROLE asistente LOGIN PASSWORD '$appPass';" | Out-Null
        }
        $dbExists = & $psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='asistente'"
        if ("$dbExists".Trim() -ne '1') {
            & $psql -U postgres -h localhost -c "CREATE DATABASE asistente OWNER asistente;" | Out-Null
        }
        Remove-Item Env:PGPASSWORD

        $authDir = (Join-Path $secrets 'auth-whatsapp') -replace '\\', '/'
        [IO.File]::WriteAllLines("$root\.env", @(
            "DATABASE_URL=postgres://asistente:$appPass@localhost:5432/asistente",
            'HISTORY_MONTHS=6',
            "AUTH_DIR=$authDir",
            'LOG_LEVEL=warn'
        ))
    }

    Write-Host "`n[3/5] Instalando dependencias del proyecto..." -ForegroundColor Green
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    & npm.cmd install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install ha fallado.' }

    Write-Host "`n[4/5] Creando tablas..." -ForegroundColor Green
    & npm.cmd run db:init
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron crear las tablas.' }

    Write-Host "`n[5/5] Arranque automatico al iniciar sesion..." -ForegroundColor Green
    $action = New-ScheduledTaskAction -Execute "$root\iniciar.cmd" -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'Asistente WhatsApp' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

    Stop-Transcript | Out-Null
    Write-Host "`nTODO LISTO. Se abre ahora la ventana del asistente." -ForegroundColor Green
    Write-Host "Si WhatsApp aun no esta vinculado, escanea el QR con el movil" -ForegroundColor Green
    Write-Host "(WhatsApp > Ajustes > Dispositivos vinculados > Vincular un dispositivo)." -ForegroundColor Green
    Write-Host "Panel de control: panel.cmd  |  Acceso desde el iPhone: movil.cmd" -ForegroundColor Green
    # explorer.exe lo abre SIN permisos de administrador, como un doble clic normal
    Start-Process explorer.exe "`"$root\iniciar.cmd`""
    Start-Sleep -Seconds 8
} catch {
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "El detalle esta en $secrets\instalacion.log (mandaselo a Claude)." -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch {}
    Read-Host 'Pulsa Enter para cerrar'
}
