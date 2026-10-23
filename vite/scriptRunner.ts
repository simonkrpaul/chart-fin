import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Logger, Plugin } from 'vite';

interface ParamDef {
  name: string;
  label: string;
  default: string;
}

interface ScriptDef {
  id: string;
  label: string;
  description: string;
  file: string;
  longRunning?: boolean;
  params?: ParamDef[];
  link?: { label: string; url: string };
  /** Builds argv after the script path; throws on invalid input. */
  buildArgs: (params: Record<string, string>, repoRoot: string) => string[];
}

const SCRIPTS: ScriptDef[] = [
  {
    id: 'ephemeris',
    label: 'Ephemeris server',
    description: 'Flask server on 127.0.0.1:5050 used by the Ephemeris panel.',
    file: 'ephemeris_server.py',
    longRunning: true,
    buildArgs: () => [],
  },
  {
    id: 'bybit',
    label: 'BTC latest (Bybit)',
    description: 'python scripts/bybit_sync.py — syncs the gap since the last run.',
    file: 'bybit_sync.py',
    buildArgs: () => [],
  },
  {
    id: 'mt5',
    label: 'Gold latest (MT5)',
    description: 'python scripts/mt5_sync.py --tf 5m 15m 1h 4h 1d 1w 1M (Windows + running MT5 terminal).',
    file: 'mt5_sync.py',
    buildArgs: () => ['--tf', '5m', '15m', '1h', '4h', '1d', '1w', '1M'],
  },
  {
    id: 'sp500',
    label: 'S&P 500 daily (Kaggle)',
    description: 'python scripts/import_kaggle_sp500.py --mode append --input <csv>. Download the CSV from Kaggle first.',
    file: 'import_kaggle_sp500.py',
    params: [{ name: 'input', label: 'Input CSV (repo-relative)', default: 'public/sp500/sp500_stocks.csv' }],
    link: {
      label: 'Kaggle dataset',
      url: 'https://www.kaggle.com/datasets/darkmatternet/s-and-p-500-stocks-25-years-of-data-updated-daily',
    },
    buildArgs: (params, repoRoot) => {
      const rel = (params.input ?? '').trim();
      const abs = path.resolve(repoRoot, rel);
      if (!rel || !abs.startsWith(repoRoot + path.sep)) throw new Error('Input must be a path inside the repo');
      if (path.extname(abs).toLowerCase() !== '.csv') throw new Error('Input must be a .csv file');
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${rel}`);
      return ['--mode', 'append', '--input', abs];
    },
  },
];

const MAX_LINES = 2000;

interface RunState {
  proc: ChildProcess | null;
  running: boolean;
  exitCode: number | null;
  startedAt: number | null;
  endedAt: number | null;
  lines: string[];
  clients: Set<ServerResponse>;
}

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// LAN (RFC 1918), Tailscale (100.64/10) and IPv6 ULA / link-local only — never the public internet.
function isPrivateAddr(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  if (LOOPBACK_ADDRS.has(addr) || a === '127.0.0.1') return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const [x, y] = [Number(m[1]), Number(m[2])];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
  }
  return /^f[cd]/i.test(a) || /^fe[89ab]/i.test(a);
}

function tokenMatches(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Access = 'ok' | 'forbidden' | 'need-token';

// Same-origin only so other sites open in the browser can't trigger runs.
// localhost needs nothing extra; any other device on the LAN/tailnet must send the token.
function checkAccess(req: IncomingMessage, token: string): Access {
  const addr = req.socket.remoteAddress ?? '';
  if (!isPrivateAddr(addr)) return 'forbidden';
  const host = req.headers.host ?? '';
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== host) return 'forbidden';
    } catch {
      return 'forbidden';
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'forbidden';

  const isLocal = LOOPBACK_ADDRS.has(addr)
    && LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ''))
    && !req.headers['x-forwarded-for'];
  if (isLocal) return 'ok';
  return tokenMatches(req.headers['x-chartfin-token'], token) ? 'ok' : 'need-token';
}

function loadToken(repoRoot: string): string {
  const fromEnv = process.env.CHARTFIN_RUNNER_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = path.join(repoRoot, '.chartfin', 'runner-token');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 16) return saved;
  } catch { /* first run */ }
  const token = randomBytes(12).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  }
}

export function scriptRunner(): Plugin {
  const states = new Map<string, RunState>();
  for (const s of SCRIPTS) {
    states.set(s.id, {
      proc: null, running: false, exitCode: null, startedAt: null, endedAt: null, lines: [], clients: new Set(),
    });
  }

  const broadcast = (st: RunState, event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of st.clients) c.write(msg);
  };

  const pushLine = (st: RunState, line: string) => {
    st.lines.push(line);
    if (st.lines.length > MAX_LINES) st.lines.splice(0, st.lines.length - MAX_LINES);
    broadcast(st, 'log', line);
  };

  const statusOf = (st: RunState) => ({
    running: st.running, exitCode: st.exitCode, startedAt: st.startedAt, endedAt: st.endedAt,
  });

  return {
    name: 'chartfin-script-runner',
    configureServer(server) {
      install(server.config.root, server.middlewares, server.httpServer, server.config.logger);
    },
    configurePreviewServer(server) {
      install(server.config.root, server.middlewares, server.httpServer, server.config.logger);
    },
  };

  function install(root: string, middlewares: Connect.Server, httpServer: NodeJS.EventEmitter | null, logger: Logger) {
      const repoRoot = path.resolve(root);
      const python = process.env.CHARTFIN_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
      const token = loadToken(repoRoot);
      httpServer?.once('listening', () => {
        logger.info(`  ➜  Script runner token (for phone / other devices): ${token}`);
      });

      const start = (def: ScriptDef, st: RunState, args: string[]) => {
        st.lines = [];
        st.running = true;
        st.exitCode = null;
        st.startedAt = Date.now();
        st.endedAt = null;
        pushLine(st, `$ ${python} scripts/${def.file} ${args.join(' ')}`.trimEnd());
        broadcast(st, 'status', statusOf(st));

        const proc = spawn(python, ['-u', path.join(repoRoot, 'scripts', def.file), ...args], {
          cwd: repoRoot,
          env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
        st.proc = proc;

        const attach = (stream: NodeJS.ReadableStream | null) => {
          if (!stream) return;
          let partial = '';
          stream.on('data', (chunk: Buffer) => {
            const parts = (partial + chunk.toString('utf8')).split(/\r\n|\n|\r/);
            partial = parts.pop() ?? '';
            for (const p of parts) pushLine(st, p);
          });
          stream.on('end', () => {
            if (partial) pushLine(st, partial);
            partial = '';
          });
        };
        attach(proc.stdout);
        attach(proc.stderr);

        const finish = (code: number | null) => {
          if (!st.running) return;
          st.running = false;
          st.proc = null;
          st.exitCode = code;
          st.endedAt = Date.now();
          pushLine(st, `[exit ${code ?? 'killed'}]`);
          broadcast(st, 'status', statusOf(st));
        };
        proc.on('error', err => {
          pushLine(st, `[error] ${err.message}`);
          finish(-1);
        });
        proc.on('close', code => finish(code));
      };

      const killAll = () => {
        for (const st of states.values()) if (st.proc) killTree(st.proc);
      };
      httpServer?.on('close', killAll);
      process.on('exit', killAll);

      middlewares.use('/api/scripts', async (req: IncomingMessage, res: ServerResponse) => {
        const access = checkAccess(req, token);
        if (access === 'forbidden') {
          sendJson(res, 403, { error: 'Script runner is only available on your local network' });
          return;
        }
        if (access === 'need-token') {
          sendJson(res, 401, { error: 'Enter the script runner token shown in the desktop terminal', needToken: true });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const [id, action] = url.pathname.split('/').filter(Boolean);

        if (!id) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
          sendJson(res, 200, SCRIPTS.map(s => ({
            id: s.id,
            label: s.label,
            description: s.description,
            longRunning: !!s.longRunning,
            params: s.params ?? [],
            link: s.link ?? null,
            ...statusOf(states.get(s.id)!),
          })));
          return;
        }

        const def = SCRIPTS.find(s => s.id === id);
        const st = states.get(id);
        if (!def || !st) { sendJson(res, 404, { error: 'Unknown script' }); return; }

        if (action === 'stream' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`event: snapshot\ndata: ${JSON.stringify({ lines: st.lines, ...statusOf(st) })}\n\n`);
          st.clients.add(res);
          req.on('close', () => st.clients.delete(res));
          return;
        }

        if (req.method !== 'POST' || req.headers['x-chartfin-runner'] !== '1') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }

        if (action === 'run') {
          if (st.running) { sendJson(res, 409, { error: 'Already running' }); return; }
          let args: string[];
          try {
            const raw = await readBody(req);
            const parsed: unknown = raw ? JSON.parse(raw) : {};
            const params: Record<string, string> = {};
            if (parsed && typeof parsed === 'object') {
              for (const p of def.params ?? []) {
                const v = (parsed as Record<string, unknown>)[p.name];
                if (typeof v === 'string') params[p.name] = v;
              }
            }
            args = def.buildArgs(params, repoRoot);
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
            return;
          }
          start(def, st, args);
          sendJson(res, 202, statusOf(st));
          return;
        }

        if (action === 'stop') {
          if (st.proc) killTree(st.proc);
          sendJson(res, 202, statusOf(st));
          return;
        }

        sendJson(res, 404, { error: 'Unknown action' });
      });
  }
}
