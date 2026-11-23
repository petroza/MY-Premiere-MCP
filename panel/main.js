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
  // Panel nainstalovaný z podepsaného .zxp leží ve složce Adobe (CEP\extensions), ne ve složce aplikace – tam
  // server ani Worker nejsou. Pak platí cesta, kterou zapsal instalátor (%APPDATA%\MYpremiereMCP\root.txt).
  if (!fs.existsSync(path.join(ROOT, 'server', 'index.js'))) {
    try {
      var rootTxt = fs.readFileSync(path.join(process.env.APPDATA || '', 'MYpremiereMCP', 'root.txt'), 'utf8').trim();
      if (rootTxt && fs.existsSync(path.join(rootTxt, 'server', 'index.js'))) ROOT = rootTxt;
    } catch (e) { /* instalátor ještě neběžel – panel ohlásí chybějící server */ }
  }
  var HOST_JSX = path.join(extDir, 'host', 'host.jsx').replace(/\\/g, '/');
  var SERVER_JS = path.join(ROOT, 'server', 'index.js').replace(/\\/g, '/');
  // přibalený Node (tools\node) na konec PATH – agenti (Claude/Codex) pak spustí MCP server příkazem "node"
  // i na PC bez instalace Node.js; nainstalovaný Node má přednost
  try {
    var bundledNodeDir = path.join(ROOT, 'tools', 'node');
    if (fs.existsSync(path.join(bundledNodeDir, 'node.exe'))) process.env.PATH = (process.env.PATH || '') + ';' + bundledNodeDir;
  } catch (e) {}

  var PORT = 7880;
  try { PORT = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).port || PORT; } catch (e) {}

  var $ = function (id) { return document.getElementById(id); };
  var pocet = 0;
  var clients = {}; // pid MCP serveru -> kdo ho používá (hlásí se přes /hello)
  // napojení na panel: zadání čekající na Claude (aplikace), otevřená čekání panel_wait_task, právě zpracovávané zadání
  var taskQueue = [], taskWaiters = [], lastTaskPoll = 0, taskSeq = 0, activeTask = null;
  function claudeListening() { return taskWaiters.length > 0 || Date.now() - lastTaskPoll < 15000; }
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
  // PZ_WORKER_APPDATA: izolovaná testovací instance – stejný token jako server MCP a sdílený Worker (S14)
  var TOKEN_DIR = path.join(process.env.PZ_WORKER_APPDATA || process.env.APPDATA || ROOT, 'MYpremiereMCP');
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
          var pct = running ? Math.round((running.progress || 0) * 100) : 0;
          var JOB = { transcribe: 'Přepis', diarize: 'Mluvčí', analyze: 'Osnova', plan: 'Plán střihu', plan_edit: 'Plán střihu',
            sync: 'Synchronizace', translate: 'Překlad', refine_edges: 'Dolaďování hranic', prepare_media: 'Převod videa',
            broll_index: 'Rejstřík záběrů', broll_plan: 'Výběr záběrů', frame: 'Snímek', describe_frame: 'Popis snímku',
            yt_speakers: 'Mluvčí (YouTuber)', yt_plan: 'Plán YouTuber', yt_build_ae: 'Stavba v AE' };
          $('workerText').textContent = running
            ? (JOB[running.type] || running.type) + ' ' + pct + ' %' + (running.message ? ' – ' + running.message : '') + q
            : 'Worker: připraven' + q;
          $('workerPulse').classList.toggle('on', !!running);
          $('workerBar').classList.toggle('on', !!running);
          $('workerBar').firstChild.style.width = pct + '%';
        } catch (e) {
          $('workerText').textContent = 'Worker: neznámý stav';
          $('workerPulse').classList.remove('on');
        }
      });
    });
    req.on('error', function () {
      $('workerText').textContent = 'Worker: neběží (spustí se při první úloze)';
      $('workerPulse').classList.remove('on');
      $('workerBar').classList.remove('on');
    });
    req.on('timeout', function () { req.destroy(); });
    req.end();
  }
  setInterval(pollWorker, 3000);
  pollWorker();

  /* ---------------- vytížení počítače (GPU, VRAM, RAM, CPU) ---------------- */
  function setMeter(id, pct, text) {
    var el = $(id);
    if (!el) return;
    el.style.display = '';
    var bar = el.querySelector('.bar i');
    var p = Math.max(0, Math.min(100, pct || 0));
    bar.style.width = p + '%';
    bar.className = p >= 92 ? 'hot' : p >= 75 ? 'warn' : '';
    el.querySelector('.v').textContent = text;
  }
  var gb = function (b) { return (b / 1073741824).toFixed(1).replace('.', ','); };
  var lastCpu = null;
  function cpuTimes() {
    var t = { idle: 0, total: 0 };
    os.cpus().forEach(function (c) {
      for (var k in c.times) t.total += c.times[k];
      t.idle += c.times.idle;
    });
    return t;
  }
  var gpuOk = true; // bez NVIDIA karty (Mac, AMD) se GPU/VRAM prostě nezobrazí
  function pollResources() {
    var total = os.totalmem(), used = total - os.freemem();
    setMeter('resRam', 100 * used / total, gb(used) + '/' + gb(total) + ' GB');
    var now = cpuTimes();
    if (lastCpu) {
      var dt = now.total - lastCpu.total;
      setMeter('resCpu', dt ? 100 * (1 - (now.idle - lastCpu.idle) / dt) : 0, Math.round(dt ? 100 * (1 - (now.idle - lastCpu.idle) / dt) : 0) + ' %');
    }
    lastCpu = now;
    if (!gpuOk) return;
    cp.execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 4000 }, function (err, stdout) {
        if (err) { gpuOk = false; return; }
        var v = String(stdout).split(/\r?\n/)[0].split(',').map(function (s) { return Number(s.trim()); });
        if (v.length < 3 || isNaN(v[2])) { gpuOk = false; return; }
        setMeter('resGpu', v[0], v[0] + ' %');
        setMeter('resVram', 100 * v[1] / v[2], (v[1] / 1024).toFixed(1).replace('.', ',') + '/' + Math.round(v[2] / 1024) + ' GB');
      });
  }
  setInterval(pollResources, 2000);
  pollResources();

  /* ---------------- rychlá volba délky ---------------- */
  var targetSec = 0;
  try { targetSec = Number(localStorage.getItem('targetSec') || 0); } catch (e) { /* bez paměti */ }
  var chips = document.querySelectorAll('.chip[data-sec]'); // jen délky – šablony zadání mají třídu chip taky
  var NEEDS_LEN = /upoutávk|výrok|teaser|highlight|trailer/i;
  function paintChips() {
    Array.prototype.forEach.call(chips, function (c) { c.classList.toggle('on', Number(c.getAttribute('data-sec')) === targetSec); });
  }
  Array.prototype.forEach.call(chips, function (c) {
    c.addEventListener('click', function () {
      var s = Number(c.getAttribute('data-sec'));
      // upoutávka / výrok bez délky = celý materiál (AI tok S15: druhý klik na „20 s“ délku vypnul → 14 min „upoutávka“);
      // vypnout délku jde jen u zadání, které ji nepotřebuje
      targetSec = targetSec === s && !NEEDS_LEN.test($('prompt').value || '') ? 0 : s;
      try { localStorage.setItem('targetSec', String(targetSec)); } catch (e) { /* bez paměti */ }
      paintChips();
    });
  });
  paintChips();
  /** zadání + zvolená délka (u Hermese jde délka zvlášť proměnnou prostředí, ať ji nepřebije slovo v textu) */
  function withTarget(prompt, sec, fmt) {
    prompt = prompt.replace(/\s*Formát \S+ udělá panel sám[^\n]*$/, '');
    prompt = prompt.replace(/\s*Cílová délka výsledného střihu: [^\n]*$/, ''); // opakované zadání (tlačítka ve výpisu)
    if (sec) prompt += '\n\nCílová délka výsledného střihu: ' + sec + ' sekund (±10 %).';
    // agent jinak na konci nabízí „chceš verzi 9:16?“, i když ji panel po střihu udělá sám
    if (fmt && fmt !== '16:9') prompt += '\nFormát ' + fmt + ' udělá panel sám z hotové sekvence – stříhej v 16:9, reframe nedělej a nenabízej.';
    return prompt;
  }

  /* ---------------- Zpět = smazat sekvence z posledního zadání ---------------- */
  var undoStack = []; // [{ label, ids: [sequenceID], names: [...] }]
  function hostCall(name, args, timeoutMs) {
    return evalQueued('PMCP.call(' + jsString(name) + ',' + jsString(JSON.stringify(args || {})) + ')', timeoutMs || 20000)
      .then(function (r) {
        if (r.timeout) throw new Error('časový limit (modální dialog v Premiere?)');
        var j = JSON.parse(r.raw);
        if (!j.ok) throw new Error(j.error || 'chyba ExtendScriptu');
        return j.result;
      });
  }
  function sequenceIds() {
    return hostCall('projectInfo').then(function (p) { return p.sequences; }).catch(function () { return null; });
  }
  /** před během si zapamatuje sekvence, po běhu uloží nově vzniklé na zásobník pro Zpět */
  function trackRun(label, meta) {
    var before = sequenceIds();
    return function done() {
      Promise.all([before, sequenceIds()]).then(function (r) {
        if (!r[0] || !r[1]) return;
        var old = {};
        r[0].forEach(function (s) { old[s.sequenceID] = true; });
        var fresh = r[1].filter(function (s) { return !old[s.sequenceID]; });
        if (!fresh.length) return;
        undoStack.push({ label: label, ids: fresh.map(function (s) { return s.sequenceID; }),
          names: fresh.map(function (s) { return s.name; }) });
        $('undo').disabled = false;
        if (meta) offerFeedback(meta, fresh);
        // jen poslední nová sekvence = finální verze (agent občas postaví v1 a pak opravenou v2 – v1 nepřevádět)
        if (meta && meta.format && meta.format !== '16:9') reframeFresh(meta.format, fresh.slice(-1), undoStack[undoStack.length - 1]);
      });
    };
  }

  /* ---------------- rychlá zadání ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('.tpl'), function (b) {
    b.addEventListener('click', function () {
      $('prompt').value = b.getAttribute('data-text');
      var len = Number(b.getAttribute('data-len') || 0);
      if (len && targetSec !== len) {
        var chip = document.querySelector('.chip[data-sec="' + len + '"]');
        if (chip) chip.click();
      } else if (!len && targetSec) {
        var on = document.querySelector('.chip[data-sec="' + targetSec + '"]');
        if (on) on.click(); // délka z textu zadání (3 minuty) – zrušit zvolenou krátkou
      }
      $('prompt').focus();
    });
  });

  /* ---------------- formát pro sociální sítě (Auto Reframe) ---------------- */
  var FORMATS = { '9:16': [9, 16, 1080, 1920], '1:1': [1, 1, 1080, 1080], '4:5': [4, 5, 1080, 1350] };
  try { var savedFormat = localStorage.getItem('format'); if (savedFormat) $('format').value = savedFormat; } catch (e) { /* bez paměti */ }
  var ccManual = false;
  $('ccChars').addEventListener('change', function () { ccManual = true; });
  $('format').addEventListener('change', function () {
    try { localStorage.setItem('format', $('format').value); } catch (e) { /* bez paměti */ }
    // na výšku se 40 znaků na řádek nevejde (1080 px šířky) – titulky rovnou na 25, na šířku zpět 40
    var vertical = $('format').value === '9:16' || $('format').value === '4:5';
    $('ccChars').value = vertical ? '25' : ($('format').value === '1:1' ? '30' : '40');
  });
  // „📱 Převést aktivní“ – formát pro sítě hned z aktivní sekvence, bez nového střihu (16:9 -> nabídne 9:16)
  $('reframeNow').addEventListener('click', function () {
    var format = FORMATS[$('format').value] ? $('format').value : '9:16';
    if (format !== $('format').value) { $('format').value = format; $('format').dispatchEvent(new Event('change')); }
    hostCall('projectInfo').then(function (p) {
      var a = p.activeSequence;
      if (!a) throw new Error('žádná aktivní sekvence – otevři sekvenci v Premiere');
      var entry = { label: format + ' z „' + a.name + '“', ids: [], names: [] };
      undoStack.push(entry);
      $('undo').disabled = false;
      reframeFresh(format, [a], entry);
    }).catch(function (e) { out('✖ ' + e.message, 'err'); });
  });
  /** z nově vzniklých sekvencí udělá verze ve zvoleném formátu; přidá je k položce Zpět stejného zadání */
  function reframeFresh(format, fresh, undoEntry) {
    var f = FORMATS[format];
    if (!f) return;
    fresh.reduce(function (p, s) {
      return p.then(function () {
        out('⚙ ' + format + ': Auto Reframe podle obličeje – „' + s.name + '“', 'dim');
        // střihy kamery uvnitř klipů -> řez videa na kopii před reframem (ořez se v každém záběru chytí hned)
        return hostCall('getSequence', { sequence: s.sequenceID }, 30000).then(function (d) {
          return require(path.join(ROOT, 'server', 'camera-cuts.cjs')).cameraCuts(d.clips || [], { root: ROOT });
        }).catch(function () { return []; }).then(function (cuts) {
          return hostCall('reframeSequence', { sequence: s.sequenceID, num: f[0], den: f[1], width: f[2], height: f[3],
            motion: 'faster', splitAt: cuts, name: s.name + ' ' + format.replace(':', 'x') }, 600000);
        }).then(function (r) {
          out('✔ ' + r.name + ' (' + r.width + '×' + r.height + (r.cameraSplits ? ', střihy kamery: ' + r.cameraSplits : '') + ')', 'ai');
          if (undoEntry) { undoEntry.ids.push(r.sequenceID); undoEntry.names.push(r.name); }
        });
      }).catch(function (e) { out('✖ ' + format + ' se nepovedl: ' + e.message, 'err'); });
    }, Promise.resolve());
  }

  /* ---------------- hodnocení výsledku (data na ladění lokálního modelu) ---------------- */
  // 👍/👎 pod hotovým střihem -> cache\feedback.jsonl (zadání, agent, délka, sekvence, hodnocení). Z toho se dá
  // poznat, kde Hermes zaostává za Claudem, a doplnit případy do scripts/highlight-cases.json.
  function offerFeedback(meta, fresh) {
    var row = document.createElement('div');
    row.className = 'dim';
    row.style.margin = '2px 0 6px';
    row.textContent = 'Jak dopadl střih „' + fresh.map(function (s) { return s.name; }).join('“, „') + '“? ';
    [['👍', 'good'], ['👎', 'bad']].forEach(function (b) {
      var btn = document.createElement('button');
      btn.textContent = b[0];
      btn.style.margin = '0 4px 0 0';
      btn.addEventListener('click', function () {
        var rec = { time: new Date().toISOString(), rating: b[1], agent: meta.agent, model: meta.model || null,
          targetSec: meta.targetSec || null, prompt: meta.prompt, sequences: fresh.map(function (s) {
            return { name: s.name, id: s.sequenceID, duration: s.duration }; }) };
        try {
          fs.mkdirSync(path.join(ROOT, 'cache'), { recursive: true });
          fs.appendFileSync(path.join(ROOT, 'cache', 'feedback.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
          row.textContent = b[1] === 'good' ? '👍 díky, uloženo' : '👎 uloženo – napiš klidně do zadání, co bylo špatně, a spusť znovu';
        } catch (e) {
          row.textContent = '✖ hodnocení se neuložilo: ' + e.message;
        }
      });
      row.appendChild(btn);
    });
    // rychlé akce s výsledkem: přepnout na sekvenci, vyexportovat MP4 vedle projektu (…\export\<název>.mp4)
    fresh.forEach(function (s) {
      var open = document.createElement('button');
      open.textContent = '▶ Otevřít';
      open.title = 'Otevřít „' + s.name + '“ v Premiere';
      open.style.margin = '0 4px 0 8px';
      open.addEventListener('click', function () {
        hostCall('openSequence', { sequence: s.sequenceID }).catch(function (e) { out('✖ ' + e.message, 'err'); });
      });
      var exp = document.createElement('button');
      exp.textContent = '⬇ Export MP4';
      exp.title = 'Vyexportuje „' + s.name + '“ do složky export vedle projektu (H.264, jako zdroj)';
      exp.addEventListener('click', function () {
        hostCall('projectInfo').then(function (p) {
          var dir = path.join(path.dirname(p.path || ROOT), 'export');
          var file = path.join(dir, s.name.replace(/[\\/:*?"<>|]+/g, '-') + '.mp4');
          runTool('Export „' + s.name + '“ → ' + file, 'export_sequence', { sequence: s.sequenceID, output: file });
        }).catch(function (e) { out('✖ ' + e.message, 'err'); });
      });
      row.appendChild(open);
      row.appendChild(exp);
    });
    outEl.appendChild(row);
    outEl.scrollTop = outEl.scrollHeight;
  }

  /* ---------------- zdroj (aktivní sekvence) nad zadáním ---------------- */
  function pollSource() {
    if (child) return; // během úlohy ExtendScript nezdržovat
    hostCall('projectInfo').then(function (p) {
      var a = p.activeSequence;
      $('srcName').textContent = a ? a.name : 'žádná';
      $('srcName').title = a ? 'Ze které sekvence se bude stříhat (aktivní)' : 'žádná aktivní sekvence – otevři sekvenci s klipem';
      // bez sekvence jen „žádná“ – dlouhý text se za popiskem Aktivní sekvence opakoval a usekl (vzhled S4 #11, S11);
      // titulky podle tvaru aktivní sekvence (jako okno Text v obraze: na výšku 20 znaků), dokud je uživatel nezměnil (AI tok S11)
      if (a && a.width && a.height && !ccManual) {
        var r = a.width / a.height;
        $('ccChars').value = r < 0.8 ? '20' : r < 1.2 ? '30' : '40';
      }
    }).catch(function () { $('srcName').textContent = '–'; });
  }
  setInterval(pollSource, 4000);
  setTimeout(pollSource, 1500);

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
    // token v konstantním čase (bezpečnost S13)
    var tk = Buffer.from(String(req.headers['x-pmcp-token'] || '')), tt = Buffer.from(String(TOKEN));
    if (tk.length !== tt.length || !require('crypto').timingSafeEqual(tk, tt)) return send(401, { error: 'bad token' });
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
      // Napojení na panel: Claude v aplikaci čeká (panel_wait_task) na zadání z panelu a hlásí průběh (panel_report)
      if (req.url === '/task/next') {
        lastTaskPoll = Date.now();
        if (taskQueue.length) {
          activeTask = taskQueue.shift();
          updateClaudeLink();
          out('⚙ Claude (aplikace) převzal zadání a pracuje…', 'dim');
          return send(200, { raw: JSON.stringify({ task: activeTask }) });
        }
        var waiter = { send: send, done: false };
        waiter.timer = setTimeout(function () {
          if (waiter.done) return;
          waiter.done = true;
          taskWaiters.splice(taskWaiters.indexOf(waiter), 1);
          lastTaskPoll = Date.now();
          send(200, { raw: JSON.stringify({ task: null }) });
          updateClaudeLink();
        }, Math.min(Number(data.waitMs) || 240000, 240000));
        res.on('close', function () { // Claude relaci zavřel – čekání zrušit
          if (waiter.done) return;
          waiter.done = true;
          clearTimeout(waiter.timer);
          var i = taskWaiters.indexOf(waiter);
          if (i >= 0) taskWaiters.splice(i, 1);
          updateClaudeLink();
        });
        taskWaiters.push(waiter);
        updateClaudeLink();
        return;
      }
      if (req.url === '/task/report') {
        out(String(data.text || ''), data.error ? 'err' : 'ai');
        if (data.done || data.error) {
          out(data.error ? '✖ Claude (aplikace): zadání se nepovedlo' : '✔ hotovo (Claude, aplikace)', data.error ? 'err' : 'dim');
          activeTask = null;
          updateClaudeLink();
        }
        return send(200, { raw: JSON.stringify({ ok: true }) });
      }
      if (req.url === '/hello') {
        // MCP server pluginu hlásí, kdo ho používá (aplikace Claude, Codex…) – pro indikátor „Claude“ v hlavičce
        clients[String(data.pid)] = { client: String(data.client || '?'), entry: String(data.entry || ''), last: Date.now() };
        updateClaudeLink();
        return send(200, { raw: JSON.stringify({ ok: true }) });
      }
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

  $('addCaptions').addEventListener('click', function () {
    if (child) { out('Nejdřív počkej, až agent doběhne (nebo klikni Stop).', 'err'); return; }
    var chars = Number($('ccChars').value);
    var lines = Number($('ccLines').value);
    var lang = $('ccLang').value;
    var a = { charsPerLine: chars, lines: lines };
    if (lang) a.translate = lang;
    // přímo bez agenta – jde o jedno mechanické volání (dřív přes Clauda: kredity + ~10 s navíc)
    runTool('Titulky do aktivní sekvence' + (lang ? ' (přeložené do češtiny)' : ''), 'add_captions', a);
  });

  // Vložení videa přes panel: MKV/WebM Premiere shodí už při importu – server je nejdřív převede na MP4
  // (import_media -> premiereMedia -> worker/media.py). Přímo bez agenta, jde o mechanický úkon.
  // Moderní okno Windows pro výběr souborů (jako v Průzkumníku). window.cep.fs.showOpenDialogEx ukazuje staré
  // okno ze 90. let – proto OpenFileDialog z .NET přes PowerShell (AutoUpgradeEnabled = moderní IFileDialog).
  // Neblokuje panel; poslední složka se pamatuje.
  var picking = false;
  function pickFiles(title, cb) {
    if (picking) return;
    var lastDir = '';
    try { lastDir = localStorage.getItem('importDir') || ''; } catch (e) { /* bez paměti složky */ }
    var ps = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.OpenFileDialog',
      '$f.Title = ' + JSON.stringify(title).replace(/^"|"$/g, "'"),
      '$f.Multiselect = $true',
      '$f.AutoUpgradeEnabled = $true',
      "$f.Filter = 'Video a zvuk|*.mkv;*.webm;*.mp4;*.mov;*.mxf;*.avi;*.m4v;*.wav;*.mp3;*.m4a|Všechny soubory|*.*'",
      lastDir ? "$f.InitialDirectory = '" + lastDir.replace(/'/g, "''") + "'" : '',
      // vlastník TopMost, jinak se okno otevře za Premiere
      '$o = New-Object System.Windows.Forms.Form -Property @{TopMost = $true; ShowInTaskbar = $false}',
      "if ($f.ShowDialog($o) -eq 'OK') { $f.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) } }",
    ].filter(Boolean).join('\n');
    var enc = Buffer.from(ps, 'utf16le').toString('base64');
    picking = true;
    var p = cp.spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { windowsHide: true });
    var buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', function (d) { buf += d; });
    p.on('error', function (e) { picking = false; out('✖ Okno pro výběr souborů se neotevřelo: ' + e.message, 'err'); });
    p.on('close', function () {
      picking = false;
      var files = buf.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (files.length) { try { localStorage.setItem('importDir', path.dirname(files[0])); } catch (e) { /* nic */ } }
      cb(files);
    });
  }

  function importPaths(paths) {
    if (!paths.length) return;
    if (child) { out('Nejdřív počkej, až předchozí úloha doběhne (nebo klikni Stop).', 'err'); return; }
    runTool('Vložit do projektu: ' + paths.map(function (p) { return path.basename(p); }).join(', '),
      'import_media', { paths: paths, openSequence: true });
  }

  $('importVideo').addEventListener('click', function () {
    if (child) { out('Nejdřív počkej, až předchozí úloha doběhne (nebo klikni Stop).', 'err'); return; }
    pickFiles('Vložit video do projektu', importPaths);
  });

  // Přetažení souborů z Průzkumníka: kamkoli do panelu (zvýrazní se řádek „Vložit video…“). Bez preventDefault
  // na celém okně by prohlížeč panelu přetažené video „otevřel“ místo panelu.
  var dropRow = $('dropRow');
  function dropPaths(ev) {
    var dt = ev.dataTransfer, paths = [], i;
    for (i = 0; dt.files && i < dt.files.length; i++) if (dt.files[i].path) paths.push(dt.files[i].path);
    if (!paths.length) {
      // CEF bez File.path: cesty z text/uri-list (file:///D:/…)
      (dt.getData('text/uri-list') || '').split(/\r?\n/).forEach(function (u) {
        if (/^file:\/\//i.test(u)) paths.push(decodeURIComponent(u.replace(/^file:\/\/\/?/i, '')).replace(/\//g, '\\'));
      });
    }
    return paths;
  }
  var dragDepth = 0;
  window.addEventListener('dragenter', function (ev) { ev.preventDefault(); dragDepth++; dropRow.classList.add('drag'); });
  window.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; dropRow.classList.remove('drag'); } });
  window.addEventListener('dragover', function (ev) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', function (ev) {
    ev.preventDefault();
    dragDepth = 0;
    dropRow.classList.remove('drag');
    var paths = dropPaths(ev);
    if (paths.length) importPaths(paths);
    else out('✖ Z přetažení se nepodařilo zjistit cestu k souboru (typy: ' +
      Array.prototype.join.call(ev.dataTransfer.types || [], ', ') + ') – použij tlačítko Vložit video…', 'err');
  });

  // Zastavit vše: Hermes (i z jiné instalace), lokální modely a Worker zabírají grafiku a RAM – dva Hermesy naráz
  // vzaly 11,8 z 12,3 GB grafiky a Premiere se 4K záznamy sekala celý počítač (2026-10-05).
  $('stopAll').addEventListener('click', function () {
    if (child) { stopAgent(); out('■ úloha zastavena', 'dim'); }
    out('› Zastavit AI procesy (Hermes, modely, Worker)', 'me');
    var p = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(ROOT, 'scripts', 'stop-all.ps1')], { windowsHide: true });
    var buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', function (d) { buf += d; });
    p.on('error', function (e) { out('✖ ' + e.message, 'err'); });
    p.on('close', function () {
      buf.split(/\r?\n/).filter(Boolean).forEach(function (l) { out(l, /^Zastaveno|^Grafika/.test(l) ? 'ai' : 'dim'); });
    });
  });

  $('undo').addEventListener('click', function () {
    if (child) { out('Nejdřív počkej, až agent doběhne (nebo klikni Stop).', 'err'); return; }
    // Spolehlivá cesta: poslední zadání vytvořilo nové sekvence -> smazat právě ty (jde opakovaně, po zadáních)
    if (undoStack.length) {
      var run = undoStack.pop();
      hostCall('deleteSequences', { ids: run.ids }).then(function (r) {
        out(r.deleted.length
          ? '↶ Smazáno z posledního zadání: ' + r.deleted.map(function (n) { return '„' + n + '“'; }).join(', ') +
            (undoStack.length ? ' · dalším klikem i předchozí (' + undoStack.length + ')' : '')
          : '↶ Sekvence z posledního zadání už v projektu nejsou.', 'dim');
      }).catch(function (e) {
        undoStack.push(run);
        out('✖ Zpět se nepodařilo: ' + e.message, 'err');
      });
      return;
    }
    // Zadání nevytvořilo sekvenci (upravilo existující) -> jeden krok Ctrl+Z v Premiere s pojistkou proti opakování.
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
  // nepřijde při přepnutí Claude <-> Codex a zpátky. Výchozí je Sonnet: ve srovnávacím testu
  // na skutečném střihu (HANDOFF 10) dodržel zadanou stopáž a neměl vady, zatímco Haiku 4.5
  // cílovou délku ignorovalo (339 s místo 180) - proto bylo z nabídky na přání uživatele odstraněno.
  // Codex: výchozí GPT-5.6-Sol – Astra na stejném střihu spálila ~770 tis. tokenů (2026-09-24), zůstává jen volitelně
  var lastModelByAgent = { claude: 'sonnet', codex: 'gpt-5.6-sol' };
  try {
    var savedClaude = localStorage.getItem('pmcp.model.claude');
    if (savedClaude === 'haiku') savedClaude = null; // model už v nabídce není
    if (savedClaude !== null) lastModelByAgent.claude = savedClaude;
  } catch (e) {}
  try {
    var savedCodex = localStorage.getItem('pmcp.model.codex.v2'); // v2: nový výchozí Sol, staré volby neplatí
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
    try { localStorage.setItem('pmcp.model.' + agent + (agent === 'codex' ? '.v2' : ''), $('model').value); } catch (e) {}
  });
  updateModelOptions();

  function out(text, cls) {
    var div = document.createElement('div');
    div.className = cls || 'ai';
    div.textContent = text;
    outEl.appendChild(div);
    outEl.scrollTop = outEl.scrollHeight;
  }

  // Indikátor „Claude“ v hlavičce: zelený, když má aplikace Claude plugin připojený (její MCP server se každých
  // 10 s hlásí přes /hello). Šedý = nepřipojeno; kliknutí otevře v aplikaci novou relaci, která se připojí.
  function clientLabel(c) {
    if (/^(run-tool|local-edit|claude-analyza)$/.test(c.client)) return null; // krátké pomocné běhy panelu
    if (c.entry === 'claude-desktop' || /claude/i.test(c.client)) return 'Claude';
    if (/codex/i.test(c.client)) return 'Codex';
    return c.client;
  }
  function connectedClients() {
    var now = Date.now(), count = {};
    Object.keys(clients).forEach(function (k) {
      if (now - clients[k].last > 25000) { delete clients[k]; return; }
      var l = clientLabel(clients[k]);
      if (l) count[l] = (count[l] || 0) + 1;
    });
    return Object.keys(count).map(function (l) { return count[l] > 1 ? l + ' (' + count[l] + ' relace)' : l; });
  }
  function updateClaudeLink() {
    var el = $('claudeLink');
    if (!el) return;
    var list = connectedClients();
    var connected = list.some(function (l) { return /^Claude/.test(l); });
    var listening = claudeListening();
    el.classList.toggle('on', connected || listening);
    // tečka jako prvek (znak ● v písmu Segoe sedí pod osou textu a „padal“)
    el.innerHTML = '<span class="ld"></span>' + (activeTask ? 'Claude pracuje…' : listening ? 'Claude čeká na zadání' :
      connected ? 'Claude připojen' : 'Připojit Claude');
    el.title = listening || activeTask
      ? 'Aplikace Claude je napojená na panel: zadání s agentem Claude (aplikace) převezme hned a průběh píše sem.'
      : connected
        ? 'Aplikace Claude má plugin připojený, ale nečeká na zadání z panelu – klikni a zapni napojení na panel.'
        : 'Aplikace Claude není připojená – klikni: otevře se v ní relace napojená na panel, potvrď složku a odešli Enterem.';
  }
  setInterval(updateClaudeLink, 5000);
  $('claudeLink').addEventListener('click', function () {
    if (claudeListening()) {
      out('Claude (aplikace) je napojený na panel a čeká na zadání – vyber agenta Claude (aplikace) a klikni Spustit.', 'dim');
      return;
    }
    try {
      openClaudeApp(PANEL_MODE_PROMPT);
      out('⚙ V aplikaci Claude se otevřela relace pro napojení na panel – potvrď složku a odešli Enterem. ' +
        'Indikátor pak ukáže „Claude čeká na zadání“.', 'dim');
    } catch (e) {
      out('✖ Aplikaci Claude se nepodařilo otevřít: ' + e.message, 'err');
    }
  });

  // tlačítko ve výpisu: stejné zadání znovu s jiným agentem (když Claude Code nejde kvůli účtu)
  var lastPrompt = '';
  function offerRerun(agent, label) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.margin = '4px 6px 2px 0';
    b.addEventListener('click', function () {
      if (child || !lastPrompt) return;
      $('agent').value = agent;
      $('agent').dispatchEvent(new Event('change'));
      $('prompt').value = lastPrompt;
      runAgent();
    });
    outEl.appendChild(b);
    outEl.scrollTop = outEl.scrollHeight;
  }

  // jednorázové přihlášení Claude Code: otevře okno terminálu s `claude auth login` (přihlášení v prohlížeči),
  // panel pak hlídá stav a po přihlášení zadání sám zopakuje
  function offerLogin() {
    var b = document.createElement('button');
    b.textContent = '🔑 Přihlásit Claude Code';
    b.className = 'primary';
    b.style.margin = '4px 6px 2px 0';
    b.addEventListener('click', function () {
      var exe = findExe('claude');
      if (!exe) { out('✖ Claude Code CLI nenalezen v PATH.', 'err'); return; }
      cp.spawn('cmd.exe', ['/c', 'start', '"Prihlaseni Claude"', 'cmd', '/k', '"' + exe + '" auth login'],
        { detached: true, windowsHide: false, windowsVerbatimArguments: true }).unref();
      out('⚙ Otevřelo se okno s přihlášením – dokonči ho v prohlížeči. Zadání pak zopakuju samo.', 'dim');
      var tries = 0;
      var t = setInterval(function () {
        if (++tries > 100) { clearInterval(t); return; } // ~5 min
        cp.execFile(exe, ['auth', 'status'], { windowsHide: true, timeout: 8000 }, function (err, stdout) {
          if (/"loggedIn":\s*true/.test(String(stdout || ''))) {
            clearInterval(t);
            out('✔ Claude Code přihlášen.', 'ai');
            if (lastPrompt && !child) { $('agent').value = 'claude'; $('prompt').value = lastPrompt; runAgent(); }
          }
        });
      }, 3000);
    });
    outEl.appendChild(b);
    outEl.scrollTop = outEl.scrollHeight;
  }

  function findExe(name) {
    try {
      var lines = cp.execSync('where.exe ' + name, { encoding: 'utf8', windowsHide: true }).split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) if (/\.exe$/i.test(lines[i].trim())) return lines[i].trim();
      return lines[0].trim() || null;
    } catch (e) {}

    // přibalený přenosný Node (tools\node) – přenesená složka na PC bez instalace Node.js
    if (name === 'node') {
      var bundledNode = path.join(ROOT, 'tools', 'node', 'node.exe');
      if (fs.existsSync(bundledNode)) return bundledNode;
    }

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
        out('Claude Code v panelu není na tomhle počítači přihlášený. Stačí se jednou přihlásit (pamatuje si to), ' +
          'nebo zadání pošli do aplikace Claude, kde přihlášený jsi.', 'err');
        offerLogin();
        offerRerun('claudeapp', '▶ Poslat do aplikace Claude');
        offerRerun('hermes', '▶ Místo toho v Hermesovi (lokálně, zdarma)');
      }
      // Firemní účet (TV Nova) má příkazový Claude Code přes předplatné zakázaný – obejít to nejde (jen API klíč nebo
      // správce). Aplikace Claude povolená je: zadání se tam pošle samo a panel si to pamatuje (další už rovnou).
      if (ev.is_error && /disabled Claude subscription access|organization has disabled/i.test(String(ev.result || ''))) {
        try { localStorage.setItem('claudeCliBlocked', String(Date.now())); } catch (e) { /* bez paměti */ }
        out('Příkazový Claude Code je u tvého účtu zakázaný (organizace) – posílám zadání do aplikace Claude.', 'dim');
        setTimeout(function () { if (lastPrompt) sendToClaudeApp(lastPrompt); }, 300);
        offerRerun('hermes', '▶ Místo toho v Hermesovi (lokálně, zdarma)');
        offerRerun('codex', '▶ Místo toho v Codexu (GPT)');
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

  // „Claude (aplikace)“: zadání se předá desktopové aplikaci Claude odkazem claude://code/new (oficiální, viz
  // support.claude.com 14729294) – nová relace Claude Code ve složce pluginu s předvyplněným zadáním, stačí Enter.
  // Firemní účet má zakázaný příkazový `claude` (panel), aplikace ale povolená je – ruční přepínání přes chat odpadá.
  // Text, kterým se relace v aplikaci Claude přepne do režimu napojení na panel (funguje i bez pluginu)
  var PANEL_MODE_PROMPT =
    'Napoj se na panel MY Premiere MCP v Premiere: opakovaně volej nástroj panel_wait_task (MCP server premiere). ' +
    'Každé zadání, které vrátí, vykonej přes nástroje premiere podle CLAUDE.md (výsledek vždy jako NOVÁ sekvence), ' +
    'průběh a výsledek hlas přes panel_report (na konci done: true) a pak znovu panel_wait_task. ' +
    'Neukončuj práci, dokud tě o to nepožádám.';

  function openClaudeApp(q) {
    // rundll32 předá URL přímo obsluze protokolu – bez cmd.exe, který by rozbil znaky & a %
    cp.spawn('rundll32.exe', ['url.dll,FileProtocolHandler',
      'claude://code/new?q=' + encodeURIComponent(q) + '&folder=' + encodeURIComponent(ROOT)],
      { detached: true, windowsHide: true }).unref();
  }

  // „Claude (aplikace)“: když je aplikace Claude napojená na panel (čeká v panel_wait_task), dostane zadání hned a průběh
  // se vypisuje tady. Jinak zadání počká ve frontě a v aplikaci se otevře relace v režimu napojení (oficiální odkaz
  // claude://code/new, support.claude.com 14729294) – po potvrzení složky a Enteru si ho hned vyzvedne.
  function sendToClaudeApp(prompt) {
    out('› ' + prompt, 'me');
    lastPrompt = prompt;
    var task = { id: String(++taskSeq), prompt: prompt };
    var w = null;
    while (taskWaiters.length && !w) { w = taskWaiters.shift(); if (w.done) w = null; }
    if (w) {
      w.done = true;
      clearTimeout(w.timer);
      activeTask = task;
      w.send(200, { raw: JSON.stringify({ task: task }) });
      out('⚙ předáno Claude (aplikace) – pracuje přes plugin, průběh se objeví tady', 'dim');
      updateClaudeLink();
      return;
    }
    taskQueue.push(task);
    if (claudeListening()) {
      out('⚙ zadání čeká – Claude (aplikace) si ho vyzvedne, až dokončí předchozí', 'dim');
      return;
    }
    try {
      openClaudeApp(PANEL_MODE_PROMPT);
      out('⚙ Claude (aplikace) zatím není napojený – v aplikaci se otevřela relace pro napojení na panel. Potvrď složku ' +
        'a odešli Enterem; zadání si pak hned vyzvedne a další už půjdou rovnou.', 'dim');
    } catch (e) {
      out('✖ Aplikaci Claude se nepodařilo otevřít: ' + e.message, 'err');
    }
  }

  /** zadání z formuláře (text, agent, model, délka) – pro hned spuštění i pro frontu */
  function formTask() {
    var p = $('prompt').value.trim();
    // pojistka: upoutávka / výrok bez zvolené délky a bez délky v textu = 20 s, ne celý materiál (AI tok S15)
    var sec = targetSec || (NEEDS_LEN.test(p) && !/\d+\s*(s\b|sek|vteř|min)/i.test(p) ? 20 : 0);
    return { prompt: p, agent: $('agent').value, model: $('model').value,
      targetSec: sec, resume: $('pokracovat').checked, format: $('format').value };
  }

  /** Spustí zadání. Vrací 'spawned' (běží, na konci zavolá task.onDone), 'sent' (předáno aplikaci Claude) nebo false. */
  function runAgent(task) {
    task = task || formTask();
    var prompt = task.prompt;
    if (!prompt || child) return false;
    var agent = task.agent;
    if (agent !== 'hermes') prompt = withTarget(prompt, task.targetSec, task.format);
    // zadání z fronty: sekvence zapamatovaná při přidání (aktivní sekvence se mezitím mění – předchozí úloha otevře svou)
    if (task.seqName && agent !== 'hermes') {
      prompt += '\n\nPracuj se sekvencí „' + task.seqName + '“' + (task.source ? ' (zdroj ' + task.source + ')' : '') + '.';
    }
    if (agent === 'claudeapp') { sendToClaudeApp(prompt); return 'sent'; }
    // Příkazový Claude je u účtu zakázaný (organizace) -> rovnou do aplikace Claude. Jednou za 24 h se CLI zkusí
    // znovu, kdyby ho správce povolil (při chybě se zadání do aplikace pošle stejně samo).
    if (agent === 'claude') {
      var blockedAt = 0;
      try { blockedAt = Number(localStorage.getItem('claudeCliBlocked') || 0); } catch (e) { /* bez paměti */ }
      if (claudeListening() || (blockedAt && Date.now() - blockedAt < 24 * 3600 * 1000)) {
        out('ℹ Příkazový Claude Code je u tvého účtu zakázaný – zadání jde do aplikace Claude.', 'dim');
        sendToClaudeApp(prompt);
        return 'sent';
      }
    }
    // Hermes = lokální model uživatele (O:\Hermes, llama-server :8000). Nejede přes CLI agenta,
    // ale přes náš skript: vybere věty lokálně a rovnou postaví sekvenci - bez kreditů.
    var exe = findExe(agent === 'hermes' ? 'node' : agent);
    if (!exe) {
      out(agent === 'claude'
        ? '✖ Claude Code CLI nenalezen v PATH.'
        : agent === 'hermes'
          ? '✖ Node.js nenalezen v PATH (potřebný pro lokální střih).'
          : '✖ Codex CLI nenalezen. Nainstaluj: npm install -g @openai/codex a přihlas se (codex login).', 'err');
      return false;
    }
    if (lastAgent !== agent) sessionId = null;
    lastAgent = agent;

    var args;
    if (agent === 'hermes') {
      args = [path.join(ROOT, 'scripts', 'local-edit.mjs'), 'hermes'];
    } else if (agent === 'claude') {
      args = ['-p', '--output-format', 'stream-json', '--verbose',
        '--mcp-config', path.join(ROOT, 'mcp.json'), '--strict-mcp-config',
        '--allowedTools', 'mcp__premiere'];
      // Úsporný režim: z vestavěných nástrojů Claude Code jen ToolSearch (popisy 43 MCP nástrojů ~15k tokenů se
      // načtou až na vyžádání), krátký vlastní systémový prompt (hybrid: lokální model navrhne, Claude zkontroluje)
      // a střední úsilí (výchozí hluboké přemýšlení generovalo 4× víc výstupu bez rozdílu ve výsledku).
      // Změřeno 2026-09-24 na stejném střihu (scripts/compare-agents.mjs): $0.85 / 132 s -> $0.16 / 70 s, kvalita stejná.
      // Jen u claude.exe: .cmd (npm instalace) jde přes cmd.exe, který víceřádkový argument s uvozovkami rozbije.
      if (!/\.(cmd|bat)$/i.test(exe)) {
        try {
          args.push('--tools=ToolSearch', '--effort', 'medium',
            '--system-prompt', fs.readFileSync(path.join(ROOT, 'panel', 'agent-system.md'), 'utf8'));
        } catch (e) {
          /* bez souboru s promptem běží výchozí režim Claude Code */
        }
      }
      if (task.model) args.push('--model', task.model);
      // zadání z fronty jsou samostatná – navazovat na konverzaci jiného zadání by je pomíchalo
      if (task.resume && !task.queued && sessionId) args.push('--resume', sessionId);
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
      if (task.model) args.push('-m', task.model);
      args.push('-');
    }

    out('› ' + prompt, 'me');
    lastPrompt = prompt;
    $('undo').disabled = false; // nová akce = čerstvá historie, undo zámek z předchozí akce už neplatí
    $('stop').disabled = false;
    setAiIcon(agent);

    if (agent === 'hermes' && task.targetSec) out('⚙ cílová délka ' + task.targetSec + ' s', 'dim');
    var finishTrack = trackRun(prompt.split('\n')[0].slice(0, 60),
      { agent: agent, model: task.model, targetSec: task.targetSec, prompt: task.prompt, format: task.format });
    var useShell = /\.(cmd|bat)$/i.test(exe);
    var env = process.env;
    if (agent === 'hermes') {
      env = Object.assign({}, process.env, { PMCP_TARGET_SEC: task.targetSec ? String(task.targetSec) : '',
        PMCP_SEQUENCE: task.seqId || '' });
    }
    // .cmd přes cmd.exe: argumenty s mezerou (cesta aplikace „O:\AI STRIH ALL app\…“ v --mcp-config / mcp_servers.args) musí být
    // v uvozovkách, jinak je cmd rozdělí (Node je u shell: true sám neozávorkuje)
    var qa = function (a) { a = String(a); return /[\s"&|<>^()]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a; };
    child = useShell ? cp.spawn(qa(exe), args.map(qa), { cwd: ROOT, windowsHide: true, shell: true, env: env })
      : cp.spawn(exe, args, { cwd: ROOT, windowsHide: true, shell: false, env: env });
    child.stdin.end(prompt, 'utf8');

    var buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (d) {
      buf += d;
      var lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(function (line) {
        if (!line.trim()) return;
        if (agent === 'hermes') { // prostý text, ne stream JSON
          if (/^\s*0 % (ve frontě|běží)\s*$/.test(line)) return; // šum – průběh ukazuje pruh pod Workerem
          out(line, /^✖/.test(line) ? 'err' : /^(⚙|\s)/.test(line) ? 'dim' : 'ai');
          return;
        }
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
      if (code && errBuf.trim()) out('✖ ' + cleanErr(errBuf), 'err');
      child = null;
      $('stop').disabled = true;
      setAiIcon(null);
      finishTrack();
      if (task.onDone) task.onDone(code ? 'error' : 'done');
      setTimeout(pumpQueue, 800);
    });
    return 'spawned';
  }

  /* ---------------- fronta zadání ---------------- */
  // Zadání běží po jednom (Premiere ExtendScript i grafika zvládnou bezpečně jednu úlohu). Každé si při přidání
  // zapamatuje agenta, model, délku a aktivní sekvenci, takže lze nachystat víc střihů a nechat je doběhnout.
  var jobs = [], qSeq = 0, qPaused = false;
  var AGENT_LABEL = { claude: 'Claude', claudeapp: 'Claude app', codex: 'Codex', hermes: 'Hermes' };
  function renderQueue() {
    var waiting = jobs.filter(function (j) { return j.status === 'wait'; }).length;
    $('queue').classList.toggle('on', jobs.length > 0);
    $('qCount').textContent = (waiting ? waiting + ' čeká' : '') + (qPaused ? ' · pozastaveno' : '');
    $('qPause').textContent = qPaused ? 'pokračovat' : 'pozastavit';
    var list = $('qList');
    list.innerHTML = '';
    jobs.forEach(function (j) {
      var row = document.createElement('div');
      row.className = 'qi ' + j.status;
      var icon = { wait: '⏳', running: '▶', done: '✔', error: '✖' }[j.status];
      var tag = AGENT_LABEL[j.agent] + (j.model ? ' ' + j.model : '') + (j.targetSec ? ' · ' + j.targetSec + ' s' : '') +
        (j.format && j.format !== '16:9' ? ' · ' + j.format : '') + (j.seqName ? ' · ' + j.seqName.slice(0, 18) : '');
      row.innerHTML = '<span class="st"></span><span class="tag"></span><span class="tx"></span>';
      row.children[0].textContent = icon;
      row.children[1].textContent = '[' + tag + ']';
      row.children[2].textContent = j.prompt;
      row.title = j.prompt;
      if (j.status !== 'running') {
        var x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.title = j.status === 'wait' ? 'Odebrat z fronty' : 'Skrýt';
        x.addEventListener('click', function () { jobs = jobs.filter(function (k) { return k !== j; }); renderQueue(); });
        row.appendChild(x);
      }
      list.appendChild(row);
    });
  }
  function pumpQueue() {
    if (child || qPaused || jobs.some(function (j) { return j.status === 'running'; })) return;
    var next = jobs.filter(function (j) { return j.status === 'wait'; })[0];
    if (!next) return;
    next.status = 'running';
    next.onDone = function (st) { next.status = st; renderQueue(); };
    renderQueue();
    var r = runAgent(next);
    if (r === 'sent') {
      // Claude (aplikace) pracuje mimo panel – další zadání až po jeho hlášení „hotovo“ (panel_report done),
      // jinak by dvě úlohy sahaly do Premiere naráz. Neodešlé zadání čeká v taskQueue, dokud se aplikace nenapojí.
      var since = Date.now();
      var t = setInterval(function () {
        var finished = !activeTask && !taskQueue.length && Date.now() - since > 4000;
        if (!finished && Date.now() - since < 45 * 60 * 1000) return;
        clearInterval(t);
        next.status = finished ? 'done' : 'error';
        renderQueue();
        pumpQueue();
      }, 2000);
    } else if (r !== 'spawned') {
      next.status = 'error';
      renderQueue();
      setTimeout(pumpQueue, 300);
    }
  }
  function enqueue(task) {
    if (!task.prompt) return;
    task.id = ++qSeq;
    task.queued = true;
    task.status = 'capture';
    // zapamatovat aktivní sekvenci teď – než přijde řada, otevřou se jiné
    hostCall('getSequence', { clips: true }).then(function (s) {
      task.seqId = s.sequenceID;
      task.seqName = s.name;
      var m = (s.clips || []).filter(function (c) { return c.mediaPath; })[0];
      task.source = m ? m.mediaPath : '';
    }).catch(function () { /* bez aktivní sekvence – agent si zdroj najde sám */ }).then(function () {
      task.status = 'wait';
      jobs.push(task);
      renderQueue();
      pumpQueue();
    });
  }
  $('enqueue').addEventListener('click', function () {
    var t = formTask();
    if (!t.prompt) return;
    enqueue(t);
    $('prompt').value = '';
    out('➕ do fronty: ' + t.prompt.slice(0, 80) + ' [' + AGENT_LABEL[t.agent] + (t.targetSec ? ', ' + t.targetSec + ' s' : '') + ']', 'dim');
  });
  $('qPause').addEventListener('click', function (ev) {
    ev.preventDefault();
    qPaused = !qPaused;
    renderQueue();
    pumpQueue();
  });
  $('qClear').addEventListener('click', function (ev) {
    ev.preventDefault();
    jobs = jobs.filter(function (j) { return j.status === 'wait' || j.status === 'running'; });
    renderQueue();
  });
  /** Spustit: hned, nebo do fronty, když něco běží */
  function runOrQueue() {
    var t = formTask();
    if (!t.prompt) return;
    if (child || jobs.some(function (j) { return j.status === 'running' || j.status === 'wait'; })) {
      enqueue(t);
      $('prompt').value = '';
      out('➕ běží jiná úloha – zadání čeká ve frontě', 'dim');
      return;
    }
    runAgent(t);
  }

  // Přímé spuštění jednoho nástroje bez AI agenta (titulky): mechanická úloha, agent by jen stál kredity
  // a čas. Výstup i průběh jako u lokálního střihu, Stop funguje stejně.
  // chyba procesu pro uživatele: bez zásobníku a cest node_modules (redaktorka S1: „✖ tion closed at McpError.fromError (file:///…“)
  function cleanErr(s) {
    var lines = String(s).split(/\r?\n/).filter(function (l) {
      return l.trim() && !/^\s+at /.test(l) && !/^\s*[{}],?\s*$/.test(l) && !/^\s*(code|data):/.test(l) && !/^Node\.js v/.test(l) && !/^\s*\^+\s*$/.test(l);
    }).map(function (l) { return l.replace(/file:\/\/\/\S+/g, '').trim(); });
    var t = lines.slice(-4).join('\n').slice(-600);
    if (/Connection closed/.test(s)) t += '\nServer MY Premiere MCP se nespustil nebo spadl. Zavři a znovu otevři panel; když to trvá, spusť INSTALL\\Instalace.cmd (zkontroluje instalaci).';
    return t;
  }
  function runTool(label, tool, toolArgs) {
    if (child) { out('Nejdřív počkej, až předchozí úloha doběhne (nebo klikni Stop).', 'err'); return; }
    var exe = findExe('node');
    if (!exe) { out('✖ Node.js nenalezen v PATH.', 'err'); return; }
    out('› ' + label, 'me');
    $('stop').disabled = false;
    setAiIcon('hermes');
    child = cp.spawn(exe, [path.join(ROOT, 'scripts', 'run-tool.mjs'), tool, JSON.stringify(toolArgs || {})],
      { cwd: ROOT, windowsHide: true, env: process.env });
    var buf = '', errBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (d) {
      buf += d;
      var lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(function (line) {
        if (line.trim()) out(line, /^✖/.test(line) ? 'err' : /^(⚙|\s)/.test(line) ? 'dim' : 'ai');
      });
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (d) { errBuf = (errBuf + d).slice(-4000); });
    child.on('error', function (e) { out('✖ ' + e.message, 'err'); });
    child.on('close', function (code) {
      if (code && errBuf.trim()) out('✖ ' + cleanErr(errBuf), 'err');
      child = null;
      $('stop').disabled = true;
      setAiIcon(null);
      setTimeout(pumpQueue, 800);
    });
  }


  $('run').addEventListener('click', runOrQueue);
  $('stop').addEventListener('click', function () {
    stopAgent();
    // zastavení = uživatel chce mít klid; další zadání z fronty se samo nespustí, dokud frontu nepustí
    if (jobs.some(function (j) { return j.status === 'wait'; })) { qPaused = true; renderQueue(); out('■ zastaveno · fronta pozastavena', 'dim'); }
    else out('■ zastaveno', 'dim');
  });
  $('prompt').addEventListener('keydown', function (ev) {
    // Enter samotný spustí zadání, Shift+Enter dělá nový řádek (běžná konvence chatu).
    // Ctrl+Enter = přidat do fronty
    if (ev.key === 'Enter' && ev.ctrlKey) { ev.preventDefault(); $('enqueue').click(); return; }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); runOrQueue(); }
  });
})();
