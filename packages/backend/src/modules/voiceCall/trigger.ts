import { config } from '../../config.js'
import type { LineFlexMessage } from '../line.js'

const CALL_TRIGGER_RE = /^(?:打電話|跟饅頭通話|跟饅頭打電話|語音通話|打給饅頭)[。！？!?\s]*$/u

export function isVoiceCallTrigger(text: string): boolean {
  return CALL_TRIGGER_RE.test(text.trim())
}

export function voiceCallAvailable(): boolean {
  return config.liffId !== 'not-configured'
}

export function buildVoiceCallFlex(): LineFlexMessage {
  if (!voiceCallAvailable()) throw new Error('liff_not_configured')

  return {
    type: 'flex',
    altText: '和饅頭語音通話',
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '和饅頭語音通話', weight: 'bold', size: 'xl' },
          {
            type: 'text',
            text: '按下按鈕後，就可以直接和饅頭說話。',
            wrap: true,
            color: '#666666',
            size: 'sm',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#06C755',
            action: {
              type: 'uri',
              label: '開始和饅頭通話',
              uri: `https://liff.line.me/${config.liffId}`,
            },
          },
        ],
      },
    },
  }
}
