// Evita que Windows se suspenda por inactividad MIENTRAS el asistente esta abierto
// (lo mismo que hace un reproductor de video). No cambia ningun ajuste de Windows:
// al cerrar el asistente, el ordenador vuelve a comportarse como siempre.
// Cerrar la TAPA si suspende; eso se cambia en las opciones de energia de Windows.
import { spawn } from 'node:child_process'

export function keepAwake() {
  if (process.platform !== 'win32') return
  const script = [
    `$k = Add-Type -Name P -Namespace W -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
    '[void]$k::SetThreadExecutionState([uint32]2147483649)', // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60 }`,
  ].join('; ')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}
