/* stardust web app — shared interactions: page transitions, auto-advance, toggles */
(function () {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // mark ready (triggers .fade / .stagger reveals)
  requestAnimationFrame(() => document.body.classList.add('ready'));

  // fade-out navigation
  function go(url) {
    if (!url) return;
    if (reduce) { location.href = url; return; }
    document.body.classList.add('leaving');
    setTimeout(() => { location.href = url; }, 240);
  }

  // any element with data-nav navigates with a fade
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-nav]');
    if (el) { e.preventDefault(); go(el.getAttribute('data-nav')); }
  });

  // Enter-to-send on a landing input with data-nav-enter
  document.querySelectorAll('[data-nav-enter]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(inp.getAttribute('data-nav-enter')); });
  });

  // auto-advance: [data-advance][data-delay]
  const auto = document.querySelector('[data-advance]');
  if (auto) {
    const delay = parseInt(auto.getAttribute('data-delay') || '2600', 10);
    let t = setTimeout(() => go(auto.getAttribute('data-advance')), reduce ? Math.min(delay, 600) : delay);
    // a skip control cancels the timer and jumps now
    document.querySelectorAll('[data-skip]').forEach((s) => s.addEventListener('click', (e) => {
      e.preventDefault(); clearTimeout(t); go(auto.getAttribute('data-advance'));
    }));
  }

  // viewport toggle (desktop/mobile) on the preview
  const prev = document.getElementById('preview');
  const vDesk = document.getElementById('vDesk'), vMob = document.getElementById('vMob');
  if (prev && vDesk && vMob) {
    vDesk.addEventListener('click', () => { prev.classList.remove('mobile'); vDesk.classList.add('on'); vMob.classList.remove('on'); });
    vMob.addEventListener('click', () => { prev.classList.add('mobile'); vMob.classList.add('on'); vDesk.classList.remove('on'); });
  }

  // variant seg switch: swaps the iframe src to data-src on the clicked button
  document.querySelectorAll('.seg[data-variant-switch] button').forEach((b) => {
    b.addEventListener('click', () => {
      const seg = b.closest('.seg');
      seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      const frame = document.getElementById('artframe');
      const src = b.getAttribute('data-src');
      if (frame && src) frame.src = src;
      const label = document.getElementById('variantLabel');
      if (label && b.getAttribute('data-label')) label.textContent = b.getAttribute('data-label');
    });
  });

  // progress-fill animation: elements with [data-fill] get width set on ready
  if (!reduce) {
    requestAnimationFrame(() => setTimeout(() => {
      document.querySelectorAll('[data-fill]').forEach((el) => { el.style.width = el.getAttribute('data-fill'); });
    }, 250));
  } else {
    document.querySelectorAll('[data-fill]').forEach((el) => { el.style.width = el.getAttribute('data-fill'); });
  }

  // generic "roll out next 10" — flips queued cells to live
  document.querySelectorAll('[data-rollout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const grid = document.querySelector(btn.getAttribute('data-rollout'));
      if (!grid) return;
      const queued = [...grid.querySelectorAll('.cell.queued')].slice(0, 10);
      queued.forEach((c, i) => setTimeout(() => { c.classList.remove('queued'); c.classList.add('live'); }, reduce ? 0 : i * 60));
      const cnt = document.getElementById('liveCount');
      if (cnt) {
        const cur = parseInt(cnt.getAttribute('data-n') || '3', 10) + queued.length;
        cnt.setAttribute('data-n', cur); cnt.textContent = cur;
      }
    });
  });

  // tree expand / collapse (live rollout dashboard)
  document.querySelectorAll('[data-tree]').forEach((p) => {
    p.addEventListener('click', () => { const g = p.closest('.tnode'); if (g) g.classList.toggle('open'); });
  });

  // ===================== demo dock (walkthrough) =====================
  const SCREENS = [
    { f: 'index.html',       n: 'Landing',        hint: 'Press the amber ▸ (or Enter) on the URL', spot: '.field .send' },
    { f: 'working.html',     n: 'Studio · working', hint: 'When you’ve watched enough — “See snapshot →”', spot: '.btn-primary' },
    { f: 'capturing.html',   n: 'Brand review', hint: 'Try “Audit”, then “See directions →”', spot: '.btn-primary' },
    { f: 'variants.html',    n: 'Pick a direction', hint: 'Click a variant card — C is recommended', spot: '.vcard.rec' },
    { f: 'workspace.html',   n: 'Iterate',        hint: 'Switch A/B/C in the toolbar, then Deploy →', spot: '.btn-primary' },
    { f: 'deploy.html',      n: 'Map to AEM',     hint: 'Review the blocks, then Deploy 3 templates →', spot: '.btn-primary' },
    { f: 'deploy-run.html',  n: 'Deploying',      hint: 'Click “See result →”', spot: '.btn-primary' },
    { f: 'live.html',        n: 'Rollout dashboard', hint: 'Expand a section to see page status · open the live site', spot: null },
  ];
  const ASIDES = { 'audit.html': { n: 'Brand audit', hint: 'The full audit — Back to review, or continue', back: 'capturing.html', next: 'variants.html' } };
  const file = (location.pathname.split('/').pop() || 'index.html');
  const idx = SCREENS.findIndex((s) => s.f === file);
  const aside = ASIDES[file];
  if (idx === -1 && !aside) return;
  const cur = aside || SCREENS[idx];
  const pv = aside ? { f: aside.back } : SCREENS[idx - 1];
  const nx = aside ? { f: aside.next } : SCREENS[idx + 1];
  const stepLabel = aside ? '◆' : ((idx + 1) + '/' + SCREENS.length);

  // dock
  const dock = document.createElement('div');
  dock.className = 'demodock';
  dock.innerHTML =
    '<span class="dd-tag">DEMO</span>' +
    '<span class="dd-step">' + stepLabel + '</span>' +
    '<span class="dd-name">' + cur.n + '</span>' +
    '<span class="dd-hint">' + cur.hint + '</span>' +
    '<span class="sep"></span>' +
    '<button class="dd-btn icon dd-prev" title="Previous" ' + (pv ? '' : 'disabled') + '>◀</button>' +
    '<button class="dd-btn dd-next" title="Next screen">' + (nx ? 'Next ▸' : 'Restart ↻') + '</button>' +
    '<button class="dd-btn dd-all" title="All screens">▦</button>';
  document.body.appendChild(dock);
  dock.querySelector('.dd-prev').addEventListener('click', () => pv && go(pv.f));
  dock.querySelector('.dd-next').addEventListener('click', () => go(nx ? nx.f : 'index.html'));

  // overlay — jump to any screen
  const ov = document.createElement('div');
  ov.className = 'demo-overlay';
  ov.innerHTML =
    '<div class="demo-modal"><div class="mh"><span class="t">All screens</span><button class="x" aria-label="close">×</button></div>' +
    '<div class="demo-grid">' +
    SCREENS.map((s, i) => '<a data-nav="' + s.f + '" class="' + (i === idx ? 'cur' : '') + '"><span class="n">' + (i + 1) + '</span><span><span class="nm">' + s.n + '</span><span class="hn">' + s.hint + '</span></span></a>').join('') +
    Object.entries(ASIDES).map(([f, a]) => '<a data-nav="' + f + '" class="' + (f === file ? 'cur' : '') + '"><span class="n">◆</span><span><span class="nm">' + a.n + '</span><span class="hn">' + a.hint + '</span></span></a>').join('') +
    '</div></div>';
  document.body.appendChild(ov);
  const toggleOv = (open) => ov.classList.toggle('open', open);
  dock.querySelector('.dd-all').addEventListener('click', () => toggleOv(true));
  ov.querySelector('.x').addEventListener('click', () => toggleOv(false));
  ov.addEventListener('click', (e) => { if (e.target === ov) toggleOv(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleOv(false);
    if (e.key === 'ArrowRight' && !ov.classList.contains('open')) go(nx ? nx.f : 'index.html');
    if (e.key === 'ArrowLeft' && pv && !ov.classList.contains('open')) go(pv.f);
  });

  // spotlight the element to click
  if (cur.spot) {
    const target = document.querySelector(cur.spot);
    if (target) setTimeout(() => target.classList.add('demo-hint'), 700);
  }
})();
