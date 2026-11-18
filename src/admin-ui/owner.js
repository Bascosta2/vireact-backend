/* Vireact owner console. Same-origin page; every data call needs a live owner session (admin key +
 * a code texted to the owner's phone). All user content is inserted as text nodes (never as HTML). The admin key is
 * kept in memory only for the sign-in request and never stored. */
(() => {
  'use strict';

  const app = document.getElementById('app');
  let session = { expiresAt: null };
  let hls = null;

  // ---------- DOM helpers (text only, never innerHTML)
  const h = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  };
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const mount = (...nodes) => { stopPlayer(); clear(app); nodes.forEach((n) => app.appendChild(n)); };

  const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const fmtDay = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const fmtNum = (n) => (n == null || !Number.isFinite(Number(n)) ? '' : Number(n).toLocaleString());
  const fmtTime = (s) => {
    if (s == null || !Number.isFinite(Number(s))) return '';
    const t = Math.max(0, Math.round(Number(s)));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };
  const fmtSize = (b) => (b ? `${(b / (1024 * 1024)).toFixed(1)} MB` : '');
  const toneOf = (s) => (s == null ? '' : s >= 70 ? 'ok' : s >= 40 ? 'warn' : 'err');
  const scoreEl = (s) => h('span', { class: `score ${toneOf(s)}`, text: s == null ? '–' : String(Math.round(s)) });
  const statusBadge = (st) => h('span', { class: `badge ${st === 'completed' ? 'ok' : st === 'failed' ? 'err' : 'warn'}`, text: st || 'unknown' });
  const safeHref = (url) => {
    try { const u = new URL(String(url)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
  };
  const extLink = (url, label) => {
    const href = safeHref(url);
    return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label || href }) : h('span', { text: url || '' });
  };
  const kv = (rows) => h('div', { class: 'kv' }, rows.filter((r) => r && r[1] != null && r[1] !== '').map(([k, v]) => [h('div', { class: 'k', text: k }), h('div', { class: 'v' }, v instanceof Node ? v : String(v))]));
  const card = (title, ...children) => h('section', { class: 'card' }, title ? h('h3', { text: title }) : null, ...children);

  // ---------- API
  class AuthError extends Error {}
  const api = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`/api/v1/owner${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Vireact-Owner': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && !path.startsWith('/session/')) throw new AuthError(json?.message || 'Sign in again.');
    if (!res.ok) throw new Error(json?.message || json?.error || `Request failed (${res.status})`);
    return json?.data;
  };
  const guard = (fn) => async (...args) => {
    try { await fn(...args); } catch (err) {
      if (err instanceof AuthError) return showSignIn('Your session ended. Sign in again.');
      showError(err);
    }
  };
  const showError = (err) => {
    const box = document.getElementById('view');
    const msg = h('div', { class: 'warnbox', text: err?.message || 'Something went wrong.' });
    if (box) { clear(box); box.appendChild(msg); } else mount(h('div', { class: 'center' }, msg));
  };

  // ---------- auth screens
  const authCard = (title, intro, ...body) => h('div', { class: 'center' }, h('div', { class: 'auth' },
    h('div', { class: 'brand' }, 'VIREACT ', h('b', { text: '·' }), ' OWNER'),
    h('h1', { text: title, style: 'margin-top:14px' }), h('p', { text: intro }), ...body));

  const showNotConfigured = (missing = []) => mount(authCard('Not set up', 'The owner console is switched off until these are set on Railway (backend service, Variables):',
    h('ul', { class: 'tight' }, (missing.length ? missing : ['server settings']).map((m) => h('li', { class: 'mono', text: m }))),
    h('p', { class: 'note', text: 'Reload this page once they are saved and the deploy has finished.' })));

  let phoneHint = null;

  // Step 1: admin key -> a code is texted to the owner's phone.
  const showSignIn = (message = '') => {
    const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Admin key' });
    const err = h('div', { class: 'error', role: 'alert', text: message });
    const send = h('button', { class: 'primary', type: 'submit', text: 'Text me a code' });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        send.disabled = true;
        try {
          const out = await api('/session/code', { method: 'POST', body: { key: key.value } });
          showCodeStep(key.value, out.sentTo);
          key.value = '';
        } catch (ex) { err.textContent = ex.message; } finally { send.disabled = false; }
      },
    },
    h('label', { text: 'Admin key' }), key, err,
    h('div', { class: 'actions' }, send));
    mount(authCard('Sign in', `Enter your admin key and we'll text a 6-digit code to ${phoneHint || 'your phone'}.`, form,
      h('p', { class: 'note', text: 'Sessions end after 30 minutes idle or 8 hours. Every sign-in and every record opened is logged.' })));
    setTimeout(() => key.focus(), 0);
  };

  // Step 2: the texted code. The admin key stays in this closure only until sign-in finishes.
  const showCodeStep = (adminKey, sentTo) => {
    const code = h('input', { class: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '10', placeholder: '000000', 'aria-label': 'Code from the text message' });
    const err = h('div', { class: 'error', role: 'alert' });
    const info = h('p', { text: `We texted a code to ${sentTo || phoneHint || 'your phone'}. It works once and expires in 10 minutes.` });
    const go = h('button', { class: 'primary', type: 'submit', text: 'Sign in' });
    const resend = h('button', { class: 'link', type: 'button', text: 'Text a new code', disabled: true });
    setTimeout(() => { resend.disabled = false; }, 30000);
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      err.textContent = '';
      try {
        const out = await api('/session/code', { method: 'POST', body: { key: adminKey } });
        info.textContent = `We texted a new code to ${out.sentTo || phoneHint || 'your phone'}.`;
      } catch (ex) { err.textContent = ex.message; }
      setTimeout(() => { resend.disabled = false; }, 30000);
    });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        go.disabled = true;
        try {
          const out = await api('/session/login', { method: 'POST', body: { key: adminKey, code: code.value } });
          adminKey = '';
          session = { expiresAt: out.expiresAt };
          route();
        } catch (ex) {
          err.textContent = ex.message;
          code.value = '';
        } finally { go.disabled = false; }
      },
    },
    info,
    h('label', { text: 'Code from the text' }), code, err,
    h('div', { class: 'actions' }, go, resend));
    mount(authCard('Check your phone', '', form,
      h('p', { class: 'note' }, h('button', { class: 'link', type: 'button', text: 'Start over', onclick: () => { adminKey = ''; showSignIn(); } }))));
    setTimeout(() => code.focus(), 0);
  };

  // ---------- shell
  const TABS = [['overview', 'Overview'], ['videos', 'Videos'], ['users', 'Users'], ['audit', 'Access log']];
  const shell = (active) => {
    const view = h('div', { id: 'view' }, h('div', { class: 'loading', text: 'Loading' }));
    const header = h('header', { class: 'top' }, h('div', { class: 'bar' },
      h('div', { class: 'brand' }, 'VIREACT ', h('b', { text: '·' }), ' OWNER'),
      h('nav', { class: 'tabs', 'aria-label': 'Sections' }, TABS.map(([id, label]) => h('button', {
        class: id === active ? 'on' : '', text: label, onclick: () => { location.hash = `#/${id}`; },
      }))),
      h('div', { class: 'right' },
        session.expiresAt ? h('span', { text: `Session ends by ${new Date(session.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` }) : null,
        h('button', { text: 'Sign out', onclick: guard(async () => { await api('/session/logout', { method: 'POST' }); showSignIn('Signed out.'); }) }))));
    mount(header, h('main', {}, view));
    return view;
  };

  // ---------- views
  const tile = (k, v, sub) => h('div', { class: 'tile' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }), sub ? h('div', { class: 'subtle', text: sub }) : null);

  const showOverview = guard(async () => {
    const view = shell('overview');
    const o = await api('/overview');
    clear(view);
    view.append(
      h('h2', { text: 'Overview' }), h('p', { class: 'muted', text: 'Everything across all accounts.' }),
      card(null, h('div', { class: 'tiles' },
        tile('Users', fmtNum(o.users), `${fmtNum(o.usersWeek)} new this week`),
        tile('Videos', fmtNum(o.videos), `${fmtNum(o.videosDay)} in the last 24 hours`),
        tile('Analyzing now', fmtNum(o.processing)),
        tile('Failed (7 days)', fmtNum(o.failedWeek)),
        tile('Real views logged', fmtNum(o.reported)))),
      card('Plans', h('div', { class: 'tiles' }, Object.entries(o.plans).map(([p, n]) => tile(p, fmtNum(n))))),
      card('Promo codes redeemed', Object.keys(o.promos).length
        ? h('div', { class: 'tiles' }, Object.entries(o.promos).map(([c, n]) => tile(c.toUpperCase(), fmtNum(n))))
        : h('p', { class: 'muted', text: 'None yet.' })));
  });

  const readQuery = () => {
    const q = location.hash.split('?')[1] || '';
    return Object.fromEntries(new URLSearchParams(q));
  };
  const setQuery = (base, params) => {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));
    const qs = new URLSearchParams(clean).toString();
    location.hash = `#/${base}${qs ? `?${qs}` : ''}`;
  };

  const videoTable = (rows, { showUser = true } = {}) => h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['', 'Video', showUser ? 'User' : null, 'Plan', 'Uploaded', 'Status', 'Score', 'Predicted', 'Real', 'Coach', 'Scripts'].filter((x) => x !== null).map((t) => h('th', { text: t })))),
    h('tbody', {}, rows.length ? rows.map((r) => h('tr', { class: 'click', onclick: () => { location.hash = `#/video/${r.id}`; } },
      h('td', {}, r.thumbnailUrl && safeHref(r.thumbnailUrl) ? h('img', { class: 'thumb', src: safeHref(r.thumbnailUrl), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'thumb' })),
      h('td', {}, h('div', { class: 't-title', title: r.title, text: r.title }), r.error ? h('div', { class: 'subtle', text: r.error }) : null),
      showUser ? h('td', {}, h('div', { text: r.user.email || r.user.id }), r.user.name ? h('div', { class: 'subtle', text: r.user.name }) : null) : null,
      h('td', {}, h('span', { class: 'badge', text: r.plan }), r.promo ? h('span', { class: 'badge accent', text: r.promo }) : null),
      h('td', { class: 'num', text: fmtDate(r.createdAt) }),
      h('td', {}, statusBadge(r.status)),
      h('td', { class: 'num' }, scoreEl(r.score)),
      h('td', { class: 'num', text: r.predicted ? fmtNum(r.predicted.expected) : '' }),
      h('td', { class: 'num', text: fmtNum(r.actualViews) }),
      h('td', { class: 'num', text: r.chat.fromUser ? `${r.chat.fromUser} asked` : '' }),
      h('td', {}, r.scripts ? h('span', { class: 'badge ok', text: 'yes' }) : ''))) : h('tr', {}, h('td', { colspan: '11', class: 'muted', text: 'Nothing found.' })))));

  const pager = (data, onPage) => h('div', { class: 'pager' },
    h('span', { text: `${fmtNum(data.total)} total` }),
    h('button', { text: 'Previous', disabled: data.page <= 1, onclick: () => onPage(data.page - 1) }),
    h('span', { text: `Page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.pageSize))}` }),
    h('button', { text: 'Next', disabled: data.page * data.pageSize >= data.total, onclick: () => onPage(data.page + 1) }));

  const showVideos = guard(async () => {
    const view = shell('videos');
    const q = readQuery();
    const search = h('input', { type: 'search', placeholder: 'Search title, file name, user email or name', value: q.q || '' });
    const status = h('select', { 'aria-label': 'Status' }, [['', 'Any status'], ['completed', 'Completed'], ['processing', 'Processing'], ['queued', 'Queued'], ['pending', 'Pending'], ['failed', 'Failed']].map(([v, t]) => h('option', { value: v, text: t, selected: q.status === v })));
    const plan = h('select', { 'aria-label': 'Plan' }, [['', 'Any plan'], ['free', 'Free'], ['premium', 'Premium'], ['pro', 'Pro'], ['enterprise', 'Enterprise']].map(([v, t]) => h('option', { value: v, text: t, selected: q.plan === v })));
    const from = h('input', { type: 'date', value: q.from || '', 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: (q.to || '').slice(0, 10), 'aria-label': 'To' });
    const apply = (page = 1) => setQuery('videos', { q: search.value.trim(), status: status.value, plan: plan.value, from: from.value, to: to.value ? `${to.value}T23:59:59` : '', page: page > 1 ? page : '' });
    const filters = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); apply(); } }, search, status, plan, from, to, h('button', { class: 'primary', type: 'submit', text: 'Search' }));
    const data = await api(`/videos?${new URLSearchParams(q).toString()}`);
    clear(view);
    view.append(h('h2', { text: 'Videos' }), h('p', { class: 'muted', text: 'Every upload from every account, newest first. Open one to see everything the software produced.' }),
      filters, card(null, videoTable(data.rows), pager(data, apply)));
  });

  const showUsers = guard(async () => {
    const view = shell('users');
    const q = readQuery();
    const search = h('input', { type: 'search', placeholder: 'Search email or name', value: q.q || '' });
    const apply = (page = 1) => setQuery('users', { q: search.value.trim(), page: page > 1 ? page : '' });
    const data = await api(`/users?${new URLSearchParams(q).toString()}`);
    clear(view);
    view.append(h('h2', { text: 'Users' }),
      h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); apply(); } }, search, h('button', { class: 'primary', type: 'submit', text: 'Search' })),
      card(null, h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Email', 'Name', 'Plan', 'Videos', 'Last upload', 'Joined', 'Sign-in'].map((t) => h('th', { text: t })))),
        h('tbody', {}, data.rows.map((u) => h('tr', { class: 'click', onclick: () => { location.hash = `#/user/${u.id}`; } },
          h('td', { text: u.email }), h('td', { text: u.name || '' }),
          h('td', {}, h('span', { class: 'badge', text: u.plan }), u.promo ? h('span', { class: 'badge accent', text: u.promo }) : null, u.billed ? h('span', { class: 'badge ok', text: 'billed' }) : null),
          h('td', { class: 'num', text: fmtNum(u.videos) }), h('td', { class: 'num', text: fmtDay(u.lastVideoAt) }), h('td', { class: 'num', text: fmtDay(u.createdAt) }),
          h('td', {}, h('span', { class: 'badge', text: u.provider || 'local' }), u.verified ? null : h('span', { class: 'badge warn', text: 'unverified' }))))))),
      pager(data, apply)));
  });

  const subscriptionKv = (s) => (s ? kv([
    ['Plan', s.plan], ['Status', s.status],
    ['Promo', s.promo ? `${s.promo.code.toUpperCase()} · ${s.promo.lifetime ? 'for life' : `until ${fmtDay(s.promo.endsAt)}`}` : ''],
    ['Billed through Stripe', s.stripeSubscriptionId ? 'yes' : 'no'],
    ['Payment failed', s.paymentFailed ? `yes (${fmtDate(s.paymentFailedAt)})` : ''],
    ['Trial', s.trialEndsAt ? `ends ${fmtDate(s.trialEndsAt)}` : s.trialUsedAt ? `used ${fmtDay(s.trialUsedAt)}` : 'never used'],
    ['Period', s.currentPeriodStart ? `${fmtDay(s.currentPeriodStart)} to ${fmtDay(s.currentPeriodEnd)}` : ''],
    ['Usage this period', s.usage ? `${s.usage.videosUsed ?? 0} videos · ${s.usage.chatMessagesUsed ?? 0} coach messages` : ''],
  ]) : h('p', { class: 'muted', text: 'No subscription row (Free).' }));

  const showUser = guard(async (id) => {
    const view = shell('users');
    const d = await api(`/users/${encodeURIComponent(id)}`);
    clear(view);
    const u = d.user;
    view.append(
      h('div', { class: 'back' }, h('button', { text: 'Back', onclick: () => history.back() })),
      h('h2', { text: u.email }), h('p', { class: 'muted', text: u.name || '' }),
      h('div', { class: 'grid2' },
        card('Account', kv([
          ['User id', h('span', { class: 'mono', text: String(u._id) })], ['Name', u.name], ['Email', u.email],
          ['Sign-in', u.provider || 'local'], ['Email verified', u.isEmailVerified ? 'yes' : 'no'], ['Joined', fmtDate(u.createdAt)],
          ['Free analyses used (lifetime)', fmtNum(u.lifetimeFreeVideosUsed ?? 0)],
          ['Creator profile', u.creatorProfile ? [u.creatorProfile.niche, (u.creatorProfile.platforms || []).join(', '), u.creatorProfile.followers != null ? `${fmtNum(u.creatorProfile.followers)} followers` : '', u.creatorProfile.goal].filter(Boolean).join(' · ') : ''],
          ['Came from', u.attribution ? [u.attribution.source, u.attribution.medium, u.attribution.campaign].filter(Boolean).join(' / ') : ''],
        ])),
        card('Plan', subscriptionKv(d.subscription),
          d.promos.length ? h('p', { class: 'subtle', text: `Promo codes used: ${d.promos.map((p) => `${p.code.toUpperCase()} (${fmtDay(p.grantedAt)})`).join(', ')}` }) : null)),
      card(`Videos (${fmtNum(d.videos.total)})`, videoTable(d.videos.rows, { showUser: false })));
  });

  // ---------- one video: everything
  const stopPlayer = () => { if (hls) { try { hls.destroy(); } catch { /* ignore */ } hls = null; } };
  const player = (v) => {
    const src = safeHref(v.streamUrl);
    if (!src) return h('p', { class: 'muted', text: 'No playable stream stored for this video.' });
    const el = h('video', { controls: true, playsinline: true, preload: 'metadata', poster: safeHref(v.thumbnailUrl) || null });
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: false });
      hls.loadSource(src);
      hls.attachMedia(el);
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = src;
    } else {
      return h('p', { class: 'muted', text: 'This browser cannot play the stream.' });
    }
    return el;
  };

  const FEATURE_NAMES = { hook: 'Hook', pacing: 'Pacing', audio: 'Audio', caption: 'Caption clarity', views_predictor: 'Views predictor', advanced_analytics: 'Advanced analytics' };
  const list = (items) => (items && items.length ? h('ul', { class: 'tight' }, items.map((x) => h('li', { text: typeof x === 'string' ? x : JSON.stringify(x) }))) : null);

  const featureBlock = (a) => h('div', { class: 'feature' },
    h('h4', {}, h('span', { text: FEATURE_NAMES[a.feature] || a.feature }), scoreEl(a.score), a.rating ? h('span', { class: 'badge', text: a.rating }) : null),
    a.feedback ? h('div', { text: a.feedback }) : null,
    a.suggestions?.length ? [h('div', { class: 'subtle', text: 'Suggestions', style: 'margin-top:6px' }), list(a.suggestions)] : null,
    a.emotionalTriggers?.length ? [h('div', { class: 'subtle', text: 'Emotional triggers', style: 'margin-top:6px' }), list(a.emotionalTriggers)] : null,
    a.retentionDrivers?.length ? [h('div', { class: 'subtle', text: 'Retention drivers', style: 'margin-top:6px' }), list(a.retentionDrivers)] : null,
    a.psychologicalProfile ? h('div', { class: 'subtle', text: `Profile: ${typeof a.psychologicalProfile === 'string' ? a.psychologicalProfile : JSON.stringify(a.psychologicalProfile)}`, style: 'margin-top:6px' }) : null);

  const fixItem = (f) => h('div', { class: 'item' },
    h('div', { class: 'head' }, h('span', { class: 'ts', text: `${fmtTime(f.tStart)}${f.tEnd != null ? `–${fmtTime(f.tEnd)}` : ''}` }),
      f.category ? h('span', { class: 'badge', text: f.category }) : null,
      f.severity != null ? h('span', { class: `badge ${f.severity >= 3 ? 'err' : f.severity >= 2 ? 'warn' : ''}`, text: `severity ${f.severity}` }) : null,
      f.sourceFeature ? h('span', { class: 'subtle', text: f.sourceFeature }) : null),
    f.observed ? h('div', { class: 'muted', text: `Seen: ${f.observed}` }) : null,
    f.issue ? h('div', { text: f.issue }) : null,
    f.fix ? h('div', {},
      h('div', { class: 'subtle', text: `Fix${f.fix.type ? ` (${f.fix.type})` : ''}`, style: 'margin-top:6px' }),
      f.fix.before || f.fix.after ? h('div', { class: 'beforeafter' }, h('div', { text: `Before: ${f.fix.before || ''}` }), h('div', { text: `After: ${f.fix.after || ''}` })) : null,
      f.fix.text || f.fix.instruction ? h('div', { text: f.fix.text || f.fix.instruction }) : null) : null,
    f.expectedImpact ? h('div', { class: 'subtle', text: `Expected impact: ${f.expectedImpact}`, style: 'margin-top:4px' }) : null);

  const rewriteItem = (r) => h('div', { class: 'item' },
    h('div', { class: 'head' }, h('span', { class: 'ts', text: fmtTime(r.timestamp) }), r.lineId ? h('span', { class: 'subtle mono', text: r.lineId }) : null),
    h('div', { class: 'beforeafter' }, h('div', { text: `Said: ${r.originalTranscript || ''}` }), h('div', { text: `Rewrite: ${r.rewrittenLine || ''}` })),
    r.rationale ? h('div', { class: 'muted', text: r.rationale, style: 'margin-top:6px' }) : null,
    r.deliveryNote ? h('div', { class: 'subtle', text: `Delivery: ${r.deliveryNote}` }) : null);

  const SCRIPT_ACCESS = { free: 2, premium: 6, pro: 10, enterprise: 10 };
  const scriptItem = (o, i, plan) => h('div', { class: 'item' },
    h('div', { class: 'head' }, h('span', { class: 'ts', text: String(i + 1).padStart(2, '0') }), h('strong', { text: o.title || `Script ${i + 1}` }),
      i >= (SCRIPT_ACCESS[plan] ?? 2) ? h('span', { class: 'badge warn', text: 'locked for this user' }) : h('span', { class: 'badge ok', text: 'open for this user' })),
    o.angle ? h('div', { class: 'muted', text: o.angle }) : null,
    o.hookLine ? h('div', { style: 'margin-top:6px' }, h('span', { class: 'subtle', text: 'Hook: ' }), h('strong', { text: o.hookLine })) : null,
    o.beats?.length ? h('div', { style: 'margin-top:6px' }, o.beats.map((b) => h('div', { style: 'margin:4px 0' },
      h('span', { class: 'ts', text: `${fmtTime(b.tStart)}–${fmtTime(b.tEnd)} ` }),
      b.say ? h('span', { text: `“${b.say}” ` }) : null,
      b.onScreenText ? h('span', { class: 'badge', text: `on screen: ${b.onScreenText}` }) : null,
      b.visual ? h('span', { class: 'subtle', text: ` ${b.visual}` }) : null))) : null,
    o.cta ? h('div', { class: 'subtle', text: `Ending: ${o.cta}`, style: 'margin-top:6px' }) : null,
    o.whyItWorks ? h('div', { class: 'subtle', text: `Why: ${o.whyItWorks}` }) : null);

  const showVideo = guard(async (id) => {
    const view = shell('videos');
    const d = await api(`/videos/${encodeURIComponent(id)}`);
    clear(view);
    const v = d.video;
    const plan = d.subscription?.plan || 'free';
    const scores = (v.analysis || []).filter((a) => a.score != null);
    const pr = d.prediction;
    const scripts = v.scriptSuggestions?.options || [];

    view.append(
      h('div', { class: 'back' }, h('button', { text: 'Back', onclick: () => history.back() })),
      h('h2', { text: v.sourceTitle || v.filename || 'Untitled' }),
      h('p', { class: 'muted' },
        statusBadge(v.analysisStatus), h('span', { class: 'badge', text: plan }), d.subscription?.promo ? h('span', { class: 'badge accent', text: d.subscription.promo.code }) : null,
        ' Uploaded ', fmtDate(v.createdAt), ' by ',
        d.user ? h('button', { class: 'link', text: d.user.email, onclick: () => { location.hash = `#/user/${d.user._id}`; } }) : 'unknown user'),
      h('div', { class: 'grid2' },
        h('div', {},
          card('Video', player(v)),
          card('Input', kv([
            ['File name', v.filename], ['Source link', v.sourceUrl ? extLink(v.sourceUrl) : ''], ['Source title', v.sourceTitle],
            ['Length', v.duration ? `${fmtTime(v.duration)} (${Math.round(v.duration)} s)` : ''], ['File size', fmtSize(v.fileSize)],
            ['Followers given', v.creatorFollowers != null ? fmtNum(v.creatorFollowers) : 'not given'], ['Platform', v.creatorPlatform || ''],
            ['Posted', v.postedAt ? fmtDate(v.postedAt) : ''], ['Post link', v.postUrl ? extLink(v.postUrl) : ''],
            ['Features requested', (v.selectedFeatures || []).join(', ')],
            ['Error', v.lastError ? `${v.lastError}${v.lastErrorAt ? ` (${fmtDate(v.lastErrorAt)})` : ''}` : ''],
            ['Video id', h('span', { class: 'mono', text: v.id })],
            ['Twelve Labs', [v.twelveLabsAssetId && `asset ${v.twelveLabsAssetId}`, v.twelveLabsVideoId && `video ${v.twelveLabsVideoId}`].filter(Boolean).join(' · ')],
            ['AI calls', d.aiCalls ? h('span', {}, `${fmtNum(d.aiCalls)} recorded. `, h('a', { href: '/admin/ai', target: '_blank', rel: 'noopener noreferrer', text: 'Open AI review' }), ' and filter by this video id.') : 'none recorded'],
          ])),
          card('Predicted views', kv([
            ['Shown to user', pr.shown?.expected != null ? `${fmtNum(pr.shown.expected)} (${fmtNum(pr.shown.low)} to ${fmtNum(pr.shown.high)})` : 'none'],
            ['Method', `${pr.method || 'score'}${pr.comparables ? ` · ${pr.comparables} comparables` : ''}`],
            ['Before learning', pr.base?.expected != null ? `${fmtNum(pr.base.expected)} (${fmtNum(pr.base.low)} to ${fmtNum(pr.base.high)})` : ''],
            ['Learned correction', pr.learning ? `x${pr.learning.factor} from ${fmtNum(pr.learning.observations)} results (model v${pr.learning.version})` : ''],
            ['Edit energy', pr.drivers ? `x${pr.drivers.energy}` : ''],
            ['Lifted by', (pr.drivers?.boosts || []).join(', ')], ['Held back by', (pr.drivers?.drags || []).join(', ')],
            ['Real views', pr.actualViews != null ? fmtNum(pr.actualViews) : 'not logged'],
          ]),
          pr.snapshots?.length ? h('table', { style: 'margin-top:10px' }, h('thead', {}, h('tr', {}, ['Logged', 'Views', 'Likes', 'Comments', 'Shares', 'Saves'].map((t) => h('th', { text: t })))),
            h('tbody', {}, pr.snapshots.map((s) => h('tr', {}, h('td', { text: fmtDate(s.capturedAt) }), ...[s.views, s.likes, s.comments, s.shares, s.saves].map((n) => h('td', { class: 'num', text: fmtNum(n) })))))) : null)),
        h('div', {},
          card('Scores', h('div', { class: 'tiles' }, tile('Virality', v.viralityScore ?? '–'), scores.map((a) => tile(FEATURE_NAMES[a.feature] || a.feature, Math.round(a.score))))),
          card('Personal Video Coach', d.chat.messages.length
            ? h('div', { class: 'chat' }, d.chat.messages.map((m) => h('div', { class: `bubble ${m.isUser ? 'user' : 'ai'}` }, m.text, h('span', { class: 'when', text: `${m.isUser ? 'User' : 'Coach'} · ${fmtDate(m.createdAt)}` }))))
            : h('p', { class: 'muted', text: 'No coach conversation.' })))),
      card('Feedback report', (v.analysis || []).length ? (v.analysis || []).map(featureBlock) : h('p', { class: 'muted', text: 'No analysis stored.' })),
      card(`Timestamped fixes (${(v.timestampFeedback || []).length})`, (v.timestampFeedback || []).length ? v.timestampFeedback.map(fixItem) : h('p', { class: 'muted', text: 'None.' })),
      card(`Line rewrites (${(v.scriptRewrites || []).length})`, (v.scriptRewrites || []).length ? v.scriptRewrites.map(rewriteItem) : h('p', { class: 'muted', text: 'None.' })),
      card(`Scripts (${scripts.length})`, scripts.length
        ? [h('p', { class: 'subtle', text: `Generated ${fmtDate(v.scriptSuggestions.generatedAt)} · ${v.scriptSuggestions.generationCount ?? 0} generation(s) · target ${v.scriptSuggestions.targetSeconds ?? '?'} s` }), ...scripts.map((o, i) => scriptItem(o, i, plan))]
        : h('p', { class: 'muted', text: 'Not generated yet (written when the user opens the Scripts tab).' })),
      card('More',
        h('details', {}, h('summary', { text: `Transcript (${(v.rawTranscript || []).length} segments)` }),
          (v.rawTranscript || []).map((t) => h('div', { style: 'margin:4px 0' }, h('span', { class: 'ts', text: `${fmtTime(t.tStart)} ` }), t.text || ''))),
        h('details', {}, h('summary', { text: `Scenes (${(v.scenes || []).length})` }), h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, ['#', 'Time', 'Visual', 'On screen', 'Audio', 'Purpose'].map((t) => h('th', { text: t })))),
          h('tbody', {}, (v.scenes || []).map((s) => h('tr', {}, h('td', { text: String(s.sceneNumber ?? '') }), h('td', { class: 'ts', text: `${fmtTime(s.startTime)}–${fmtTime(s.endTime)}` }),
            h('td', { text: s.visualDescription || '' }), h('td', { text: s.onScreenText || '' }), h('td', { text: s.audioSummary || '' }), h('td', { text: s.purpose || '' }))))))),
        h('details', {}, h('summary', { text: 'Everything stored for this video (raw)' }), h('pre', { text: JSON.stringify(d, null, 2) }))));
  });

  const showAudit = guard(async () => {
    const view = shell('audit');
    const rows = await api('/audit?limit=300');
    clear(view);
    const LABELS = { sms_send: 'Code texted', login: 'Sign-in', logout: 'Sign-out', view_video: 'Opened video', view_user: 'Opened user' };
    view.append(h('h2', { text: 'Access log' }), h('p', { class: 'muted', text: 'Every sign-in attempt and every record opened here. Anything you did not do means the admin key has leaked: change ADMIN_API_KEY on Railway.' }),
      card(null, h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['When', 'What', 'Result', 'Record', 'IP', 'Browser'].map((t) => h('th', { text: t })))),
        h('tbody', {}, rows.map((r) => h('tr', {},
          h('td', { class: 'num', text: fmtDate(r.createdAt) }), h('td', { text: LABELS[r.action] || r.action }),
          h('td', {}, r.ok ? h('span', { class: 'badge ok', text: 'ok' }) : h('span', { class: 'badge err', text: r.detail || 'refused' })),
          h('td', {}, r.videoId ? h('button', { class: 'link', text: 'video', onclick: () => { location.hash = `#/video/${r.videoId}`; } }) : null, r.userId && !r.videoId ? h('button', { class: 'link', text: 'user', onclick: () => { location.hash = `#/user/${r.userId}`; } }) : null),
          h('td', { class: 'mono', text: r.ip || '' }), h('td', { class: 'subtle', text: (r.userAgent || '').slice(0, 80) }))))))));
  });

  // ---------- router
  const route = guard(async () => {
    const [path] = location.hash.replace(/^#\/?/, '').split('?');
    const [section, id] = path.split('/');
    if (section === 'video' && id) return showVideo(id);
    if (section === 'user' && id) return showUser(id);
    if (section === 'users') return showUsers();
    if (section === 'audit') return showAudit();
    if (section === 'overview') return showOverview();
    return showVideos();
  });

  const boot = async () => {
    try {
      const s = await api('/session');
      phoneHint = s.phoneHint || null;
      if (!s.configured) return showNotConfigured(s.missing || []);
      if (!s.signedIn) return showSignIn();
      session = { expiresAt: s.expiresAt };
      route();
    } catch (err) { showError(err); }
  };

  // Navigation only while the console is showing (not on the sign-in or setup screens).
  window.addEventListener('hashchange', () => { if (document.querySelector('header.top')) route(); });
  boot();
})();
