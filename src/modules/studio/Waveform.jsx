import { useEffect, useRef, useState } from 'react';
import { peaksFor, SR } from './engine';

/**
 * Waveform with drag-to-select (mouse or finger) and a moving playhead.
 * selection = [startSec, endSec] | null; cursor = a tap position in seconds.
 */
export default function Waveform({ samples, selection, onSelect, playhead, height = 140, tone = 'brand', interactive = true, marker }) {
  const wrap = useRef(null);
  const canvas = useRef(null);
  const [width, setWidth] = useState(600);
  const drag = useRef(null);
  const secs = samples ? samples.length / SR : 0;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const dark = document.documentElement.classList.contains('dark');
    const css = getComputedStyle(document.documentElement);
    const mid = height / 2;
    // grid: a line every second
    g.fillStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)';
    for (let s = 1; s < secs; s++) g.fillRect(Math.round((s / secs) * width), 0, 1, height);
    g.fillRect(0, mid, width, 1);
    if (selection && secs) {
      const a = (selection[0] / secs) * width;
      const b = (selection[1] / secs) * width;
      g.fillStyle = dark ? 'rgba(96,165,250,0.22)' : 'rgba(37,99,235,0.14)';
      g.fillRect(a, 0, Math.max(1, b - a), height);
      g.fillStyle = dark ? 'rgba(96,165,250,0.9)' : 'rgba(37,99,235,0.9)';
      g.fillRect(a, 0, 1.5, height);
      g.fillRect(b - 1.5, 0, 1.5, height);
    }
    if (samples?.length) {
      const pk = peaksFor(samples, width);
      let top = 0;
      for (let i = 0; i < pk.length; i++) top = Math.max(top, Math.abs(pk[i]));
      const k = 1 / Math.max(top, 0.05); // quiet takes still fill the view
      const color = tone === 'accent' ? '#e11d48' : tone === 'green' ? '#059669' : css.getPropertyValue('--wave') || (dark ? '#60a5fa' : '#2563eb');
      g.fillStyle = color.trim() || '#2563eb';
      for (let x = 0; x < width; x++) {
        const lo = pk[x * 2] * k;
        const hi = pk[x * 2 + 1] * k;
        const y1 = mid - hi * (mid - 4);
        const y2 = mid - lo * (mid - 4);
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    } else {
      g.fillStyle = dark ? 'rgba(255,255,255,0.35)' : 'rgba(15,23,42,0.35)';
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('No recording yet', width / 2, mid - 8);
    }
    if (marker != null && secs) {
      g.fillStyle = '#f59e0b';
      g.fillRect((marker / secs) * width, 0, 2, height);
    }
    if (playhead != null && secs) {
      g.fillStyle = dark ? '#fbbf24' : '#f59e0b';
      g.fillRect(Math.min(width - 2, (playhead / secs) * width), 0, 2, height);
    }
  }, [samples, selection, playhead, width, height, secs, tone, marker]);

  const at = (e) => {
    const r = canvas.current.getBoundingClientRect();
    return Math.max(0, Math.min(secs, ((e.clientX - r.left) / r.width) * secs));
  };
  const down = (e) => {
    if (!interactive || !secs) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = at(e);
    onSelect?.(null);
  };
  const move = (e) => {
    if (drag.current == null) return;
    const t = at(e);
    const a = Math.min(drag.current, t);
    const b = Math.max(drag.current, t);
    if (b - a > 0.02) onSelect?.([a, b]);
  };
  const up = () => (drag.current = null);

  return (
    <div ref={wrap} className="w-full select-none">
      <canvas
        ref={canvas}
        style={{ width: '100%', height, touchAction: interactive ? 'none' : 'auto' }}
        className={interactive ? 'cursor-crosshair rounded-xl bg-slate-50 dark:bg-white/5' : 'rounded-xl bg-slate-50 dark:bg-white/5'}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label="Waveform — drag to select part of the recording"
      />
    </div>
  );
}
