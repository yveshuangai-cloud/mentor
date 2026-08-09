/**
 * 音訊 Hook — 麥克風採集 + PCM 編碼 + 播放 AI 語音
 *
 * 採集：Web Audio API → ScriptProcessor → PCM 16kHz mono 16-bit
 * 播放：完整 MP3 累積 → 單次解碼 → PCM 寫入 ScriptProcessor 串流播放
 * 新增：靜音（mute）、擴音（speaker）切換
 *
 * 播放策略 v3（徹底消除爆米花聲）：
 * - 不再用 decodeAudioData 逐段解碼 MP3（根本原因：decoder warmup artifacts）
 * - 改用持續累積的 PCM ring buffer + ScriptProcessor 串流輸出
 * - 每次收到新 MP3 chunk → 累積到完整 MP3 → 一次 decode 整段 → 提取新增的 PCM
 * - ScriptProcessor 以固定速率從 PCM buffer 讀取，零 gap、零 click
 * - AudioContext 設定為 24kHz（匹配 MiniMax TTS 輸出，避免重採樣 artifacts）
 */

import { useRef, useState, useCallback, useEffect } from 'react';

interface UseAudioOptions {
  /** 收到音訊 chunk 的回調（PCM ArrayBuffer） */
  onAudioChunk?: (chunk: ArrayBuffer) => void;
  /** 偵測到用戶開口（VAD） */
  onSpeechStart?: () => void;
  /** 偵測到用戶停止說話 */
  onSpeechEnd?: () => void;
}

function resampleMono(input: Float32Array, inputRate: number, outputRate = 16000): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[i] = input[left]! * (1 - fraction) + input[right]! * fraction;
  }
  return output;
}

export function useAudio(options: UseAudioOptions = {}) {
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);

  // 音訊上下文（麥克風）
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // ====== 播放系統 v3：PCM 串流 ======
  const playContextRef = useRef<AudioContext | null>(null);
  const playGainRef = useRef<GainNode | null>(null);
  const playProcessorRef = useRef<ScriptProcessorNode | null>(null);

  // PCM 串流 buffer（Float32 samples, mono）
  // 所有解碼後的 PCM 都寫入這裡，ScriptProcessor 從這裡讀取
  const pcmBufferRef = useRef<Float32Array[]>([]);
  const pcmReadPosRef = useRef(0);      // 目前讀取到第幾個 sample
  const pcmTotalSamplesRef = useRef(0); // 總共有多少 sample
  const isStreamingRef = useRef(false);  // 是否正在串流播放
  // 2026-06-19 Climb 2 — TTS echo gate: 慢慢 TTS 期間 + 400ms 殘響期，不送 mic chunks 給 STT
  // 修「呵呵→黑黑黑」echo 幻聽。local VAD 仍正常跑 → barge-in 仍 work
  const aiTailMuteUntilRef = useRef(0);

  // MP3 累積（完整累積 → 一次解碼）
  const mp3TotalRef = useRef<Uint8Array[]>([]);  // 本次語音的所有 MP3 data
  const mp3TotalSizeRef = useRef(0);
  const decodedSamplesRef = useRef(0);   // 已解碼過的 sample 數
  const isDecodingRef = useRef(false);   // 防止並行解碼
  const pendingDecodeRef = useRef(false); // 解碼中有新 chunk 到達
  const mp3FlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // VAD 相關
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSpeakingRef = useRef(false);
  const loudChunkCountRef = useRef(0);

  // Mute 狀態 ref
  const isMutedRef = useRef(false);

  // Filler 音訊系統（預載「嗯...」等音檔）
  const fillerBuffersRef = useRef<AudioBuffer[]>([]);
  const fillerLoadedRef = useRef(false);
  const fillerSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const fillerGainRef = useRef<GainNode | null>(null);

  // ====== 語靈呼吸光球視覺化 — 兩路聲浪分析器 ======
  // 2026-06-18 借語靈 yuling_orb_standalone.html 設計
  // micAnalyser 接 audioContextRef（16kHz，跟麥克風一致）
  // remoteAnalyser 接 playContextRef（24kHz，跟 MiniMax TTS 一致）
  // 兩個都是懶建，第一次呼叫 getVolume 才生
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micVolBufRef = useRef<Uint8Array | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteVolBufRef = useRef<Uint8Array | null>(null);

  /** 麥克風即時音量 (0-1)，給呼吸光球用 */
  const getMicVolume = useCallback((): number => {
    const ctx = audioContextRef.current;
    const src = sourceRef.current;
    if (!ctx || !src) return 0;

    // 懶建 analyser（同 AudioContext 下）
    if (!micAnalyserRef.current) {
      try {
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        src.connect(an);   // 分接，不影響原本到 processor 的路徑
        micAnalyserRef.current = an;
        micVolBufRef.current = new Uint8Array(an.frequencyBinCount);
      } catch { return 0; }
    }

    const an = micAnalyserRef.current;
    const buf = micVolBufRef.current;
    if (!an || !buf) return 0;
    an.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i]!;
    return s / buf.length / 255;
  }, []);

  /** 慢慢（遠端）即時音量 (0-1)，給呼吸光球用 */
  const getRemoteVolume = useCallback((): number => {
    const gain = playGainRef.current;
    const ctx = playContextRef.current;
    if (!gain || !ctx) return 0;

    // 懶建 analyser（同 playContext 下，從 gainNode 分接）
    if (!remoteAnalyserRef.current) {
      try {
        const an = ctx.createAnalyser();
        an.fftSize = 256;
        gain.connect(an);  // gainNode → 既有 destination + 新的 analyser
        remoteAnalyserRef.current = an;
        remoteVolBufRef.current = new Uint8Array(an.frequencyBinCount);
      } catch { return 0; }
    }

    const an = remoteAnalyserRef.current;
    const buf = remoteVolBufRef.current;
    if (!an || !buf) return 0;
    an.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i]!;
    return s / buf.length / 255;
  }, []);

  /**
   * 啟動麥克風
   */
  const startMic = useCallback(async () => {
    // 防止重複啟動（避免二次 getUserMedia 彈窗）
    if (streamRef.current || audioContextRef.current) {
      console.log('麥克風已啟動，跳過重複請求');
      return;
    }

    try {
      setMicError(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,   // 留著：防她的 TTS 回灌麥克風（回授）
          // 2026-06-21 平衡版：只關 noiseSuppression —— 它是「頻譜上把非人聲砍掉」的元兇，
          // 撕紙/拍手/打噴嚏/打字就是被它殺的。關掉讓環境音進得來給 YAMNet 場景偵測。
          // autoGainControl 留 true：它只調音量、不砍頻譜，對環境音殺傷小，卻能穩住人聲音量、
          // 保護 STT（小聲/遠講不漏字）。= 救環境音又最大保 STT 的平衡。
          noiseSuppression: false,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (isMutedRef.current) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // --- 簡易 VAD：計算 RMS ---
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i]! * inputData[i]!;
        }
        const rms = Math.sqrt(sum / inputData.length);

        // Fix 0F: 動態 VAD 門檻 — AI 播放中提高門檻，防止喇叭迴音誤觸打斷
        // 0.15 + 4 chunks：減少迴音誤判導致的回應中斷
        const threshold = isStreamingRef.current ? 0.15 : 0.04;
        const chunksNeeded = isStreamingRef.current ? 4 : 3;

        if (rms > threshold) {
          loudChunkCountRef.current++;
          if (!isSpeakingRef.current && loudChunkCountRef.current >= chunksNeeded) {
            isSpeakingRef.current = true;
            options.onSpeechStart?.();
          }
          if (vadTimerRef.current) clearTimeout(vadTimerRef.current);
          vadTimerRef.current = setTimeout(() => {
            isSpeakingRef.current = false;
            loudChunkCountRef.current = 0;
            options.onSpeechEnd?.();
          }, 1500);
        } else {
          loudChunkCountRef.current = 0;
        }

        // 2026-06-19 Climb 2 — TTS echo gate
        // 防 echo「呵呵→黑黑黑」幻聽。local VAD（上方 RMS）仍跑 → barge-in 仍 work
        // 🔥 2026-06-19 BUG fix：原本用 isStreamingRef 一旦 true 永遠 true（player 永不自然停）
        //   導致開場白後 mic 永遠 mute、慢慢收不到任何 audio。改用「PCM buffer 還有東西」當訊號。
        const pcmHasData = pcmBufferRef.current.length > 0;
        const isAISpeakingNow = pcmHasData || Date.now() < aiTailMuteUntilRef.current;
        if (isAISpeakingNow) return;

        // Browsers commonly ignore the requested 16 kHz and run at 44.1/48 kHz.
        // Deepgram is configured for 16 kHz, so resample using the actual context rate.
        const resampled = resampleMono(inputData, ctx.sampleRate, 16000);
        const pcm = new Int16Array(resampled.length);
        for (let i = 0; i < resampled.length; i++) {
          const s = Math.max(-1, Math.min(1, resampled[i]!));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        options.onAudioChunk?.(pcm.buffer);
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      if (ctx.state === 'suspended') await ctx.resume();
      if (ctx.state !== 'running') throw new Error('麥克風尚未啟動，請再點一次允許。');

      setMicActive(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '無法取得麥克風';
      setMicError(msg);
      console.error('麥克風錯誤:', err);
      throw err;
    }
  }, [options]);

  /**
   * 停止麥克風
   */
  const stopMic = useCallback(() => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    audioContextRef.current?.close();
    streamRef.current?.getTracks().forEach(t => t.stop());

    processorRef.current = null;
    sourceRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;

    if (vadTimerRef.current) clearTimeout(vadTimerRef.current);
    isSpeakingRef.current = false;
    loudChunkCountRef.current = 0;

    setMicActive(false);
  }, []);

  /**
   * 切換靜音
   */
  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev;
      isMutedRef.current = next;

      const stream = streamRef.current;
      if (stream) {
        stream.getAudioTracks().forEach(track => {
          track.enabled = !next;
        });
      }

      return next;
    });
  }, []);

  /**
   * 切換擴音模式
   */
  const toggleSpeaker = useCallback(() => {
    setIsSpeakerOn(prev => {
      const next = !prev;
      if (playGainRef.current) {
        playGainRef.current.gain.value = next ? 1.5 : 1.0;
      }
      return next;
    });
  }, []);

  // ====== 播放系統 v3 ======

  /**
   * 確保播放 context 已建立（24kHz 匹配 MiniMax TTS）
   */
  function ensurePlayContext(): AudioContext {
    if (!playContextRef.current || playContextRef.current.state === 'closed') {
      // 使用 24000Hz 匹配 MiniMax TTS 輸出，避免重採樣 artifacts
      const ctx = new AudioContext({ sampleRate: 24000 });
      playContextRef.current = ctx;

      const gain = ctx.createGain();
      gain.gain.value = isSpeakerOn ? 1.5 : 1.0;
      gain.connect(ctx.destination);
      playGainRef.current = gain;
    }
    return playContextRef.current;
  }

  /**
   * 啟動 PCM 串流播放器（ScriptProcessor 持續輸出）
   * 這是消除爆音的核心：用固定速率的 ScriptProcessor 持續讀取 PCM buffer
   * 不再有 chunk 邊界問題，因為 PCM 是連續的
   */
  function startStreamPlayer() {
    if (isStreamingRef.current) return;

    const ctx = ensurePlayContext();
    const gainNode = playGainRef.current!;

    // 建立播放用 ScriptProcessor（2048 samples = ~85ms @ 24kHz）
    const player = ctx.createScriptProcessor(2048, 1, 1);
    playProcessorRef.current = player;

    player.onaudioprocess = (e) => {
      const output = e.outputBuffer.getChannelData(0);
      const buffers = pcmBufferRef.current;
      const needed = output.length;
      let written = 0;
      let bufIdx = 0;
      let readPos = pcmReadPosRef.current;

      // 從 PCM buffer 讀取 sample 填入 output
      while (bufIdx < buffers.length && written < needed) {
        const buf = buffers[bufIdx]!;
        const available = buf.length - readPos;
        const toRead = Math.min(available, needed - written);

        for (let i = 0; i < toRead; i++) {
          output[written + i] = buf[readPos + i]!;
        }
        written += toRead;
        readPos += toRead;

        if (readPos >= buf.length) {
          // 這個 buffer 讀完了，移到下一個
          readPos = 0;
          bufIdx++;
        }
      }

      // 清理已讀完的 buffer（節省記憶體）
      if (bufIdx > 0) {
        pcmBufferRef.current = buffers.slice(bufIdx);
      }
      pcmReadPosRef.current = readPos;

      // 如果沒有足夠的 sample，填零（靜音）
      for (let i = written; i < needed; i++) {
        output[i] = 0;
      }
      // 🔥 註：原本這裡有 auto-set aiTailMuteUntilRef、但 condition 邏輯反向
      // 每次 buffer 空時就 refresh tail → mic 永遠 mute。已移除。
      // pcmHasData 為 false 就是 mic 可送 — 不需 tail 自動 set
    };

    player.connect(gainNode);
    // ScriptProcessor 需要連接到 destination 才能觸發 onaudioprocess
    // 但已經連到 gainNode → destination 了，不需額外連接

    isStreamingRef.current = true;
  }

  /**
   * 核心：解碼目前累積的所有 MP3 → 提取尚未播放的新 PCM
   *
   * 策略：將所有 MP3 data 合併後一次 decodeAudioData
   * 然後只取出 decodedSamplesRef 之後的新 PCM 部分
   * 這樣解碼器只啟動一次，不會有 warmup artifacts
   */
  async function decodeAndAppend() {
    if (isDecodingRef.current) {
      pendingDecodeRef.current = true;
      return;
    }
    isDecodingRef.current = true;

    try {
      const chunks = mp3TotalRef.current;
      if (chunks.length === 0) {
        isDecodingRef.current = false;
        return;
      }

      // 合併所有 MP3 chunks 成一個大 buffer
      const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(totalSize);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }

      const ctx = ensurePlayContext();

      // 一次性解碼整段 MP3
      const audioBuffer = await ctx.decodeAudioData(merged.buffer.slice(0));
      const totalDecodedSamples = audioBuffer.length;
      const prevDecoded = decodedSamplesRef.current;

      if (totalDecodedSamples > prevDecoded) {
        // 提取新增的 PCM 部分
        const channelData = audioBuffer.getChannelData(0);
        const newSamples = totalDecodedSamples - prevDecoded;
        const newPCM = new Float32Array(newSamples);

        // 從上次解碼結束的位置開始複製
        for (let i = 0; i < newSamples; i++) {
          newPCM[i] = channelData[prevDecoded + i]!;
        }

        pcmBufferRef.current.push(newPCM);
        pcmTotalSamplesRef.current += newSamples;
        decodedSamplesRef.current = totalDecodedSamples;

        // 確保串流播放器已啟動
        if (!isStreamingRef.current) {
          startStreamPlayer();
        }
      }
    } catch (err) {
      console.warn('MP3 解碼失敗:', (err as Error).message?.slice(0, 80));
    }

    isDecodingRef.current = false;

    // 如果解碼期間有新 chunk 到達，再解碼一次
    if (pendingDecodeRef.current) {
      pendingDecodeRef.current = false;
      decodeAndAppend();
    }
  }

  /**
   * 播放 AI 語音串流 — 累積 MP3 → 觸發解碼
   */
  const playAudioChunk = useCallback((audioData: ArrayBuffer) => {
    // 累積 MP3 chunk
    mp3TotalRef.current.push(new Uint8Array(audioData));
    mp3TotalSizeRef.current += audioData.byteLength;

    // 清除之前的 flush timer
    if (mp3FlushTimerRef.current) {
      clearTimeout(mp3FlushTimerRef.current);
    }

    // 累積到 2KB+ → 立即觸發解碼（極低閾值加速首次播放）
    if (mp3TotalSizeRef.current >= 2048 && !isDecodingRef.current) {
      decodeAndAppend();
    } else {
      // 否則 40ms 後觸發（極快 flush，最小化首次延遲）
      mp3FlushTimerRef.current = setTimeout(() => {
        mp3FlushTimerRef.current = null;
        decodeAndAppend();
      }, 40);
    }
  }, []);

  /**
   * Flush buffer（audio:done 時呼叫 — 所有 MP3 都收到了）
   */
  const flushMp3Buffer = useCallback((_forceAll = false) => {
    if (mp3FlushTimerRef.current) {
      clearTimeout(mp3FlushTimerRef.current);
      mp3FlushTimerRef.current = null;
    }

    // 最後一次解碼，確保所有 MP3 都轉成 PCM
    if (mp3TotalRef.current.length > 0) {
      decodeAndAppend();
    }
  }, []);

  /**
   * 停止播放（打斷時用）
   */
  const stopPlayback = useCallback(() => {
    // 清空 MP3 累積
    mp3TotalRef.current = [];
    mp3TotalSizeRef.current = 0;
    decodedSamplesRef.current = 0;

    if (mp3FlushTimerRef.current) {
      clearTimeout(mp3FlushTimerRef.current);
      mp3FlushTimerRef.current = null;
    }

    // 停止串流播放器
    if (playProcessorRef.current) {
      playProcessorRef.current.disconnect();
      playProcessorRef.current = null;
    }

    // 清空 PCM buffer
    pcmBufferRef.current = [];
    pcmReadPosRef.current = 0;
    pcmTotalSamplesRef.current = 0;
    isStreamingRef.current = false;
    isDecodingRef.current = false;
    pendingDecodeRef.current = false;

    // 2026-06-19 Climb 2 — 啟動 400ms tail mute（慢慢 TTS 殘響期 mic 不送 STT）
    aiTailMuteUntilRef.current = Date.now() + 400;

    if (playContextRef.current && playContextRef.current.state !== 'closed') {
      playContextRef.current.close();
    }
    playContextRef.current = null;
    playGainRef.current = null;
  }, []);

  /**
   * 🎵 軟著陸：fade-out 音量 → 300ms 後自動清空播放
   * 後端送 audio:fadeout 時呼叫，讓打斷聽起來不會突然斷掉
   * 比 stopPlayback() 更溫柔：先降音量再停
   */
  const fadeOutPlayback = useCallback(() => {
    const ctx = playContextRef.current;
    const gain = playGainRef.current;

    if (!ctx || ctx.state === 'closed' || !gain) {
      // 沒有播放中 → 直接清空
      stopPlayback();
      return;
    }

    // 300ms 內把音量降到 0
    try {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
    } catch {
      // AudioContext 可能已關閉
      stopPlayback();
      return;
    }

    // 300ms 後清空所有播放資源
    setTimeout(() => {
      stopPlayback();
    }, 320); // 多 20ms 緩衝
  }, [stopPlayback]);

  // ====== Filler 音訊系統 ======

  /**
   * 預載 filler 音檔（在通話建立時呼叫）
   * 用 MiniMax TTS 預先生成的「嗯...」「欸...」等音檔
   */
  const preloadFillers = useCallback(async () => {
    if (fillerLoadedRef.current) return;
    fillerLoadedRef.current = true;

    const ctx = ensurePlayContext();
    // 12 個 filler: 嗯, 欸, 嗯哼, 唔, 啊, 呼, 哦, 喔, 嗚, 呃, 嗯嗯, 這個嘛
    const fillerPaths = Array.from({ length: 12 }, (_, i) =>
      `/audio/fillers/filler-${i}.mp3`
    );

    const results = await Promise.allSettled(
      fillerPaths.map(async (path) => {
        try {
          const resp = await fetch(path);
          if (!resp.ok) return null;
          const arrayBuffer = await resp.arrayBuffer();
          return await ctx.decodeAudioData(arrayBuffer);
        } catch {
          return null;
        }
      })
    );

    fillerBuffersRef.current = results
      .map(r => r.status === 'fulfilled' ? r.value : null)
      .filter((b): b is AudioBuffer => b !== null);

    console.log(`[Filler] 預載 ${fillerBuffersRef.current.length} 個 filler 音檔`);
  }, []);

  /**
   * 播放 filler 音訊（「嗯...」）
   * 收到後端 filler 信號時立刻播放，等真正 TTS 到達時會被 stopFiller 停掉
   */
  const playFiller = useCallback((index: number) => {
    const buffers = fillerBuffersRef.current;
    if (buffers.length === 0) return;

    // 選擇 filler（如果 index 超出範圍，隨機選）
    const buf = buffers[index % buffers.length];
    if (!buf) return;

    const ctx = ensurePlayContext();
    const gainNode = playGainRef.current;
    if (!gainNode) return;

    // 停止之前的 filler
    stopFiller();

    // 建立 filler gain（用於淡出）
    const fillerGain = ctx.createGain();
    fillerGain.gain.value = 1.0;
    fillerGain.connect(gainNode);
    fillerGainRef.current = fillerGain;

    // 播放 filler
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(fillerGain);
    source.start();
    fillerSourceRef.current = source;

    source.onended = () => {
      fillerSourceRef.current = null;
      fillerGainRef.current = null;
    };
  }, []);

  /**
   * 停止 filler（真正的 TTS 音訊到達時呼叫）
   * 用快速淡出避免突然靜音的 click
   */
  const stopFiller = useCallback(() => {
    if (fillerSourceRef.current && fillerGainRef.current) {
      try {
        const ctx = playContextRef.current;
        if (ctx && ctx.state !== 'closed') {
          // 50ms 淡出
          fillerGainRef.current.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.05);
          const src = fillerSourceRef.current;
          setTimeout(() => {
            try { src.stop(); } catch { /* already stopped */ }
          }, 60);
        } else {
          fillerSourceRef.current.stop();
        }
      } catch { /* ignore */ }
    }
    fillerSourceRef.current = null;
    fillerGainRef.current = null;
  }, []);

  // 🔧 QA-M9: 組件卸載時清除所有 timer 和音訊資源
  useEffect(() => {
    return () => {
      if (vadTimerRef.current) { clearTimeout(vadTimerRef.current); vadTimerRef.current = null; }
      if (mp3FlushTimerRef.current) { clearTimeout(mp3FlushTimerRef.current); mp3FlushTimerRef.current = null; }
      // 關閉音訊上下文
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      if (playContextRef.current && playContextRef.current.state !== 'closed') {
        playContextRef.current.close().catch(() => {});
      }
      // 停止麥克風串流
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  /**
   * 🔎 播搜尋音效（慢慢 invoke tool 時、給潛意識感覺她在搜）
   * 用 WebAudio 合成、不需要 mp3 檔
   * start：高音 → 升頻、150ms (像「咻」一聲開始搜)
   * done： 中音 → 降頻、80ms  (像「叮」一聲找到了)
   */
  const playSearchBlip = useCallback((phase: 'start' | 'done') => {
    try {
      const ctx = ensurePlayContext();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';

      const now = ctx.currentTime;
      if (phase === 'start') {
        // 升頻 sweep — 像啟動搜尋
        osc.frequency.setValueAtTime(700, now);
        osc.frequency.exponentialRampToValueAtTime(1300, now + 0.13);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.06, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        osc.start(now);
        osc.stop(now + 0.17);
      } else {
        // 降頻 — 像找到了
        osc.frequency.setValueAtTime(1100, now);
        osc.frequency.exponentialRampToValueAtTime(700, now + 0.08);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.05, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.start(now);
        osc.stop(now + 0.10);
      }
    } catch (err) {
      // 音效失敗不影響通話
      console.warn('[useAudio] playSearchBlip 失敗:', err);
    }
  }, []);

  /**
   * 🔧 Pre-warm 播放管道（call:ready 時呼叫）
   * 提前建立 AudioContext + ScriptProcessor，避免開場白前 1-2 秒被吃掉
   * 2026-06-18 補：主動 resume 避免之前 suspended 殘留
   */
  const warmUpPlayback = useCallback(() => {
    const ctx = ensurePlayContext();
    // 如果之前建立時被 browser 標記 suspended（沒 gesture）→ 現在主動 resume
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    startStreamPlayer();
  }, []);

  return {
    micActive,
    micError,
    isMuted,
    isSpeakerOn,
    startMic,
    stopMic,
    toggleMute,
    toggleSpeaker,
    playAudioChunk,
    stopPlayback,
    fadeOutPlayback,
    flushBuffer: (forceAll?: boolean) => flushMp3Buffer(forceAll),
    preloadFillers,
    playFiller,
    stopFiller,
    playSearchBlip,
    warmUpPlayback,
    // 語靈呼吸光球用
    getMicVolume,
    getRemoteVolume,
  };
}
