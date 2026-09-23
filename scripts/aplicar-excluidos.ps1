# Reinicia el asistente para que cargue la lista de numeros excluidos y borre sus restos.
$root = Split-Path $PSScriptRoot -Parent
$node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src/index.js*' }
$loop = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*iniciar.cmd*' }
$node | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($loop) {
    Write-Host 'Listo: el asistente se reinicia solo en 15 segundos con la lista nueva.' -ForegroundColor Green
} else {
    Start-Process explorer.exe "`"$root\iniciar.cmd`""
    Write-Host 'Listo: asistente arrancado con la lista nueva.' -ForegroundColor Green
}
Write-Host 'En su ventana veras "Numeros excluidos: N" y cuantos registros suyos se han borrado.'
