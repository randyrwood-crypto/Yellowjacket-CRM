(function () {
  'use strict';

  var STAGES = ['New Lead', 'Contacted', 'Quoted', 'Negotiating', 'Won', 'Lost'];
  var STAGE_VAR = {
    'New Lead': '--stage-new', Contacted: '--stage-contacted', Quoted: '--stage-quoted',
    Negotiating: '--stage-negotiating', Won: '--stage-won', Lost: '--stage-lost',
  };
  var SERVICE_TYPES = ['Fishing Tools', 'Rental Tools', 'Wireline', 'Workover', 'Consulting', 'Other'];

  var currentUser = null;
  var currentView = { view: 'login' };
  var tableFilter = { q: '', stage: '', service: '' };
  var loginMode = 'salesman';
  var loginError = '';
  var roster = [];
  var team = [];
  var lostOpps = [];

  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  /* ---------------- helpers ---------------- */
  function esc(s) {
    if (s === undefined || s === null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMoney(n) {
    n = Number(n) || 0;
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = String(iso).slice(0, 10);
    var p = d.split('-');
    if (p.length !== 3) return d;
    return p[1] + '/' + p[2] + '/' + p[0];
  }
  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }
  function isOverdue(l) {
    if (!l.next_follow_up) return false;
    if (l.stage === 'Won' || l.stage === 'Lost') return false;
    return String(l.next_follow_up).slice(0, 10) < todayISO();
  }
  function isAdmin() {
    return !!currentUser && currentUser.role === 'admin';
  }
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 3600);
  }
  function monthLabel(period) {
    if (!period) return '';
    var p = period.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, 1);
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }

  /* ---------------- API ---------------- */
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'request_failed');
          err.code = data.error;
          err.details = data.details;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------------- router ---------------- */
  function route(view, params) {
    currentView = { view: currentUser ? (view || 'dashboard') : 'login' };
    for (var k in (params || {})) if (k !== 'view') currentView[k] = params[k];
    render();
  }

  // Each view builder takes a callback and calls it with the finished HTML
  // once it has what it needs (usually after an API call, but some paths —
  // e.g. a salesman opening the blank "Add Lead" form — resolve with
  // nothing to await and call back immediately/synchronously). Because of
  // that, the placeholder MUST be painted before the builder is invoked,
  // never after — otherwise a synchronous callback's real content gets
  // painted first and then instantly overwritten by the placeholder.
  function render() {
    if (!currentUser) {
      app.innerHTML = renderLoginView();
      wireView();
      return;
    }
    var viewToken = currentView; // guards against a stale response landing after the user has already navigated elsewhere
    app.innerHTML = shellHtml('<div class="empty-state"><h3>Loading…</h3></div>');
    wireView();

    var done = function (html) {
      if (currentView !== viewToken) return; // user moved on — drop this result
      app.innerHTML = shellHtml(html);
      wireView();
    };

    switch (currentView.view) {
      case 'dashboard': renderDashboard(done); break;
      case 'leads': renderLeadsView(done); break;
      case 'form': renderFormView(currentView.id, done); break;
      case 'report': renderReportView(currentView.id, done); break;
      case 'archive': renderArchiveView(done); break;
      case 'archiveMonth': renderArchiveMonthView(currentView.period, done); break;
      case 'lostOpps': renderLostOppsView(done); break;
      case 'lostOppReport': renderLostOppReportView(currentView.id, done); break;
      case 'team': renderTeamView(done); break;
      default: renderDashboard(done);
    }
  }

  function shellHtml(mainHtml) {
    return (
      '<div class="shell">' +
      renderRail() +
      '<div class="view">' + mainHtml + '</div>' +
      '</div>'
    );
  }

  /* ---------------- rail / nav ---------------- */
  function renderRail() {
    var items = [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'leads', label: 'Leads & Accounts' },
      { id: 'archive', label: 'Archive' },
      { id: 'lostOpps', label: 'Lost Opportunities' },
      { id: 'form', label: 'Add Lead' },
    ];
    if (isAdmin()) items.push({ id: 'team', label: 'Team' });

    var navHtml = items.map(function (it) {
      var active = currentView.view === it.id ||
        (it.id === 'archive' && currentView.view === 'archiveMonth');
      return '<li><button data-nav="' + it.id + '" class="' + (active ? 'active' : '') + '">' + esc(it.label) + '</button></li>';
    }).join('');

    return (
      '<div class="rail">' +
      '<div class="rail-stripe"></div>' +
      '<div class="brand"><div class="brand-title">Yellowjacket</div><div class="brand-sub">Sales CRM</div></div>' +
      '<ul class="nav">' + navHtml + '</ul>' +
      '<div class="rail-foot">' +
      '<div class="rail-badge' + (isAdmin() ? ' admin' : '') + '">' + esc(isAdmin() ? 'Admin Mode' : currentUser.name) + '</div>' +
      '<button id="logout-btn">Log Out</button>' +
      '</div>' +
      '</div>'
    );
  }

  /* ---------------- login ---------------- */
  function renderLoginView() {
    var html = '<div class="view-login"><div class="login-panel">';
    html += '<h1 class="login-title">Sales CRM Sign In</h1>';
    html += '<p class="login-sub">Sign in to see your pipeline, or as Admin to manage the whole team.</p>';
    html += '<div class="login-tabs">' +
      '<button type="button" class="login-tab' + (loginMode === 'salesman' ? ' active' : '') + '" data-login-mode="salesman">Salesman</button>' +
      '<button type="button" class="login-tab' + (loginMode === 'admin' ? ' active' : '') + '" data-login-mode="admin">Admin</button>' +
      '</div>';
    html += '<form id="login-form">';
    if (loginMode === 'salesman') {
      if (!roster.length) {
        html += '<p class="form-error" style="margin-top:0">No salesmen have been added yet. Ask your admin to add you from the Team page.</p>';
      } else {
        html += '<div class="field"><label>Name</label><select id="login-name">' +
          roster.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') +
          '</select></div>';
      }
    } else {
      html += '<div class="field"><label>Admin Name</label><input type="text" id="login-admin-name" autocomplete="username"></div>';
    }
    html += '<div class="field"><label>Password</label><input type="password" id="login-pw" autocomplete="current-password"></div>';
    if (loginError) html += '<p class="form-error">' + esc(loginError) + '</p>';
    if (loginMode === 'admin' || roster.length) {
      html += '<button type="submit" class="btn btn-primary" style="width:100%">Sign In</button>';
    }
    html += '</form></div></div>';
    return html;
  }

  function loadRoster(cb) {
    api('GET', '/api/auth/roster').then(function (data) {
      roster = data.salesmen || [];
      cb && cb();
    }).catch(function () { cb && cb(); });
  }

  /* ---------------- dashboard ---------------- */
  function renderDashboard(done) {
    api('GET', '/api/stats').then(function (stats) {
      var html = '<div class="view-head"><div>' +
        '<p class="view-kicker">' + esc(monthLabel(stats.currentPeriod)) + '</p>' +
        '<h1 class="view-title">Dashboard</h1>' +
        '</div></div>';

      html += '<div class="hl-bar">' +
        '<div class="hl-seg"><div class="hl-label">Open Leads</div><div class="hl-value">' + stats.totals.lead_count + '</div></div>' +
        '<div class="hl-seg"><div class="hl-label">Pipeline Value</div><div class="hl-value">' + fmtMoney(stats.totals.pipeline_value) + '</div></div>' +
        '<div class="hl-seg"><div class="hl-label">Overdue Follow-Ups</div><div class="hl-value">' + stats.overdueCount + '</div></div>' +
        '</div>';

      html += '<div class="panel"><h2 class="panel-title">Pipeline by Stage</h2>' + barRows(stats.byStage, 'stage') + '</div>';

      if (isAdmin() && stats.bySalesman.length) {
        html += '<div class="panel"><h2 class="panel-title">Performance by Salesman</h2>' + barRows(stats.bySalesman, 'name') + '</div>';
      }

      done(html);
    }).catch(function (err) { done(errorState(err)); });
  }

  function barRows(rows, labelKey) {
    if (!rows.length) return '<p class="empty-state" style="padding:24px 0">No data yet this month.</p>';
    var max = Math.max.apply(null, rows.map(function (r) { return Number(r.value || r.n || 0); }).concat([1]));
    return '<div class="bar-rows">' + rows.map(function (r) {
      var value = Number(r.value !== undefined ? r.value : r.n);
      var count = r.n !== undefined ? r.n : '';
      var pct = Math.round((Number(r.value || r.n || 0) / max) * 100);
      var color = STAGE_VAR[r[labelKey]] || '--steel';
      return '<div class="bar-row">' +
        '<div class="bar-row-label"><span class="sq-dot" style="background:var(' + color + ')"></span>' + esc(r[labelKey]) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:var(' + color + ')"></div></div>' +
        '<div class="bar-row-value">' + (r.value !== undefined ? fmtMoney(r.value) : count) + (r.n !== undefined && r.value !== undefined ? ' · ' + r.n : '') + '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function errorState(err) {
    if (err && err.status === 401) { currentUser = null; render(); return ''; }
    return '<div class="empty-state"><h3>Something went wrong</h3><p>' + esc((err && err.message) || 'Please try again.') + '</p></div>';
  }

  /* ---------------- leads list ---------------- */
  function renderLeadsView(done) {
    api('GET', '/api/leads').then(function (data) {
      var leads = data.leads;
      var html = '<div class="view-head"><div><p class="view-kicker">' + leads.length + ' account' + (leads.length === 1 ? '' : 's') + '</p>' +
        '<h1 class="view-title">Leads &amp; Accounts</h1>' +
        '<p class="view-sub">' + (isAdmin() ? 'Search, filter, and open any account.' : 'Search, filter, and open your accounts.') + ' This list is the current month — last month is in Archive.</p></div>' +
        '<button class="btn btn-primary" data-nav="form">+ New Lead</button></div>';

      html += '<div class="toolbar">' +
        '<div class="search"><input type="text" id="q-search" placeholder="Search company, contact, or site…" value="' + esc(tableFilter.q) + '"></div>' +
        '<select class="filter-sel" id="q-stage"><option value="">All stages</option>' + STAGES.map(function (s) { return '<option value="' + esc(s) + '"' + (tableFilter.stage === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
        '<select class="filter-sel" id="q-service"><option value="">All services</option>' + SERVICE_TYPES.map(function (s) { return '<option value="' + esc(s) + '"' + (tableFilter.service === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
        '</div>';

      var rows = leads.filter(function (l) {
        if (tableFilter.stage && l.stage !== tableFilter.stage) return false;
        if (tableFilter.service && l.service_type !== tableFilter.service) return false;
        if (tableFilter.q) {
          var hay = [l.company, l.contact, l.site, l.lead_code].join(' ').toLowerCase();
          if (hay.indexOf(tableFilter.q.toLowerCase()) === -1) return false;
        }
        return true;
      });

      if (!leads.length) {
        html += '<div class="table-wrap"><div class="empty-state"><h3>No leads yet</h3><p>Add your first lead to start building the pipeline.</p><button class="btn btn-primary" data-nav="form">+ New Lead</button></div></div>';
        return done(html);
      }
      if (!rows.length) {
        html += '<div class="table-wrap"><div class="empty-state"><h3>No matches</h3><p>Try clearing the search or filters.</p></div></div>';
        return done(html);
      }

      html += '<div class="table-wrap"><table><thead><tr>' +
        '<th>Lead ID</th><th>Company / Site</th><th>Contact</th><th>Service Type</th><th>Stage</th><th>Deal Value</th><th>Salesman</th><th>Next Follow-Up</th><th></th>' +
        '</tr></thead><tbody>' +
        rows.map(function (l) {
          var od = isOverdue(l);
          var v = STAGE_VAR[l.stage] || '--steel';
          var canEdit = isAdmin() || l.salesman_id === currentUser.id;
          return '<tr style="border-left:4px solid var(' + v + ')">' +
            '<td class="nowrap">' + esc(l.lead_code) + '</td>' +
            '<td><div class="cell-company">' + esc(l.company || '—') + '</div><div class="cell-sub">' + esc(l.site || '') + '</div></td>' +
            '<td>' + esc(l.contact || '—') + '<div class="cell-sub">' + esc(l.phone || '') + '</div></td>' +
            '<td>' + esc(l.service_type || '—') + '</td>' +
            '<td>' + stageChip(l.stage) + '</td>' +
            '<td class="money">' + fmtMoney(l.deal_value) + '</td>' +
            '<td>' + esc(l.salesman_name || '—') + '</td>' +
            '<td class="nowrap" style="' + (od ? 'color:var(--overdue);font-weight:700' : '') + '">' + (l.next_follow_up ? fmtDate(l.next_follow_up) : '—') + (od ? ' ⚠' : '') + '</td>' +
            '<td><div class="row-actions">' +
            '<button class="icon-btn" title="View" data-open-report="' + l.id + '">⊙</button>' +
            (canEdit ? '<button class="icon-btn" title="Edit" data-nav="form" data-edit-id="' + l.id + '">✎</button>' : '') +
            (isAdmin() ? '<button class="icon-btn" title="Delete" data-delete-lead="' + l.id + '">✕</button>' : '') +
            '</div></td></tr>';
        }).join('') +
        '</tbody></table></div>';
      done(html);
    }).catch(function (err) { done(errorState(err)); });
  }

  function stageChip(stage) {
    var v = STAGE_VAR[stage] || '--steel';
    return '<span class="chip" style="color:var(' + v + ');border-color:var(' + v + ');background:color-mix(in srgb, var(' + v + ') 14%, transparent)"><span class="dot" style="background:var(' + v + ')"></span>' + esc(stage) + '</span>';
  }

  /* ---------------- add / edit lead form ---------------- */
  function renderFormView(editId, done) {
    function build(editing) {
      if (editId && !editing) {
        return done('<div class="empty-state"><h3>Not available</h3><p>That lead could not be found, or isn\'t assigned to you.</p><button class="btn btn-ghost" data-nav="leads">Back to Leads</button></div>');
      }
      loadTeamIfAdmin(function () {
        var f = editing || { stage: 'New Lead' };
        var html = '<div class="view-head"><div><p class="view-kicker">' + (editing ? 'Edit account' : 'New account') + '</p>' +
          '<h1 class="view-title">' + (editing ? 'Edit Lead' : 'Add A New Lead') + '</h1>' +
          '<p class="view-sub">' + (editing ? 'Update this account and save — it updates everyone’s shared list immediately.' : 'Fill in what you know and save — it’s added to the shared list right away.') + '</p></div></div>';

        html += '<div class="form-wrap panel"><form id="lead-form">';
        if (editing) html += '<input type="hidden" id="f-id" value="' + editing.id + '">';
        html += fieldHtml('company', 'Company / Account Name', f.company, true);
        html += '<div class="field-row">' + fieldHtml('contact', 'Primary Contact', f.contact) + fieldHtml('phone', 'Phone', f.phone) + '</div>';
        html += fieldHtml('email', 'Email', f.email);
        html += '<div class="field-row">' + fieldHtml('site', 'Lease / Well / Site Name', f.site) + fieldHtml('county', 'County / Basin', f.county) + '</div>';
        html += fieldHtml('location', 'Location / Address', f.location);
        html += '<div class="field-row">' + selectHtml('service_type', 'Service Type Needed', f.service_type, SERVICE_TYPES) + selectHtml('stage', 'Pipeline Stage', f.stage, STAGES) + '</div>';
        if (isAdmin()) {
          html += '<div class="field-row">' + fieldHtml('deal_value', 'Est. Deal Value ($)', f.deal_value, false, 'number') +
            selectHtml('salesman_id', 'Salesman', String(f.salesman_id || currentUser.id), null, team.filter(function(u){return u.role==='salesman';}).map(function (u) { return { value: u.id, label: u.name }; })) + '</div>';
        } else {
          html += '<div class="field-row">' + fieldHtml('deal_value', 'Est. Deal Value ($)', f.deal_value, false, 'number') +
            '<div class="field"><label>Salesman</label><input type="text" value="' + esc(editing ? editing.salesman_name : currentUser.name) + '" disabled></div></div>';
        }
        html += '<div class="field-row">' + fieldHtml('last_contact', 'Last Contact', f.last_contact ? String(f.last_contact).slice(0,10) : '', false, 'date') + fieldHtml('next_follow_up', 'Next Follow-Up', f.next_follow_up ? String(f.next_follow_up).slice(0,10) : '', false, 'date') + '</div>';
        html += '<div class="field"><label>Notes</label><textarea id="f-notes">' + esc(f.notes || '') + '</textarea></div>';
        html += '<div id="form-error"></div>';
        html += '<div class="form-actions"><button type="submit" class="btn btn-primary">' + (editing ? 'Save Changes' : '✓ Save Lead') + '</button>' +
          '<button type="button" class="btn btn-ghost" data-nav="' + (editing ? 'leads' : 'dashboard') + '">Cancel</button></div>';
        html += '</form></div>';
        done(html);
      });
    }
    if (editId) {
      api('GET', '/api/leads/' + editId).then(function (data) { build(data.lead); }).catch(function () { build(null); });
    } else {
      build(null);
    }
  }
  function fieldHtml(key, label, val, required, type) {
    type = type || 'text';
    var reqStar = required ? ' <span class="req">*</span>' : '';
    return '<div class="field"><label>' + esc(label) + reqStar + '</label><input type="' + type + '" id="f-' + key + '" value="' + esc(val === undefined || val === null ? '' : val) + '"></div>';
  }
  function selectHtml(key, label, val, options, objectOptions) {
    var opts;
    if (objectOptions) {
      opts = objectOptions.map(function (o) { return '<option value="' + o.value + '"' + (String(val) === String(o.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('');
    } else {
      opts = options.map(function (o) { return '<option value="' + esc(o) + '"' + (val === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('');
    }
    return '<div class="field"><label>' + esc(label) + '</label><select id="f-' + key + '">' + (objectOptions ? '' : '<option value="">— Select —</option>') + opts + '</select></div>';
  }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

  function loadTeamIfAdmin(cb) {
    if (!isAdmin()) return cb();
    api('GET', '/api/team').then(function (data) { team = data.users; cb(); }).catch(cb);
  }

  function submitLeadForm(e) {
    e.preventDefault();
    var idEl = document.getElementById('f-id');
    var company = val('f-company');
    var errEl = document.getElementById('form-error');
    if (!company) {
      errEl.innerHTML = '<p class="form-error">Company / Account Name is required.</p>';
      return;
    }
    var body = {
      company: company, contact: val('f-contact'), phone: val('f-phone'), email: val('f-email'),
      site: val('f-site'), county: val('f-county'), location: val('f-location'),
      service_type: val('f-service_type'), stage: val('f-stage') || 'New Lead',
      deal_value: Number(val('f-deal_value')) || 0,
      last_contact: val('f-last_contact') || null, next_follow_up: val('f-next_follow_up') || null,
      notes: val('f-notes'),
    };
    if (isAdmin()) body.salesman_id = val('f-salesman_id');

    var req = idEl ? api('PUT', '/api/leads/' + idEl.value, body) : api('POST', '/api/leads', body);
    req.then(function (data) {
      toast(idEl ? 'Lead updated.' : 'Lead saved.');
      route('report', { id: data.lead.id });
    }).catch(function (err) {
      errEl.innerHTML = '<p class="form-error">' + esc((err.details && err.details[0]) || 'Could not save — please try again.') + '</p>';
    });
  }

  /* ---------------- report ---------------- */
  function renderReportView(id, done) {
    api('GET', '/api/leads/' + id).then(function (data) {
      var l = data.lead;
      var canEdit = isAdmin() || l.salesman_id === currentUser.id;
      var od = isOverdue(l);
      var html = '<div class="report-toolbar">' +
        '<button class="btn btn-ghost" data-nav="leads">← Back to Leads</button>' +
        '<div style="display:flex;gap:10px">' +
        (canEdit ? '<button class="btn btn-ghost" data-nav="form" data-edit-id="' + l.id + '">Edit</button>' : '') +
        (isAdmin() ? '<button class="btn btn-ghost" data-delete-lead="' + l.id + '" data-after="leads">Delete</button>' : '') +
        '<button class="btn btn-primary" id="btn-print">⎙ Print</button>' +
        '</div></div>';
      html += '<div class="report">' +
        '<div class="report-head"><div><div class="report-kicker">Account Profile</div><div class="report-id">' + esc(l.lead_code) + '</div></div></div>' +
        '<h1 class="report-title">' + esc(l.company || 'Untitled Account') + '</h1>' +
        '<div class="report-status-row">' + stageChip(l.stage) + '<span class="report-value">' + fmtMoney(l.deal_value) + '</span>' +
        (od ? '<span class="chip" style="color:var(--overdue);border-color:var(--overdue)">Follow-up overdue</span>' : '') + '</div>' +
        '<div class="report-grid">' +
        rg('Primary Contact', l.contact) + rg('Phone', l.phone) + rg('Email', l.email) + rg('Salesman', l.salesman_name) +
        rg('Lease / Well / Site', l.site) + rg('County / Basin', l.county) + rg('Location / Address', l.location) + rg('Service Type', l.service_type) +
        rg('Last Contact', l.last_contact ? fmtDate(l.last_contact) : '') + rg('Next Follow-Up', l.next_follow_up ? fmtDate(l.next_follow_up) : '') +
        '</div>' +
        '<div class="rg-item"><label>Notes</label><div class="report-notes">' + (l.notes ? esc(l.notes) : '<span class="empty">No notes on file.</span>') + '</div></div>' +
        '</div>';
      done(html);
    }).catch(function (err) { done(errorState(err)); });
  }
  function rg(label, value) {
    return '<div class="rg-item"><label>' + esc(label) + '</label><div>' + (value ? esc(value) : '<span class="empty">—</span>') + '</div></div>';
  }

  /* ---------------- archive ---------------- */
  function renderArchiveView(done) {
    Promise.all([
      api('GET', '/api/leads/periods'),
      api('GET', '/api/lost-opportunities/periods'),
    ]).then(function (results) {
      var periods = Array.from(new Set(results[0].periods.concat(results[1].periods))).sort().reverse();
      var html = '<div class="view-head"><div><h1 class="view-title">Archive</h1><p class="view-sub">Past months’ accounts and lost opportunities, kept for reference.</p></div></div>';
      if (!periods.length) {
        html += '<div class="table-wrap"><div class="empty-state"><h3>Nothing archived yet</h3><p>Past months will show up here once a new month begins.</p></div></div>';
        return done(html);
      }
      html += '<div class="table-wrap"><table><thead><tr><th>Month</th><th></th></tr></thead><tbody>' +
        periods.map(function (p) { return '<tr><td>' + esc(monthLabel(p)) + '</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" data-open-archive="' + esc(p) + '">Open</button></td></tr>'; }).join('') +
        '</tbody></table></div>';
      done(html);
    }).catch(function (err) { done(errorState(err)); });
  }
  function renderArchiveMonthView(period, done) {
    Promise.all([
      api('GET', '/api/leads?period=' + encodeURIComponent(period)),
      api('GET', '/api/lost-opportunities?period=' + encodeURIComponent(period)),
    ]).then(function (results) {
      var leads = results[0].leads;
      var lost = results[1].lostOpportunities;
      var html = '<div class="view-head"><div><p class="view-kicker">Archived · ' + esc(monthLabel(period)) + '</p><h1 class="view-title">' + esc(monthLabel(period)) + '</h1></div>' +
        '<button class="btn btn-ghost" data-nav="archive">← Back to Archive</button></div>';

      html += '<h2 class="panel-title" style="margin:24px 0 8px">Accounts</h2>';
      if (!leads.length) {
        html += '<div class="table-wrap"><div class="empty-state"><h3>No accounts</h3></div></div>';
      } else {
        html += '<div class="table-wrap"><table><thead><tr><th>Lead ID</th><th>Company</th><th>Stage</th><th>Deal Value</th><th>Salesman</th><th></th></tr></thead><tbody>' +
          leads.map(function (l) {
            return '<tr><td>' + esc(l.lead_code) + '</td><td>' + esc(l.company) + '</td><td>' + stageChip(l.stage) + '</td><td class="money">' + fmtMoney(l.deal_value) + '</td><td>' + esc(l.salesman_name) + '</td>' +
              '<td style="text-align:right"><button class="icon-btn" title="View" data-open-report="' + l.id + '">⊙</button></td></tr>';
          }).join('') + '</tbody></table></div>';
      }

      html += '<h2 class="panel-title" style="margin:24px 0 8px">Lost Opportunities</h2>';
      if (!lost.length) {
        html += '<div class="table-wrap"><div class="empty-state"><h3>None logged</h3></div></div>';
      } else {
        html += '<div class="table-wrap"><table><thead><tr><th>ID</th><th>Company</th><th>Reason</th><th>Potential Loss</th><th>Salesman</th><th></th></tr></thead><tbody>' +
          lost.map(function (o) {
            return '<tr><td>' + esc(o.lost_code) + '</td><td>' + esc(o.company) + '</td><td>' + esc(o.reason || '—') + '</td><td class="money">' + fmtMoney(o.potential_revenue_loss) + '</td><td>' + esc(o.salesman_name) + '</td>' +
              '<td style="text-align:right"><button class="icon-btn" title="View" data-open-lost-report="' + o.id + '">⊙</button></td></tr>';
          }).join('') + '</tbody></table></div>';
      }
      done(html);
    }).catch(function (err) { done(errorState(err)); });
  }

  /* ---------------- lost opportunities ---------------- */
  function renderLostOppsView(done) {
    api('GET', '/api/lost-opportunities').then(function (data) {
      var rows = data.lostOpportunities;
      lostOpps = rows;
      var totalLoss = rows.reduce(function (a, o) { return a + Number(o.potential_revenue_loss || 0); }, 0);
      var html = '<div class="view-head"><div><p class="view-kicker">' + rows.length + ' record' + (rows.length === 1 ? '' : 's') + ' · ' + fmtMoney(totalLoss) + ' potential revenue lost</p>' +
        '<h1 class="view-title">Lost Opportunities</h1><p class="view-sub">A running log of business that didn’t close. This list is the current month — last month is in Archive.</p></div>' +
        '<button class="btn btn-primary" id="btn-add-lost">+ Log Lost Opportunity</button></div>';
      html += '<div id="lost-form-slot"></div>';
      if (!rows.length) {
        html += '<div class="table-wrap"><div class="empty-state"><h3>Nothing logged yet</h3></div></div>';
        return done(html);
      }
      html += '<div class="table-wrap"><table><thead><tr><th>ID</th><th>Company</th><th>Contact</th><th>Service Type</th><th>Reason</th><th>Potential Loss</th><th>Salesman</th><th></th></tr></thead><tbody>' +
        rows.map(function (o) {
          return '<tr><td>' + esc(o.lost_code) + '</td><td>' + esc(o.company) + '</td><td>' + esc(o.contact || '—') + '</td><td>' + esc(o.service_type || '—') + '</td><td>' + esc(o.reason || '—') + '</td>' +
            '<td class="money">' + fmtMoney(o.potential_revenue_loss) + '</td><td>' + esc(o.salesman_name) + '</td>' +
            '<td><div class="row-actions">' +
            '<button class="icon-btn" title="View" data-open-lost-report="' + o.id + '">⊙</button>' +
            '<button class="icon-btn" title="Edit" data-edit-lost="' + o.id + '">✎</button>' +
            (isAdmin() ? '<button class="icon-btn" title="Delete" data-delete-lost="' + o.id + '">✕</button>' : '') +
            '</div></td></tr>';
        }).join('') + '</tbody></table></div>';
      done(html);
    }).catch(function (err) { done(errorState(err)); });
  }
  function renderLostOppReportView(id, done) {
    api('GET', '/api/lost-opportunities/' + id).then(function (data) {
      var o = data.lostOpportunity;
      var html = '<div class="report-toolbar">' +
        '<button class="btn btn-ghost" data-nav="lostOpps">← Back to Lost Opportunities</button>' +
        '<div style="display:flex;gap:10px">' +
        (isAdmin() ? '<button class="btn btn-ghost" data-delete-lost="' + o.id + '" data-after="lostOpps">Delete</button>' : '') +
        '</div></div>';
      html += '<div class="report">' +
        '<div class="report-head"><div><div class="report-kicker">Lost Opportunity</div><div class="report-id">' + esc(o.lost_code) + '</div></div></div>' +
        '<h1 class="report-title">' + esc(o.company || 'Untitled') + '</h1>' +
        '<div class="report-status-row"><span class="report-value">' + fmtMoney(o.potential_revenue_loss) + ' potential loss</span></div>' +
        '<div class="report-grid">' +
        rg('Contact', o.contact) + rg('Service Type', o.service_type) + rg('Reason Lost', o.reason) + rg('Salesman', o.salesman_name) +
        '</div>' +
        '<div class="rg-item"><label>Notes</label><div class="report-notes">' + (o.notes ? esc(o.notes) : '<span class="empty">No notes on file.</span>') + '</div></div>' +
        '</div>';
      done(html);
    }).catch(function (err) { done(errorState(err)); });
  }
  function lostOppFormHtml(editing) {
    var f = editing || {};
    var idField = editing ? '<input type="hidden" id="f-lo-id" value="' + editing.id + '">' : '';
    var salesmanField;
    if (isAdmin()) {
      salesmanField = selectHtml('lo-salesman_id', 'Salesman', String(f.salesman_id || currentUser.id), null, team.filter(function (u) { return u.role === 'salesman'; }).map(function (u) { return { value: u.id, label: u.name }; }));
    } else {
      salesmanField = '<div class="field"><label>Salesman</label><input type="text" value="' + esc(editing ? editing.salesman_name : currentUser.name) + '" disabled></div>';
    }
    return '<div class="panel form-wrap"><form id="lost-form">' + idField +
      fieldHtml('lo-company', 'Company', f.company, true) +
      '<div class="field-row">' + fieldHtml('lo-contact', 'Contact', f.contact) + selectHtml('lo-service', 'Service Type', f.service_type || '', SERVICE_TYPES) + '</div>' +
      '<div class="field-row">' + fieldHtml('lo-reason', 'Reason Lost', f.reason) + fieldHtml('lo-loss', 'Potential Revenue Loss ($)', f.potential_revenue_loss, false, 'number') + '</div>' +
      '<div class="field-row">' + salesmanField + '</div>' +
      '<div class="field"><label>Notes</label><textarea id="f-lo-notes">' + esc(f.notes || '') + '</textarea></div>' +
      '<div id="lost-form-error"></div>' +
      '<div class="form-actions"><button type="submit" class="btn btn-primary">' + (editing ? 'Save Changes' : 'Save') + '</button><button type="button" class="btn btn-ghost" id="lost-form-cancel">Cancel</button></div>' +
      '</form></div>';
  }
  function openLostForm(editing) {
    loadTeamIfAdmin(function () {
      document.getElementById('lost-form-slot').innerHTML = lostOppFormHtml(editing);
      document.getElementById('lost-form').addEventListener('submit', submitLostOppForm);
      document.getElementById('lost-form-cancel').addEventListener('click', function () { document.getElementById('lost-form-slot').innerHTML = ''; });
    });
  }
  function submitLostOppForm(e) {
    e.preventDefault();
    var idEl = document.getElementById('f-lo-id');
    var company = val('f-lo-company');
    var errEl = document.getElementById('lost-form-error');
    if (!company) { errEl.innerHTML = '<p class="form-error">Company is required.</p>'; return; }
    var body = {
      company: company, contact: val('f-lo-contact'), service_type: val('f-lo-service'),
      reason: val('f-lo-reason'), potential_revenue_loss: Number(val('f-lo-loss')) || 0, notes: val('f-lo-notes'),
    };
    if (isAdmin()) body.salesman_id = val('f-lo-salesman_id');
    var req = idEl ? api('PUT', '/api/lost-opportunities/' + idEl.value, body) : api('POST', '/api/lost-opportunities', body);
    req.then(function () {
      toast(idEl ? 'Lost opportunity updated.' : 'Lost opportunity logged.');
      route('lostOpps');
    }).catch(function (err) {
      errEl.innerHTML = '<p class="form-error">' + esc((err.details && err.details[0]) || 'Could not save.') + '</p>';
    });
  }

  /* ---------------- team (admin) ---------------- */
  function renderTeamView(done) {
    api('GET', '/api/team').then(function (data) {
      team = data.users;
      var html = '<div class="view-head"><div><h1 class="view-title">Team</h1><p class="view-sub">Add salesmen, reset passwords, and manage admin access.</p></div></div>';

      html += '<div class="panel"><h2 class="panel-title">Add Team Member</h2><form id="add-user-form">' +
        '<div class="field-row">' + fieldHtml('nu-name', 'Full Name', '', true) + fieldHtml('nu-pass', 'Temporary Password', '', true, 'password') + '</div>' +
        '<div class="field"><label>Role</label><select id="f-nu-role"><option value="salesman">Salesman</option><option value="admin">Admin</option></select></div>' +
        '<div id="add-user-error"></div>' +
        '<div class="form-actions"><button type="submit" class="btn btn-primary">Add</button></div>' +
        '</form></div>';

      html += '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th></th></tr></thead><tbody>' +
        team.map(function (u) {
          return '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.role) + '</td>' +
            '<td><div class="row-actions">' +
            '<button class="btn btn-ghost btn-sm" data-reset-pw="' + u.id + '">Reset Password</button>' +
            (u.id !== currentUser.id ? '<button class="btn btn-ghost btn-sm" data-remove-user="' + u.id + '">Remove</button>' : '') +
            '</div></td></tr>';
        }).join('') + '</tbody></table></div>';
      done(html);
    }).catch(function (err) { done(errorState(err)); });
  }

  /* ---------------- wiring ---------------- */
  var deleteArmed = null;

  function wireView() {
    document.querySelectorAll('[data-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var view = btn.getAttribute('data-nav');
        var editId = btn.getAttribute('data-edit-id');
        route(view, editId ? { id: editId } : {});
      });
    });
    document.querySelectorAll('[data-open-report]').forEach(function (el) {
      el.addEventListener('click', function () { route('report', { id: el.getAttribute('data-open-report') }); });
    });
    document.querySelectorAll('[data-open-archive]').forEach(function (el) {
      el.addEventListener('click', function () { route('archiveMonth', { period: el.getAttribute('data-open-archive') }); });
    });
    document.querySelectorAll('[data-open-lost-report]').forEach(function (el) {
      el.addEventListener('click', function () { route('lostOppReport', { id: el.getAttribute('data-open-lost-report') }); });
    });

    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', function () {
      api('POST', '/api/auth/logout').then(function () { currentUser = null; loginMode = 'salesman'; loginError = ''; loadRoster(function () { render(); }); });
    });

    var loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var nameEl = loginMode === 'admin' ? document.getElementById('login-admin-name') : document.getElementById('login-name');
      var name = nameEl ? nameEl.value.trim() : '';
      var pw = document.getElementById('login-pw').value;
      doLogin(name, pw);
    });
    document.querySelectorAll('[data-login-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () { loginMode = btn.getAttribute('data-login-mode'); loginError = ''; render(); });
    });

    var leadForm = document.getElementById('lead-form');
    if (leadForm) leadForm.addEventListener('submit', submitLeadForm);

    var printBtn = document.getElementById('btn-print');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    var addLostBtn = document.getElementById('btn-add-lost');
    if (addLostBtn) addLostBtn.addEventListener('click', function () { openLostForm(null); });

    document.querySelectorAll('[data-edit-lost]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-edit-lost');
        var record = null;
        for (var i = 0; i < lostOpps.length; i++) { if (String(lostOpps[i].id) === String(id)) { record = lostOpps[i]; break; } }
        openLostForm(record);
      });
    });

    document.querySelectorAll('[data-delete-lead]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-delete-lead');
        var key = 'lead-' + id;
        if (deleteArmed !== key) {
          deleteArmed = key;
          btn.textContent = '✕ Confirm?';
          setTimeout(function () { if (deleteArmed === key) deleteArmed = null; }, 4000);
          return;
        }
        deleteArmed = null;
        api('DELETE', '/api/leads/' + id).then(function () {
          toast('Lead deleted.');
          var after = btn.getAttribute('data-after');
          route(after || 'leads');
        }).catch(function () { toast('Could not delete.', true); });
      });
    });
    document.querySelectorAll('[data-delete-lost]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-delete-lost');
        var key = 'lost-' + id;
        if (deleteArmed !== key) {
          deleteArmed = key;
          btn.textContent = '✕';
          btn.title = 'Confirm delete?';
          setTimeout(function () { if (deleteArmed === key) deleteArmed = null; }, 4000);
          return;
        }
        deleteArmed = null;
        api('DELETE', '/api/lost-opportunities/' + id).then(function () { toast('Removed.'); route('lostOpps'); }).catch(function () { toast('Could not delete.', true); });
      });
    });

    var addUserForm = document.getElementById('add-user-form');
    if (addUserForm) addUserForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var errEl = document.getElementById('add-user-error');
      api('POST', '/api/team', { name: val('f-nu-name'), password: val('f-nu-pass'), role: val('f-nu-role') }).then(function () {
        toast('Team member added.');
        route('team');
      }).catch(function (err) {
        errEl.innerHTML = '<p class="form-error">' + esc((err.details && err.details[0]) || (err.code === 'name_taken' ? 'That name is already in use.' : 'Could not add.')) + '</p>';
      });
    });
    document.querySelectorAll('[data-reset-pw]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-reset-pw');
        var pw = window.prompt('New temporary password for this person (min 8 characters):');
        if (!pw) return;
        api('PUT', '/api/team/' + id + '/password', { password: pw }).then(function () { toast('Password reset.'); }).catch(function () { toast('Could not reset password (min 8 characters).', true); });
      });
    });
    document.querySelectorAll('[data-remove-user]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-remove-user');
        var key = 'user-' + id;
        if (deleteArmed !== key) {
          deleteArmed = key;
          btn.textContent = 'Confirm?';
          setTimeout(function () { if (deleteArmed === key) deleteArmed = null; }, 4000);
          return;
        }
        deleteArmed = null;
        api('DELETE', '/api/team/' + id).then(function () { toast('Removed.'); route('team'); }).catch(function (err) {
          toast(err.message || 'Could not remove — they may have records on file.', true);
        });
      });
    });

    var qs = document.getElementById('q-search');
    if (qs) qs.addEventListener('input', function () { tableFilter.q = qs.value; route('leads'); });
    var qStage = document.getElementById('q-stage');
    if (qStage) qStage.addEventListener('change', function () { tableFilter.stage = qStage.value; route('leads'); });
    var qService = document.getElementById('q-service');
    if (qService) qService.addEventListener('change', function () { tableFilter.service = qService.value; route('leads'); });
  }

  function doLogin(name, password) {
    if (!name) { loginError = 'Select your name.'; render(); return; }
    api('POST', '/api/auth/login', { name: name, password: password }).then(function (data) {
      currentUser = data.user;
      loginError = '';
      route('dashboard');
    }).catch(function () {
      loginError = 'Incorrect name or password.';
      render();
    });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    api('GET', '/api/auth/me').then(function (data) {
      currentUser = data.user;
      if (currentUser) {
        route('dashboard');
      } else {
        loadRoster(function () { render(); });
      }
    }).catch(function () { loadRoster(function () { render(); }); });
  }

  boot();
})();
