/* Vireact editor training data (viral examples + sound library). Served at /admin/editor; talks to
 * /api/v1/admin/editor/* on the same origin with the x-admin-key header (sessionStorage only).
 * Everything from the server is rendered through esc(). */
(function () {
  'use strict';
  var API = '/api/v1/admin/editor';
  var KEY_STORE = 'vireactAiReviewKey';
  var key = '';
  try { key = sessionStorage.getItem(KEY_STORE) || ''; } catch (e) { key = ''; }
  var pollTimer = null;

  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function int(n) { return n == null ? '–' : Number(n).toLocaleString(); }
  function setKey(v) {
    key = v || '';
    try { if (key) sessionStorage.setItem(KEY_STORE, key); else sessionStorage.removeItem(KEY_STORE); } catch (e) { /* private mode */ }
  }
  function errMsg(data, fallback) { return (data && (data.message || data.error)) || fallback; }

  function showLogin(message) {
    setKey('');
    if (pollTimer) clearTimeout(pollTimer);
    $('#app').classList.add('hidden');
    $('#signout').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#login-msg').textContent = message || '';
    $('#ex-rows').innerHTML = '';
    $('#snd-rows').innerHTML = '';
  }
  function showApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#signout').classList.remove('hidden');
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'x-admin-key': key };
    if (opts.json) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.json ? JSON.stringify(opts.json) : undefined, credentials: 'omit', cache: 'no-store' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 401) showLogin('Signed out: the server did not accept the key.');
          return { ok: res.ok, status: res.status, data: data };
        });
      });
  }

  /** Multipart upload with progress (fetch has no upload progress). */
  function upload(path, form, onProgress) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', API + path);
      xhr.setRequestHeader('x-admin-key', key);
      xhr.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = function () {
        var data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = {}; }
        if (xhr.status === 401) showLogin('Signed out: the server did not accept the key.');
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: data });
      };
      xhr.onerror = function () { resolve({ ok: false, status: 0, data: { message: 'Network error. Check the connection and try again.' } }); };
      xhr.send(form);
    });
  }

  // ---------- Tabs ----------
  function selectTab(name) {
    $('#tab-examples').setAttribute('aria-selected', String(name === 'examples'));
    $('#tab-sounds').setAttribute('aria-selected', String(name === 'sounds'));
    $('#panel-examples').classList.toggle('hidden', name !== 'examples');
    $('#panel-sounds').classList.toggle('hidden', name !== 'sounds');
    if (name === 'sounds') loadSounds(); else loadExamples();
  }

  // ---------- Examples ----------
  function badge(status) {
    var cls = status === 'ready' ? 'ok' : status === 'failed' ? 'err' : status === 'pending' ? 'warn' : '';
    var label = status === 'pending' ? 'profiling…' : status;
    return '<span class="badge ' + cls + '">' + esc(label) + '</span>';
  }

  function loadExamples() {
    return api('/examples').then(function (r) {
      if (!r.ok) { $('#ex-msg').textContent = errMsg(r.data, 'Could not load examples.'); return; }
      var d = r.data;
      var cfg = [];
      if (!d.claude) cfg.push('ANTHROPIC_API_KEY is not set, so new examples cannot be profiled yet.');
      if (!d.storage) cfg.push('S3 storage is not set up: examples still work, but their files are not kept, so they cannot be re-profiled later.');
      $('#ex-config').textContent = cfg.join(' ');
      $('#ex-config').classList.toggle('hidden', cfg.length === 0);
      $('#ex-tiles').innerHTML =
        '<div class="tile"><div class="k">Examples</div><div class="v">' + int(d.counts.total) + '</div></div>' +
        '<div class="tile"><div class="k">Profiled, used by the editor</div><div class="v">' + int(d.counts.ready) + '</div></div>';
      $('#ex-rows').innerHTML = d.examples.map(function (e) {
        var p = e.profile;
        var learn = p ? esc(p.summary) + '<div class="sub-label" style="font-size:12px;margin-top:4px">' + esc(p.durationSec) + 's · shot ' + esc(p.avgShotSec) + 's · ' + esc(p.cutsPerMin) + ' cuts/min · ' + esc(p.speechWpm) + ' wpm · captions ' + esc(p.captionDensity) + '</div>' : (e.error ? '<span style="color:var(--err)">' + esc(e.error) + '</span>' : '');
        return '<tr data-id="' + esc(e.id) + '">' +
          '<td>' + esc(e.filename) + '</td>' +
          '<td>' + esc(e.platform) + (e.niche ? ' · ' + esc(e.niche) : '') + '</td>' +
          '<td class="num">' + int(e.actualViews) + '</td>' +
          '<td class="num">' + int(e.shares) + '</td>' +
          '<td>' + badge(e.status) + '</td>' +
          '<td class="summary">' + learn + '</td>' +
          '<td class="row" style="flex-wrap:nowrap">' +
            (e.canReprofile && e.status !== 'pending' ? '<button type="button" class="secondary small" data-act="reprofile">Re-profile</button>' : '') +
            '<button type="button" class="secondary small" data-act="delete">Delete</button>' +
          '</td></tr>';
      }).join('') || '<tr><td colspan="7" class="helper">No examples yet.</td></tr>';
      if (pollTimer) clearTimeout(pollTimer);
      if (d.examples.some(function (e) { return e.status === 'pending'; })) pollTimer = setTimeout(loadExamples, 8000);
    });
  }

  function submitExample(ev) {
    ev.preventDefault();
    var file = $('#ex-file').files[0];
    if (!file) return;
    var form = new FormData();
    form.append('file', file);
    [['platform', '#ex-platform'], ['niche', '#ex-niche'], ['actualViews', '#ex-views'], ['followers', '#ex-followers'], ['likes', '#ex-likes'], ['comments', '#ex-comments'], ['shares', '#ex-shares'], ['saves', '#ex-saves'], ['retentionRate', '#ex-retention'], ['postedAt', '#ex-posted'], ['creatorHandle', '#ex-handle']]
      .forEach(function (f) { var v = $(f[1]).value.trim(); if (v) form.append(f[0], v); });
    $('#ex-submit').disabled = true;
    $('#ex-progress').classList.remove('hidden');
    $('#ex-msg').textContent = 'Uploading…';
    upload('/examples', form, function (pct) { $('#ex-progress').value = pct; }).then(function (r) {
      $('#ex-submit').disabled = false;
      $('#ex-progress').classList.add('hidden');
      if (!r.ok) { $('#ex-msg').textContent = errMsg(r.data, 'Upload failed.'); return; }
      $('#ex-msg').textContent = 'Uploaded. Profiling runs in the background (about a minute).';
      $('#ex-form').reset();
      loadExamples();
    });
  }

  function exampleAction(ev) {
    var btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.closest('tr').getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'delete' && !window.confirm('Delete this example? The editor stops using it.')) return;
    btn.disabled = true;
    var req = act === 'delete' ? api('/examples/' + encodeURIComponent(id), { method: 'DELETE' }) : api('/examples/' + encodeURIComponent(id) + '/reprofile', { method: 'POST' });
    req.then(function (r) {
      if (!r.ok) window.alert(errMsg(r.data, 'That did not work.'));
      loadExamples();
    });
  }

  // ---------- Sounds ----------
  function loadSounds() {
    return api('/sounds').then(function (r) {
      if (!r.ok) { $('#snd-msg').textContent = errMsg(r.data, 'Could not load sounds.'); return; }
      var d = r.data;
      $('#snd-config').textContent = d.storage ? '' : 'S3 storage is not set up yet, so sounds cannot be added.';
      $('#snd-config').classList.toggle('hidden', d.storage);
      if (!$('#snd-mood').options.length) {
        $('#snd-mood').innerHTML = '<option value="">Pick one</option>' + d.moods.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('');
        $('#snd-sfx').innerHTML = d.sfxTypes.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('');
      }
      $('#snd-rows').innerHTML = d.sounds.map(function (s) {
        var details = s.kind === 'music' ? [s.mood, s.energy ? 'energy ' + s.energy : null, s.bpm ? s.bpm + ' bpm' : null, s.genre].filter(Boolean).join(' · ') : s.sfxType;
        return '<tr data-id="' + esc(s.id) + '">' +
          '<td>' + esc(s.title) + '</td><td><code>' + esc(s.slug) + '</code></td><td>' + esc(s.kind) + '</td>' +
          '<td>' + esc(details) + (s.durationSec ? ' · ' + esc(s.durationSec) + 's' : '') + '</td>' +
          '<td class="summary">' + esc(s.licenseSource) + (s.attribution ? '<br>' + esc(s.attribution) : '') + '</td>' +
          '<td>' + (s.active ? '<span class="badge ok">active</span>' : '<span class="badge">off</span>') + '</td>' +
          '<td><button type="button" class="secondary small" data-active="' + (s.active ? 'false' : 'true') + '">' + (s.active ? 'Turn off' : 'Turn on') + '</button></td></tr>';
      }).join('') || '<tr><td colspan="7" class="helper">No sounds yet. Without music the editor leaves music out.</td></tr>';
    });
  }

  function submitSound(ev) {
    ev.preventDefault();
    var file = $('#snd-file').files[0];
    if (!file) return;
    var kind = $('#snd-kind').value;
    var form = new FormData();
    form.append('file', file);
    form.append('kind', kind);
    var fields = [['title', '#snd-title'], ['licenseSource', '#snd-license'], ['attribution', '#snd-attr']];
    if (kind === 'music') fields = fields.concat([['mood', '#snd-mood'], ['energy', '#snd-energy'], ['bpm', '#snd-bpm'], ['genre', '#snd-genre']]);
    else fields.push(['sfxType', '#snd-sfx']);
    fields.forEach(function (f) { var v = $(f[1]).value.trim(); if (v) form.append(f[0], v); });
    $('#snd-submit').disabled = true;
    $('#snd-msg').textContent = 'Uploading…';
    upload('/sounds', form).then(function (r) {
      $('#snd-submit').disabled = false;
      if (!r.ok) { $('#snd-msg').textContent = errMsg(r.data, 'Upload failed.'); return; }
      $('#snd-msg').textContent = 'Added as ' + r.data.sound.slug + '.';
      $('#snd-form').reset();
      toggleKind();
      loadSounds();
    });
  }

  function soundAction(ev) {
    var btn = ev.target.closest('button[data-active]');
    if (!btn) return;
    btn.disabled = true;
    api('/sounds/' + encodeURIComponent(btn.closest('tr').getAttribute('data-id')), { method: 'PATCH', json: { active: btn.getAttribute('data-active') === 'true' } })
      .then(function () { loadSounds(); });
  }

  function toggleKind() {
    var music = $('#snd-kind').value === 'music';
    $$('.music-only').forEach(function (el) { el.classList.toggle('hidden', !music); });
    $$('.sfx-only').forEach(function (el) { el.classList.toggle('hidden', music); });
  }

  // ---------- Boot ----------
  function start() {
    showApp();
    selectTab('examples');
  }

  $('#login').addEventListener('submit', function (ev) {
    ev.preventDefault();
    setKey($('#key').value.trim());
    api('/examples').then(function (r) {
      if (r.ok) { $('#key').value = ''; start(); }
      else if (r.status !== 401) $('#login-msg').textContent = errMsg(r.data, 'Could not reach the server.');
    });
  });
  $('#signout').addEventListener('click', function () { showLogin(''); });
  $('#tab-examples').addEventListener('click', function () { selectTab('examples'); });
  $('#tab-sounds').addEventListener('click', function () { selectTab('sounds'); });
  $('#ex-form').addEventListener('submit', submitExample);
  $('#ex-rows').addEventListener('click', exampleAction);
  $('#snd-form').addEventListener('submit', submitSound);
  $('#snd-rows').addEventListener('click', soundAction);
  $('#snd-kind').addEventListener('change', toggleKind);

  if (key) start(); else showLogin('');
})();
