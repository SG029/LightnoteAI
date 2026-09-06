import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCcw } from "lucide-react";

interface Props {
  beforeSrc: string;
  afterSrc: string;
}

/** Resync threshold. Below this the two players are indistinguishable. */
const DRIFT_TOLERANCE_SEC = 0.12;

/**
 * Before/after comparison with a draggable divider.
 *
 * Two <video> elements are layered and the top one is clipped, rather than
 * using a single canvas. That keeps native decoding and seeking, and means
 * the original file is never re-encoded just to be displayed.
 *
 * The two players are kept in sync by nominating the "before" video as the
 * clock and correcting the other only when it drifts past a threshold —
 * setting currentTime every frame would cause constant re-seeking and stutter.
 */
export function CompareSlider({ beforeSrc, afterSrc }: Props) {
  const [position, setPosition] = useState(50);
  const [playing, setPlaying] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLVideoElement>(null);
  const afterRef = useRef<HTMLVideoElement>(null);
  const dragging = useRef(false);

  const moveTo = useCallback((clientX: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const pct = ((clientX - bounds.left) / bounds.width) * 100;
    setPosition(Math.min(100, Math.max(0, pct)));
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (dragging.current) moveTo(event.clientX);
    };
    const onUp = () => {
      dragging.current = false;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [moveTo]);

  const toggle = async () => {
    const before = beforeRef.current;
    const after = afterRef.current;
    if (!before || !after) return;

    if (playing) {
      before.pause();
      after.pause();
      setPlaying(false);
      return;
    }

    after.currentTime = before.currentTime;
    // Autoplay can still be refused; keep the button state truthful.
    await Promise.all([before.play(), after.play()]).catch(() => {});
    setPlaying(!before.paused);
  };

  const restart = () => {
    for (const video of [beforeRef.current, afterRef.current]) {
      if (video) video.currentTime = 0;
    }
  };

  const onTimeUpdate = () => {
    const before = beforeRef.current;
    const after = afterRef.current;
    if (!before || !after) return;
    if (Math.abs(after.currentTime - before.currentTime) > DRIFT_TOLERANCE_SEC) {
      after.currentTime = before.currentTime;
    }
  };

  return (
    <div className="space-y-3">
      <div
        ref={containerRef}
        className="relative aspect-video w-full select-none overflow-hidden rounded-xl border border-line bg-black"
      >
        <video
          ref={beforeRef}
          src={beforeSrc}
          className="absolute inset-0 size-full object-contain"
          playsInline
          muted
          loop
          onTimeUpdate={onTimeUpdate}
          onEnded={() => setPlaying(false)}
        />

        <div
          className="absolute inset-0"
          style={{ clipPath: `inset(0 0 0 ${position}%)` }}
        >
          <video
            ref={afterRef}
            src={afterSrc}
            className="absolute inset-0 size-full object-contain"
            playsInline
            muted
            loop
          />
        </div>

        <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-dim backdrop-blur">
          Before
        </span>
        <span className="pointer-events-none absolute right-3 top-3 rounded-md bg-accent/85 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#04222a] backdrop-blur">
          After
        </span>

        {/* Divider */}
        <div
          className="absolute inset-y-0 z-10 w-px cursor-ew-resize bg-white/90"
          style={{ left: `${position}%` }}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
        >
          <div className="absolute left-1/2 top-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-black/60 backdrop-blur">
            <span className="text-[10px] font-bold tracking-tighter text-white">◀▶</span>
          </div>
        </div>

        <input
          type="range"
          min={0}
          max={100}
          value={position}
          onChange={(e) => setPosition(Number(e.target.value))}
          aria-label="Comparison position"
          className="absolute inset-x-0 bottom-0 z-20 h-8 w-full cursor-ew-resize opacity-0"
        />
      </div>

      <div className="flex items-center gap-2">
        <button onClick={toggle} className="btn-ghost flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs">
          {playing ? <Pause size={13} /> : <Play size={13} />}
          {playing ? "Pause" : "Play both"}
        </button>
        <button onClick={restart} className="btn-ghost flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs">
          <RotateCcw size={13} />
          Restart
        </button>
        <span className="ml-auto text-[11px] text-ink-faint">Drag the divider to compare</span>
      </div>
    </div>
  );
}
