// Canal interno entre modulos: WhatsApp avisa y los borradores reaccionan.
//   'mensajes'  { rows, live }  mensajes guardados (live = llegados ahora, no del historico)
//   'conectado'                 WhatsApp conectado
import { EventEmitter } from 'node:events'

export const bus = new EventEmitter()
