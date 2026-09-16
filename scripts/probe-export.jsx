(function () {
  var out = [];
  var seq = app.project.activeSequence;
  out.push('seq=' + (seq ? seq.name : 'null'));
  var presetFwd = 'C:/Program Files/Adobe/Adobe Premiere Pro 2026/MediaIO/systempresets/4E49434B_48323634/01 - Match Source - High bitrate.epr';
  var presetBack = presetFwd.replace(/\//g, '\\');
  var outDir = new Folder('O:/MYpremiereMCP/test/export');
  out.push('preset exists=' + new File(presetFwd).exists + ' outDir exists=' + outDir.exists);
  out.push('encoder=' + typeof app.encoder + ' ENCODE_ENTIRE=' + app.encoder.ENCODE_ENTIRE);
  var tries = [
    ['fwd', 'O:/MYpremiereMCP/test/export/probe_fwd.mp4', presetFwd, 0],
    ['back', 'O:\\MYpremiereMCP\\test\\export\\probe_back.mp4', presetBack, 0],
    ['back-const', 'O:\\MYpremiereMCP\\test\\export\\probe_const.mp4', presetBack, app.encoder.ENCODE_ENTIRE]
  ];
  for (var i = 0; i < tries.length; i++) {
    try {
      var r = seq.exportAsMediaDirect(tries[i][1], tries[i][2], tries[i][3]);
      out.push(tries[i][0] + ' -> ' + r + ' exists=' + new File(tries[i][1]).exists);
      if (new File(tries[i][1]).exists) break;
    } catch (e) {
      out.push(tries[i][0] + ' EXC ' + e);
    }
  }
  return out.join('\n');
})();
