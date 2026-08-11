import WebSocket from 'ws'
import { config } from '../../config.js'

export interface DeepgramTranscript {
  text: string
  isFinal: boolean
  speechFinal: boolean
}

interface DeepgramOptions {
  onTranscript: (event: DeepgramTranscript) => void
  onError: (error: Error) => void
  onOpen?: () => void
}

export class DeepgramStream {
  private socket: WebSocket | null = null
  private keepAlive: NodeJS.Timeout | null = null

  constructor(private readonly options: DeepgramOptions) {}

  async connect(): Promise<void> {
    if (config.deepgramApiKey === 'not-configured') throw new Error('deepgram_not_configured')
    if (this.socket?.readyState === WebSocket.OPEN) return

    const query = new URLSearchParams({
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      model: 'nova-2',
      language: 'zh-TW',
      interim_results: 'true',
      endpointing: '500',
      vad_events: 'true',
      utterance_end_ms: '1200',
      smart_format: 'true',
    })
    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query.toString()}`, {
      headers: { Authorization: `Token ${config.deepgramApiKey}` },
    })
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('deepgram_connect_timeout')), 10_000)
      socket.once('open', () => {
        clearTimeout(timeout)
        this.keepAlive = setInterval(() => this.sendJson({ type: 'KeepAlive' }), 8_000)
        this.options.onOpen?.()
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })

    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          type?: string
          code?: string
          description?: string
          message?: string
          is_final?: boolean
          speech_final?: boolean
          channel?: { alternatives?: Array<{ transcript?: string }> }
        }
        if (message.type === 'Error') {
          this.options.onError(new Error(
            `Deepgram ${message.code ?? 'stream_error'}: ${message.description ?? message.message ?? 'unknown error'}`,
          ))
          return
        }
        if (message.type !== 'Results') return
        const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? ''
        if (!text) return
        this.options.onTranscript({
          text,
          isFinal: Boolean(message.is_final),
          speechFinal: Boolean(message.speech_final),
        })
      } catch (error) {
        this.options.onError(error as Error)
      }
    })
    socket.on('error', (error) => this.options.onError(error))
    socket.on('close', (code, reason) => {
      if (code !== 1000) this.options.onError(new Error(`Deepgram closed ${code}: ${reason.toString()}`))
    })
  }

  sendAudio(chunk: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(chunk)
  }

  finalize(): void {
    this.sendJson({ type: 'Finalize' })
  }

  close(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    this.sendJson({ type: 'CloseStream' })
    this.socket?.close()
    this.socket = null
  }

  private sendJson(value: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value))
  }
}
