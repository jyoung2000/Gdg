/*
 * The offline edition's application code.
 *
 * Plain DOM, no framework, no build step, no imports — because the file has to
 * run from file://, where a module graph and a bundler are exactly the
 * dependencies this edition exists to avoid.
 *
 * What is simulated is the backend. Everything else is real: the navigation,
 * the disclosure, the drawer, the pickers, the filters, the palette, the
 * mobile sheet and the focus handling are the same interactions the production
 * app performs, so what someone judges here is the interface rather than a
 * picture of it.
 */
(function () {
  'use strict';

  var DATA = window.MERIDIAN_OFFLINE_DATA;
  var root = document.getElementById('root');

  /* ---------------------------------------------------------------- */
  /* State                                                            */
  /* ---------------------------------------------------------------- */

  var state = {
    screen: 'chat',
    moreOpen: false,
    navOpen: false,
    drawer: null, // { title, body }
    palette: false,
    paletteQuery: '',
    paletteIndex: 0,
    routing: 'Auto',
    modelQuery: '',
    modelFilter: 'all',
    settings: 'general',
    tools: DATA.tools.map(function (t) { return { id: t.id, on: t.on }; }),
    sent: false,
    optimisation: 'Balanced',
  };

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function set(patch) {
    Object.keys(patch).forEach(function (k) { state[k] = patch[k]; });
    render();
  }

  /* ---------------------------------------------------------------- */
  /* Navigation                                                       */
  /* ---------------------------------------------------------------- */

  var PRIMARY = [
    { id: 'chat', label: 'Chats' },
    { id: 'projects', label: 'Projects' },
    { id: 'models', label: 'Models' },
    { id: 'activity', label: 'Activity' },
    { id: 'settings', label: 'Settings' },
  ];

  /* Everything the production sidebar keeps behind its "More" disclosure. */
  var MORE = [
    { id: 'home', label: 'Home' }, { id: 'workspace', label: 'Workspace' },
    { id: 'director', label: 'Director' }, { id: 'tasks', label: 'Tasks' },
    { id: 'agents', label: 'Agents' }, { id: 'browser', label: 'Browser' },
    { id: 'computer', label: 'Computer' }, { id: 'versioncontrol', label: 'Version Control' },
    { id: 'generations', label: 'Generations' }, { id: 'discover', label: 'Discover' },
    { id: 'ai', label: 'AI' }, { id: 'skills', label: 'Skills' },
    { id: 'connections', label: 'Connections' }, { id: 'pools', label: 'Pools' },
    { id: 'mcp', label: 'MCP' }, { id: 'devops', label: 'DevOps' },
  ];

  function go(id) {
    set({ screen: id, navOpen: false, palette: false, moreOpen: state.moreOpen || isMore(id) });
  }
  function isMore(id) {
    return MORE.some(function (m) { return m.id === id; });
  }

  /* ---------------------------------------------------------------- */
  /* Pieces                                                           */
  /* ---------------------------------------------------------------- */

  function dot(status) { return h('span', { class: 'of-dot of-dot--' + status, 'aria-hidden': 'true' }); }

  function chip(label, pressed, onclick) {
    return h('button', { type: 'button', class: 'of-chip', 'aria-pressed': pressed ? 'true' : 'false', onclick: onclick }, [label]);
  }

  function sectionTitle(text) { return h('div', { class: 'of-nav-title', text: text }); }

  function navButton(item, active) {
    return h('button', {
      type: 'button', class: 'of-nav-btn', 'aria-current': active ? 'page' : null,
      onclick: function () { go(item.id); },
    }, [item.label]);
  }

  function sidebar() {
    var kids = [
      sectionTitle('Meridian'),
      h('button', {
        type: 'button', class: 'of-nav-btn', style: 'font-weight:600',
        onclick: function () { set({ screen: 'chat', sent: false, navOpen: false }); },
      }, ['+  New chat']),
    ];
    PRIMARY.forEach(function (p) { kids.push(navButton(p, state.screen === p.id)); });
    kids.push(sectionTitle('More'));
    kids.push(h('button', {
      type: 'button', class: 'of-nav-btn', 'aria-expanded': state.moreOpen ? 'true' : 'false',
      onclick: function () { set({ moreOpen: !state.moreOpen }); },
    }, [(state.moreOpen ? '▾  Hide advanced' : '▸  Everything else')]));
    if (state.moreOpen) MORE.forEach(function (m) { kids.push(navButton(m, state.screen === m.id)); });

    return h('nav', { class: 'of-side', 'data-open': state.navOpen ? 'true' : 'false', 'aria-label': 'Primary' }, kids);
  }

  function topbar() {
    return h('header', { class: 'of-top' }, [
      h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm of-menu-btn', 'aria-label': 'Menu', 'aria-expanded': state.navOpen ? 'true' : 'false', onclick: function () { set({ navOpen: !state.navOpen }); } }, ['☰']),
      h('strong', { text: 'Meridian' }),
      h('span', { class: 'of-preview-flag', text: 'Offline preview' }),
      h('div', { class: 'of-grow' }),
      h('button', { type: 'button', class: 'mrd-button mrd-button--secondary mrd-button--sm', onclick: function () { set({ palette: true, paletteQuery: '', paletteIndex: 0 }); } }, ['⌘K  Search']),
    ]);
  }

  /* ---------------------------------------------------------------- */
  /* Screens                                                          */
  /* ---------------------------------------------------------------- */

  function routingPicker() {
    var modes = ['Auto', 'Best', 'Fast', 'Cheap', 'Free', 'Local'];
    return h('div', { class: 'of-row', role: 'group', 'aria-label': 'Routing' },
      modes.map(function (m) {
        return chip(m, state.routing === m, function () { set({ routing: m }); });
      }).concat([
        h('button', {
          type: 'button', class: 'of-chip',
          onclick: function () { openDrawer('Advanced routing', advancedRoutingBody()); },
        }, ['Advanced…']),
        h('button', {
          type: 'button', class: 'of-chip',
          onclick: function () { openDrawer('Tools', toolsBody()); },
        }, ['Tools · ' + state.tools.filter(function (t) { return t.on; }).length]),
      ]));
  }

  function chatScreen() {
    var body = [];
    if (!state.sent) {
      body.push(h('div', { class: 'of-col', style: 'gap:8px;margin-block:6vh 20px;max-width:720px' }, [
        h('h1', { class: 'of-h1', text: 'What do you need?' }),
        h('p', { class: 'of-muted', style: 'margin:0', text: 'Describe it. Meridian picks the model, runs the work, and shows you why.' }),
      ]));
    } else {
      body.push(h('div', { class: 'of-col', style: 'max-width:760px;gap:18px' }, [
        h('div', { class: 'of-card' }, [
          h('div', { class: 'of-muted', style: 'font-size:12px;margin-block-end:6px', text: 'You' }),
          h('div', { text: 'Find where authentication is handled and fix the token refresh bug.' }),
        ]),
        h('div', { class: 'of-col', style: 'gap:10px' }, [
          h('div', { class: 'of-muted', style: 'font-size:13px', text: "I'll handle this as a task." }),
          h('ul', { class: 'of-stage-list' }, DATA.taskStages.map(function (s) {
            var mark = s.state === 'done' ? '✓' : s.state === 'active' ? '●' : '○';
            return h('li', {}, [
              h('span', { 'aria-hidden': 'true', text: mark }),
              h('span', { text: s.label }),
              s.state === 'active' ? h('span', { class: 'of-muted', style: 'font-size:12px', text: 'running…' }) : null,
            ]);
          })),
          h('div', { class: 'of-row', style: 'gap:8px' }, [
            h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm', onclick: function () { openDrawer('Task details', taskBody()); } }, ['Task details']),
            h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm', onclick: function () { openDrawer('Agent run', agentBody()); } }, ['Agent run · 6 specialists']),
          ]),
        ]),
        h('div', { class: 'of-card' }, [
          h('div', { text: 'The refresh path drops the rotation token when the response omits `expires_in`. I have made it fall back to the documented default and added a regression test.' }),
          h('hr', { class: 'of-sep' }),
          h('div', { class: 'of-row', style: 'gap:14px;font-size:13px' }, [
            h('span', { class: 'of-muted', text: DATA.routing.selected + ' · google' }),
            h('span', { class: 'of-muted', text: '1,204 tokens' }),
            h('span', { class: 'of-muted', text: 'Free' }),
            h('span', { class: 'of-muted', text: '410 ms' }),
            h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm', onclick: function () { openDrawer('Why this model?', whyBody()); } }, ['Why this model?']),
          ]),
        ]),
      ]));
    }

    body.push(h('div', { class: 'of-col', style: 'max-width:760px;margin-block-start:20px;gap:10px' }, [
      h('div', { class: 'of-composer' }, [
        h('textarea', { rows: '2', 'aria-label': 'Message', placeholder: 'Ask for anything, or describe a change you want made…' }),
        h('div', { class: 'of-row', style: 'margin-block-start:8px' }, [
          routingPicker(),
          h('div', { class: 'of-grow' }),
          h('button', { type: 'button', class: 'mrd-button mrd-button--primary mrd-button--sm', onclick: function () { set({ sent: true }); } }, ['Send']),
        ]),
      ]),
      h('p', { class: 'of-muted', style: 'font-size:12px;margin:0', text: 'Offline preview — nothing is sent anywhere and no model runs.' }),
    ]));

    if (!state.sent) {
      body.push(h('div', { class: 'of-col', style: 'margin-block-start:28px;max-width:760px;gap:8px' }, [
        h('h2', { class: 'of-h2', text: 'Recent' }),
      ].concat(DATA.conversations.map(function (c) {
        return h('div', { class: 'of-card of-card--tap', tabindex: '0', role: 'button', onclick: function () { set({ sent: true }); } }, [
          h('div', { text: c.title }),
          h('div', { class: 'of-muted', style: 'font-size:12px', text: c.when }),
        ]);
      }))));
    }
    return h('div', { class: 'of-col' }, body);
  }

  function modelsScreen() {
    var filters = [
      { id: 'all', label: 'All' }, { id: 'free', label: 'Free' }, { id: 'local', label: 'Local' },
      { id: 'vision', label: 'Vision' }, { id: 'image', label: 'Image' }, { id: 'tools', label: 'Tools' },
    ];
    var q = state.modelQuery.trim().toLowerCase();
    var shown = DATA.models.filter(function (m) {
      if (q && (m.name + ' ' + m.provider).toLowerCase().indexOf(q) === -1) return false;
      if (state.modelFilter === 'free') return m.verdict === 'free';
      if (state.modelFilter === 'local') return m.verdict === 'local';
      if (state.modelFilter === 'vision') return m.caps.indexOf('vision') !== -1;
      if (state.modelFilter === 'image') return m.caps.indexOf('image') !== -1;
      if (state.modelFilter === 'tools') return m.caps.indexOf('tools') !== -1;
      return true;
    });

    return h('div', { class: 'of-col' }, [
      h('div', { class: 'of-row' }, [
        h('h1', { class: 'of-h1', text: 'Models' }),
        h('span', { class: 'of-muted', text: shown.length + ' of ' + DATA.models.length + ' shown' }),
      ]),
      h('p', { class: 'of-muted', style: 'margin:0', text: 'What AI Meridian can use, where it comes from, and what it costs. Demo catalogue — not live provider data.' }),
      h('div', { class: 'of-row' }, [
        h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm', onclick: function () { go('connections'); } }, ['Connections']),
        h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm', onclick: function () { go('discover'); } }, ['Discover free models']),
        h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm', onclick: function () { go('pools'); } }, ['Pools']),
      ]),
      h('div', { class: 'of-row' }, [
        h('input', {
          type: 'search', class: 'mrd-input', 'aria-label': 'Search models', placeholder: 'Search models',
          value: state.modelQuery, style: 'flex:1 1 220px;padding:8px 12px;border-radius:9px;border:1px solid var(--mrd-border-subtle,#e2e2df);font:inherit;background:transparent;color:inherit',
          oninput: function (e) { state.modelQuery = e.target.value; render(); requestAnimationFrame(focusSearch); },
        }),
      ].concat(filters.map(function (f) {
        return chip(f.label, state.modelFilter === f.id, function () { set({ modelFilter: f.id }); });
      }))),
      h('div', { class: 'of-col', style: 'gap:10px' }, shown.length ? shown.map(modelCard) : [
        h('div', { class: 'of-card' }, [
          h('div', { text: 'Nothing matched' }),
          h('div', { class: 'of-muted', style: 'font-size:13px', text: 'Clear the search or choose a different filter.' }),
        ]),
      ]),
    ]);
  }

  function modelCard(m) {
    return h('div', {
      class: 'of-card of-card--tap', role: 'button', tabindex: '0',
      onclick: function () { openDrawer(m.name, modelBody(m)); },
      onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(m.name, modelBody(m)); } },
    }, [
      h('div', { class: 'of-row', style: 'gap:10px' }, [
        dot(m.health),
        h('strong', { text: m.name }),
        h('span', { class: 'of-muted', style: 'font-size:13px', text: m.provider }),
        h('span', { class: 'mrd-badge mrd-badge--sm', text: m.access }),
        m.ctx ? h('span', { class: 'of-muted', style: 'font-size:12px', text: m.ctx.toLocaleString() + ' ctx' }) : null,
        h('div', { class: 'of-grow' }),
        h('span', { class: 'of-muted', style: 'font-size:12px', text: 'checked ' + m.checked }),
      ]),
      h('div', { class: 'of-muted', style: 'font-size:13px;margin-block-start:5px', text: m.quota + (m.caps.length ? ' · ' + m.caps.join(' · ') : '') }),
    ]);
  }

  function connectionsScreen() {
    return h('div', { class: 'of-col' }, [
      h('h1', { class: 'of-h1', text: 'Connections' }),
      h('p', { class: 'of-muted', style: 'margin:0', text: 'The accounts Meridian uses to reach models. Keys are shown masked and never leave this machine.' }),
      h('div', { class: 'of-col', style: 'gap:10px' }, DATA.connections.map(function (c) {
        return h('div', {
          class: 'of-card of-card--tap', role: 'button', tabindex: '0',
          onclick: function () { openDrawer(c.name, connectionBody(c)); },
        }, [
          h('div', { class: 'of-row', style: 'gap:10px' }, [
            dot(c.state === 'connected' ? c.health : 'unknown'),
            h('strong', { text: c.name }),
            h('span', { class: 'mrd-badge mrd-badge--sm', text: c.state === 'connected' ? 'Connected' : 'Not connected' }),
            h('div', { class: 'of-grow' }),
            h('span', { class: 'of-muted', style: 'font-size:13px', text: c.models + ' models' }),
          ]),
          h('div', { class: 'of-muted', style: 'font-size:13px;margin-block-start:5px', text: (c.key || 'No key configured') + ' · ' + c.dataUse }),
        ]);
      })),
    ]);
  }

  function discoverScreen() {
    var free = DATA.models.filter(function (m) { return m.verdict === 'free' || m.verdict === 'local'; });
    return h('div', { class: 'of-col' }, [
      h('h1', { class: 'of-h1', text: 'Discover' }),
      h('div', { class: 'of-card' }, [
        h('div', { class: 'of-row' }, [
          h('strong', { text: 'Discovery sources' }),
          h('span', { class: 'mrd-badge mrd-badge--sm', text: '3/6 loaded' }),
          h('span', { class: 'of-muted', style: 'font-size:13px', text: '77 providers · 202 models · 126 free' }),
        ]),
        h('div', { class: 'of-muted', style: 'font-size:13px;margin-block-start:8px', text: 'free-llm-api-hub, uzair004 and mnfst loaded from cache. Three provider endpoints were unreachable and are reported rather than hidden.' }),
      ]),
      h('p', { class: 'of-muted', style: 'margin:0', text: free.length + ' shown. Excluded: 1 because it costs money; 1 because cost is not established.' }),
      h('div', { class: 'of-col', style: 'gap:10px' }, free.map(modelCard)),
    ]);
  }

  function projectsScreen() {
    return h('div', { class: 'of-col' }, [
      h('h1', { class: 'of-h1', text: 'Projects' }),
      h('p', { class: 'of-muted', style: 'margin:0', text: 'A project holds files, context, conversations and its own model preferences.' }),
      h('div', { class: 'of-col', style: 'gap:10px' }, DATA.projects.map(function (p) {
        return h('div', { class: 'of-card of-card--tap', role: 'button', tabindex: '0', onclick: function () { openDrawer(p.name, projectBody(p)); } }, [
          h('div', { class: 'of-row' }, [h('strong', { text: p.name }), h('span', { class: 'of-muted', style: 'font-size:13px', text: p.note })]),
          h('div', { class: 'of-muted', style: 'font-size:13px;margin-block-start:5px', text: p.files + ' files · ' + p.chats + ' conversations' }),
        ]);
      })),
    ]);
  }

  function activityScreen() {
    return h('div', { class: 'of-col' }, [
      h('h1', { class: 'of-h1', text: 'Activity' }),
      h('p', { class: 'of-muted', style: 'margin:0', text: 'What ran, on which model, what it cost, and what recovered.' }),
      h('div', { class: 'of-scroll-x' }, [
        h('table', { class: 'of-table' }, [
          h('thead', {}, [h('tr', {}, ['When', 'Model', 'Provider', 'Tokens', 'Cost', 'Latency', 'Outcome'].map(function (t) { return h('th', { text: t }); }))]),
          h('tbody', {}, DATA.activity.map(function (a) {
            return h('tr', {}, [
              h('td', { 'data-label': 'When', text: a.when }),
              h('td', { 'data-label': 'Model', text: a.model }),
              h('td', { 'data-label': 'Provider', text: a.provider }),
              h('td', { 'data-label': 'Tokens', text: a.tokens }),
              h('td', { 'data-label': 'Cost', text: a.cost }),
              h('td', { 'data-label': 'Latency', text: a.ms + ' ms' }),
              h('td', { 'data-label': 'Outcome' }, [
                a.outcome === 'recovered'
                  ? h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm', onclick: function () { openDrawer('Recovered request', recoveredBody()); } }, ['Recovered'])
                  : h('span', { class: 'of-muted', text: 'ok' }),
              ]),
            ]);
          })),
        ]),
      ]),
    ]);
  }

  var SETTINGS_SECTIONS = [
    { id: 'general', label: 'General' },
    { id: 'models', label: 'Models & Connections' },
    { id: 'behavior', label: 'AI Behavior' },
    { id: 'tools', label: 'Tools' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'advanced', label: 'Advanced' },
  ];

  function settingsScreen() {
    var bodies = {
      general: ['Appearance and theme', 'Keyboard shortcuts', 'Default project', 'Language and formatting'],
      models: ['Providers and credentials', 'Local model endpoints', 'Default model', 'Discovery sources and refresh'],
      behavior: ['Routing defaults', 'Token optimisation', 'Response preferences', 'Agents and specialists', 'Advanced routing policies'],
      tools: ['MCP servers', 'Skills', 'Browser', 'Computer agent', 'Docker sandbox', 'Tool permissions'],
      privacy: ['Provider data use', 'Trust levels', 'Sensitive-request routing', 'Local-only preference'],
      advanced: ['Pools and reservations', 'Circuit breakers', 'Gateway and networking', 'Diagnostics', 'Request tracing'],
    };
    var items = bodies[state.settings] || [];
    return h('div', { class: 'of-col' }, [
      h('h1', { class: 'of-h1', text: 'Settings' }),
      h('div', { class: 'of-row' }, SETTINGS_SECTIONS.map(function (s) {
        return chip(s.label, state.settings === s.id, function () { set({ settings: s.id }); });
      })),
      state.settings === 'behavior'
        ? h('div', { class: 'of-card' }, [
            h('div', { class: 'of-row' }, [
              h('strong', { text: 'Token optimisation' }),
              h('div', { class: 'of-grow' }),
            ]),
            h('div', { class: 'of-row', style: 'margin-block-start:8px' }, ['Off', 'Conservative', 'Balanced', 'Aggressive'].map(function (m) {
              return chip(m, state.optimisation === m, function () { set({ optimisation: m }); });
            })),
            h('p', { class: 'of-muted', style: 'font-size:13px;margin-block-end:0', text: 'Every individual technique can still be turned off under Advanced optimisation.' }),
          ])
        : null,
      h('div', { class: 'of-col', style: 'gap:10px' }, items.map(function (label) {
        return h('div', { class: 'of-card of-card--tap', role: 'button', tabindex: '0', onclick: function () { openDrawer(label, settingBody(label)); } }, [
          h('div', { class: 'of-row' }, [h('span', { text: label }), h('div', { class: 'of-grow' }), h('span', { class: 'of-muted', text: '›' })]),
        ]);
      })),
    ]);
  }

  /** Every screen the production sidebar can reach, so nothing is a dead link. */
  function placeholderScreen(id) {
    var item = MORE.concat(PRIMARY).filter(function (m) { return m.id === id; })[0];
    return h('div', { class: 'of-col' }, [
      h('h1', { class: 'of-h1', text: item ? item.label : id }),
      h('div', { class: 'of-card' }, [
        h('p', { style: 'margin-block-start:0', text: 'This screen exists in the production application with its full functionality.' }),
        h('p', { class: 'of-muted', style: 'margin-block-end:0', text: 'The offline preview renders the surfaces a first-time user meets in full, and represents the advanced destinations by name so the navigation is complete and nothing here is a dead link.' }),
      ]),
    ]);
  }

  function screenBody() {
    switch (state.screen) {
      case 'chat': return chatScreen();
      case 'models': return modelsScreen();
      case 'connections': return connectionsScreen();
      case 'discover': return discoverScreen();
      case 'projects': return projectsScreen();
      case 'activity': return activityScreen();
      case 'settings': return settingsScreen();
      default: return placeholderScreen(state.screen);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Drawer bodies                                                    */
  /* ---------------------------------------------------------------- */

  function kv(label, value) {
    return h('div', { class: 'of-row', style: 'justify-content:space-between;gap:16px' }, [
      h('span', { class: 'of-muted', style: 'font-size:13px', text: label }),
      h('span', { style: 'font-size:13px;text-align:end', text: value }),
    ]);
  }

  function modelBody(m) {
    return h('div', { class: 'of-col' }, [
      kv('Provider', m.provider), kv('Access', m.access),
      kv('Context', m.ctx ? m.ctx.toLocaleString() + ' tokens' : '—'),
      kv('Allowance', m.quota), kv('Health', m.health),
      kv('Latency', m.latency ? m.latency + ' ms' : 'not measured'),
      kv('Last checked', m.checked),
      kv('Capabilities', m.caps.length ? m.caps.join(', ') : 'none recorded'),
      h('hr', { class: 'of-sep' }),
      h('p', { class: 'of-muted', style: 'font-size:13px', text: m.verdict === 'unknown'
        ? 'Cost is not established for this model, so it is excluded from free filters rather than counted as free.'
        : 'Claim carries its source and date. Meridian never labels an unknown cost as free.' }),
    ]);
  }

  function connectionBody(c) {
    return h('div', { class: 'of-col' }, [
      kv('Status', c.state === 'connected' ? 'Connected' : 'Not connected'),
      kv('API key', c.key || 'None configured'),
      kv('Models', String(c.models)), kv('Health', c.health),
      kv('Trust', c.trust), kv('Data use', c.dataUse),
      h('hr', { class: 'of-sep' }),
      h('div', { class: 'of-row' }, [
        h('button', { type: 'button', class: 'mrd-button mrd-button--secondary mrd-button--sm' }, ['Test connection']),
        h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm' }, ['Replace key']),
      ]),
      h('p', { class: 'of-muted', style: 'font-size:12px', text: 'Keys are stored encrypted and are never shown in full, logged, or included in telemetry.' }),
    ]);
  }

  function whyBody() {
    return h('div', { class: 'of-col' }, [
      h('div', {}, [h('strong', { text: DATA.routing.selected }), h('span', { class: 'of-muted', text: ' · ' + DATA.routing.provider })]),
      h('h2', { class: 'of-h2', text: 'Chosen because' }),
      h('ul', { style: 'margin:0;padding-inline-start:18px' }, DATA.routing.reasons.map(function (r) { return h('li', { text: r }); })),
      h('h2', { class: 'of-h2', text: 'Not chosen' }),
      h('div', { class: 'of-col', style: 'gap:6px' }, DATA.routing.rejected.map(function (r) {
        return h('div', { class: 'of-row', style: 'gap:8px;font-size:13px' }, [
          h('span', { text: r.what }), h('span', { class: 'of-muted', text: '— ' + r.why }),
        ]);
      })),
    ]);
  }

  function advancedRoutingBody() {
    return h('div', { class: 'of-col' }, [
      h('p', { class: 'of-muted', style: 'font-size:13px;margin-block-start:0', text: 'The six everyday modes cover most work. These are the explicit policies underneath them.' }),
      h('div', { class: 'of-col', style: 'gap:8px' }, ['FREE_FIRST — exhaust free capacity before anything paid', 'CHEAP_FIRST — cheapest capable model', 'QUALITY_FIRST — best measured quality', 'FASTEST — lowest measured latency', 'LOCAL_FIRST — own hardware first', 'BALANCED — even weighting', 'CUSTOM — your own weights'].map(function (t) {
        return h('div', { class: 'of-card', text: t });
      })),
      h('p', { class: 'of-muted', style: 'font-size:12px', text: 'Pools, reservations and per-provider overrides live in Settings → Advanced.' }),
    ]);
  }

  function toolsBody() {
    return h('div', { class: 'of-col' }, DATA.tools.map(function (t) {
      var current = state.tools.filter(function (s) { return s.id === t.id; })[0];
      return h('div', { class: 'of-card' }, [
        h('div', { class: 'of-row' }, [
          h('div', { class: 'of-col', style: 'gap:2px' }, [
            h('strong', { text: t.name }),
            h('span', { class: 'of-muted', style: 'font-size:12px', text: t.note }),
          ]),
          h('div', { class: 'of-grow' }),
          h('button', {
            type: 'button', class: 'of-chip', role: 'switch', 'aria-checked': current.on ? 'true' : 'false',
            'aria-label': t.name,
            onclick: function () {
              current.on = !current.on;
              openDrawer('Tools', toolsBody());
            },
          }, [current.on ? 'On' : 'Off']),
        ]),
      ]);
    }));
  }

  function taskBody() {
    return h('div', { class: 'of-col' }, [
      kv('Stages', DATA.taskStages.length + ' (' + DATA.taskStages.filter(function (s) { return s.state === 'done'; }).length + ' done)'),
      kv('Estimated calls', '14'), kv('Tokens so far', '38,220'), kv('Cost so far', 'Free'),
      h('hr', { class: 'of-sep' }),
      h('div', { class: 'of-row' }, [
        h('button', { type: 'button', class: 'mrd-button mrd-button--secondary mrd-button--sm' }, ['Checkpoints']),
        h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm' }, ['Logs']),
        h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm' }, ['Revert']),
      ]),
      h('p', { class: 'of-muted', style: 'font-size:12px', text: 'Every change is recorded with its previous content and can be reverted exactly until you accept it.' }),
    ]);
  }

  function agentBody() {
    return h('div', { class: 'of-col' }, ['File finder', 'Planner', 'Implementer', 'Tester', 'Reviewer', 'Debugger'].map(function (role, i) {
      return h('div', { class: 'of-card' }, [
        h('div', { class: 'of-row' }, [
          dot(i < 3 ? 'healthy' : 'unknown'),
          h('strong', { text: role }),
          h('div', { class: 'of-grow' }),
          h('span', { class: 'of-muted', style: 'font-size:12px', text: i < 3 ? 'gpt-oss-120b' : 'waiting' }),
        ]),
      ]);
    }));
  }

  function projectBody(p) {
    return h('div', { class: 'of-col' }, [
      kv('Files', String(p.files)), kv('Conversations', String(p.chats)),
      kv('Default model', 'Auto'), kv('Tools', '4 enabled'),
      h('hr', { class: 'of-sep' }),
      h('p', { class: 'of-muted', style: 'font-size:13px', text: 'Project instructions and knowledge are sent with every request in this project.' }),
    ]);
  }

  function recoveredBody() {
    return h('div', { class: 'of-col' }, [
      h('p', { style: 'margin-block-start:0', text: 'Your request was completed using a fallback model.' }),
      kv('First tried', 'llama-3.3-70b:free · openrouter'),
      kv('Why it failed', 'Rate limited (429), Retry-After 34s'),
      kv('Completed on', 'gpt-oss-120b · groq'),
      kv('Extra latency', '1,860 ms'),
      h('p', { class: 'of-muted', style: 'font-size:13px', text: 'The first provider is cooling down and will be tried again once its window resets.' }),
    ]);
  }

  function settingBody(label) {
    return h('div', { class: 'of-col' }, [
      h('p', { style: 'margin-block-start:0', text: label }),
      h('p', { class: 'of-muted', style: 'font-size:13px', text: 'The production application shows this setting’s full controls here. The offline preview reproduces the structure and navigation rather than simulating every control.' }),
    ]);
  }

  function openDrawer(title, body) {
    state.drawer = { title: title, body: body };
    render();
    var d = document.querySelector('.of-drawer');
    if (d) { var f = d.querySelector('button'); if (f) f.focus(); }
  }
  function closeDrawer() { set({ drawer: null }); }

  /* ---------------------------------------------------------------- */
  /* Command palette                                                  */
  /* ---------------------------------------------------------------- */

  function paletteItems() {
    var all = PRIMARY.concat(MORE).map(function (i) { return { label: 'Go to ' + i.label, run: function () { go(i.id); } }; });
    all = all.concat([
      { label: 'New chat', run: function () { set({ screen: 'chat', sent: false, palette: false }); } },
      { label: 'Advanced routing', run: function () { set({ palette: false }); openDrawer('Advanced routing', advancedRoutingBody()); } },
      { label: 'Tools', run: function () { set({ palette: false }); openDrawer('Tools', toolsBody()); } },
      { label: 'Why this model?', run: function () { set({ palette: false }); openDrawer('Why this model?', whyBody()); } },
      { label: 'Diagnostics', run: function () { set({ screen: 'settings', settings: 'advanced', palette: false }); } },
      { label: 'Provider health', run: function () { go('connections'); } },
    ]);
    var q = state.paletteQuery.trim().toLowerCase();
    return q ? all.filter(function (i) { return i.label.toLowerCase().indexOf(q) !== -1; }) : all;
  }

  function palette() {
    var items = paletteItems();
    var idx = Math.min(state.paletteIndex, Math.max(0, items.length - 1));
    return h('div', { class: 'of-palette', role: 'dialog', 'aria-label': 'Command palette', 'aria-modal': 'true' }, [
      h('input', {
        type: 'text', placeholder: 'Search commands and screens…', 'aria-label': 'Search commands',
        value: state.paletteQuery,
        oninput: function (e) { state.paletteQuery = e.target.value; state.paletteIndex = 0; render(); focusPalette(); },
        onkeydown: function (e) {
          if (e.key === 'ArrowDown') { e.preventDefault(); state.paletteIndex = Math.min(idx + 1, items.length - 1); render(); focusPalette(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); state.paletteIndex = Math.max(idx - 1, 0); render(); focusPalette(); }
          else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) items[idx].run(); }
        },
      }),
      h('ul', { role: 'listbox' }, items.map(function (i, n) {
        return h('li', { role: 'option', 'aria-selected': n === idx ? 'true' : 'false', onclick: i.run }, [
          h('span', { text: i.label }),
        ]);
      })),
    ]);
  }

  function focusPalette() {
    requestAnimationFrame(function () {
      var input = document.querySelector('.of-palette input');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
  }
  function focusSearch() {
    var input = document.querySelector('input[type="search"]');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */

  function render() {
    root.textContent = '';
    var overlayOpen = !!state.drawer || state.palette || state.navOpen;

    root.appendChild(h('div', { class: 'of-shell' }, [
      topbar(),
      h('div', { class: 'of-stage' }, [
        sidebar(),
        h('main', { class: 'of-main', id: 'main' }, [screenBody()]),
      ]),
    ]));

    root.appendChild(h('div', {
      class: 'of-scrim', 'data-open': overlayOpen ? 'true' : 'false', 'aria-hidden': 'true',
      onclick: function () { set({ drawer: null, palette: false, navOpen: false }); },
    }));

    root.appendChild(h('aside', {
      class: 'of-drawer', 'data-open': state.drawer ? 'true' : 'false',
      role: 'dialog', 'aria-label': state.drawer ? state.drawer.title : 'Details',
      'aria-hidden': state.drawer ? 'false' : 'true',
    }, state.drawer ? [
      h('div', { class: 'of-row', style: 'margin-block-end:14px' }, [
        h('h2', { class: 'of-h2', text: state.drawer.title }),
        h('div', { class: 'of-grow' }),
        h('button', { type: 'button', class: 'mrd-button mrd-button--tertiary mrd-button--sm', 'aria-label': 'Close', onclick: closeDrawer }, ['Close']),
      ]),
      state.drawer.body,
    ] : []));

    if (state.palette) root.appendChild(palette());
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      set({ palette: !state.palette, paletteQuery: '', paletteIndex: 0 });
      if (state.palette) focusPalette();
    } else if (e.key === 'Escape') {
      if (state.palette || state.drawer || state.navOpen) set({ palette: false, drawer: null, navOpen: false });
    }
  });

  render();
})();
