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
  var os = require('os');

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
          $('workerText').textContent = running
            ? 'Worker: ' + running.type + ' ' + Math.round((running.progress || 0) * 100) + ' % – ' + (running.message || '') + q
            : 'Worker: připraven' + q;
          $('workerPulse').classList.toggle('on', !!running);
        } catch (e) {
          $('workerText').textContent = 'Worker: neznámý stav';
          $('workerPulse').classList.remove('on');
        }
      });
    });
    req.on('error', function () { $('workerText').textContent = 'Worker: neběží (spustí se při první úloze)'; $('workerPulse').classList.remove('on'); });
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

  // Poslední vybraný model si pamatuje zvlášť pro každého agenta, ať uživatel o volbu
  // nepřijde při přepnutí Claude <-> Codex a zpátky. Dokud si uživatel u Claude sám nic
  // nevybere, výchozí je Haiku 4.5 - ve srovnávacím testu (HANDOFF 5v) vyšel jako nejrychlejší
  // a nejlevnější, s přesností srovnatelnou nebo lepší než Opus.
  var lastModelByAgent = { claude: 'haiku', codex: '' };
  try {
    var savedClaude = localStorage.getItem('pmcp.model.claude');
    if (savedClaude !== null) lastModelByAgent.claude = savedClaude;
  } catch (e) {}
  try {
    var savedCodex = localStorage.getItem('pmcp.model.codex');
    if (savedCodex !== null) lastModelByAgent.codex = savedCodex;
  } catch (e) {}

  function updateModelOptions() {
    var agent = $('agent').value;
    var opts = $('model').options;
    for (var i = 0; i < opts.length; i++) {
      var forAgent = opts[i].getAttribute('data-agent');
      opts[i].hidden = !!forAgent && forAgent !== agent;
    }
    var remembered = lastModelByAgent[agent] || '';
    var hasOption = remembered && Array.prototype.some.call(opts, function (o) { return o.value === remembered && !o.hidden; });
    $('model').value = hasOption ? remembered : '';
  }
  $('agent').addEventListener('change', updateModelOptions);
  $('model').addEventListener('change', function () {
    var agent = $('agent').value;
    lastModelByAgent[agent] = $('model').value;
    try { localStorage.setItem('pmcp.model.' + agent, $('model').value); } catch (e) {}
  });
  updateModelOptions();

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
    } catch (e) {}

    // Premiere/CEP inherits PATH when Premiere starts, so it may not see a Codex
    // installed or updated by the desktop app later. Look in Codex's local app
    // directory as a fallback; each app build keeps the CLI in its own folder.
    if (name === 'codex') {
      var codexBin = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
      try {
        var builds = fs.readdirSync(codexBin).map(function (entry) {
          var exe = path.join(codexBin, entry, 'codex.exe');
          return fs.existsSync(exe) ? { exe: exe, mtime: fs.statSync(exe).mtimeMs } : null;
        }).filter(Boolean).sort(function (a, b) { return b.mtime - a.mtime; });
        if (builds.length) return builds[0].exe;
      } catch (e) {}

      var npmShim = path.join(process.env.APPDATA || '', 'npm', 'codex.cmd');
      if (fs.existsSync(npmShim)) return npmShim;
    }
    return null;
  }

  function setAiIcon(agentOrNull) {
    $('aiClaude').classList.toggle('on', agentOrNull === 'claude');
    $('aiGpt').classList.toggle('on', agentOrNull === 'codex');
  }

  /* ---------------- diktování (mikrofon -> lokální Whisper) ---------------- */
  var micStream = null;
  var mediaRecorder = null;

  function submitTranscribeJob(filePath) {
    return new Promise(function (resolve, reject) {
      var payload = JSON.stringify({ type: 'transcribe', params: { path: filePath, language: 'cs' } });
      var req = http.request(
        { host: '127.0.0.1', port: WORKER_PORT, path: '/jobs', method: 'POST', timeout: 5000,
          headers: { 'X-PMCP-Token': TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        function (res) {
          var body = '';
          res.setEncoding('utf8');
          res.on('data', function (c) { body += c; });
          res.on('end', function () {
            try { resolve(JSON.parse(body).id); } catch (e) { reject(e); }
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  function pollTranscribeJob(id, startedAt) {
    startedAt = startedAt || Date.now();
    return new Promise(function (resolve, reject) {
      if (Date.now() - startedAt > 90000) { reject(new Error('časový limit přepisu')); return; }
      var req = http.request(
        { host: '127.0.0.1', port: WORKER_PORT, path: '/jobs/' + id, method: 'GET', timeout: 3000, headers: { 'X-PMCP-Token': TOKEN } },
        function (res) {
          var body = '';
          res.setEncoding('utf8');
          res.on('data', function (c) { body += c; });
          res.on('end', function () {
            try {
              var job = JSON.parse(body);
              if (job.status === 'done') {
                var data = JSON.parse(fs.readFileSync(job.result.file, 'utf8'));
                resolve((data.segments || []).map(function (s) { return s.text; }).join(' ').trim());
              } else if (job.status === 'error') {
                reject(new Error(job.error || 'chyba přepisu'));
              } else {
                setTimeout(function () { pollTranscribeJob(id, startedAt).then(resolve, reject); }, 600);
              }
            } catch (e) { reject(e); }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  function startDictation() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      out('✖ Mikrofon není v tomhle panelu dostupný.', 'err');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      micStream = stream;
      var chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = function () {
        micStream.getTracks().forEach(function (t) { t.stop(); });
        micStream = null;
        $('mic').classList.remove('recording');
        if (!chunks.length) { out('🎤 žádná nahrávka.', 'dim'); return; }
        $('mic').disabled = true;
        out('🎤 přepisuji nahrávku (lokálně)…', 'dim');
        var blob = new Blob(chunks, { type: 'audio/webm' });
        blob.arrayBuffer().then(function (buf) {
          var tmpPath = path.join(os.tmpdir(), 'pmcp-dikt-' + Date.now() + '.webm');
          fs.writeFileSync(tmpPath, Buffer.from(buf));
          return submitTranscribeJob(tmpPath).then(function (jobId) {
            return pollTranscribeJob(jobId);
          }).finally(function () {
            try { fs.unlinkSync(tmpPath); } catch (e) {}
          });
        }).then(function (text) {
          if (!text) { out('🎤 nerozpoznal jsem žádný text.', 'err'); return; }
          var cur = $('prompt').value;
          $('prompt').value = cur.trim() ? cur.trim() + ' ' + text : text;
          $('prompt').focus();
          out('🎤 „' + text + '“', 'dim');
        }).catch(function (e) {
          out('✖ Diktování selhalo: ' + e.message, 'err');
        }).finally(function () {
          $('mic').disabled = false;
        });
      };
      mediaRecorder.start();
      $('mic').classList.add('recording');
      out('🎤 nahrávám… (klikni znovu pro ukončení)', 'dim');
    }).catch(function (e) {
      out('✖ Mikrofon nedostupný: ' + e.message, 'err');
    });
  }

  $('mic').addEventListener('click', function () {
    if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
    startDictation();
  });

  function stopAgent() {
    if (!child) return;
    try { cp.execSync('taskkill /pid ' + child.pid + ' /T /F', { windowsHide: true }); } catch (e) {}
    child = null;
    setAiIcon(null);
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
    if (t === 'thread.started') {
      sessionId = m.thread_id || sessionId;
    } else if (t === 'agent_message' || t === 'agent_message_delta') {
      if (m.message) out(m.message, 'ai');
    } else if (t === 'item.completed') {
      var item = m.item || {};
      if (item.type === 'agent_message' && item.text) out(item.text, 'ai');
      else if (item.type === 'mcp_tool_call') {
        out('⚙ ' + (item.tool || item.name || 'MCP') + ' ' + shortInput(item.arguments), 'tool');
        if (item.error) out('✖ ' + String(item.error), 'err');
      } else if (item.type === 'error') {
        // "Model metadata for X not found" je jen neškodné upozornění Codexu (chybí v jeho
        // lokální katalogu metadat, běh pokračuje normálně dál) - nezobrazovat jako chybu.
        var msg = item.message || JSON.stringify(item);
        var benign = /model metadata for .* not found/i.test(msg);
        out((benign ? '· ' : '✖ ') + msg, benign ? 'dim' : 'err');
      }
    } else if (t === 'turn.completed') {
      out('✔ hotovo', 'dim');
    } else if (t === 'turn.failed') {
      out('✖ ' + ((m.error && m.error.message) || m.message || 'Codex skončil s chybou'), 'err');
    }
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
      out(agent === 'claude'
        ? '✖ Claude Code CLI nenalezen v PATH.'
        : '✖ Codex CLI nenalezen. Nainstaluj: npm install -g @openai/codex a přihlas se (codex login).', 'err');
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
        // Bez schválení Codex v neinteraktivním exec režimu MCP volání vždy zamítne
        // ("MCP tool call requires approval, but approval policy is never") - není
        // se koho zeptat. default_tools_approval_mode="approve" tohle řeší jen pro
        // NÁŠ vlastní server (stejná důvěra jako u Claude --allowedTools mcp__premiere),
        // --sandbox read-only navíc drží na uzdě zbytek (shell nástroje Codexu) -
        // užší než dřívější --dangerously-bypass-approvals-and-sandbox, který rušil
        // sandbox úplně pro všechno. Ověřeno naostro 2026-09-17.
        '--sandbox', 'read-only',
        '-c', 'mcp_servers.premiere.command="node"',
        '-c', 'mcp_servers.premiere.args=["' + SERVER_JS + '"]',
        '-c', 'mcp_servers.premiere.default_tools_approval_mode="approve"'];
      if ($('model').value) args.push('-m', $('model').value);
      args.push('-');
    }

    out('› ' + prompt, 'me');
    $('run').disabled = true;
    $('undo').disabled = false; // nová akce = čerstvá historie, undo zámek z předchozí akce už neplatí
    $('stop').disabled = false;
    setAiIcon(agent);

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
      setAiIcon(null);
    });
  }

  $('run').addEventListener('click', runAgent);
  $('stop').addEventListener('click', function () { stopAgent(); out('■ zastaveno', 'dim'); });
  $('prompt').addEventListener('keydown', function (ev) {
    // Enter samotný spustí zadání, Shift+Enter dělá nový řádek (běžná konvence chatu).
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); runAgent(); }
  });
})();
