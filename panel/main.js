/*
 * MY Premiere MCP - panel uvnitr Premiere.
 * 1) Most: HTTP server na 127.0.0.1, ktery predava volani z MCP serveru do ExtendScriptu.
 *    Chranen tokenem (hlavicka X-PMCP-Token) a odmita pozadavky z prohlizece (Origin).
 * 2) AI: spousti Claude Code / Codex CLI s MCP serverem a streamuje prubeh do panelu.
 */
(function () {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  var http = require('http');
  var crypto = require('crypto');
  var cp = require('child_process');

  var extDir = decodeURIComponent(window.location.pathname).replace(/^\/+/, '').replace(/\/[^\/]*$/, '');
  try { extDir = fs.realpathSync(extDir); } catch (e) {}
  var ROOT = path.dirname(extDir);
  var HOST_JSX = path.join(extDir, 'host', 'host.jsx').replace(/\\/g, '/');
  var SERVER_JS = path.join(ROOT, 'server', 'index.js').replace(/\\/g, '/');

  var PORT = 7880;
  try { PORT = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).port || PORT; } catch (e) {}

  var $ = function (id) { return document.getElementById(id); };
  var pocet = 0;
  $('port').textContent = PORT;

  function log(msg) {
    var t = new Date().toTimeString().slice(0, 8);
    var el = $('log');
    el.textContent = (t + '  ' + msg + '\n' + el.textContent).slice(0, 8000);
  }
  function setStav(text, cls) {
    $('stav').textContent = text;
    $('dot').className = 'dot' + (cls ? ' ' + cls : '');
  }

  /* ---------------- token ---------------- */
  var TOKEN_DIR = path.join(process.env.APPDATA || ROOT, 'MYpremiereMCP');
  var TOKEN_FILE = path.join(TOKEN_DIR, 'token.txt');
  var TOKEN;
  try {
    TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    TOKEN = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, TOKEN, 'utf8');
  }

  /* ---------------- stav lokálního Workeru ---------------- */
  var WORKER_PORT = 7881;
  try { WORKER_PORT = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).worker.port || WORKER_PORT; } catch (e) {}
  function pollWorker() {
    // Node http (ne fetch): prohlížeč by poslal hlavičku Origin a Worker by požadavek odmítl
    var req = http.request({ host: '127.0.0.1', port: WORKER_PORT, path: '/jobs', method: 'GET', headers: { 'X-PMCP-Token': TOKEN }, timeout: 2000 }, function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try {
          var jobs = JSON.parse(body);
          var running = jobs.filter(function (j) { return j.status === 'running'; })[0];
          var queued = jobs.filter(function (j) { return j.status === 'queued'; }).length;
          var q = queued ? ' · ve frontě ' + queued : '';
          $('worker').textContent = running
            ? 'Worker: ' + running.type + ' ' + Math.round((running.progress || 0) * 100) + ' % – ' + (running.message || '') + q
            : 'Worker: připraven' + q;
        } catch (e) {
          $('worker').textContent = 'Worker: neznámý stav';
        }
      });
    });
    req.on('error', function () { $('worker').textContent = 'Worker: neběží (spustí se při první úloze)'; });
    req.on('timeout', function () { req.destroy(); });
    req.end();
  }
  setInterval(pollWorker, 3000);
  pollWorker();

  /* ---------------- ExtendScript fronta ---------------- */
  var queue = Promise.resolve();
  function evalQueued(code, timeoutMs) {
    var p = queue.then(function () {
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          resolve({ timeout: true });
        }, timeoutMs || 120000);
        window.__adobe_cep__.evalScript(code, function (raw) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ raw: String(raw) });
        });
      });
    });
    queue = p.catch(function () {});
    return p;
  }
  // JSON nechava U+2028/U+2029 neescapovane, ale v ES3 retezci ExtendScriptu jsou to konce radku
  var LS_RE = new RegExp(String.fromCharCode(0x2028), 'g');
  var PS_RE = new RegExp(String.fromCharCode(0x2029), 'g');
  function jsString(s) { return JSON.stringify(s).replace(LS_RE, '\\u2028').replace(PS_RE, '\\u2029'); }

  function loadHost() {
    return evalQueued('$.evalFile(' + jsString(HOST_JSX) + '); typeof PMCP.call', 20000).then(function (r) {
      log('host.jsx: ' + (r.raw || 'timeout'));
      return r.raw === 'function';
    });
  }

  /* ---------------- HTTP most ---------------- */
  var server = http.createServer(function (req, res) {
    function send(code, obj) {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    }
    var hostOk = /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '');
    if (!hostOk || req.headers.origin) return send(403, { error: 'forbidden' });

    if (req.method === 'GET' && req.url === '/ping') return send(200, { ok: true, app: 'PPRO', panel: '0.1.0' });
    if (req.headers['x-pmcp-token'] !== TOKEN) return send(401, { error: 'bad token' });
    if (req.method !== 'POST') return send(404, { error: 'not found' });

    var body = '';
    req.setEncoding('utf8');
    req.on('data', function (c) {
      body += c;
      if (body.length > 5e6) req.destroy();
    });
    req.on('end', function () {
      var data;
      try { data = JSON.parse(body || '{}'); } catch (e) { return send(400, { error: 'bad json' }); }
      pocet++;
      $('pocet').textContent = pocet;
      var code;
      if (req.url === '/call') {
        code = 'PMCP.call(' + jsString(String(data.fn)) + ',' + jsString(JSON.stringify(data.args || {})) + ')';
      } else if (req.url === '/eval') {
        code = String(data.code || '');
      } else if (req.url === '/reload') {
        return loadHost().then(function (ok) { send(ok ? 200 : 500, { raw: JSON.stringify({ ok: ok, result: { reloaded: ok } }) }); });
      } else {
        return send(404, { error: 'not found' });
      }
      var started = Date.now();
      evalQueued(code, data.timeoutMs || 120000).then(function (r) {
        var label = data.fn || 'eval';
        if (r.timeout) {
          log(label + ' → timeout (modální dialog v Premiere?)');
          return send(504, { error: 'ExtendScript timeout – není v Premiere otevřený dialog?' });
        }
        log(label + ' → ' + (Date.now() - started) + ' ms ' + r.raw.slice(0, 80).replace(/\s+/g, ' '));
        send(200, { raw: r.raw });
      });
    });
  });

  // Node defaultně zabíjí spojení po requestTimeout 300000 ms – dlouhé ExtendScript volání
  // (buildTimeline na stovkách klipů, export) by tím spadla dřív, než evalScript vrátí výsledek.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  server.on('error', function (e) {
    if (e && e.code === 'EADDRINUSE') setStav('port ' + PORT + ' je obsazený', 'err');
    else setStav('chyba serveru', 'err');
    log(String(e));
  });

  loadHost().then(function (ok) {
    if (!ok) log('VAROVÁNÍ: host.jsx se nenačetl');
    server.listen(PORT, '127.0.0.1', function () {
      setStav('most běží · 127.0.0.1:' + PORT, 'on');
      log('panel připraven, kořen ' + ROOT);
    });
  });

  $('reload').addEventListener('click', function (ev) {
    ev.preventDefault();
    loadHost().then(function (ok) { log(ok ? 'host.jsx znovu načten' : 'host.jsx NEnačten'); });
  });

  $('openInstrukce').addEventListener('click', function () {
    cp.exec('start "" "' + path.join(ROOT, 'EXTERNI_AI_INSTRUKCE.md') + '"');
  });
  $('tplExport').addEventListener('click', function () {
    $('prompt').value = 'Exportuj analýzu videa (nástroj export_analysis): ';
    $('prompt').focus();
  });
  $('tplImport').addEventListener('click', function () {
    $('prompt').value = 'Sestříhej podle plánu z jiné AI (nástroj build_from_plan) – soubor s plánem: ___ , zdrojové video: ___';
    $('prompt').focus();
  });

  $('addCaptions').addEventListener('click', function () {
    if (child) { out('Nejdřív počkej, až agent doběhne (nebo klikni Stop).', 'err'); return; }
    var chars = $('ccChars').value;
    var lines = $('ccLines').value;
    $('prompt').value = 'Zavolej nástroj add_captions na aktivní sekvenci s parametry charsPerLine=' + chars +
      ', lines=' + lines + '. Nic jiného nedělej, jen mi řekni výsledek (kolik titulků a jaké je znění).';
    runAgent();
  });

  $('undo').addEventListener('click', function () {
    if (child) { out('Nejdřív počkej, až agent doběhne (nebo klikni Stop).', 'err'); return; }
    // DŮLEŽITÉ: Premiere/QE undo pracuje po jednotlivých vnitřních krocích (např. samostatně
    // nastavení in/out bodu klipu), ne po celých akcích nástrojů. Opakované klikání za sebou
    // prokazatelně nechá projekt v nekonzistentním stavu (klip se "natáhne" na celý zdroj
    // místo aby zmizel) - testováno 2026-09-16. Proto: jen JEDNO použití mezi akcemi, pak
    // se tlačítko zamkne, dokud neproběhne další Spustit (to má vlastní čerstvou historii).
    $('undo').disabled = true;
    evalQueued('PMCP.call(' + jsString('undo') + ',' + jsString('{}') + ')', 20000).then(function (r) {
      if (r.timeout) { out('✖ Zpět: časový limit (modální dialog v Premiere?)', 'err'); return; }
      var ok = false;
      try { ok = JSON.parse(r.raw).ok; } catch (e) {}
      if (!ok) $('undo').disabled = false;
      out(ok
        ? '↶ Vráceno zpět (jeden krok). Zkontroluj výsledek v Premiere - u složitějších akcí to nemusí vrátit celou operaci najednou. Tlačítko je teď zamčené, ať se to omylem nerozbije opakovaným klikáním.'
        : '✖ Zpět se nepodařilo: ' + r.raw.slice(0, 200), ok ? 'dim' : 'err');
    });
  });

  window.addEventListener('beforeunload', function () {
    try { server.close(); } catch (e) {}
    stopAgent();
  });

  /* ---------------- AI agent ---------------- */
  var child = null;
  var sessionId = null;
  var lastAgent = null;
  var outEl = $('out');
  $('nastroje').addEventListener('change', function () {
    outEl.classList.toggle('show-tools', $('nastroje').checked);
  });

  function out(text, cls) {
    var div = document.createElement('div');
    div.className = cls || 'ai';
    div.textContent = text;
    outEl.appendChild(div);
    outEl.scrollTop = outEl.scrollHeight;
  }

  function findExe(name) {
    try {
      var lines = cp.execSync('where.exe ' + name, { encoding: 'utf8', windowsHide: true }).split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) if (/\.exe$/i.test(lines[i].trim())) return lines[i].trim();
      return lines[0].trim() || null;
    } catch (e) {
      return null;
    }
  }

  function stopAgent() {
    if (!child) return;
    try { cp.execSync('taskkill /pid ' + child.pid + ' /T /F', { windowsHide: true }); } catch (e) {}
    child = null;
  }

  function shortInput(obj) {
    var s = JSON.stringify(obj || {});
    return s.length > 180 ? s.slice(0, 180) + '…' : s;
  }

  function handleClaudeEvent(ev) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      sessionId = ev.session_id;
      var mcp = (ev.mcp_servers || []).map(function (m) { return m.name + ':' + m.status; }).join(', ');
      out('● ' + (ev.model || '') + (mcp ? ' · MCP ' + mcp : ''), 'dim');
    } else if (ev.type === 'assistant' && ev.message) {
      (ev.message.content || []).forEach(function (c) {
        if (c.type === 'text' && c.text.trim()) out(c.text.trim(), 'ai');
        else if (c.type === 'tool_use') out('⚙ ' + c.name.replace(/^mcp__premiere__/, '') + ' ' + shortInput(c.input), 'tool');
      });
    } else if (ev.type === 'user' && ev.message && ev.message.content && ev.message.content.forEach) {
      ev.message.content.forEach(function (c) {
        if (c.type === 'tool_result' && c.is_error) {
          var t = typeof c.content === 'string' ? c.content : (c.content || []).map(function (x) { return x.text || ''; }).join(' ');
          out('✖ ' + t.slice(0, 400), 'err');
        }
      });
    } else if (ev.type === 'result') {
      sessionId = ev.session_id || sessionId;
      var info = ((ev.duration_ms || 0) / 1000).toFixed(1) + ' s';
      if (ev.total_cost_usd) info += ' · $' + ev.total_cost_usd.toFixed(3);
      out((ev.is_error ? '✖ chyba' : '✔ hotovo') + ' (' + info + ')', ev.is_error ? 'err' : 'dim');
      if (ev.is_error && /not logged in|\/login/i.test(String(ev.result || ''))) {
        out('Claude CLI není přihlášené. V terminálu spusť: claude auth login  (a pak zadání zopakuj).', 'err');
      }
    }
  }

  function handleCodexEvent(ev) {
    var m = ev.msg || ev;
    var t = m.type || '';
    if (t === 'agent_message' || t === 'agent_message_delta') { if (m.message) out(m.message, 'ai'); }
    else if (/mcp_tool_call/.test(t)) out('⚙ ' + ((m.invocation && m.invocation.tool) || t) + ' ' + shortInput(m.invocation && m.invocation.arguments), 'tool');
    else if (t === 'error') out('✖ ' + (m.message || JSON.stringify(m)), 'err');
    else if (t === 'task_complete') out('✔ hotovo', 'dim');
  }

  function runAgent() {
    var prompt = $('prompt').value.trim();
    if (!prompt || child) return;
    var agent = $('agent').value;
    var exe = findExe(agent);
    if (!exe) {
      out(agent === 'codex'
        ? '✖ Codex CLI nenalezen. Nainstaluj: npm install -g @openai/codex a přihlas se (codex login).'
        : '✖ Claude Code CLI nenalezen v PATH.', 'err');
      return;
    }
    if (lastAgent !== agent) sessionId = null;
    lastAgent = agent;

    var args;
    if (agent === 'claude') {
      args = ['-p', '--output-format', 'stream-json', '--verbose',
        '--mcp-config', path.join(ROOT, 'mcp.json'), '--strict-mcp-config',
        '--allowedTools', 'mcp__premiere'];
      if ($('model').value) args.push('--model', $('model').value);
      if ($('pokracovat').checked && sessionId) args.push('--resume', sessionId);
    } else {
      args = ['exec', '--json', '--skip-git-repo-check',
        '-c', 'mcp_servers.premiere.command="node"',
        '-c', 'mcp_servers.premiere.args=["' + SERVER_JS + '"]',
        '-'];
    }

    out('› ' + prompt, 'me');
    $('run').disabled = true;
    $('undo').disabled = false; // nová akce = čerstvá historie, undo zámek z předchozí akce už neplatí
    $('stop').disabled = false;

    var useShell = /\.(cmd|bat)$/i.test(exe);
    child = cp.spawn(exe, args, { cwd: ROOT, windowsHide: true, shell: useShell, env: process.env });
    child.stdin.end(prompt, 'utf8');

    var buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (d) {
      buf += d;
      var lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(function (line) {
        if (!line.trim()) return;
        try {
          var ev = JSON.parse(line);
          if (agent === 'claude') handleClaudeEvent(ev); else handleCodexEvent(ev);
        } catch (e) {
          out(line, 'dim');
        }
      });
    });
    var errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (d) { errBuf = (errBuf + d).slice(-4000); });
    child.on('error', function (e) { out('✖ ' + e.message, 'err'); });
    child.on('close', function (code) {
      if (code && errBuf.trim()) out('✖ ' + errBuf.trim().slice(-1200), 'err');
      child = null;
      $('run').disabled = false;
      $('stop').disabled = true;
    });
  }

  $('run').addEventListener('click', runAgent);
  $('stop').addEventListener('click', function () { stopAgent(); out('■ zastaveno', 'dim'); });
  $('prompt').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) runAgent();
  });
})();
