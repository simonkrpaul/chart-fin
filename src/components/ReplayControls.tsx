/**
 * ReplayControls – floating bar replay control bar (TradingView-style).
 *
 * Appears at the bottom-centre of the chart when replay is active.
 * The timer lives here; it calls tickReplay() at the configured speed.
 *
 * Usage:
 *   1. Click "▶ Replay" in the toolbar.
 *   2. Click any candle on the chart – replay starts from that bar.
 *   3. Use the controls below to play/pause/step/change speed/exit.
 */
import React, { useEffect } from 'react';
import { useChartStore } from '../store/chartStore';

const SPEEDS = [
  { label: '½×',  value: 0.5 },
  { label: '1×',  value: 1   },
  { label: '2×',  value: 2   },
  { label: '5×',  value: 5   },
  { label: '10×', value: 10  },
  { label: '30×', value: 30  },
];

// ── Module-level sub-components (must NOT be defined inside the render fn) ──
// Defining components inside another component causes React to unmount/remount
// them on every re-render, which breaks click events during rapid ticking.

interface BtnProps {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
  text: string;
  border: string;
  accent: string;
  hover: string;
}

const ReplayBtn: React.FC<BtnProps> = ({
  title, onClick, disabled, active = false, danger = false,
  children, text, border, accent, hover,
}) => {
  const base: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: 30, minWidth: 32, padding: '0 8px',
    background: active ? accent : 'transparent',
    color: danger ? '#ef5350' : active ? '#fff' : text,
    border: `1px solid ${danger ? '#ef5350' : active ? accent : border}`,
    borderRadius: 4, cursor: 'pointer', fontSize: 13,
    transition: 'background 0.1s',
    userSelect: 'none' as const,
    opacity: disabled ? 0.35 : 1,
  };
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={base}
      onMouseEnter={e => { if (!disabled && !active) (e.currentTarget as HTMLButtonElement).style.background = hover; }}
      onMouseLeave={e => { if (!disabled && !active) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
};

const ReplaySep: React.FC<{ border: string }> = ({ border }) => (
  <div style={{ width: 1, height: 20, background: border, flexShrink: 0 }} />
);

// ─────────────────────────────────────────────────────────────────────────────

export const ReplayControls: React.FC = () => {
  const {
    replay,
    primarySlots,
    stopReplay,
    setReplayPlaying,
    stepReplay,
    setReplaySpeed,
    tickReplay,
    theme,
  } = useChartStore();

  // ── Timer ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!replay.active || !replay.playing) return;
    const ms = Math.max(16, Math.round(1000 / replay.speed)); // ≥ 1 frame
    const id = setInterval(() => tickReplay(), ms);
    return () => clearInterval(id);
  }, [replay.active, replay.playing, replay.speed, tickReplay]);

  if (!replay.active) return null;

  // ── Theme tokens ─────────────────────────────────────────────────────────
  const bg     = theme === 'dark' ? 'rgba(19,23,34,0.97)' : 'rgba(255,255,255,0.97)';
  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#d0d3db';
  const accent = '#2962ff';
  const hover  = theme === 'dark' ? '#2a2e39' : '#e8eaf0';

  const isAtStart = replay.index <= replay.startIndex;
  const isAtEnd   = replay.index >= primarySlots.length - 1;

  // Current bar date label
  const slot    = primarySlots[replay.index];
  const dateStr = slot
    ? new Date(slot.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  const btnProps = { text, border, accent, hover };

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 38,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: '4px 8px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
        zIndex: 20,
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {/* Back to replay start */}
      <ReplayBtn {...btnProps} title="Back to replay start" onClick={() => stepReplay(-(replay.index - replay.startIndex))} disabled={isAtStart}>
        ⏮
      </ReplayBtn>

      {/* Step back 1 bar */}
      <ReplayBtn {...btnProps} title="Step back 1 bar (← arrow)" onClick={() => stepReplay(-1)} disabled={isAtStart}>
        ◀
      </ReplayBtn>

      {/* Play / Pause */}
      <ReplayBtn {...btnProps} title={replay.playing ? 'Pause' : 'Play'} onClick={() => setReplayPlaying(!replay.playing)} disabled={isAtEnd} active={replay.playing}>
        <span style={{ fontSize: 15 }}>{replay.playing ? '⏸' : '▶'}</span>
      </ReplayBtn>

      {/* Step forward 1 bar */}
      <ReplayBtn {...btnProps} title="Step forward 1 bar (→ arrow)" onClick={() => stepReplay(1)} disabled={isAtEnd}>
        ▶
      </ReplayBtn>

      <ReplaySep border={border} />

      {/* Speed selector */}
      <span style={{ fontSize: 10, color: text, opacity: 0.55, marginRight: 2 }}>Speed</span>
      {SPEEDS.map(s => (
        <ReplayBtn key={s.value} {...btnProps} title={`${s.value} bars/sec`} onClick={() => setReplaySpeed(s.value)} active={replay.speed === s.value}>
          <span style={{ fontSize: 10 }}>{s.label}</span>
        </ReplayBtn>
      ))}

      <ReplaySep border={border} />

      {/* Current date indicator */}
      <span style={{ fontSize: 11, color: text, minWidth: 96, textAlign: 'center', opacity: 0.85 }}>
        {dateStr}
      </span>

      {/* Progress indicator */}
      <span style={{ fontSize: 10, opacity: 0.4, color: text }}>
        {replay.index - replay.startIndex + 1}&nbsp;bars
      </span>

      <ReplaySep border={border} />

      {/* Exit replay */}
      <ReplayBtn {...btnProps} title="Exit replay mode" onClick={stopReplay} danger>
        <span style={{ fontSize: 11 }}>✕ Exit</span>
      </ReplayBtn>
    </div>
  );
};
