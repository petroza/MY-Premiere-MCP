/*
 * MYpremiereMCP - ExtendScript strana (bezi uvnitr Premiere, ES3 syntaxe!).
 * Jediny vstup: PMCP.call(nazev, argumentyJSON) -> JSON {ok, result|error}.
 * Casy jsou vsude v sekundach.
 */
var PMCP = {};
(function () {
  var TICKS = 254016000000;
  var EPS = 0.002;
  var AUDIO_EXT = { wav: 1, mp3: 1, aac: 1, m4a: 1, aif: 1, aiff: 1, flac: 1, ogg: 1, wma: 1 };

  /* ---------- JSON (ExtendScript nema nativni JSON) ---------- */
  var ESC_RE = new RegExp('[\\\\"' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
  function esc(s) {
    return '"' + String(s).replace(ESC_RE, function (c) {
      var m = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
      return m[c] || ('\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
    }) + '"';
  }
  function toJSON(v) {
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return String(v);
    if (t === 'string') return esc(v);
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(toJSON(v[i]));
      return '[' + a.join(',') + ']';
    }
    var o = [];
    for (var k in v) {
      if (!v.hasOwnProperty(k)) continue;
      if (typeof v[k] === 'function' || v[k] === undefined) continue;
      o.push(esc(k) + ':' + toJSON(v[k]));
    }
    return '{' + o.join(',') + '}';
  }

  /* ---------- pomocne ---------- */
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function ticks(sec) { return String(Math.round(sec * TICKS)); }
  function timeObj(sec) { var t = new Time(); t.seconds = sec; return t; }
  function normPath(p) { return String(p || '').replace(/\//g, '\\').toLowerCase(); }
  function extOf(p) { var m = String(p).match(/\.([a-z0-9]+)$/i); return m ? m[1].toLowerCase() : ''; }
  function needProject() { if (!app.project) throw new Error('No project is open'); return app.project; }
  function mediaPath(item) { try { return item.getMediaPath() || ''; } catch (e) { return ''; } }

  function getSeq(id) {
    needProject();
    if (id === undefined || id === null || id === '') {
      if (!app.project.activeSequence) throw new Error('No active sequence');
      return app.project.activeSequence;
    }
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
      if (seqs[i].sequenceID === id || seqs[i].name === id) return seqs[i];
    }
    throw new Error('Sequence not found: ' + id);
  }
  function frameDur(seq) { return seq.getSettings().videoFrameRate.seconds; }
  function snap(sec, fd) { return Math.round(sec / fd) * fd; }

  function activate(seq) {
    app.project.openSequence(seq.sequenceID);
    try { app.project.activeSequence = seq; } catch (e) {}
  }

  function collect(item, out) {
    for (var i = 0; i < item.children.numItems; i++) {
      var c = item.children[i];
      if (c.type === ProjectItemType.BIN) collect(c, out); else out.push(c);
    }
  }

  function resolveItem(key, autoImport) {
    needProject();
    var k = String(key), nk = normPath(k), list = [], i;
    collect(app.project.rootItem, list);
    for (i = 0; i < list.length; i++) if (list[i].nodeId === k) return list[i];
    for (i = 0; i < list.length; i++) if (normPath(mediaPath(list[i])) === nk) return list[i];
    if (autoImport && new File(k).exists) {
      app.project.importFiles([k], true, app.project.getInsertionBin(), false);
      list = [];
      collect(app.project.rootItem, list);
      for (i = 0; i < list.length; i++) if (normPath(mediaPath(list[i])) === nk) return list[i];
    }
    for (i = 0; i < list.length; i++) if (list[i].name === k) return list[i];
    throw new Error('Project item not found: ' + k);
  }

  function isAudioOnly(item) { return !!AUDIO_EXT[extOf(mediaPath(item))]; }

  function clipInfo(c, kind, ti, ci) {
    var r = {
      kind: kind, track: ti, index: ci, name: c.name,
      start: r3(c.start.seconds), end: r3(c.end.seconds),
      inPoint: r3(c.inPoint.seconds), outPoint: r3(c.outPoint.seconds)
    };
    try { if (c.projectItem) { r.mediaPath = mediaPath(c.projectItem); r.nodeId = c.projectItem.nodeId; } } catch (e) {}
    try { r.disabled = c.disabled; } catch (e) {}
    try { r.speed = c.getSpeed(); } catch (e) {}
    try { r.selected = c.isSelected(); } catch (e) {}
    return r;
  }

  function dumpSeq(seq, withClips) {
    var st = seq.getSettings();
    var fd = st.videoFrameRate.seconds;
    var r = {
      name: seq.name, sequenceID: seq.sequenceID,
      fps: r3(1 / fd), width: st.videoFrameWidth, height: st.videoFrameHeight,
      duration: r3(Number(seq.end) / TICKS),
      playhead: r3(seq.getPlayerPosition().seconds),
      videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks
    };
    try {
      var sin = Number(seq.getInPoint()), sout = Number(seq.getOutPoint());
      r.inPoint = sin >= 0 ? r3(sin) : null;
      r.outPoint = sout >= 0 ? r3(sout) : null;
    } catch (e) {}
    if (withClips) {
      r.clips = [];
      var groups = [[seq.videoTracks, 'video'], [seq.audioTracks, 'audio']];
      for (var g = 0; g < groups.length; g++) {
        var tracks = groups[g][0];
        for (var t = 0; t < tracks.numTracks; t++) {
          var clips = tracks[t].clips;
          for (var j = 0; j < clips.numItems; j++) r.clips.push(clipInfo(clips[j], groups[g][1], t, j));
        }
      }
    }
    return r;
  }

  /* in/out na projektove polozce; overi, ktery format casu Premiere prijal */
  function setItemRange(item, inS, outS) {
    var attempts = [
      function () { item.setInPoint(inS, 4); item.setOutPoint(outS, 4); },
      function () { item.setInPoint(ticks(inS), 4); item.setOutPoint(ticks(outS), 4); }
    ];
    var gi = null, go = null;
    for (var i = 0; i < attempts.length; i++) {
      attempts[i]();
      try { gi = item.getInPoint(4).seconds; go = item.getOutPoint(4).seconds; } catch (e) { return 'unverified'; }
      if (Math.abs(gi - inS) < 0.05 && Math.abs(go - outS) < 0.05) return i === 0 ? 'seconds' : 'ticks';
    }
    throw new Error('Could not set in/out on ' + item.name + ' (got ' + gi + '..' + go + ', wanted ' + inS + '..' + outS + ')');
  }

  function findClipAt(track, at, fd) {
    // Klipy se skladaji na trat v rostoucim case, takže prave vlozeny je skoro vzdy posledni –
    // skenovat od konce z O(n) na klip udela O(1) misto O(n^2) pri stovkach klipu (buildTimeline).
    var n = track.clips.numItems;
    for (var j = n - 1; j >= 0; j--) {
      if (Math.abs(track.clips[j].start.seconds - at) < fd / 2) return track.clips[j];
    }
    return null;
  }

  function placeRange(seq, item, inS, outS, at, kind, idx) {
    var tracks = kind === 'audio' ? seq.audioTracks : seq.videoTracks;
    if (idx >= tracks.numTracks) throw new Error((kind === 'audio' ? 'A' : 'V') + (idx + 1) + ' does not exist in the sequence');
    var track = tracks[idx];
    var fd = frameDur(seq);
    setItemRange(item, inS, outS);
    track.overwriteClip(item, ticks(at));
    var c = findClipAt(track, at, fd);
    if (!c) { track.overwriteClip(item, at); c = findClipAt(track, at, fd); }
    try { item.clearInPoint(); item.clearOutPoint(); } catch (e) {}
    if (!c) throw new Error('overwriteClip did not place ' + item.name + ' at ' + at + 's');
    return { kind: kind, track: idx, start: r3(c.start.seconds), end: r3(c.end.seconds) };
  }

  function clearSequence(seq) {
    var groups = [seq.videoTracks, seq.audioTracks];
    for (var g = 0; g < 2; g++) {
      for (var t = 0; t < groups[g].numTracks; t++) {
        var clips = groups[g][t].clips;
        for (var j = clips.numItems - 1; j >= 0; j--) clips[j].remove(false, false);
      }
    }
  }

  function razorAll(seq, sec) {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    if (!qs) throw new Error('QE: no active sequence');
    // Time.getFormatted() u nestandardnich fps (napr. VFR zaznam obrazovky) vraci spatny timecode.
    // Proto nastavime playhead pres DOM na presne ticky a timecode precteme primo z QE.
    var prev = seq.getPlayerPosition().ticks;
    seq.setPlayerPosition(ticks(sec));
    var tc = qs.CTI.timecode;
    var i;
    function cut(track) {
      try { track.razor(tc); } catch (e) { track.razor(tc, true, true); }
    }
    for (i = 0; i < qs.numVideoTracks; i++) cut(qs.getVideoTrackAt(i));
    for (i = 0; i < qs.numAudioTracks; i++) cut(qs.getAudioTrackAt(i));
    seq.setPlayerPosition(String(prev));
    return tc;
  }

  function eachClip(seq, fn) {
    var groups = [[seq.videoTracks, 'video'], [seq.audioTracks, 'audio']];
    for (var g = 0; g < 2; g++) {
      var tracks = groups[g][0];
      for (var t = 0; t < tracks.numTracks; t++) {
        var clips = tracks[t].clips;
        for (var j = clips.numItems - 1; j >= 0; j--) fn(clips[j], groups[g][1], t, j);
      }
    }
  }

  /* ---------- API ---------- */
  var api = {};

  api.ping = function () {
    var r = { app: 'PPRO', version: app.version, build: app.build, project: null };
    if (app.project && app.project.path) {
      r.project = { name: app.project.name, path: app.project.path };
      if (app.project.activeSequence) r.activeSequence = app.project.activeSequence.name;
    }
    return r;
  };

  api.projectInfo = function () {
    needProject();
    var seqs = [], s = app.project.sequences;
    for (var i = 0; i < s.numSequences; i++) {
      seqs.push({ name: s[i].name, sequenceID: s[i].sequenceID, duration: r3(Number(s[i].end) / TICKS) });
    }
    var active = app.project.activeSequence;
    return {
      name: app.project.name, path: app.project.path, sequences: seqs,
      activeSequence: active ? { name: active.name, sequenceID: active.sequenceID } : null
    };
  };

  api.listItems = function () {
    needProject();
    var out = [];
    function walk(item, binPath) {
      for (var i = 0; i < item.children.numItems; i++) {
        var c = item.children[i];
        if (c.type === ProjectItemType.BIN) {
          out.push({ type: 'bin', name: c.name, nodeId: c.nodeId, bin: binPath });
          walk(c, binPath + '/' + c.name);
        } else {
          var rec = { type: 'item', name: c.name, nodeId: c.nodeId, bin: binPath, mediaPath: mediaPath(c) };
          try { rec.isSequence = c.isSequence(); } catch (e) {}
          out.push(rec);
        }
      }
    }
    walk(app.project.rootItem, '');
    return out;
  };

  api.importFiles = function (a) {
    needProject();
    var bin = app.project.getInsertionBin();
    if (a.bin) {
      var found = null, root = app.project.rootItem;
      for (var i = 0; i < root.children.numItems; i++) {
        if (root.children[i].type === ProjectItemType.BIN && root.children[i].name === a.bin) found = root.children[i];
      }
      bin = found || root.createBin(a.bin);
    }
    app.project.importFiles(a.paths, true, bin, false);
    var res = [];
    for (var j = 0; j < a.paths.length; j++) {
      try { var it = resolveItem(a.paths[j], false); res.push({ path: a.paths[j], name: it.name, nodeId: it.nodeId }); }
      catch (e) { res.push({ path: a.paths[j], error: String(e.message || e) }); }
    }
    return res;
  };

  api.getSequence = function (a) { return dumpSeq(getSeq(a.sequence), a.clips !== false); };

  api.openSequence = function (a) { var s = getSeq(a.sequence); activate(s); return { name: s.name, sequenceID: s.sequenceID }; };

  /* Nova sekvence poskladana z useku zdroju: [{source, in, out, audioOnly?, extra:[{source, offset, audioTrack}]}] */
  api.buildSequence = function (a) {
    var segs = a.segments;
    if (!segs || !segs.length) throw new Error('No segments');
    var first = resolveItem(segs[0].source, true);
    var seq = app.project.createNewSequenceFromClips(a.name || 'AI strih', [first], app.project.getInsertionBin());
    if (!seq) throw new Error('createNewSequenceFromClips failed');
    clearSequence(seq);
    var fd = frameDur(seq);
    var cursor = 0, gap = a.gap || 0, placed = [], warnings = [];
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      var item = resolveItem(sg.source, true);
      var inS = snap(sg['in'], fd), outS = snap(sg.out, fd);
      if (outS - inS < fd) { warnings.push('segment ' + i + ' too short, skipped'); continue; }
      var audioOnly = sg.audioOnly || isAudioOnly(item);
      var main = placeRange(seq, item, inS, outS, cursor, audioOnly ? 'audio' : 'video', audioOnly ? (sg.audioTrack || 0) : (sg.videoTrack || 0));
      var rec = { i: i, source: sg.source, 'in': r3(inS), out: r3(outS), at: r3(cursor), placed: [main] };
      var extra = sg.extra || [];
      for (var x = 0; x < extra.length; x++) {
        try {
          var xi = resolveItem(extra[x].source, true);
          var off = extra[x].offset || 0;
          rec.placed.push(placeRange(seq, xi, Math.max(0, inS + off), outS + off, cursor, 'audio', extra[x].audioTrack === undefined ? 1 : extra[x].audioTrack));
        } catch (e) { warnings.push('segment ' + i + ' extra ' + x + ': ' + (e.message || e)); }
      }
      placed.push(rec);
      // skutecny konec klipu (Premiere zaokrouhli na snimky zdroje) - jinak vznikaji 1snimkove mezery
      cursor = snap(main.end + gap, fd);
    }
    if (a.open !== false) activate(seq);
    return { sequenceID: seq.sequenceID, name: seq.name, duration: r3(cursor), segments: placed.length, placed: placed, warnings: warnings };
  };

  function removeLinkedAudio(seq, item, at, fd) {
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var cl = seq.audioTracks[t].clips;
      for (var j = cl.numItems - 1; j >= 0; j--) {
        try {
          if (cl[j].projectItem && cl[j].projectItem.nodeId === item.nodeId && Math.abs(cl[j].start.seconds - at) < fd / 2) cl[j].remove(false, false);
        } catch (e) {}
      }
    }
  }

  /* Klipy na presne pozice: [{kind:'video'|'audio', source, in, at, dur, track, videoOnly}].
     Nejdriv obraz (bez zvuku kamer), potom zvuk - zvuk tak nic neprepise. */
  api.buildTimeline = function (a) {
    var clips = a.clips, i;
    if (!clips || !clips.length) throw new Error('No clips');
    var cache = {};
    function item(src) {
      if (!cache[src]) cache[src] = resolveItem(src, true);
      return cache[src];
    }
    var tmplClip = clips[0];
    for (i = 0; i < clips.length; i++) if (clips[i].kind !== 'audio') { tmplClip = clips[i]; break; }
    var seq = app.project.createNewSequenceFromClips(a.name || 'AI multicam', [item(tmplClip.source)], app.project.getInsertionBin());
    if (!seq) throw new Error('createNewSequenceFromClips failed');
    clearSequence(seq);
    var fd = frameDur(seq), placed = 0, warnings = [];
    var order = [];
    for (i = 0; i < clips.length; i++) if (clips[i].kind !== 'audio') order.push(clips[i]);
    for (i = 0; i < clips.length; i++) if (clips[i].kind === 'audio') order.push(clips[i]);
    for (i = 0; i < order.length; i++) {
      var c = order[i];
      try {
        var it = item(c.source);
        var atS = snap(c.at, fd), endS = snap(c.at + c.dur, fd);
        if (endS - atS < fd) continue;
        var inS = Math.max(0, snap(c['in'], fd));
        var kind = c.kind === 'audio' ? 'audio' : 'video';
        placeRange(seq, it, inS, inS + (endS - atS), atS, kind, c.track || 0);
        if (kind === 'video' && c.videoOnly) removeLinkedAudio(seq, it, atS, fd);
        placed++;
      } catch (e) {
        if (warnings.length < 20) warnings.push(c.kind + ' ' + c.source + ' @' + r3(c.at) + ': ' + (e.message || e));
      }
    }
    // zaokrouhleni na snimky kamer s necelociselnym posunem muze nechat 1snimkovou mezeru - dotahni konec klipu
    var closed = 0;
    for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
      var vc = seq.videoTracks[vt].clips;
      for (var q = 0; q + 1 < vc.numItems; q++) {
        var gapS = vc[q + 1].start.seconds - vc[q].end.seconds;
        if (gapS > EPS && gapS <= 2 * fd + EPS) {
          try { vc[q].end = timeObj(vc[q + 1].start.seconds); closed++; } catch (e) { warnings.push('gap close failed @' + r3(vc[q].end.seconds)); }
        }
      }
    }
    if (a.open !== false) activate(seq);
    return { sequenceID: seq.sequenceID, name: seq.name, duration: r3(Number(seq.end) / TICKS), clips: placed, total: order.length, gapsClosed: closed, warnings: warnings };
  };

  api.razor = function (a) {
    var seq = getSeq(a.sequence);
    activate(seq);
    var fd = frameDur(seq), done = [];
    for (var i = 0; i < a.times.length; i++) done.push(razorAll(seq, snap(a.times[i], fd)));
    return { cuts: done };
  };

  /* Vyrizne casove useky ze vsech stop. ripple = posune nasledujici klipy (vsechny stopy stejne, sync zustane). */
  api.removeRanges = function (a) {
    var seq = getSeq(a.sequence);
    activate(seq);
    var fd = frameDur(seq), ripple = a.ripple !== false;
    var ranges = [], i;
    for (i = 0; i < a.ranges.length; i++) {
      var s = snap(a.ranges[i].start, fd), e = snap(a.ranges[i].end, fd);
      if (e - s >= fd) ranges.push({ start: s, end: e });
    }
    ranges.sort(function (p, q) { return q.start - p.start; });
    var removed = 0, shifted = 0;
    for (i = 0; i < ranges.length; i++) {
      var rs = ranges[i].start, re = ranges[i].end;
      var tcs = razorAll(seq, rs), tce = razorAll(seq, re);
      // pojistka: kdyby razor rezal jinde, nic nemazat ani neposouvat
      var straddle = null;
      eachClip(seq, function (c) {
        var cs = c.start.seconds, ce = c.end.seconds;
        if ((cs < rs - fd / 2 && ce > rs + fd / 2) || (cs < re - fd / 2 && ce > re + fd / 2)) straddle = c.name + ' ' + r3(cs) + '-' + r3(ce);
      });
      if (straddle) throw new Error('Razor failed at ' + r3(rs) + '/' + r3(re) + 's (QE timecode ' + tcs + '/' + tce + '), clip still spans the cut: ' + straddle + '. Nothing was removed.');
      eachClip(seq, function (c) {
        var cs = c.start.seconds, ce = c.end.seconds;
        if (cs >= rs - EPS && ce <= re + EPS && ce - cs > EPS) { c.remove(false, false); removed++; }
      });
      if (ripple) {
        var d = re - rs, later = [];
        eachClip(seq, function (c) { if (c.start.seconds >= re - EPS) later.push({ clip: c, orig: c.start.seconds }); });
        later.sort(function (p, q) { return p.orig - q.orig; });
        for (var k = 0; k < later.length; k++) {
          var cl = later[k].clip;
          // propojeny klip se mohl posunout spolu s partnerem - posun jen jednou
          if (Math.abs(cl.start.seconds - later[k].orig) < EPS) { cl.move(timeObj(-d)); shifted++; }
        }
      }
    }
    return { removed: removed, shifted: shifted, ranges: ranges.length, duration: r3(Number(seq.end) / TICKS) };
  };

  api.removeClips = function (a) {
    var seq = getSeq(a.sequence), list = a.clips.slice(0), n = 0;
    list.sort(function (p, q) { return q.index - p.index; });
    for (var i = 0; i < list.length; i++) {
      var tracks = list[i].kind === 'audio' ? seq.audioTracks : seq.videoTracks;
      var c = tracks[list[i].track].clips[list[i].index];
      if (!c) throw new Error('Clip not found: ' + toJSON(list[i]));
      c.remove(!!a.ripple, true);
      n++;
    }
    return { removed: n };
  };

  api.addMarkers = function (a) {
    var seq = getSeq(a.sequence), n = 0;
    for (var i = 0; i < a.markers.length; i++) {
      var m = a.markers[i];
      var mk = seq.markers.createMarker(m.time);
      if (m.name) mk.name = m.name;
      if (m.comment) mk.comments = m.comment;
      if (m.duration) { try { mk.end = m.time + m.duration; } catch (e) { mk.end = timeObj(m.time + m.duration); } }
      if (m.color !== undefined) { try { mk.setColorByIndex(m.color); } catch (e) {} }
      n++;
    }
    return { added: n };
  };

  api.getMarkers = function (a) {
    var seq = getSeq(a.sequence), out = [];
    var m = seq.markers.getFirstMarker();
    while (m) {
      out.push({ name: m.name, comment: m.comments, start: r3(m.start.seconds), end: r3(m.end.seconds), type: m.type });
      m = seq.markers.getNextMarker(m);
    }
    return out;
  };

  api.setPlayhead = function (a) {
    var seq = getSeq(a.sequence);
    seq.setPlayerPosition(ticks(a.time));
    return { playhead: r3(seq.getPlayerPosition().seconds) };
  };

  api.exportSequence = function (a) {
    var seq = getSeq(a.sequence);
    var wa = a.range === 'inout' ? 1 : (a.range === 'workarea' ? 2 : 0);
    // Premiere 26 export odmita cesty s '/', vraci jen "Unknown Error" - vzdy zpetna lomitka
    var output = String(a.output).replace(/\//g, '\\');
    var preset = String(a.preset).replace(/\//g, '\\');
    if (!new File(preset).exists) throw new Error('Export preset not found: ' + preset);
    var outFolder = new File(output).parent;
    if (outFolder && !outFolder.exists) outFolder.create();
    if (a.useAME) {
      app.encoder.launchEncoder();
      var job = app.encoder.encodeSequence(seq, output, preset, wa, 1);
      app.encoder.startBatch();
      return { queuedInAME: true, jobID: job, output: output };
    }
    var res = seq.exportAsMediaDirect(output, preset, wa);
    var f = new File(output);
    if (!f.exists) throw new Error('Export failed: ' + res);
    return { result: String(res), output: output, sizeMB: r3(f.length / 1048576) };
  };

  api.saveProject = function () { needProject(); app.project.save(); return { saved: app.project.path }; };

  api.undo = function () {
    needProject();
    app.enableQE();
    qe.project.undo();
    return { undone: true };
  };

  api.addCaptions = function (a) {
    var seq = getSeq(a.sequence);
    if (!a.srtPath) throw new Error('Missing srtPath');
    var item = resolveItem(a.srtPath, true);
    var ok = seq.createCaptionTrack(item, 0);
    if (!ok) throw new Error('createCaptionTrack failed');
    return { added: true, sequence: seq.name };
  };

  api.detectSceneCuts = function (a) {
    needProject();
    if (!a.source) throw new Error('Missing source');
    var item = resolveItem(a.source, true);
    var seq = app.project.createNewSequenceFromClips('SCENE DETECT ' + item.name, [item], app.project.getInsertionBin());
    if (!seq) throw new Error('Nepodařilo se vytvořit dočasnou sekvenci.');
    var vt = seq.videoTracks[0].clips[0];
    var at = seq.audioTracks[0] && seq.audioTracks[0].clips.numItems ? seq.audioTracks[0].clips[0] : null;
    if (a.to !== undefined && a.to > 0 && a.to < vt.end.seconds) {
      vt.end = timeObj(a.to);
      vt.outPoint = timeObj(a.to);
      if (at) { at.end = timeObj(a.to); at.outPoint = timeObj(a.to); }
    }
    vt.setSelected(true, true);
    var ok = seq.performSceneEditDetectionOnSelection('CreateMarkers', false, a.sensitivity || 'LowSensitivity');
    if (!ok) throw new Error('performSceneEditDetectionOnSelection selhalo.');
    var mk = vt.projectItem.getMarkers();
    var cuts = [];
    var m = mk.getFirstMarker();
    while (m) { cuts.push(r3(m.start.seconds)); m = mk.getNextMarker(m); }
    return { sequence: seq.name, sequenceID: seq.sequenceID, analyzed: r3(vt.end.seconds), cuts: cuts, count: cuts.length };
  };

  PMCP.api = api;
  PMCP.toJSON = toJSON;
  PMCP.call = function (name, argsJson) {
    try {
      var fn = api[name];
      if (!fn) throw new Error('Unknown function: ' + name);
      var args = argsJson ? eval('(' + argsJson + ')') : {};
      return toJSON({ ok: true, result: fn(args || {}) });
    } catch (e) {
      return toJSON({ ok: false, error: String(e && e.message ? e.message : e), line: e && e.line });
    }
  };
})();
