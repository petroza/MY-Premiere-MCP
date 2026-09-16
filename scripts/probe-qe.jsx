(function () {
  var out = [];
  function add(k, v) { out.push(k + ' = ' + v); }
  function tryAdd(k, fn) { try { add(k, fn()); } catch (e) { add(k, 'ERR ' + e); } }

  var s = app.project.activeSequence;
  var st = s.getSettings();
  add('seq', s.name);
  add('videoDisplayFormat', st.videoDisplayFormat);
  add('videoFrameRate.seconds', st.videoFrameRate.seconds);
  add('videoFrameRate.ticks', st.videoFrameRate.ticks);
  tryAdd('timebase', function () { return s.timebase; });
  var t = new Time();
  t.seconds = 2;
  tryAdd('getFormatted(2s)', function () { return t.getFormatted(st.videoFrameRate, st.videoDisplayFormat); });
  tryAdd('playhead(DOM)', function () { return s.getPlayerPosition().seconds; });

  app.enableQE();
  var qs = qe.project.getActiveSequence();
  tryAdd('qe.seq.name', function () { return qs.name; });
  tryAdd('qe.CTI.timecode', function () { return qs.CTI.timecode; });
  tryAdd('qe.CTI.ticks', function () { return qs.CTI.ticks; });
  tryAdd('qe.CTI.secs', function () { return qs.CTI.secs; });
  tryAdd('qe.CTI.frames', function () { return qs.CTI.frames; });
  tryAdd('qe.seq props', function () { return qs.reflect.properties.join(','); });
  tryAdd('qe.seq methods', function () { return qs.reflect.methods.join(','); });
  var tr = qs.getVideoTrackAt(0);
  tryAdd('qe.track methods', function () { return tr.reflect.methods.join(','); });
  tryAdd('qe.track.razor args', function () {
    var m = tr.reflect.find('razor');
    var a = [];
    for (var i = 0; i < m.arguments.length; i++) a.push(m.arguments[i].name + ':' + m.arguments[i].dataType);
    return a.join(', ');
  });
  tryAdd('qe.CTI props', function () { return qs.CTI.reflect.properties.join(','); });
  return out.join('\n');
})();
