/**
 * 🧑‍⚖️ Voice Judge — Dual-Brain Pattern (P0.2)
 *
 * 借鏡 ailivex-platform v10 的 Haiku judge / Sonnet speak 分離：
 *   Sonnet 是「真正開口講話」的 brain
 *   Haiku 是「判斷該不該回應 / 這句話跟我有沒有關 / 是不是雜音」的 brain
 *
 * 加在 voice-pipeline 的 streamVoiceBrain 之前。Haiku 1.5s 內判斷出來，
 * 超時 fail-safe 預設「回應」，從不阻塞真實對話。
 *
 * ROI：判斷類 token 從 Sonnet 等級降到 Haiku 等級（5-10x 便宜），
 * 過濾雜音省下不必要的 Sonnet streaming 成本，也讓真實對話更聚焦。
 *
 * 設計戒律：
 *   - 永遠不阻塞 critical path（超時就 default=true）
 *   - 只當 advisory，最終決定權在 voice-pipeline
 *   - 不存進 DB，只 log + return
 */

import Anthropic from '@anthropic-ai/sdk';
import { getLlm } from './llmClient.js';
import { config } from '../config.js';
import { SOUL } from './soulConfig.js';

const JUDGE_TIMEOUT_MS = 1500;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = getLlm() as unknown as Anthropic;
  return _client;
}

export interface JudgeDecision {
  shouldRespond: boolean;
  reason: string;
  latencyMs: number;
  source: 'haiku' | 'timeout-default' | 'error-default';
}

/**
 * 判斷這句話該不該回應
 *
 * @param transcript 用戶剛說完的話（final transcript from Deepgram）
 * @param userName 用戶名（給 prompt 用）
 * @param recentTurns 最近 2-3 個 turn（給判斷上下文）
 * @returns JudgeDecision — 超時或失敗時 fail-safe shouldRespond=true
 */
export async function shouldRespond(
  transcript: string,
  userName: string,
  recentTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Promise<JudgeDecision> {
  const t0 = Date.now();

  // 顯著太短/太空（< 2 字元）→ 直接 false 不浪費 Haiku
  const trimmed = transcript.trim();
  if (trimmed.length < 2) {
    return {
      shouldRespond: false,
      reason: 'too-short-or-empty',
      latencyMs: Date.now() - t0,
      source: 'timeout-default',
    };
  }

  // 「嗯」「啊」「對」這種純應答詞 → 不需要 Sonnet 大費周章
  if (/^[嗯啊喔哦欸阿耶嗨咦哈哎嘿]{1,3}[？\?！\!。\.~～]*$/.test(trimmed)) {
    return {
      shouldRespond: false,
      reason: 'pure-acknowledgement',
      latencyMs: Date.now() - t0,
      source: 'timeout-default',
    };
  }

  // 真正的 Haiku 判斷
  const recent = recentTurns
    .slice(-3)
    .map((t) => `${t.role === 'user' ? userName : SOUL.name}：${t.content}`)
    .join('\n');

  const sys = `你是${SOUL.name}的「判斷腦」。
你的任務：判斷剛聽到的這句話該不該回應。
注意：
- 對方明確在跟${SOUL.name}講話 → respond
- 對方好像在跟旁邊的人講話、自言自語、或只是雜音碎詞 → skip
- 不確定時 → respond（寧可回多不要漏）

只回 "respond" 或 "skip" 一個詞，不要加標點或解釋。`;

  const userMsg = `${recent ? `[最近對話]\n${recent}\n\n` : ''}[剛剛 ${userName} 說]\n${trimmed}\n\n判斷：`;

  try {
    const r = await Promise.race([
      getClient().messages.create({
        model: config.claudeHaikuModel || 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        system: sys,
        messages: [{ role: 'user', content: userMsg }],
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), JUDGE_TIMEOUT_MS),
      ),
    ]);

    if (!r) {
      return {
        shouldRespond: true,
        reason: 'haiku-timeout-default-true',
        latencyMs: Date.now() - t0,
        source: 'timeout-default',
      };
    }

    const block = r.content.find((b) => b.type === 'text');
    const verdict = block && block.type === 'text' ? block.text.trim().toLowerCase() : 'respond';
    const shouldRespond = !verdict.startsWith('skip');

    return {
      shouldRespond,
      reason: `haiku-${verdict.slice(0, 20)}`,
      latencyMs: Date.now() - t0,
      source: 'haiku',
    };
  } catch (e: any) {
    console.warn('[voice-judge] Haiku 失敗，fail-safe respond:', e?.message);
    return {
      shouldRespond: true,
      reason: `haiku-error-${e?.message?.slice(0, 30)}`,
      latencyMs: Date.now() - t0,
      source: 'error-default',
    };
  }
}
