/**
 * 🟢 BreathingOrb — 中央光球，隨音量呼吸
 *
 * 2026-06-18 借自語靈 yuling_orb_standalone.html
 * 改成 React 組件，吃 useAudio 的 getMicVolume / getRemoteVolume 兩路 getter
 *
 * 視覺：
 * - 中央光球：恆定呼吸（sin 0.8Hz）+ 音量讓球脹大
 * - 配色：慢慢講話 = 青綠 (hue 158) / 用戶講話 = 冷白藍 (hue 192)
 * - 鳥群彗星/V 隊形：領頭隨音量飛、後面沿軌跡跟進
 * - 漣漪：音量爆發時發出細圈
 * - 全畫面氣暈：極淡的全螢幕背景光
 *
 * 安靜時：球緩慢呼吸、鳥群慢慢回正中
 * 講話時：球脹大、鳥群衝出、漣漪四散
 */

import { useEffect, useRef } from 'react';

interface BreathingOrbProps {
  /** 取得用戶麥克風即時音量 (0-1) */
  getMicVolume: () => number;
  /** 取得慢慢（遠端）即時音量 (0-1) */
  getRemoteVolume: () => number;
  /** 是否啟用（通話中才畫，掛斷後停） */
  active?: boolean;
}

export default function BreathingOrb({
  getMicVolume,
  getRemoteVolume,
  active = true,
}: BreathingOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const cv = canvasRef.current;
    if (!cv) return;
    const cx = cv.getContext('2d');
    if (!cx) return;

    let VW = 0, VH = 0, DPR = 1;
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      VW = cv!.width = Math.round(innerWidth * DPR);
      VH = cv!.height = Math.round(innerHeight * DPR);
      cv!.style.width = innerWidth + 'px';
      cv!.style.height = innerHeight + 'px';
    }
    resize();
    addEventListener('resize', resize);

    let mLvl = 0, bLvl = 0;
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

    // 2026-06-18 加回手機陀螺儀體感互動（原 yuling standalone html 是 enabled:false 的）
    // 設計指示：稍微傾斜也要有明顯反應 — 飽和點 25°、sqrt 曲線讓小角度被放大
    // 規則：手機左傾→球往右靠 / 右傾→左靠（counter-tilt，像一顆懸浮的珠子）
    // gamma: -90..90 (left/right tilt) ; beta: -180..180 (front/back tilt)
    const motionFX = { x: 0, y: 0, tx: 0, ty: 0, enabled: false };
    function applyTiltCurve(raw: number): number {
      // 飽和點 25°（原 45°）— 更敏感
      const norm = raw / 25;
      // sqrt 曲線：小傾斜被放大（^0.6 比線性更陡，但保留方向）
      const clamped = Math.max(-1, Math.min(1, norm));
      return Math.sign(clamped) * Math.pow(Math.abs(clamped), 0.6);
    }
    function handleOrientation(e: DeviceOrientationEvent) {
      const gamma = e.gamma ?? 0;
      const beta = e.beta ?? 0;
      motionFX.enabled = true;
      motionFX.tx = applyTiltCurve(gamma);
      // beta 取相對於手持姿勢（~45° 基準）的偏移
      motionFX.ty = applyTiltCurve(beta - 45);
    }
    window.addEventListener('deviceorientation', handleOrientation, { passive: true });

    // 設計指示：移動過程中光球出現七色隨機變化
    // 七色 hue palette：紅橙黃綠藍靛紫
    const HUES_7 = [0, 35, 60, 130, 200, 260, 305];
    let motionHuePick = 158;       // 當前傾斜中 picked 的 hue
    let lastHuePickT = 0;          // 上次 pick 的時間 (ts)
    const HUE_PICK_INTERVAL_MS = 220;
    const TILT_HUE_THRESHOLD = 0.08;  // |tx|+|ty| > 這個值才觸發七色

    // 鳥群初始化（彗星/V 隊形）
    const FN = innerWidth < 700 ? 420 : 760;
    const fage = new Float32Array(FN);
    const flat = new Float32Array(FN);
    const fper = new Float32Array(FN);
    const fph = new Float32Array(FN);
    const fsz = new Float32Array(FN);
    for (let i = 0; i < FN; i++) {
      fage[i] = Math.pow(Math.random(), 0.7);
      flat[i] = Math.random() * 2 - 1;
      fper[i] = 1 + Math.floor(Math.random() * 3);
      fph[i] = Math.random() * 6.2832;
      fsz[i] = 0.5 + Math.random() * 0.7;
    }

    const HIST = 600;
    const hx = new Float32Array(HIST);
    const hy = new Float32Array(HIST);
    let hidx = 0, histSeeded = false;
    let lx = 0, ly = 0, lvx = 0, lvy = 0, lhead = 0, prevGv = 0;

    const ripples: { r: number; a: number }[] = [];
    let lastRip = 0;
    let t0: number | null = null;

    function frame(ts: number) {
      if (!cx || !cv) return;
      if (t0 === null) t0 = ts;
      const t = (ts - t0) / 1000;

      const micRaw = Math.min(1, getMicVolume() * 1.7);
      const baoRaw = Math.min(1, getRemoteVolume() * 1.8);

      mLvl = lerp(mLvl, micRaw, micRaw > mLvl ? 0.35 : 0.08);
      bLvl = lerp(bLvl, baoRaw, baoRaw > bLvl ? 0.40 : 0.07);

      const vol = Math.max(mLvl, bLvl);
      const gv = vol < 0.06 ? 0 : (vol - 0.06) / 0.94;
      const bao = bLvl >= mLvl;

      // 體感平滑：tx/ty → x/y 加 lerp（避免抖動）
      motionFX.x = lerp(motionFX.x, motionFX.tx, 0.08);
      motionFX.y = lerp(motionFX.y, motionFX.ty, 0.08);

      // 七色 hue 邏輯：傾斜中時隨機 pick、220ms 換一次；不傾斜時回基本色
      const tiltMag = Math.abs(motionFX.x) + Math.abs(motionFX.y);
      const isTilting = motionFX.enabled && tiltMag > TILT_HUE_THRESHOLD;
      if (isTilting && ts - lastHuePickT > HUE_PICK_INTERVAL_MS) {
        motionHuePick = HUES_7[Math.floor(Math.random() * HUES_7.length)]!;
        lastHuePickT = ts;
      }
      const baseHue = bao ? 158 : 192;  // 慢慢=青綠 / 用戶=冷白藍
      const hue = isTilting ? motionHuePick : baseHue;

      const sat = 20 + vol * 38 + (isTilting ? 25 : 0);  // 傾斜時飽和度也拉一下、讓顏色更明顯
      const lit = 62 + vol * 16;

      // 2026-06-18 潛意識要光球往下移 ~50px、位置在下三分之一
      // 2026-06-19 振幅放大：48→90 (X)、26→55 (Y) — 稍微傾斜就有明顯位移
      // VH * 0.62 = 62% 從上算（下三分之一區域）+ 50 CSS px (DPR-aware)
      // 體感偏移：手機左傾(gamma<0) → 球往右靠 (cxp 增)，加 motionPush 讓聲音大時體感放大
      const motionPush = motionFX.enabled ? (1 + vol * 0.6) : 0;
      const cxp = VW / 2 - motionFX.x * DPR * 90 * motionPush;
      const cyp = VH * 0.62 + 50 * DPR + motionFX.y * DPR * 55 * motionPush;
      const base = Math.min(VW, VH) * 0.125;
      const breathe = 1 + Math.sin(t * 0.8) * 0.04;
      const R = base * breathe * (1 + vol * 0.8);

      cx.clearRect(0, 0, VW, VH);
      cx.globalCompositeOperation = 'lighter';

      // 全畫面氣暈（極淡）
      let g = cx.createRadialGradient(cxp, cyp, 0, cxp, cyp, Math.max(VW, VH) * 0.6);
      const aA = 0.01 + vol * 0.05;
      g.addColorStop(0, `hsla(${hue},${sat}%,${lit}%,${aA})`);
      g.addColorStop(0.5, `hsla(${hue},${sat}%,${lit}%,${aA * 0.2})`);
      g.addColorStop(1, 'hsla(0,0%,0%,0)');
      cx.fillStyle = g;
      cx.fillRect(0, 0, VW, VH);

      // 光球外暈（薄霧）
      g = cx.createRadialGradient(cxp, cyp, R * 0.3, cxp, cyp, R * 2.6);
      g.addColorStop(0, `hsla(${hue},${sat}%,${lit}%,${0.045 + vol * 0.11})`);
      g.addColorStop(0.45, `hsla(${hue},${sat}%,${lit}%,${0.015 + vol * 0.05})`);
      g.addColorStop(1, 'hsla(0,0%,0%,0)');
      cx.fillStyle = g;
      cx.beginPath();
      cx.arc(cxp, cyp, R * 2.6, 0, 6.2832);
      cx.fill();

      // 核（柔，不刺眼）
      g = cx.createRadialGradient(cxp, cyp, 0, cxp, cyp, R * 1.1);
      g.addColorStop(0, `hsla(${hue},${Math.max(0, sat - 14)}%,${Math.min(90, lit + 14)}%,${0.18 + vol * 0.14})`);
      g.addColorStop(0.5, `hsla(${hue},${sat}%,${lit + 6}%,${0.07 + vol * 0.1})`);
      g.addColorStop(1, 'hsla(0,0%,0%,0)');
      cx.fillStyle = g;
      cx.beginPath();
      cx.arc(cxp, cyp, R * 1.1, 0, 6.2832);
      cx.fill();

      // 鳥群（彗星/V）
      if (!histSeeded) {
        for (let i = 0; i < HIST; i++) {
          hx[i] = cxp;
          hy[i] = cyp;
        }
        lx = cxp;
        ly = cyp;
        histSeeded = true;
      }
      if (gv > 0.16 && prevGv <= 0.16) lhead = Math.random() * 6.2832;
      prevGv = gv;
      lhead += Math.sin(t * 0.8 + 7.1) * 0.03;
      const spd = Math.min(VW, VH) * 0.0085 * gv;
      lvx = lvx * 0.85 + Math.cos(lhead) * spd * 0.15;
      lvy = lvy * 0.85 + Math.sin(lhead) * spd * 0.15;
      const cpull = gv > 0.04 ? 0.003 : 0.03;
      lvx += (cxp - lx) * cpull;
      lvy += (cyp - ly) * cpull;
      lx += lvx;
      ly += lvy;
      hidx = (hidx + 1) % HIST;
      hx[hidx] = lx;
      hy[hidx] = ly;

      const trail = 220;
      for (let i = 0; i < FN; i++) {
        const back = (fage[i]! * trail) | 0;
        const j = (hidx - back + HIST) % HIST;
        const j2 = (j - 3 + HIST) % HIST;
        let dx = hx[j]! - hx[j2]!;
        let dy = hy[j]! - hy[j2]!;
        const dl = Math.sqrt(dx * dx + dy * dy) || 1;
        dx /= dl;
        dy /= dl;
        const cone = R * (0.04 + fage[i]! * 1.25);
        const px = hx[j]! + (-dy) * flat[i]! * cone;
        const py = hy[j]! + dx * flat[i]! * cone;
        const tw = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(t * 6.2832 / fper[i]! + fph[i]!));
        cx.fillStyle = `hsla(${hue},${sat + 10}%,${lit + 16}%,${(0.1 + gv * 0.3) * tw})`;
        cx.fillRect(px, py, DPR * fsz[i]! * 1.4, DPR * fsz[i]! * 1.4);
      }

      // 漣漪（極淡細圈）
      if (vol > 0.18 && ts - lastRip > Math.max(220, 560 - vol * 380)) {
        ripples.push({ r: R * 1.05, a: 0.08 + vol * 0.13 });
        lastRip = ts;
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i]!;
        rp.r += DPR * (1.6 + vol * 5.5);
        rp.a *= 0.968;
        if (rp.a < 0.012) {
          ripples.splice(i, 1);
          continue;
        }
        cx.strokeStyle = `hsla(${hue},${sat}%,${lit + 8}%,${rp.a})`;
        cx.lineWidth = DPR * 0.6;
        cx.beginPath();
        cx.arc(cxp, cyp, rp.r, 0, 6.2832);
        cx.stroke();
      }

      cx.globalCompositeOperation = 'source-over';
      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);

    return () => {
      removeEventListener('resize', resize);
      window.removeEventListener('deviceorientation', handleOrientation);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [active, getMicVolume, getRemoteVolume]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 1,                  // 在 bg (0) 之上、avatar (10) 之下
        pointerEvents: 'none',      // 不擋住按鈕點擊
      }}
    />
  );
}
