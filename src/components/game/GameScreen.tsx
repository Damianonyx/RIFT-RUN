import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ChevronLeft, ChevronRight, Volume2, VolumeX } from "lucide-react";
import { INITIAL_SNAP, type Snapshot } from "@/game/types";

type GameApi = {
  start: () => void;
  toggleMuted: () => void;
  queueLane: (dir: -1 | 1) => void;
  queueJump: () => void;
  dispose: () => void;
};

const enginePromise = import("@/game/engine");

export function GameScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<GameApi | null>(null);
  const pendingStart = useRef(false);
  const [snap, setSnap] = useState<Snapshot>(INITIAL_SNAP);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let game: GameApi | null = null;

    void enginePromise
      .then(({ RunnerGame }) => {
        if (cancelled) return;
        const el = canvasRef.current;
        if (!el) return;
        game = new RunnerGame(el, (next) => {
          setSnap(next);
        });
        if (cancelled) {
          game.dispose();
          return;
        }
        gameRef.current = game;
        setReady(true);
        if (pendingStart.current) {
          pendingStart.current = false;
          game.start();
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "The 3D engine failed to load.";
        setLoadError(msg);
      });

    return () => {
      cancelled = true;
      game?.dispose();
      gameRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const g = gameRef.current;
    if (g) {
      try {
        g.start();
      } catch {
        pendingStart.current = true;
        setStarting(true);
      }
      return;
    }
    pendingStart.current = true;
    setStarting(true);
  }, []);

  const mute = useCallback(() => {
    gameRef.current?.toggleMuted();
  }, []);

  const lane = useCallback((dir: -1 | 1) => {
    gameRef.current?.queueLane(dir);
  }, []);

  const jump = useCallback(() => {
    gameRef.current?.queueJump();
  }, []);

  const retry = useCallback(() => {
    window.location.reload();
  }, []);

  const playing = snap.state === "playing";
  const overlay = snap.state !== "playing";

  return (
    <div className="relative h-[100dvh] min-h-[100svh] w-full overflow-hidden bg-bg text-fg antialiased select-none">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full touch-none"
      />

      {!snap.webgl && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg p-6 text-center">
          <div className="max-w-sm">
            <p className="text-fg">This browser blocked WebGL, so the run cannot start.</p>
            <p className="mt-2 text-sm text-muted">Try Safari or Chrome, or close other tabs and reload.</p>
            <button
              type="button"
              data-ui
              onPointerDown={(e) => {
                e.preventDefault();
                retry();
              }}
              onClick={retry}
              className="mt-5 h-12 w-full rounded-lg bg-accent px-5 text-sm font-medium tracking-wide text-accent-fg"
              style={{ touchAction: "manipulation" }}
            >
              Reload
            </button>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
        <header className="flex items-start justify-between gap-3 p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:p-5">
          <div className={playing || snap.state === "over" ? "opacity-100" : "opacity-0"}>
            <p className="text-[0.6875rem] font-medium tracking-[0.22em] text-muted uppercase">Score</p>
            <p className="font-display text-3xl leading-none font-semibold tracking-tight tabular-nums sm:text-4xl">
              {snap.score}
            </p>
            {snap.combo > 1 && playing && (
              <p className="mt-1 text-xs tracking-wide text-ice tabular-nums">x{snap.combo} streak</p>
            )}
          </div>
          <div className="flex items-start gap-3">
            <div className="text-right">
              <p className="text-[0.6875rem] font-medium tracking-[0.22em] text-muted uppercase">Best</p>
              <p className="font-display text-xl leading-none font-medium tracking-tight text-fg/90 tabular-nums">
                {snap.best}
              </p>
            </div>
            <PressBtn
              label={snap.muted ? "Unmute" : "Mute"}
              onPress={mute}
              className="size-11 rounded-lg border border-border bg-surface text-fg hover:bg-surface-2"
            >
              {snap.muted ? <VolumeX className="size-5" strokeWidth={1.75} /> : <Volume2 className="size-5" strokeWidth={1.75} />}
            </PressBtn>
          </div>
        </header>

        {overlay && (
          <div className="flex flex-1 items-center justify-center px-4 pb-8">
            <div
              data-ui
              className="pointer-events-auto w-full max-w-md rounded-2xl border border-border bg-surface/92 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.45)] sm:p-7"
              style={{ touchAction: "manipulation" }}
            >
              {snap.state === "start" ? (
                <StartPanel
                  best={snap.best}
                  onStart={start}
                  onRetry={retry}
                  starting={starting && !ready}
                  loadError={loadError}
                />
              ) : (
                <OverPanel score={snap.score} best={snap.best} onStart={start} />
              )}
            </div>
          </div>
        )}

        {playing && (
          <div className="mt-auto flex items-end justify-between gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:hidden">
            <TouchBtn label="Lane left" onPress={() => lane(-1)}>
              <ChevronLeft className="size-7" strokeWidth={1.75} />
            </TouchBtn>
            <TouchBtn label="Jump" wide onPress={jump}>
              <ArrowUp className="size-7" strokeWidth={1.75} />
              <span className="text-[0.6875rem] font-medium tracking-[0.18em] uppercase">Jump</span>
            </TouchBtn>
            <TouchBtn label="Lane right" onPress={() => lane(1)}>
              <ChevronRight className="size-7" strokeWidth={1.75} />
            </TouchBtn>
          </div>
        )}
      </div>
    </div>
  );
}

function StartPanel({
  best,
  onStart,
  onRetry,
  starting,
  loadError,
}: {
  best: number;
  onStart: () => void;
  onRetry: () => void;
  starting: boolean;
  loadError: string | null;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-[0.6875rem] font-medium tracking-[0.28em] text-muted uppercase">Endless runner</p>
        <h1 className="font-display text-5xl leading-[0.95] font-semibold tracking-tight text-balance sm:text-6xl">
          Rift Run
        </h1>
        <p className="max-w-sm text-pretty text-muted">
          Three lanes of fractured stone. Switch, jump, and gather rift light before the walls close in.
        </p>
      </div>
      {loadError ? (
        <>
          <p className="text-sm text-danger">{loadError}</p>
          <PressBtn
            label="Reload"
            onPress={onRetry}
            className="h-12 w-full rounded-lg bg-accent text-sm font-medium tracking-wide text-accent-fg"
          >
            Reload
          </PressBtn>
        </>
      ) : (
        <PressBtn
          label="Start run"
          onPress={onStart}
          className="h-12 w-full rounded-lg bg-accent text-sm font-medium tracking-wide text-accent-fg"
        >
          {starting ? "Starting…" : "Start run"}
        </PressBtn>
      )}
      <ul className="space-y-1.5 text-sm text-faint">
        <li>
          <span className="text-fg/80">A / D</span> or arrows — change lane
        </li>
        <li>
          <span className="text-fg/80">Space</span> — jump crates
        </li>
        <li className="md:hidden">Tap Start, then swipe left, right, or up</li>
      </ul>
      {best > 0 && (
        <p className="text-xs tracking-wide text-muted uppercase">
          Best <span className="text-fg tabular-nums">{best}</span>
        </p>
      )}
    </div>
  );
}

function OverPanel({ score, best, onStart }: { score: number; best: number; onStart: () => void }) {
  const isBest = score > 0 && score >= best;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-[0.6875rem] font-medium tracking-[0.28em] text-muted uppercase">Run over</p>
        <h2 className="font-display text-4xl leading-none font-semibold tracking-tight">Rift Run</h2>
      </div>
      <div className="flex gap-6">
        <Stat label="Score" value={score} />
        <Stat label={isBest ? "New best" : "Best"} value={best} />
      </div>
      <PressBtn
        label="Run again"
        onPress={onStart}
        className="h-12 w-full rounded-lg bg-accent text-sm font-medium tracking-wide text-accent-fg"
      >
        Run again
      </PressBtn>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[0.6875rem] font-medium tracking-[0.22em] text-muted uppercase">{label}</p>
      <p className="font-display text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
    </div>
  );
}

function PressBtn({
  label,
  onPress,
  className,
  children,
}: {
  label: string;
  onPress: () => void;
  className: string;
  children: ReactNode;
}) {
  const last = useRef(0);
  const fire = () => {
    const now = performance.now();
    if (now - last.current < 350) return;
    last.current = now;
    onPress();
  };
  return (
    <button
      type="button"
      data-ui
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        fire();
      }}
      onPointerUp={(e) => {
        if (e.pointerType === "mouse") return;
        e.stopPropagation();
        fire();
      }}
      className={
        "pointer-events-auto flex items-center justify-center transition-transform duration-150 hover:opacity-90 active:scale-[0.98] " +
        className
      }
      style={{ touchAction: "manipulation" }}
    >
      {children}
    </button>
  );
}

function TouchBtn({
  label,
  onPress,
  children,
  wide,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      data-ui
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      className={
        "pointer-events-auto flex h-16 items-center justify-center gap-1 rounded-xl border border-border bg-surface/90 text-fg " +
        (wide ? "min-w-28 flex-1 flex-col" : "w-16")
      }
      style={{ touchAction: "manipulation" }}
    >
      {children}
    </button>
  );
}
