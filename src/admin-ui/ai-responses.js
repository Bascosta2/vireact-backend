/* Vireact AI response review. Served by the backend at /admin/ai; talks to /api/v1/admin/ai-responses
 * on the same origin with the x-admin-key header. The key lives in sessionStorage only.
 * Everything from the server is rendered through esc(): prompts and outputs contain user-typed text. */
(function () {
  'use strict';
  var API = '/api/v1/admin';
  var KEY_STORE = 'vireactAiReviewKey';
  var PAGE = 50;
  var key = '';
  try { key = sessionStorage.getItem(KEY_STORE) || ''; } catch (e) { key = ''; }
  var state = { skip: 0, total: 0, items: [], selectedId: null };

  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function int(n) { return n == null ? '–' : Number(n).toLocaleString(); }
  function ms(v) { return v == null ? '–' : (v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms'); }
  function usd(c) { return c == null ? '–' : '$' + (c < 0.01 ? Number(c).toFixed(4) : Number(c).toFixed(2)); }
  function pct(part, whole) { return whole ? Math.round((part / whole) * 100) + '%' : '–'; }
  function when(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function setKey(value) {
    key = value || '';
    try { if (key) sessionStorage.setItem(KEY_STORE, key); else sessionStorage.removeItem(KEY_STORE); } catch (e) { /* private mode */ }
  }

  function showLogin(message) {
    setKey('');
    $('#app').classList.add('hidden');
    $('#signout').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#login-msg').textContent = message || '';
    // Drop anything already rendered.
    ['#tiles', '#o-rows', '#rows', '#d-meta', '#d-output', '#d-input', '#d-trace', '#d-issues'].forEach(function (s) { $(s).innerHTML = ''; });
    $('#detail').classList.add('hidden');
  }

  function showApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#signout').classList.remove('hidden');
  }

  function api(path, options) {
    var opts = options || {};
    var headers = { 'x-admin-key': key };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'omit', cache: 'no-store' })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (res.status === 401) showLogin('Signed out: the server did not accept the key.');
          return { ok: res.ok, status: res.status, data: data };
        });
      });
  }
  function errText(out) {
    if (out.status === 429) return 'Too many requests. Wait a minute.';
    return (out.data && (out.data.error || out.data.message)) || ('HTTP ' + out.status);
  }

  function badges(it) {
    var b = [it.isError ? '<span class="badge err">error</span>' : '<span class="badge ok">ok</span>'];
    var v = it.validation && it.validation.status;
    if (v === 'failed') b.push('<span class="badge warn">gate failed</span>');
    if (v === 'passed') b.push('<span class="badge ok">gate passed</span>');
    if (it.attempt > 1) b.push('<span class="badge">retry ' + esc(it.attempt) + '</span>');
    var r = it.review && it.review.rating;
    if (r === 'good') b.push('<span class="badge ok">rated good</span>');
    if (r === 'bad') b.push('<span class="badge err">rated bad</span>');
    return b.join(' ');
  }

  function fillSelect(sel, values, allLabel) {
    var el = $(sel);
    var current = el.value;
    var list = (values || []).filter(Boolean);
    if (current && list.indexOf(current) === -1) list.push(current);
    el.innerHTML = '<option value="">' + esc(allLabel) + '</option>' + list.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
    el.value = current;
  }

  // ---- Overview ----
  function loadOverview() {
    $('#o-msg').textContent = 'Loading…';
    return api('/ai-responses/stats?hours=' + encodeURIComponent($('#o-hours').value)).then(function (out) {
      if (!out.ok) { $('#o-msg').textContent = 'Could not load overview: ' + errText(out); return; }
      var d = out.data, t = d.totals;
      $('#o-msg').textContent = t.calls ? '' : 'No AI calls recorded in this window yet.';
      var tiles = [
        ['Calls', int(t.calls), int(t.errors) + ' errors (' + pct(t.errors, t.calls) + ')'],
        ['Input tokens', int(t.inputTokens), t.calls ? 'avg ' + int(Math.round(t.inputTokens / t.calls)) + ' / call' : ''],
        ['Output tokens', int(t.outputTokens), t.calls ? 'avg ' + int(Math.round(t.outputTokens / t.calls)) + ' / call' : ''],
        ['Cost', t.costUsd ? usd(t.costUsd) : '–', t.costUsd ? 'priced models only' : 'set AI_MODEL_PRICES or see PostHog'],
        ['Quality gate', pct(t.validationChecked - t.validationFailed, t.validationChecked) + ' pass', int(t.validationFailed) + ' of ' + int(t.validationChecked) + ' failed'],
        ['Your reviews', int(t.ratedGood + t.ratedBad), int(t.ratedGood) + ' good · ' + int(t.ratedBad) + ' bad']
      ];
      $('#tiles').innerHTML = tiles.map(function (x) {
        return '<div class="tile"><div class="k">' + esc(x[0]) + '</div><div class="v">' + esc(x[1]) + '</div><div class="s">' + esc(x[2]) + '</div></div>';
      }).join('');
      $('#o-rows').innerHTML = d.rows.map(function (r, i) {
        return '<tr class="click" data-i="' + i + '" title="Show these responses">' +
          '<td>' + esc(r.feature) + '</td><td>' + esc(r.label) + '</td><td class="nowrap">' + esc(r.model) + '</td>' +
          '<td class="num">' + int(r.calls) + '</td>' +
          '<td class="num">' + (r.errors ? '<span class="badge err">' + int(r.errors) + '</span>' : '0') + '</td>' +
          '<td class="num">' + int(Math.round(r.inputTokens / r.calls)) + '</td>' +
          '<td class="num">' + int(Math.round(r.outputTokens / r.calls)) + '</td>' +
          '<td class="num">' + ms(r.avgLatencyMs) + '</td>' +
          '<td class="num">' + (r.validationChecked ? pct(r.validationFailed, r.validationChecked) : '–') + '</td>' +
          '<td class="num">' + (r.ratedGood || r.ratedBad ? int(r.ratedGood) + ' good · ' + int(r.ratedBad) + ' bad' : '–') + '</td>' +
          '<td class="num">' + usd(r.costUsd) + '</td></tr>';
      }).join('');
      $$('#o-rows tr.click').forEach(function (tr) {
        tr.addEventListener('click', function () {
          var r = d.rows[Number(tr.getAttribute('data-i'))];
          clearFilters();
          $('#f-feature').value = r.feature || '';
          $('#f-label').value = r.label || '';
          $('#f-model').value = r.model || '';
          var h = $('#o-hours').value;
          $('#f-hours').value = ['1', '24', '168', '720'].indexOf(h) !== -1 ? h : '';
          loadList(0);
        });
      });
      fillSelect('#f-feature', d.facets.features, 'All features');
      fillSelect('#f-label', d.facets.labels, 'All calls');
      fillSelect('#f-model', d.facets.models, 'All models');
    }).catch(function (e) { $('#o-msg').textContent = 'Could not reach the server: ' + e.message; });
  }

  // ---- List ----
  var FILTERS = { feature: '#f-feature', label: '#f-label', model: '#f-model', status: '#f-status', validation: '#f-validation',
    rating: '#f-rating', hours: '#f-hours', q: '#f-q', userId: '#f-user', videoId: '#f-video', traceId: '#f-trace' };

  function query(skip) {
    var p = new URLSearchParams();
    Object.keys(FILTERS).forEach(function (k) { var v = $(FILTERS[k]).value.trim(); if (v) p.set(k, v); });
    p.set('limit', String(PAGE));
    p.set('skip', String(skip));
    return p.toString();
  }
  function clearFilters() {
    Object.keys(FILTERS).forEach(function (k) { $(FILTERS[k]).value = ''; });
    $('#f-hours').value = '24';
  }

  function loadList(skip) {
    state.skip = Math.max(0, skip || 0);
    $('#list-msg').textContent = 'Loading…';
    return api('/ai-responses?' + query(state.skip)).then(function (out) {
      if (!out.ok) { $('#list-msg').textContent = 'Could not load responses: ' + errText(out); return; }
      state.items = out.data.items || [];
      state.total = out.data.total || 0;
      $('#list-msg').textContent = state.total ? '' : 'No responses match these filters.';
      renderRows();
    }).catch(function (e) { $('#list-msg').textContent = 'Could not reach the server: ' + e.message; });
  }

  function renderRows() {
    $('#rows').innerHTML = state.items.map(function (it) {
      return '<tr class="click' + (String(it._id) === state.selectedId ? ' selected' : '') + '" data-id="' + esc(it._id) + '">' +
        '<td class="nowrap">' + esc(when(it.createdAt)) + '</td>' +
        '<td>' + esc(it.feature) + '<br><span class="sub-label">' + esc(it.label) + '</span></td>' +
        '<td class="nowrap">' + esc(it.model) + '</td>' +
        '<td class="num">' + int(it.inputTokens) + ' → ' + int(it.outputTokens) + '</td>' +
        '<td class="num">' + ms(it.latencyMs) + '</td>' +
        '<td class="num">' + usd(it.costUsd) + '</td>' +
        '<td>' + badges(it) + '</td>' +
        '<td><div class="preview">' + esc(it.outputPreview || it.error) + '</div></td></tr>';
    }).join('');
    $$('#rows tr.click').forEach(function (tr) { tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-id')); }); });
    var from = state.total ? state.skip + 1 : 0;
    var to = Math.min(state.skip + PAGE, state.total);
    $('#page-info').textContent = from + '–' + to + ' of ' + state.total.toLocaleString();
    $('#prev').disabled = state.skip === 0;
    $('#next').disabled = to >= state.total;
  }

  // ---- Detail ----
  function pretty(text) {
    if (!text) return '';
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }
  function contentText(c) { return typeof c === 'string' ? c : JSON.stringify(c, null, 2); }
  function msgBlock(role, text) {
    return '<div class="msg"><div class="role"><span>' + esc(role) + '</span><span>' + int(text.length) + ' chars</span></div><pre>' + esc(text) + '</pre></div>';
  }
  function filterLink(kind, value) {
    return value ? '<button type="button" class="link" data-filter="' + esc(kind) + '" data-v="' + esc(value) + '">' + esc(value) + '</button>' : '–';
  }

  function openDetail(id) {
    state.selectedId = String(id);
    renderRows();
    return api('/ai-responses/' + encodeURIComponent(id)).then(function (out) {
      if (!out.ok) { $('#list-msg').textContent = 'Could not load response: ' + errText(out); return; }
      var it = out.data.item;
      var p = it.params || {};
      $('#detail').classList.remove('hidden');
      $('#d-heading').textContent = (it.feature || '') + ' · ' + (it.label || 'response');
      $('#d-badges').innerHTML = badges(it);
      var meta = [
        ['When', esc(when(it.createdAt))],
        ['Model', esc((it.provider || '') + ' / ' + (it.model || ''))],
        ['Tokens in / out', int(it.inputTokens) + ' / ' + int(it.outputTokens)],
        ['Cached in / reasoning', int(it.cachedInputTokens) + ' / ' + int(it.reasoningTokens)],
        ['Latency', ms(it.latencyMs)],
        ['Cost', usd(it.costUsd)],
        ['Stop reason', esc(it.stopReason || '–')],
        ['Settings', 'temp ' + esc(p.temperature == null ? '–' : p.temperature) + ' · max ' + int(p.maxTokens) + (p.reasoningEffort ? ' · effort ' + esc(p.reasoningEffort) : '')],
        ['Attempt', esc(it.attempt || 1)],
        ['User', it.userId ? filterLink('user', it.userId) : esc(it.distinctId || '–')],
        ['Video', filterLink('video', it.videoId)],
        ['Trace', filterLink('trace', it.traceId)]
      ];
      $('#d-meta').innerHTML = meta.map(function (m) { return '<div><span class="k">' + m[0] + ':</span> ' + m[1] + '</div>'; }).join('');
      $$('#d-meta .link').forEach(function (a) {
        a.addEventListener('click', function () {
          clearFilters();
          $('#f-hours').value = '';
          $({ user: '#f-user', video: '#f-video', trace: '#f-trace' }[a.getAttribute('data-filter')]).value = a.getAttribute('data-v');
          loadList(0);
        });
      });
      var errBox = $('#d-error');
      errBox.textContent = it.error || '';
      errBox.classList.toggle('hidden', !it.error);
      var issues = (it.validation && it.validation.issues) || [];
      $('#d-issues').innerHTML = issues.length
        ? '<div class="section">Quality gate issues</div><ul class="issues">' + issues.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>'
        : '';
      $('#r-note').value = (it.review && it.review.note) || '';
      $('#r-msg').textContent = it.review && it.review.reviewedAt
        ? 'Reviewed ' + when(it.review.reviewedAt) + '. Kept permanently.'
        : 'Reviewed responses are kept permanently; others are deleted after 30 days.';
      $('#d-output').innerHTML = msgBlock('assistant', pretty(it.output) || '(no output)');
      var input = it.input || [];
      $('#d-input-count').textContent = String(input.length);
      $('#d-input').innerHTML = input.map(function (m) { return msgBlock(m.role, contentText(m.content)); }).join('');
      $('#d-trace').innerHTML = (out.data.trace || []).map(function (t) {
        return '<tr class="click' + (String(t._id) === String(it._id) ? ' selected' : '') + '" data-id="' + esc(t._id) + '">' +
          '<td class="nowrap">' + esc(when(t.createdAt)) + '</td><td>' + esc(t.label) + '</td>' +
          '<td class="num">' + esc(t.attempt || 1) + '</td><td class="num">' + int(t.totalTokens) + '</td><td class="num">' + ms(t.latencyMs) + '</td>' +
          '<td>' + badges(t) + '</td></tr>';
      }).join('');
      $$('#d-trace tr.click').forEach(function (tr) { tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-id')); }); });
      $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { $('#list-msg').textContent = 'Could not reach the server: ' + e.message; });
  }

  function saveReview(rating, clear) {
    if (!state.selectedId) return;
    var note = clear ? '' : $('#r-note').value;
    $('#r-msg').textContent = 'Saving…';
    api('/ai-responses/' + encodeURIComponent(state.selectedId) + '/review', { method: 'PATCH', body: { rating: rating, note: note } }).then(function (out) {
      if (!out.ok) { $('#r-msg').textContent = 'Could not save: ' + errText(out); return; }
      var r = out.data.review;
      if (!r.kept) $('#r-note').value = '';
      $('#r-msg').textContent = r.kept ? 'Saved' + (r.rating ? ' as ' + r.rating : '') + '. Kept permanently.' : 'Review cleared. Deleted after 30 days like the rest.';
      var row = state.items.filter(function (x) { return String(x._id) === state.selectedId; })[0];
      if (row) { row.review = { rating: r.rating, note: r.note }; renderRows(); }
      $('#d-badges').innerHTML = badges(Object.assign({}, row || {}, { review: { rating: r.rating } }));
    }).catch(function (e) { $('#r-msg').textContent = 'Could not reach the server: ' + e.message; });
  }

  function start() {
    showApp();
    return loadOverview().then(function () { if (key) return loadList(0); });
  }

  // ---- Wiring ----
  $('#login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var value = $('#login-key').value.trim();
    if (!value) return;
    setKey(value);
    $('#login-key').value = '';
    $('#login-msg').textContent = 'Checking…';
    api('/ping').then(function (out) {
      if (out.ok) { $('#login-msg').textContent = ''; start(); }
      else if (out.status !== 401) showLogin('Could not sign in: ' + errText(out));
    }).catch(function (err) { showLogin('Could not reach the server: ' + err.message); });
  });
  $('#signout').addEventListener('click', function () { showLogin('Signed out.'); });
  $('#o-load').addEventListener('click', loadOverview);
  $('#o-hours').addEventListener('change', loadOverview);
  $('#f-load').addEventListener('click', function () { loadList(0); });
  $('#f-clear').addEventListener('click', function () { clearFilters(); loadList(0); });
  $('#prev').addEventListener('click', function () { loadList(state.skip - PAGE); });
  $('#next').addEventListener('click', function () { loadList(state.skip + PAGE); });
  ['#f-q', '#f-user', '#f-video', '#f-trace'].forEach(function (s) {
    $(s).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); loadList(0); } });
  });
  $('#r-good').addEventListener('click', function () { saveReview('good'); });
  $('#r-bad').addEventListener('click', function () { saveReview('bad'); });
  $('#r-clear').addEventListener('click', function () { saveReview(null, true); });

  if (key) {
    api('/ping').then(function (out) { if (out.ok) start(); else if (out.status !== 401) showLogin(errText(out)); })
      .catch(function (err) { showLogin('Could not reach the server: ' + err.message); });
  }
})();
