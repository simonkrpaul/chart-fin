/**
 * ScriptsPanel – run the data-sync Python scripts on the dev machine and
 * stream their output. Backed by the dev-server plugin in vite/scriptRunner.ts.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { refreshManifest } from '../db/marketDb';

interface ScriptInfo {
  id: string;
  label: string;
  description: string;
  longRunning: boolean;
  params: { name: string; label: string; default: string }[];
  link: { label: string; url: string } | null;
  running: boolean;
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

const API = '/api/scripts';
const HEADERS = { 'Content-Type': 'application/json', 'X-ChartFin-Runner': '1' };
const LS_PARAMS = 'chartfin.scripts.params';

function loadSavedParams(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(localStorage.getItem(LS_PARAMS) ?? '{}');
  } catch {
    return {};
  }
}

export const ScriptsPanel: React.FC = () => {
  const { theme } = useChartStore();
  const isDark = theme === 'dark';
  const bg = isDark ? '#1e222d' : '#f0f3fa';
  const text = isDark ? '#d1d4dc' : '#131722';
  const border = isDark ? '#2a2e39' : '#e0e3eb';
  const muted = isDark ? '#787b86' : '#6a6d78';

  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [params, setParams] = useState(loadSavedParams);
  const logRef = useRef<HTMLPreElement>(null);
  const prevRunning = useRef<Record<string, boolean>>({});

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(API);
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      const list: ScriptInfo[] = await res.json();
      for (const s of list) {
        if (prevRunning.current[s.id] && !s.running && s.exitCode === 0 && !s.longRunning) refreshManifest();
        prevRunning.current[s.id] = s.running;
      }
      setScripts(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Script runner unavailable (start the app with pnpm dev)');
    }
  }, []);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, 2000);
    return () => clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    if (!selected) return;
    setLines([]);
    const es = new EventSource(`${API}/${selected}/stream`);
    es.addEventListener('snapshot', e => setLines(JSON.parse((e as MessageEvent).data).lines));
    es.addEventListener('log', e => {
      const line: string = JSON.parse((e as MessageEvent).data);
      setLines(prev => (prev.length >= 2000 ? [...prev.slice(-1999), line] : [...prev, line]));
    });
    es.addEventListener('status', () => loadList());
    return () => es.close();
  }, [selected, loadList]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const paramValue = (s: ScriptInfo, name: string, def: string) => params[s.id]?.[name] ?? def;

  const setParam = (id: string, name: string, value: string) => {
    setParams(prev => {
      const next = { ...prev, [id]: { ...prev[id], [name]: value } };
      localStorage.setItem(LS_PARAMS, JSON.stringify(next));
      return next;
    });
  };

  const run = async (s: ScriptInfo) => {
    setSelected(s.id);
    const body = Object.fromEntries(s.params.map(p => [p.name, paramValue(s, p.name, p.default)]));
    const res = await fetch(`${API}/${s.id}/run`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    if (!res.ok) setError((await res.json()).error ?? `HTTP ${res.status}`);
    loadList();
  };

  const stop = async (s: ScriptInfo) => {
    await fetch(`${API}/${s.id}/stop`, { method: 'POST', headers: HEADERS });
    loadList();
  };

  const btn: React.CSSProperties = {
    padding: '3px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
    border: `1px solid ${border}`, background: isDark ? '#2a2e39' : '#fff', color: text,
  };

  const statusText = (s: ScriptInfo) => {
    if (s.running) return s.longRunning ? '● running' : '● running…';
    if (s.exitCode === null) return '';
    return s.exitCode === 0 ? '✓ done' : `✗ exit ${s.exitCode}`;
  };
  const statusColor = (s: ScriptInfo) =>
    s.running ? '#2962ff' : s.exitCode === 0 ? '#26a69a' : '#ef5350';

  return (
    <div style={{ background: bg, color: text, padding: 10, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8, height: '100%', boxSizing: 'border-box' }}>
      {error && <div style={{ color: '#ef5350', fontSize: 11 }}>{error}</div>}

      {scripts.map(s => (
        <div
          key={s.id}
          onClick={() => setSelected(s.id)}
          style={{
            border: `1px solid ${selected === s.id ? '#2962ff' : border}`,
            borderRadius: 4, padding: 8, cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600 }}>{s.label}</span>
            <span style={{ fontSize: 10, color: statusColor(s) }}>{statusText(s)}</span>
          </div>
          <div style={{ fontSize: 10, color: muted, margin: '4px 0' }}>{s.description}</div>
          {s.link && (
            <a href={s.link.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: '#2962ff' }}>
              {s.link.label} ↗
            </a>
          )}
          {s.params.map(p => (
            <label key={p.name} style={{ display: 'block', fontSize: 10, color: muted, marginTop: 4 }}>
              {p.label}
              <input
                value={paramValue(s, p.name, p.default)}
                onChange={e => setParam(s.id, p.name, e.target.value)}
                onClick={e => e.stopPropagation()}
                style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, padding: '2px 4px', marginTop: 2, background: isDark ? '#131722' : '#fff', color: text, border: `1px solid ${border}` }}
              />
            </label>
          ))}
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            {s.running ? (
              <button style={btn} onClick={e => { e.stopPropagation(); stop(s); }}>Stop</button>
            ) : (
              <button style={btn} onClick={e => { e.stopPropagation(); run(s); }}>{s.longRunning ? 'Start' : 'Run'}</button>
            )}
          </div>
        </div>
      ))}

      {selected && (
        <pre
          ref={logRef}
          style={{
            flex: 1, minHeight: 160, margin: 0, padding: 6, overflow: 'auto', fontSize: 10, lineHeight: 1.35,
            background: isDark ? '#131722' : '#fff', border: `1px solid ${border}`, borderRadius: 4,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}
        >
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
};
