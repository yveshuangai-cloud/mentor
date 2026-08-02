/**
 * 語音波形動畫 — Canvas 繪製
 *
 * 當包容在說話時，波形跳動；
 * 安靜時，波形緩慢呼吸。
 */

import { useRef, useEffect } from 'react';

interface WaveformProps {
  isActive: boolean;
  color?: string;
}

export default function Waveform({ isActive, color = '#E8345A' }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const phaseRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 高 DPI 支援
    const dpr = window.devicePixelRatio || 1;
    const width = 300;
    const height = 80;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    const bars = 40;
    const barWidth = 3;
    const gap = (width - bars * barWidth) / (bars - 1);

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);

      phaseRef.current += isActive ? 0.08 : 0.02;

      for (let i = 0; i < bars; i++) {
        const x = i * (barWidth + gap);
        const centerY = height / 2;

        // 波形高度計算
        let amplitude: number;
        if (isActive) {
          // 活躍時：多頻率疊加，隨機感
          amplitude =
            Math.sin(phaseRef.current + i * 0.3) * 0.4 +
            Math.sin(phaseRef.current * 1.5 + i * 0.5) * 0.3 +
            Math.sin(phaseRef.current * 0.7 + i * 0.15) * 0.3;
          amplitude = Math.abs(amplitude);
        } else {
          // 靜默時：緩慢呼吸
          amplitude = Math.abs(Math.sin(phaseRef.current + i * 0.2)) * 0.15 + 0.05;
        }

        const barHeight = amplitude * height * 0.8;

        // 漸層透明度（邊緣淡出）
        const normalizedPos = Math.abs(i - bars / 2) / (bars / 2);
        const alpha = 1 - normalizedPos * 0.6;

        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;

        // 圓角矩形
        const radius = barWidth / 2;
        const y = centerY - barHeight / 2;
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + barWidth - radius, y);
        ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
        ctx.lineTo(x + barWidth, y + barHeight - radius);
        ctx.quadraticCurveTo(x + barWidth, y + barHeight, x + barWidth - radius, y + barHeight);
        ctx.lineTo(x + radius, y + barHeight);
        ctx.quadraticCurveTo(x, y + barHeight, x, y + barHeight - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      animFrameRef.current = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [isActive, color]);

  return (
    <canvas
      ref={canvasRef}
      className="opacity-90"
      style={{ width: 300, height: 80 }}
    />
  );
}
