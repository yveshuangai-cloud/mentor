/**
 * 撥號等待音 — 嘟..嘟..嘟..
 *
 * 用 Web Audio API 合成嘟聲（不需要額外音檔）。
 * 三聲嘟的時間，剛好讓後端完成：
 *   第一聲：身分鎖定
 *   第二聲：上下文同步
 *   第三聲：大腦開機
 */

import { useEffect, useRef } from 'react';

interface DialToneProps {
  /** 是否播放 */
  playing: boolean;
  /** 最多嘟幾聲後自動停止（預設 5） */
  maxBeeps?: number;
  /** 超時回調（嘟太多聲了） */
  onTimeout?: () => void;
}

export default function DialTone({ playing, maxBeeps = 5, onTimeout }: DialToneProps) {
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countRef = useRef(0);

  useEffect(() => {
    if (!playing) {
      // 停止
      if (timerRef.current) clearInterval(timerRef.current);
      ctxRef.current?.close();
      ctxRef.current = null;
      countRef.current = 0;
      return;
    }

    // 開始嘟嘟嘟
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    countRef.current = 0;

    function beep() {
      if (!ctxRef.current || ctxRef.current.state === 'closed') return;

      countRef.current++;
      if (countRef.current > maxBeeps) {
        if (timerRef.current) clearInterval(timerRef.current);
        onTimeout?.();
        return;
      }

      const oscillator = ctxRef.current.createOscillator();
      const gainNode = ctxRef.current.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctxRef.current.destination);

      oscillator.frequency.value = 440; // A4 音高
      oscillator.type = 'sine';

      gainNode.gain.value = 0.15; // 音量不要太大
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctxRef.current.currentTime + 0.4);

      oscillator.start(ctxRef.current.currentTime);
      oscillator.stop(ctxRef.current.currentTime + 0.4);
    }

    // 立即嘟第一聲
    beep();

    // 每 1.5 秒嘟一聲
    timerRef.current = setInterval(beep, 1500);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      ctx.close();
    };
  }, [playing, maxBeeps, onTimeout]);

  // 純音效元件，不渲染任何 DOM
  return null;
}
