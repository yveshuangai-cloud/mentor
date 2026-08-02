/**
 * RainWindow — 通話桌面雨窗特效（台北下雨時啟用）
 *
 * 設計筆記：台北當天下雨時，雙向通話的桌面特效換成「隔著一片下雨的窗看慢慢」。
 * 移植自 rain-window-pwa（canvas 水珠 + 霧面窗 + 陀螺儀重力）。三處改動：
 *  1. 去掉啟動幕/授權，通話已在進行。
 *  2. 不另開麥克風（通話已用麥克風）——震動改吃通話「現有」的音量 getter（mic + remote）。
 *  3. 透明疊層（不是不透明淺色背景），疊在模糊頭像之上、UI 之下 → 雨珠滑過慢慢的臉。
 */
import { useEffect, useRef } from 'react';

interface RainWindowProps {
  /** 通話麥克風音量 0..1（震動用，選填） */
  getMicVolume?: () => number;
  /** 對方（慢慢）音量 0..1（震動用，選填） */
  getRemoteVolume?: () => number;
}

export default function RainWindow({ getMicVolume, getRemoteVolume }: RainWindowProps) {
  const gooRef = useRef<HTMLCanvasElement>(null);
  const glossRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const gooCv = gooRef.current;
    const glossCv = glossRef.current;
    if (!gooCv || !glossCv) return;
    const gctx = gooCv.getContext('2d')!;
    const sctx = glossCv.getContext('2d')!;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const PAD = 40;
    let W = 0, H = 0;
    let raf = 0;

    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      gooCv!.width = (W + PAD * 2) * DPR; gooCv!.height = (H + PAD * 2) * DPR;
      glossCv!.width = W * DPR; glossCv!.height = H * DPR;
      gctx.setTransform(DPR, 0, 0, DPR, PAD * DPR, PAD * DPR);
      sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }

    type Drop = { x: number; y: number; vx: number; vy: number; r: number; m: number; ph: number };
    let drops: Drop[] = [];
    function spawn() {
      drops = [];
      const n = Math.round(Math.min(90, Math.max(46, W * H / 9000)));
      for (let i = 0; i < n; i++) {
        const r = 6 + Math.pow(Math.random(), 1.6) * 20;
        drops.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40,
          r, m: r * r, ph: Math.random() * 6.2832,
        });
      }
    }
    resize(); spawn();

    // 重力（陀螺儀傾斜；沒有感測器就預設往下 = 雨往下流）
    const grav = { x: 0, y: 1 };
    function onOrient(e: DeviceOrientationEvent) {
      if (e.beta === null && e.gamma === null) return;
      const b = (e.beta ?? 0) * Math.PI / 180;
      const g = (e.gamma ?? 0) * Math.PI / 180;
      const gx = Math.sin(g), gy = Math.sin(b);
      const ang = ((screen.orientation?.angle ?? 0)) * Math.PI / 180;
      const c = Math.cos(ang), s = Math.sin(ang);
      grav.x = gx * c + gy * s;
      grav.y = -gx * s + gy * c;
    }
    window.addEventListener('deviceorientation', onOrient, true);

    // 聲音能量 → 吃通話現有的音量 getter（不另開麥克風）
    let level = 0, bass = 0, prevLevel = 0;
    function sampleAudio() {
      const mic = getMicVolume?.() ?? 0;
      const rem = getRemoteVolume?.() ?? 0;
      const raw = Math.min(1, Math.max(mic, rem));   // 誰在講話都讓窗震
      level += (raw - level) * 0.35;
      bass += (raw - bass) * 0.3;
    }
    function maybeShock() {
      if (level - prevLevel > 0.16 && level > 0.3) {
        const cx = W / 2, cy = H / 2, power = 320 + level * 680;
        for (const d of drops) {
          const dx = d.x - cx, dy = d.y - cy;
          const dist = Math.hypot(dx, dy) || 0.001;
          const fall = Math.max(0, 1 - dist / (Math.max(W, H) * 0.7));
          d.vx += (dx / dist) * power * fall;
          d.vy += (dy / dist) * power * fall;
        }
      }
      prevLevel = level;
    }

    const G = 1600, FRICTION = 0.985, BOUNCE = 0.42;
    function stepPhysics(dt: number) {
      sampleAudio(); maybeShock();
      const gx = grav.x * G, gy = grav.y * G;
      const shake = level * level * 2600;
      for (const d of drops) {
        d.vx += gx * dt; d.vy += gy * dt;
        if (shake > 1) {
          const k = shake * (14 / d.r) * dt;
          d.vx += (Math.random() - 0.5) * k * 60;
          d.vy += (Math.random() - 0.5) * k * 60;
        }
        d.vx *= FRICTION; d.vy *= FRICTION;
      }
      for (let i = 0; i < drops.length; i++) {
        const a = drops[i]!;
        for (let j = i + 1; j < drops.length; j++) {
          const b = drops[j]!;
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.001;
          const minD = (a.r + b.r) * 0.78, coh = (a.r + b.r) * 1.9;
          if (dist < minD) {
            const f = (minD - dist) / minD * 900 * dt;
            const nx = dx / dist, ny = dy / dist;
            const wa = b.m / (a.m + b.m), wb = a.m / (a.m + b.m);
            a.vx -= nx * f * wa; a.vy -= ny * f * wa;
            b.vx += nx * f * wb; b.vy += ny * f * wb;
          } else if (dist < coh) {
            const f = (dist - minD) / coh * 46 * dt;
            const nx = dx / dist, ny = dy / dist;
            a.vx += nx * f; a.vy += ny * f;
            b.vx -= nx * f; b.vy -= ny * f;
          }
        }
      }
      for (const d of drops) {
        d.x += d.vx * dt; d.y += d.vy * dt;
        if (d.x < d.r) { d.x = d.r; d.vx *= -BOUNCE; }
        if (d.x > W - d.r) { d.x = W - d.r; d.vx *= -BOUNCE; }
        if (d.y < d.r) { d.y = d.r; d.vy *= -BOUNCE; }
        if (d.y > H - d.r) { d.y = H - d.r; d.vy *= -BOUNCE; }
      }
    }

    function drawFrame(now: number) {
      const t = now / 1000;
      gctx.clearRect(-PAD, -PAD, W + PAD * 2, H + PAD * 2);
      for (const d of drops) {
        const sp = Math.hypot(d.vx, d.vy);
        const stretch = Math.min(sp / 900, 0.45);
        const ang = Math.atan2(d.vy, d.vx);
        const pulse = 1 + bass * 0.16 * Math.sin(t * 26 + d.ph);
        const R = d.r * pulse;
        gctx.save();
        gctx.translate(d.x, d.y); gctx.rotate(ang); gctx.scale(1 + stretch, 1 - stretch * 0.5);
        const grd = gctx.createRadialGradient(0, 0, 0, 0, 0, R);
        grd.addColorStop(0, '#bad6e6');
        grd.addColorStop(0.72, '#7ea9c6');
        grd.addColorStop(1, 'rgba(126,169,198,0)');
        gctx.fillStyle = grd;
        gctx.beginPath(); gctx.arc(0, 0, R, 0, 6.2832); gctx.fill();
        gctx.restore();
      }
      sctx.clearRect(0, 0, W, H);
      sctx.fillStyle = 'rgba(255,255,255,.7)';
      for (const d of drops) {
        if (d.r < 9) continue;
        sctx.beginPath();
        sctx.ellipse(d.x - d.r * 0.32, d.y - d.r * 0.38, d.r * 0.2, d.r * 0.13, -0.6, 0, 6.2832);
        sctx.fill();
      }
    }

    let last = performance.now();
    function loop(now: number) {
      const dt = Math.min((now - last) / 1000, 0.033);
      last = now;
      stepPhysics(dt); drawFrame(now);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    window.addEventListener('resize', resize);
    window.addEventListener('resize', spawn);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('resize', spawn);
      window.removeEventListener('deviceorientation', onOrient, true);
    };
  }, [getMicVolume, getRemoteVolume]);

  // 半透明疊層：疊在模糊頭像之上、UI 之下。goo 用 blur+contrast 做出霧面窗水珠的膠感。
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', opacity: 0.85 }} aria-hidden>
      <canvas ref={gooRef} style={{
        position: 'absolute', inset: -40, width: 'calc(100% + 80px)', height: 'calc(100% + 80px)',
        filter: 'blur(10px) contrast(14) saturate(0.85) opacity(0.6)',
      }} />
      <canvas ref={glossRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.5 }} />
      {/* 上方一抹天光 + 邊緣暗角，加強「窗」感 */}
      <div style={{
        position: 'absolute', inset: 0,
        background:
          'linear-gradient(180deg, rgba(200,220,235,.10), rgba(0,0,0,0) 28%),' +
          'radial-gradient(120% 100% at 50% 45%, rgba(0,0,0,0) 55%, rgba(20,40,60,.18))',
      }} />
    </div>
  );
}
