/* Vireact owner console. Same-origin page; every data call needs a live owner session (the admin key). All user content is inserted as text nodes (never as HTML). The admin key is
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

  // Admin key -> session cookie (httpOnly; this script never sees it). The key is not stored anywhere.
  const showSignIn = (message = '') => {
    const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Admin key' });
    const err = h('div', { class: 'error', role: 'alert', text: message });
    const go = h('button', { class: 'primary', type: 'submit', text: 'Sign in' });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        go.disabled = true;
        try {
          const out = await api('/session/login', { method: 'POST', body: { key: key.value } });
          key.value = '';
          session = { expiresAt: out.expiresAt };
          route();
        } catch (ex) {
          err.textContent = ex.message;
          key.value = '';
        } finally { go.disabled = false; }
      },
    },
    h('label', { text: 'Admin key' }), key, err,
    h('div', { class: 'actions' }, go));
    mount(authCard('Sign in', 'Enter your admin key.', form,
      h('p', { class: 'note', text: 'Sessions end after 30 minutes idle or 8 hours. Every sign-in and every record opened is logged.' })));
    setTimeout(() => key.focus(), 0);
  };

  // ---------- shell
  const TABS = [['overview', 'Overview'], ['videos', 'Videos'], ['users', 'Users'], ['learning', 'Learning'], ['audit', 'Access log']];
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
    const LABELS = { login: 'Sign-in', logout: 'Sign-out', view_video: 'Opened video', view_user: 'Opened user' };
    view.append(h('h2', { text: 'Access log' }), h('p', { class: 'muted', text: 'Every sign-in attempt and every record opened here. Anything you did not do means the admin key has leaked: change ADMIN_API_KEY on Railway.' }),
      card(null, h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['When', 'What', 'Result', 'Record', 'IP', 'Browser'].map((t) => h('th', { text: t })))),
        h('tbody', {}, rows.map((r) => h('tr', {},
          h('td', { class: 'num', text: fmtDate(r.createdAt) }), h('td', { text: LABELS[r.action] || r.action }),
          h('td', {}, r.ok ? h('span', { class: 'badge ok', text: 'ok' }) : h('span', { class: 'badge err', text: r.detail || 'refused' })),
          h('td', {}, r.videoId ? h('button', { class: 'link', text: 'video', onclick: () => { location.hash = `#/video/${r.videoId}`; } }) : null, r.userId && !r.videoId ? h('button', { class: 'link', text: 'user', onclick: () => { location.hash = `#/user/${r.userId}`; } }) : null),
          h('td', { class: 'mono', text: r.ip || '' }), h('td', { class: 'subtle', text: (r.userAgent || '').slice(0, 80) }))))))));
  });

  const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const times = (x) => (x == null ? '–' : `${x.toFixed(2)}×`);
  const NICE = { video: 'Your users', social: 'Public (collected)', dataset: 'Admin examples' };

  const accuracyTable = (rows) => h('div', { class: 'scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, ['', 'Videos', 'Usually off by', 'Within 2×', 'Inside the band', 'Bias'].map((t, i) => h('th', { class: i ? 'num' : '', text: t })))),
    h('tbody', {}, rows.map(([label, m]) => h('tr', {},
      h('td', { text: label }), h('td', { class: 'num', text: fmtNum(m?.n ?? 0) }), h('td', { class: 'num', text: times(m?.typicalMiss) }),
      h('td', { class: 'num', text: pct(m?.within2x) }), h('td', { class: 'num', text: pct(m?.coverage) }),
      h('td', { class: 'num', text: m?.bias == null ? '–' : m.bias > 1 ? `${times(m.bias)} too low` : `${times(1 / m.bias)} too high` }))))));

  // Plain names for the learning features (keys from features.js / deep-features.js).
  const FACTOR_NAMES = {
    firstCutSecExact: 'First cut (seconds in)', cutsPerMinExact: 'Cuts per minute', cutsInFirst3sExact: 'Cuts in the first 3 s',
    cutsPerMinFirst10sExact: 'Cuts per minute, first 10 s', cutsPerMinAfter10sExact: 'Cuts per minute, after 10 s', avgShotSecExact: 'Average shot length (s)',
    medianShotSecExact: 'Typical shot length (s)', longestShotSecExact: 'Longest shot (s)', shotCountExact: 'Number of shots', shortShotShareExact: 'Share of shots under 1 s',
    firstSpeechSec: 'First spoken word (seconds in)', speechWpm: 'Words per minute', speechCoverage: 'Share of the video with speech', openingWords: 'Words spoken in the first 3 s',
    wordsBeforeFirstCut: 'Words before the first cut', onScreenTextShare: 'Scenes with on-screen text', textShotShare: 'Shots with on-screen text',
    textInFirst2s: 'On-screen text in the first 2 s', textWhileSpeakingShare: 'On-screen text while talking', hookTextAndSpeech: 'Opening has both text and speech',
    toCameraOpening: 'Talks to camera in the opening', musicShare: 'Scenes with music', zoomShare: 'Scenes with zooms', silenceShare: 'Share of silence',
    loudnessLufs: 'Loudness (LUFS)', hookEndSec: 'Hook ends at (s)', hasCta: 'Has a call to action', hasPayoff: 'Has a payoff', durationSec: 'Length (s)',
    sceneCount: 'Scenes (Twelve Labs)', cutsPerMin: 'Cuts per minute (Twelve Labs estimate)', avgShotSec: 'Average shot (Twelve Labs estimate)',
    firstCutSec: 'First cut (Twelve Labs estimate)', longestShotSec: 'Longest shot (Twelve Labs estimate)', captionChars: 'Caption length', hashtagCount: 'Hashtags',
    originalSound: 'Original sound', postHourUtc: 'Post hour (UTC)', postWeekdayUtc: 'Post weekday (UTC)',
    brightness: 'Brightness', brightnessFirst3s: 'Brightness, first 3 s', saturation: 'Colour saturation', motion: 'Motion',
    motionFirst3s: 'Motion, first 3 s', motionHookRatio: 'Opening motion vs rest', motionVariability: 'Motion variability',
    onsetRate: 'Beats/hits per second', tempoBpm: 'Music tempo (BPM)', cutsOnBeatShare: 'Cuts on a beat', cutsOnBeatLift: 'Cuts on beat vs chance',
    hookFaceShare: 'Face size in opening', hookPeople: 'People in opening', hookCloseUp: 'Close-up opening', hookTextOverlay: 'Text overlay in opening',
    hookTextWords: 'Words of text in opening', hookEyeContact: 'Eye contact in opening', hookSceneChange: 'Scene change in first 3 s', hookVisual: 'Opening shows',
    softCutCount: 'Soft cuts', soundUsesPrior14d: 'Sound uses in prior 14 days', niche: 'Niche', format: 'Format', hookPattern: 'Hook type', language: 'Language',
  };
  const factorName = (k) => FACTOR_NAMES[k] || k;
  /** Model column names: "key", "key:missing", "key:sin", "key=level". */
  const columnName = (c) => {
    const m = String(c).match(/^([^:=]+)(?::(missing|sin|cos)|=(.+))?$/);
    if (!m) return c;
    const base = factorName(m[1]);
    if (m[2] === 'missing') return `${base} (not measured)`;
    if (m[2]) return `${base} (${m[2]})`;
    if (m[3]) return `${base}: ${m[3].replace(/_/g, ' ')}`;
    return base;
  };

  const modelCards = (d) => {
    const m = d.model;
    const trainBtn = h('button', { class: 'link', text: 'Train the model now', onclick: guard(async () => {
      trainBtn.disabled = true;
      const r = await api('/learning/model/run', { method: 'POST', body: {} });
      trainBtn.textContent = r.status === 'started' ? 'Started: refresh in a minute' : 'Already running';
    }) });
    const pctOrDash = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    const cards = [card('Matrix model (learns what beats a creator\'s own usual)', m ? h('div', {},
      kv([
        ['Version', `v${m.version}, trained ${fmtDate(m.trainedAt)} (${m.status})`],
        ['Data', `${fmtNum(m.n)} videos from ${fmtNum(m.creators)} creators with 2+ videos, ${fmtNum(m.p)} measured columns`],
        ['Ranks two videos of the same creator correctly', `${pctOrDash(m.metrics.ridge?.pairAccuracy)} (50% = coin flip; ${fmtNum(m.metrics.ridge?.pairs)} pairs, held-out creators)`],
        ['Error vs "creator\'s usual"', m.metrics.ridge?.skill == null ? '–' : `${Math.round(m.metrics.ridge.skill * 100)}% smaller`],
        ['Within 2× of the real result', pctOrDash(m.metrics.ridge?.within2x)],
        ['Neural network vs linear', m.metrics.neural ? `${m.metrics.neural.beatsRidge ? 'better' : 'not better'} (pair accuracy ${pctOrDash(m.metrics.neural.metrics?.pairAccuracy)} vs ${pctOrDash(m.metrics.neural.ridgeOnSameRows?.pairAccuracy)})` : 'not trained yet (needs 200+ videos)'],
        ['Serving to users', m.promotion?.serving ? 'yes' : `no: ${m.promotion?.reason || ''}`],
        ['Now', trainBtn],
      ]),
      h('h4', { text: 'Strongest effects (+1 standard deviation, other features held fixed)' }),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Feature', 'Views multiplier'].map((t, i) => h('th', { class: i ? 'num' : '', text: t })))),
        h('tbody', {}, m.coefficients.slice(0, 15).map((c) => h('tr', {}, h('td', { text: columnName(c.column) }), h('td', { class: 'num', text: `×${c.multiplier}` }))))))
    ) : h('div', {}, h('p', { class: 'muted', text: 'Not trained yet. It trains in the daily job once 200 videos have settled results.' }), trainBtn))];
    if (m) {
      cards.push(card('Statistical network: what is directly linked to performance', m.toPerformance.length
        ? h('div', {}, h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Feature', 'Direct link (partial correlation)'].map((t, i) => h('th', { class: i ? 'num' : '', text: t })))),
          h('tbody', {}, m.toPerformance.map((t) => h('tr', {}, h('td', { text: columnName(t.column) }), h('td', { class: 'num', text: t.partialCorrelation.toFixed(3) })))))),
          m.edges.length ? h('p', { class: 'note', text: `Strongest links between features: ${m.edges.slice(0, 8).map((e) => `${columnName(e.a)} ↔ ${columnName(e.b)} (${e.partialCorrelation})`).join('; ')}.` }) : null,
          h('p', { class: 'note', text: `Partial correlation = link that remains after every other feature is accounted for (inverse of the shrunk covariance matrix; shrinkage ${m.shrinkage}). Only links significant at p < 0.001 are shown.` }))
        : h('p', { class: 'muted', text: 'No feature has a significant direct link yet.' })));
      cards.push(card('Editing styles (principal components)', h('div', {}, m.components.map((c) => h('div', { class: 'item' },
        h('div', { class: 'head' }, h('b', { text: `Style ${c.component}` }), h('span', { class: 'subtle', text: ` explains ${Math.round(c.explained * 100)}% of the variation; link to performance ${c.correlationWithPerformance}` })),
        h('div', { class: 'subtle', text: c.loadings.map((l) => `${l.loading > 0 ? '+' : '−'}${columnName(l.column)}`).join(', ') }))))));
    }
    cards.push(card('Confirmed findings (reach the analyzers)', d.insights && d.insights.length ? h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Niche', 'Factor', 'Pairs', 'Hit had more', 'Typical hit', 'Typical miss', 'p', 'Model agrees'].map((t, i) => h('th', { class: i > 1 ? 'num' : '', text: t })))),
      h('tbody', {}, d.insights.map((i) => h('tr', {}, h('td', { text: i.niche.replace(/_/g, ' ') }), h('td', { text: factorName(i.feature) }), h('td', { class: 'num', text: fmtNum(i.pairs) }),
        h('td', { class: 'num', text: pct(i.hitHigherShare) }), h('td', { class: 'num', text: fmtVal(i.medianHit) }), h('td', { class: 'num', text: fmtVal(i.medianMiss) }),
        h('td', { class: 'num', text: String(i.p) }), h('td', { class: 'num', text: i.modelEffect == null ? '–' : `yes (×${Math.exp(i.modelEffect).toFixed(2)})` }))))))
      : h('p', { class: 'muted', text: 'None yet: a factor needs 30+ creator pairs and p < 0.05. Until then the analyzers get nothing from here.' })));
    cards.push(card('Rising sounds (in collected videos)', d.trends && d.trends.length ? h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Sound', 'Stage', 'Uses, last 14 d', 'Prior 14 d', 'vs usual'].map((t, i) => h('th', { class: i > 1 ? 'num' : '', text: t })))),
      h('tbody', {}, d.trends.map((t) => h('tr', {}, h('td', { text: t.title || t.soundId }), h('td', { text: t.stage }), h('td', { class: 'num', text: fmtNum(t.last14) }),
        h('td', { class: 'num', text: fmtNum(t.prior14) }), h('td', { class: 'num', text: vsUsual(t.medianOutperformance) }))))))
      : h('p', { class: 'muted', text: 'No sound is used often enough in the sample yet.' })));
    const c = d.comments;
    cards.push(card('What viewers say: hits vs misses', c && c.intents && c.intents.length ? h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Comment intent', 'Hits', 'Misses'].map((t, i) => h('th', { class: i ? 'num' : '', text: t })))),
      h('tbody', {}, c.intents.map((r) => h('tr', {}, h('td', { text: r.intent.replace(/_/g, ' ') }), h('td', { class: 'num', text: pct(r.hit) }), h('td', { class: 'num', text: pct(r.miss) }))))))
      : h('p', { class: 'muted', text: 'Needs analyzed hits and misses with labelled comments. Comments are results, so they explain engagement but are never model inputs.' })));
    return cards;
  };
  const fmtVal = (v) => (v == null ? '–' : typeof v === 'string' ? v.replace(/_/g, ' ') : Math.abs(v) >= 100 ? fmtNum(Math.round(v)) : String(Math.round(v * 100) / 100));
  const vsUsual = (o) => (o == null ? '' : `${Math.exp(o) >= 1 ? Math.exp(o).toFixed(1) : Math.exp(o).toFixed(2)}× usual`);

  const deepCards = (d) => {
    const dp = d.deep || {};
    const runBtn = h('button', { class: 'link', text: 'Analyze 10 videos now', onclick: guard(async () => {
      runBtn.disabled = true;
      const r = await api('/learning/deep/run', { method: 'POST', body: { limit: 10 } });
      runBtn.textContent = r.status === 'started' ? 'Started: refresh in about 10 minutes' : r.status === 'already_running' ? 'Already running' : `Not started (${r.status})`;
    }) });
    return [
      card('Deep analysis: what happens in the videos', kv([
        ['Per day', d.config.deepDaily ? `${fmtNum(d.config.deepDaily)} videos (hit and miss pairs from the same creators)` : 'Off (LEARNING_DEEP_DAILY=0)'],
        ['Analyzed', `${fmtNum(dp.analyzed)} videos, ${fmtNum(dp.videoMinutes)} minutes of video`],
        ['Exact cuts measured', fmtNum(dp.exactCuts)],
        ['Creators with a hit and a miss analyzed', fmtNum(dp.creatorsWithPairs)],
        ['Failed (not retried)', fmtNum(dp.failed)],
        ['Videos with TikTok captions', fmtNum(dp.withCaptions)],
        ['Now', dp.running ? 'Running' : runBtn],
      ]), h('p', { class: 'note', text: 'Each video: exact cut times measured from the file, Twelve Labs scene descriptions (what is on screen, on-screen text, audio, action) and the transcript, lined up shot by shot. Files are deleted after analysis.' })),
      card('What separates hits from misses', dp.factors && dp.factors.length
        ? h('div', {}, h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Factor', 'Creator pairs', 'Hit had more', 'Typical hit', 'Typical miss', 'Link to views', 'Confidence'].map((t, i) => h('th', { class: i ? 'num' : '', text: t })))),
          h('tbody', {}, dp.factors.map((f) => h('tr', {},
            h('td', { text: factorName(f.feature) }), h('td', { class: 'num', text: fmtNum(f.pairs) }), h('td', { class: 'num', text: pct(f.hitHigherShare) }),
            h('td', { class: 'num', text: fmtVal(f.medianHit) }), h('td', { class: 'num', text: fmtVal(f.medianMiss) }),
            h('td', { class: 'num', text: f.correlation == null ? '–' : f.correlation.toFixed(2) }),
            h('td', { class: 'num' }, h('span', { class: `badge ${f.status === 'reliable' && f.p < 0.05 ? 'ok' : 'warn'}`, text: f.status === 'reliable' ? (f.p < 0.05 ? 'finding' : 'no clear effect') : 'early' })))))))
        , h('p', { class: 'note', text: 'Each creator\'s best video (hit) is compared with their worst (miss), so account size and audience are the same. "Hit had more": how often the hit scored higher on that factor (50% = no difference). "Link to views": rank correlation with how far above or below usual the video did. A factor becomes a finding at 30+ creator pairs with a clear sign test (p < 0.05).' }))
        : h('p', { class: 'muted', text: 'Needs at least 5 creators with an analyzed hit and miss.' })),
      card('Latest deep analyses', dp.recent && dp.recent.length ? h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Analyzed', 'Niche', 'Picked as', 'Views', 'vs usual', 'Length', 'Shots', ''].map((t, i) => h('th', { class: i > 2 && i < 7 ? 'num' : '', text: t })))),
        h('tbody', {}, dp.recent.map((r) => h('tr', {},
          h('td', { class: 'num', text: fmtDate(r.analyzedAt) }), h('td', { text: (r.niche || '').replace(/_/g, ' ') }), h('td', { text: r.role }),
          h('td', { class: 'num', text: fmtNum(r.views) }), h('td', { class: 'num', text: vsUsual(r.outperformance) }),
          h('td', { class: 'num', text: fmtTime(r.durationSec) }), h('td', { class: 'num', text: `${fmtNum(r.shots)}${r.cutsSource === 'ffmpeg' ? '' : ' (est.)'}` }),
          h('td', {}, h('button', { class: 'link', text: 'timeline', onclick: () => { location.hash = `#/deep/${r.id}`; } })))))))
        : h('p', { class: 'muted', text: 'None yet. They run in the daily job after collection, or use "Analyze 10 videos now".' })),
    ];
  };

  const showDeep = guard(async (id) => {
    const view = shell('learning');
    const d = await api(`/learning/deep/${encodeURIComponent(id)}`);
    clear(view);
    const a = d.analysis;
    const v = d.video || {};
    const c = d.creator || {};
    const link = typeof v.url === 'string' && v.url.startsWith('https://www.tiktok.com/') ? h('a', { href: v.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open on TikTok' }) : '';
    const features = Object.entries(a.features || {}).filter(([k]) => k !== 'speechFromCaptions');
    view.append(
      h('p', {}, h('button', { class: 'link', text: '← Learning', onclick: () => { location.hash = '#/learning'; } })),
      h('h2', { text: `@${c.handle || 'creator'} · ${a.role === 'hit' ? 'their hit' : a.role === 'miss' ? 'their miss' : 'video'}` }),
      card('Video', kv([
        ['Caption', v.caption || ''], ['Sound', v.soundTitle || ''], ['Posted', fmtDay(v.postedAt)],
        ['Views', `${fmtNum(a.views)} (${vsUsual(a.outperformance)}; usual ${fmtNum(a.baselineViews)})`],
        ['Creator', `${fmtNum(c.followers)} followers, niche ${(a.niche || c.niche || '').replace(/_/g, ' ')}`],
        ['Cuts', a.cutsSource === 'ffmpeg' ? `${fmtNum(a.cuts.length)} measured from the file` : 'Estimated by Twelve Labs (file could not be measured)'],
        ['Length', fmtTime(a.media?.durationSec)], ['Language', a.language || ''],
        ['Opening frames', a.hookVision ? `${String(a.hookVision.visual || '').replace(/_/g, ' ')}; face ${a.hookVision.faceSize}; ${a.hookVision.framing?.replace(/_/g, ' ')}; ${a.hookVision.textOverlay ? `text overlay (${a.hookVision.textWords} words)` : 'no text overlay'}; ${a.hookVision.eyeContact ? 'eye contact' : 'no eye contact'}` : ''],
        ['Soundtrack', a.contentRead ? `${String(a.contentRead.audioType || 'unknown').replace(/_/g, ' ')}; ${(a.contentRead.speech || []).filter((k) => k === 'sung').length} of ${(a.contentRead.speech || []).length} transcript lines are lyrics (${a.contentRead.source === 'model' ? 'read by model' : 'rules only'})` : 'not read yet'],
        ['Model', a.model || ''], ['Link', link],
      ])),
      card('Shot by shot', h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Time', 'Said', 'On-screen text', 'What is on screen', 'Purpose'].map((t) => h('th', { text: t })))),
        h('tbody', {}, (a.timeline || []).map((r) => h('tr', {},
          h('td', { class: 'num mono', text: `${r.start.toFixed(1)}–${r.end.toFixed(1)}s` }), h('td', {}, h('div', { text: r.said || '' }), r.sung ? h('div', { class: 'subtle', text: `♪ ${r.sung}` }) : null), h('td', { text: r.onScreenText || '' }),
          h('td', { class: 'subtle', text: [r.visual, r.action].filter(Boolean).join(' · ') }), h('td', { text: r.purpose || '' }))))))),
      card('Measured features', kv(features.map(([k, val]) => [factorName(k), typeof val === 'boolean' ? (val ? 'yes' : 'no') : fmtVal(val)]))),
      v.topComments && v.topComments.length ? card('Top comments', h('div', {}, v.topComments.slice(0, 10).map((cm) => h('div', { class: 'item' },
        h('div', { text: cm.text }), h('div', { class: 'subtle', text: `${fmtNum(cm.likes)} likes · ${fmtNum(cm.replies)} replies` }))))) : null,
    );
  });

  const showLearning = guard(async () => {
    const view = shell('learning');
    const d = await api('/learning');
    clear(view);
    const inv = d.inventory;
    const rc = d.reportCard;
    const next = inv.nextMilestone;
    view.append(
      h('h2', { text: 'Learning engine' }),
      h('p', { class: 'muted', text: 'How much real data the prediction model has learned from, and how accurate it is against real results.' }),
      card('Status', kv([
        ['Daily job', d.config.enabled ? 'On' : 'Off (set LEARNING_ENABLED=true on Railway)'],
        ['Public data provider', d.config.provider || 'None yet: public video collection is off'],
        ['Daily record budget', fmtNum(d.config.dailyRecords)],
        ['Videos labelled per day', fmtNum(d.config.labelLimit)],
      ])),
      card('Data', h('div', { class: 'tiles' },
        tile('Videos with real results', fmtNum(inv.labelled.total)),
        ...Object.entries(inv.labelled.bySubject).map(([k, n]) => tile(NICE[k] || k, fmtNum(n), 'with real results')),
        tile('Public creators tracked', fmtNum(inv.social.creators), `${fmtNum(inv.social.creatorsWithBaseline)} with a baseline`),
        tile('Public videos collected', fmtNum(inv.social.videos))),
        next ? h('p', { class: 'note', text: `Next milestone: ${fmtNum(next.at)} videos with real results (${pct(next.progress)} there). Unlocks: ${next.unlocks}.` }) : null),
      ...deepCards(d),
      ...modelCards(d),
      card('Prediction accuracy against real results', accuracyTable([
        ['All results', rc.live], ['Last 14 days', rc.last14Days], ['Rules only (same videos)', rc.rulesOnly], ['With learning (same videos)', rc.liveOnSameVideos],
      ]), h('p', { class: 'note', text: 'Usually off by: 1.00× is perfect. Inside the band: the target is about 80%. Bias shows whether predictions run high or low.' })),
      card('By platform', Object.keys(rc.byPlatform).length
        ? accuracyTable(Object.entries(rc.byPlatform))
        : h('p', { class: 'muted', text: 'Needs at least 5 real results per platform.' })),
      card('Your calibration cases (must always pass)', h('div', {}, rc.ownerCases.map((c) => h('div', { class: 'item' },
        h('div', { class: 'head' }, h('span', { class: `badge ${c.pass ? 'ok' : 'err'}`, text: c.pass ? 'pass' : 'fail' }), h('span', { text: c.label })),
        h('div', { class: 'subtle', text: `Predicts ${fmtNum(c.band.low)} – ${fmtNum(c.band.high)}, expected ${fmtNum(c.band.expected)}` }))))),
      card('Videos by niche', Object.keys(inv.byNiche).length
        ? h('div', { class: 'tiles' }, Object.entries(inv.byNiche).map(([k, n]) => tile(k.replace(/_/g, ' '), fmtNum(n))))
        : h('p', { class: 'muted', text: 'No videos described yet. The daily job fills this in.' })),
      card('Recent daily runs', d.runs.length ? h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Started', 'Result', 'Provider', 'Records used', 'Steps'].map((t) => h('th', { text: t })))),
        h('tbody', {}, d.runs.map((r) => h('tr', {},
          h('td', { class: 'num', text: fmtDate(r.startedAt) }),
          h('td', {}, h('span', { class: `badge ${r.ok ? 'ok' : r.ok === false ? 'err' : 'warn'}`, text: r.ok ? 'ok' : r.ok === false ? 'problem' : 'running' })),
          h('td', { text: `${r.provider || 'none'}${r.kind === 'deep' ? ' (deep only)' : r.kind === 'model' ? ' (model only)' : ''}` }), h('td', { class: 'num', text: fmtNum(r.recordsUsed) }),
          h('td', { class: 'subtle', text: (r.steps || []).map((s) => `${s.name}${s.ok ? '' : ' (failed)'}`).join(', ') }))))))
        : h('p', { class: 'muted', text: 'No runs yet.' })));
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
    if (section === 'learning') return showLearning();
    if (section === 'deep' && id) return showDeep(id);
    return showVideos();
  });

  const boot = async () => {
    try {
      const s = await api('/session');
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
