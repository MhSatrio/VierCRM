// TEST FIXTURES – a fictional university website and fake research APIs. Every person, e-mail address (.example domains cannot be
// delivered), publication and PDF here is invented. Used by the unit tests (page builders) and the browser end-to-end test (server).
import http from 'node:http';
import { ALL_PLACES, bizHome, mapsPlacePage, mapsSearchPage, placesFor } from './maps.mjs';

const U = 'example-university.example';
const P = (slug, name, title, dept, email, layout, extra = {}) => ({ slug, name, title, dept, email, layout, phone: extra.phone ?? '', keywords: extra.keywords ?? '', bio: extra.bio ?? `${name} works on ${dept.toLowerCase()} topics at Example University. ${name.split(' ')[1]} leads a small research group.`, ...extra });

export const PEOPLE = [
  P('anna-example', 'Prof. Dr. Anna Example', 'Professor of Analytical Chemistry', 'Department of Chemistry', `anna.example@${U}`, 'jsonld', { phone: '+31 20 555 0101', keywords: 'mass spectrometry, chromatography, proteomics', orcid: '0000-0001-2345-6789' }),
  P('bram-fixture', 'Dr. Bram Fixture', 'Associate Professor', 'Department of Biology', `bram.fixture@${U}`, 'dl', { phone: '+31 20 555 0102', keywords: 'cell culture, live-cell imaging' }),
  P('chen-sample', 'Dr. Chen Sample', 'Senior Researcher', 'Materials Laboratory', `chen.sample@${U}`, 'dl', { keywords: 'nanomaterials, spectroscopy' }),
  P('dewi-placeholder', 'Dr. Dewi Placeholder', 'Lecturer', 'Faculty of Pharmacy', '', 'dl', { keywords: 'phytochemistry' }),
  P('erik-mockson', 'Erik Mockson', 'Assistant Professor', 'Department of Physics', `physics-office@${U}`, 'generic'),
  P('fatima-testwell', 'Prof. Fatima Testwell', 'Professor of Organic Chemistry', 'Department of Chemistry', `fatima.testwell@${U}`, 'obf', { keywords: 'catalysis, synthesis' }),
  P('gustav-dummy', 'Dr. Gustav Dummy', 'Postdoctoral Researcher', 'Department of Biology', `gustav.dummy@${U}`, 'cf'),
  P('hana-specimen', 'Dr. Hana Specimen', 'Research Fellow', 'Department of Physics', `hana.specimen@${U}`, 'js', { keywords: 'quantum optics' }),
  P('ivan-fictional', 'Prof. Ivan Fictional', 'Professor of Mathematics', 'Department of Mathematics', `ivan.fictional@${U}`, 'dl'),
  P('julia-staged', 'Dr. Julia Staged', 'Lecturer', 'Department of Computer Science', `julia.staged@${U}`, 'jsonld'),
  P('john-smith-chem', 'Prof. John Smith', 'Professor of Chemistry', 'Department of Chemistry', `j.smith.chem@${U}`, 'dl'),
  P('john-smith-bio', 'Dr. John Smith', 'Associate Professor', 'Department of Biology', `j.smith.bio@${U}`, 'dl'),
  P('wei-zhang', 'Prof. Wei Zhang', 'Professor of Physics', 'Department of Physics', `wei.zhang@${U}`, 'dl'),
  P('karin-mock', 'Dr. Karin Mock', 'Senior Lecturer', 'Department of Chemistry', `karin.mock@${U}`, 'dl'),
  P('lars-dummy', 'Dr. Lars Dummy', 'Assistant Professor', 'Department of Biology', `lars.dummy@${U}`, 'dl'),
  // the SAME person listed again under another URL (same e-mail) – must not become a second record
  P('a-example', 'Anna Example', 'Professor', 'Department of Chemistry', `anna.example@${U}`, 'dl'),
  P('maria-specimen', 'Dr. Maria Specimen', 'Lecturer', 'Faculty of Pharmacy', `maria.specimen@${U}`, 'dl'),
  P('noor-testwell', 'Dr. Noor Testwell', 'Researcher', 'Department of Physics', `noor.testwell@${U}`, 'dl'),
  P('omar-staged', 'Prof. Omar Staged', 'Professor of Biology', 'Department of Biology', `omar.staged@${U}`, 'dl'),
  P('petra-fixture', 'Dr. Petra Fixture', 'Lecturer', 'Department of Mathematics', `petra.fixture@${U}`, 'dl'),
  P('quinn-sample', 'Dr. Quinn Sample', 'Postdoctoral Researcher', 'Materials Laboratory', `quinn.sample@${U}`, 'dl'),
  P('rosa-placeholder', 'Dr. Rosa Placeholder', 'Research Fellow', 'Faculty of Pharmacy', `rosa.placeholder@${U}`, 'dl'),
  P('sven-mockson', 'Dr. Sven Mockson', 'Assistant Professor', 'Department of Computer Science', `sven.mockson@${U}`, 'dl'),
  P('tariq-example', 'Prof. Tariq Example', 'Professor of Chemistry', 'Department of Chemistry', `tariq.example@${U}`, 'dl'),
];
export const PER_PAGE = 8;

// ---------------------------------------------------------------- fictional companies (a listing + detail pages), for "any list" scraping
export const COMPANIES = [
  { slug: 'northwind-instruments', name: 'Northwind Instruments', site: 'https://northwind-instruments.example', industry: 'Laboratory equipment', size: '50-200', location: 'Utrecht, Netherlands', email: 'sales@northwind-instruments.example', phone: '+31 30 555 0101', revenue: 'EUR 12M' },
  { slug: 'bluepeak-biotech', name: 'Bluepeak Biotech', site: 'https://bluepeak-biotech.example', industry: 'Biotechnology', size: '11-50', location: 'Basel, Switzerland', email: 'info@bluepeak-biotech.example', phone: '+41 61 555 0102', revenue: 'EUR 4M' },
  { slug: 'cedar-analytics', name: 'Cedar Analytics', site: 'https://cedar-analytics.example', industry: 'Analytical services', size: '201-500', location: 'Leeds, United Kingdom', email: 'hello@cedar-analytics.example', phone: '+44 113 555 0103', revenue: 'EUR 38M' },
  { slug: 'delta-optics', name: 'Delta Optics', site: 'https://delta-optics.example', industry: 'Optics', size: '11-50', location: 'Jena, Germany', email: 'contact@delta-optics.example', phone: '+49 3641 555 0104', revenue: 'EUR 7M' },
  { slug: 'ember-cryogenics', name: 'Ember Cryogenics', site: 'https://ember-cryogenics.example', industry: 'Cryogenic systems', size: '51-200', location: 'Lyon, France', email: 'sales@ember-cryogenics.example', phone: '+33 4 555 0105', revenue: 'EUR 15M' },
  { slug: 'fjord-sensors', name: 'Fjord Sensors', site: 'https://fjord-sensors.example', industry: 'Sensors', size: '1-10', location: 'Bergen, Norway', email: 'post@fjord-sensors.example', phone: '+47 55 555 0106', revenue: 'EUR 1M' },
];
export const companiesList = () => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Suppliers directory</title></head><body><nav class="top"><a href="/">Home</a> <a href="/about">About</a></nav><h1>Suppliers</h1><ul class="companies">${COMPANIES.map(c => `<li class="co"><a href="/company/${c.slug}"><strong>${c.name}</strong></a><span class="tag">${c.industry}</span></li>`).join('')}</ul></body></html>`;
export const companyPage = slug => { const c = COMPANIES.find(x => x.slug === slug); if (!c) return null; return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${c.name} | Suppliers directory</title><meta name="description" content="${c.name} supplies ${c.industry.toLowerCase()} to research laboratories."></head><body><h1>${c.name}</h1><dl><dt>Website</dt><dd><a href="${c.site}">${c.site.replace('https://', '')}</a></dd><dt>Industry</dt><dd>${c.industry}</dd><dt>Size</dt><dd>${c.size}</dd><dt>Location</dt><dd>${c.location}</dd><dt>Revenue</dt><dd>${c.revenue}</dd></dl><p>Contact: <a href="mailto:${c.email}">${c.email}</a> · <a href="tel:${c.phone.replace(/ /g, '')}">${c.phone}</a></p></body></html>`; };
const bySlug = Object.fromEntries(PEOPLE.map(p => [p.slug, p]));

// ---------------------------------------------------------------- pages
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shell = (title, body, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">${head}<style>body{font:16px system-ui;margin:0}nav.top,footer{padding:12px 24px;background:#eee}.person{padding:14px 24px;border-bottom:1px solid #ddd;list-style:none}ul{padding:0;margin:0}.pagination a,.pagination span{margin:0 6px}</style></head><body><nav class="top"><a href="/">Home</a> · <a href="/dir/static">People</a> · <a href="/about">About</a> · <a href="/news">News</a></nav>${body}<footer>© Example University (fictional)</footer></body></html>`;

/** card markup – two styles, like real sites: separate links/lines, or one big link */
export const card = (p, style = 'a', origin = '') => style === 'a'
  ? `<li class="person"><a href="${origin}/people/${p.slug}"><span class="name">${esc(p.name)}</span></a><div class="role">${esc(p.title)}</div><div class="unit">${esc(p.dept)}</div></li>`
  : `<li class="person"><a class="card-link" href="${origin}/people/${p.slug}"><h3>${esc(p.name)}</h3><p>${esc(p.title)}</p><p>${esc(p.dept)}</p></a></li>`;

export function directory(mode, page = 1, origin = '') {
  const pages = Math.ceil(PEOPLE.length / PER_PAGE); const slice = PEOPLE.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  if (mode === 'static') {
    const nums = Array.from({ length: pages }, (_, i) => (i + 1 === page ? `<span aria-current="page">${i + 1}</span>` : `<a href="/dir/static?page=${i + 1}">${i + 1}</a>`)).join('');
    const prev = page > 1 ? `<a href="/dir/static?page=${page - 1}" rel="prev">Previous</a>` : ''; const next = page < pages ? `<a href="/dir/static?page=${page + 1}" rel="next">Next</a>` : '';
    return shell('Staff directory – Example University', `<main><h1>Staff directory</h1><ul class="people-list">${slice.map(p => card(p, 'a')).join('')}</ul><nav class="pagination" aria-label="Pagination">${prev}${nums}${next}</nav></main>`);
  }
  if (mode === 'ext') return shell('Partner directory', `<main><h1>Partner researchers</h1><ul>${PEOPLE.slice(16, 22).map(p => card(p, 'a', origin)).join('')}</ul></main>`);
  if (mode === 'loadmore') return shell('Researchers – load more', `<main><h1>Researchers</h1><ul id="list" class="people-list">${PEOPLE.slice(0, PER_PAGE).map(p => card(p, 'b')).join('')}</ul><button id="more" type="button">Load more</button></main>
<script>let off=${PER_PAGE};document.getElementById('more').addEventListener('click',async()=>{const r=await fetch('/api/people?offset='+off+'&limit=${PER_PAGE}&style=b');const j=await r.json();document.getElementById('list').insertAdjacentHTML('beforeend',j.html);off+=j.count;if(!j.more)document.getElementById('more').remove();});</script>`);
  if (mode === 'infinite') return shell('Researchers – infinite scroll', `<main><h1>Researchers</h1><ul id="list" class="people-list">${PEOPLE.slice(0, PER_PAGE).map(p => card(p, 'a')).join('')}</ul><div id="sentinel" style="height:40px"></div></main>
<script>let off=${PER_PAGE},busy=false,done=false;const load=async()=>{if(busy||done)return;busy=true;const r=await fetch('/api/people?offset='+off+'&limit=${PER_PAGE}&style=a');const j=await r.json();document.getElementById('list').insertAdjacentHTML('beforeend',j.html);off+=j.count;if(!j.more)done=true;busy=false;};new IntersectionObserver(es=>{if(es[0].isIntersecting)load();},{rootMargin:'200px'}).observe(document.getElementById('sentinel'));</script>`);
  if (mode === 'spa') return shell('Researchers – app', `<main><h1>Researchers</h1><div id="app"></div></main>
<script>const D=${JSON.stringify(PEOPLE.slice(0, 24).map(p => ({ slug: p.slug, name: p.name, title: p.title, dept: p.dept })))};let pg=1;const per=${PER_PAGE},pages=Math.ceil(D.length/per);function draw(){const s=D.slice((pg-1)*per,pg*per);document.getElementById('app').innerHTML='<ul class="people-list">'+s.map(p=>'<li class="person"><a href="/people/'+p.slug+'"><span class="name">'+p.name+'</span></a><div class="role">'+p.title+'</div><div class="unit">'+p.dept+'</div></li>').join('')+'</ul><div class="pager"><button type="button" id="next"'+(pg>=pages?' disabled':'')+'>Next</button> <span>Page '+pg+' of '+pages+'</span></div>';const b=document.getElementById('next');if(b)b.onclick=()=>{pg++;draw();};}draw();</script>`);
  if (mode === 'jsdir') return shell('Researchers – rendered by JavaScript', `<main><h1>Researchers</h1><div id="app">Loading…</div></main><script>setTimeout(()=>{document.getElementById('app').innerHTML='<ul class="people-list">'+${JSON.stringify(PEOPLE.slice(0, 10).map(p => card(p, 'a')))}.join('')+'</ul>';},400);</script>`);
  return shell('Not found', '<h1>Not found</h1>');
}

const cfEncode = (email, key = 0x4b) => { let h = key.toString(16).padStart(2, '0'); for (const c of email) h += (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0'); return h; };

export function profile(slug) {
  const p = bySlug[slug]; if (!p) return null;
  const nameOnly = p.name.replace(/^(Prof\.|Dr\.)\s*/g, '').replace(/^(Prof\.|Dr\.)\s*/g, '');
  const interests = p.keywords ? `<h2>Research interests</h2><ul>${p.keywords.split(', ').map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : '';
  const pubs = `<h2>Selected publications</h2><ul><li><a href="https://doi.org/10.1234/example.${p.slug}">A paper by ${esc(nameOnly)}</a></li></ul>`;
  const ids = p.orcid ? `<p><a href="https://orcid.org/${p.orcid}">ORCID</a> · <a href="https://scholar.google.com/citations?user=ABC123xyz">Google Scholar</a></p>` : '';
  const bio = `<h2>Biography</h2><p>${esc(p.bio)}</p><p>Previously a visiting scientist at the Fictional Institute.</p>`;
  const inst = `<p class="affil">Example University</p>`;
  const common = `${interests}${bio}${pubs}${ids}`;
  let body;
  switch (p.layout) {
    case 'jsonld': {
      const ld = { '@context': 'https://schema.org', '@type': 'Person', name: p.name, jobTitle: p.title, worksFor: { '@type': 'CollegeOrUniversity', name: 'Example University' }, email: `mailto:${p.email}`, telephone: p.phone, description: p.bio, sameAs: p.orcid ? [`https://orcid.org/${p.orcid}`] : [] };
      return shell(`${p.name} | Example University`, `<main><h1>${esc(p.name)}</h1>${common}</main>`, `<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
    }
    case 'obf': body = `<main><h1>${esc(p.name)}</h1><div class="meta"><div>${esc(p.title)}</div><div>${esc(p.dept)}</div></div>${inst}<p>Email: ${esc(p.email.split('@')[0])} [at] ${esc(p.email.split('@')[1].replace('.', ' [dot] '))}</p>${common}</main>`; break;
    case 'cf': body = `<main><h1>${esc(p.name)}</h1><div class="meta"><div>${esc(p.title)}</div><div>${esc(p.dept)}</div></div>${inst}<p>Email: <a class="__cf_email__" href="/cdn-cgi/l/email-protection" data-cfemail="${cfEncode(p.email)}">[email&#160;protected]</a></p>${common}</main>`; break;
    case 'generic': body = `<main><h1>${esc(p.name)}</h1><div class="meta"><div>${esc(p.title)}</div><div>${esc(p.dept)}</div></div>${inst}<p>Contact: <a href="mailto:${p.email}">${p.email}</a></p>${common}</main>`; break;
    case 'js': return shell(`${p.name} | Example University`, `<main id="m"></main><script>setTimeout(()=>{document.getElementById('m').innerHTML=${JSON.stringify(`<h1>${esc(p.name)}</h1><div class="meta"><div>${esc(p.title)}</div><div>${esc(p.dept)}</div></div>${inst}<p>Email: <a href="mailto:${p.email}">${p.email}</a></p>${common}`)};},350);</script>`);
    default: // 'dl' – labelled rows
      body = `<main><h1>${esc(p.name)}</h1>${inst}<dl><dt>Position</dt><dd>${esc(p.title)}</dd><dt>Department</dt><dd>${esc(p.dept)}</dd>${p.email ? `<dt>Email</dt><dd><a href="mailto:${p.email}">${p.email}</a></dd>` : ''}${p.phone ? `<dt>Phone</dt><dd>${esc(p.phone)}</dd>` : ''}</dl>${common}</main>`;
  }
  return shell(`${p.name} | Example University`, body);
}

// ---------------------------------------------------------------- Google Scholar / ResearchGate look-alikes
export const scholarResults = q => shell('Google Scholar', `<div id="gs_res_ccl"><div class="gs_r gs_or gs_scl"><div class="gs_ri"><h3 class="gs_rt"><a href="https://journal.example/article/42">Mass spectrometry of plant proteins</a></h3><div class="gs_a">A Example, B Collaborator - Journal of Examples, 2026 - journal.example</div><div class="gs_rs">We apply mass spectrometry to plant proteins.</div></div></div><div class="gs_r gs_or gs_scl"><div class="gs_ggs gs_fl"><a href="https://repo.example/42.pdf">[PDF] repo.example</a></div><div class="gs_ri"><h3 class="gs_rt"><a href="https://journal.example/article/7">An older paper</a></h3><div class="gs_a">A Example - Old Journal, 2019 - old.example</div></div></div></div><!-- ${esc(q)} -->`);
export const scholarBlocked = () => shell('Sorry…', '<div id="gs_captcha_ccl"><form id="captcha-form">Our systems have detected unusual traffic from your computer network.</form></div>');

// ---------------------------------------------------------------- fake research APIs (shaped like the real ones)
export const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const author = (id, name, inst, topics = ['Analytical chemistry']) => ({ id: `https://openalex.org/${id}`, display_name: name, works_count: 30, last_known_institutions: [{ display_name: inst }], topics: topics.map(t => ({ display_name: t })) });
const work = (id, title, date, doi, extra = {}) => ({ id: `https://openalex.org/${id}`, doi: `https://doi.org/${doi}`, display_name: title, publication_year: Number(date.slice(0, 4)), publication_date: date, type: 'article', primary_location: { landing_page_url: `https://journal.example/article/${id}`, source: { display_name: 'Journal of Examples' } }, authorships: [{ author: { display_name: 'Author' } }], abstract_inverted_index: { This: [0], fictional: [1], abstract: [2], describes: [3], mass: [4], spectrometry: [5], of: [6], plant: [7], proteins: [8], and: [9], chromatography: [10], 'methods.': [11] }, open_access: { oa_status: 'closed' }, best_oa_location: null, ...extra });
export const OA_AUTHORS = {
  'anna example': [author('A1', 'Anna Example', 'Example University')],
  'bram fixture': [author('A2', 'Bram Fixture', 'Example University', ['Cell biology'])],
  'john smith': [author('A3', 'John Smith', 'Example University', ['Chemistry']), author('A4', 'John Smith', 'Other Institute of Technology', ['Economics'])],
  'wei zhang': [author('A5', 'Wei Zhang', 'Example University', ['Optics']), author('A6', 'Wei Zhang', 'Example University', ['Condensed matter'])],
};
export const OA_WORKS = {
  A1: [work('W11', 'Mass spectrometry of plant proteins', '2026-03-10', '10.1234/anna.latest', { open_access: { oa_status: 'gold', oa_url: 'https://journal.example/article/W11' } }), work('W12', 'An older chromatography study', '2021-05-02', '10.1234/anna.old')],
  A2: [work('W21', 'Live-cell imaging of stem cells', '2026-01-15', '10.1234/bram.latest')],
  A3: [work('W31', 'Catalysis in flow reactors', '2025-11-20', '10.1234/smith.chem')],
  A5: [work('W51', 'Optical traps revisited', '2025-08-01', '10.1234/zhang.optics')],
  A6: [work('W61', 'Superconducting films', '2024-12-12', '10.1234/zhang.films')],
};

const json = (res, o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
const html = (res, s, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(s); };

/** One local server for the site and the fake APIs. `log` records every request path (to prove nothing unexpected was contacted). */
export function startFixtureServer(port = 0) {
  const hung = new Set(); const log = []; const stats = { unpaywallCalls: 0, brevoSent: [], brevoEvents: {} };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; log.push(`${req.method} ${p}${u.search}`);
    const origin = `http://${req.headers.host}`;
    if (p === '/') return html(res, shell('Example University', '<h1>Example University</h1>'));
    // a directory whose page NEVER finishes loading (an image / tracker that hangs forever) – like a heavy university site
    if (p === '/hang.png') { hung.add(res); return; }
    // no pager in the page at all (a script draws it, or it is hidden): only ?page=N in the address
    if (p.startsWith('/dir/nopager')) return html(res, directory('static', Number(u.searchParams.get('page') || 1)).split('/dir/static').join('/dir/nopager').replace(/<nav class="pagination"[\s\S]*?<\/nav>/, ''));
    if (p.startsWith('/dir/hang')) return html(res, directory('static', Number(u.searchParams.get('page') || 1)).split('/dir/static').join('/dir/hang').replace('</main>', '<img src="/hang.png" width="1" height="1" alt=""></main>'));
    if (p.startsWith('/dir/')) { const mode = p.slice(5); const other = origin.replace('127.0.0.1', 'localhost'); return html(res, directory(mode, Number(u.searchParams.get('page') || 1), mode === 'ext' ? other : '')); }
    if (p === '/api/people') { const off = Number(u.searchParams.get('offset')); const lim = Number(u.searchParams.get('limit')); const s = PEOPLE.slice(off, off + lim); return json(res, { html: s.map(x => card(x, u.searchParams.get('style') || 'a')).join(''), count: s.length, more: off + lim < PEOPLE.length }); }
    // Google Maps look-alikes: a result list that loads more places as it is scrolled, the place panels, and the businesses' own websites
    if (p.startsWith('/maps/search/')) { const q = decodeURIComponent(p.slice(13).split('/')[0].replace(/\+/g, ' ')); return html(res, mapsSearchPage({ origin, siteOrigin: origin, query: q, places: placesFor(q) })); }
    if (p.startsWith('/maps/place/')) { const name = decodeURIComponent((p.split('/')[3] || '').replace(/\+/g, ' ')); const pl = ALL_PLACES.find(x => x.name === name); return pl ? html(res, mapsPlacePage({ origin, siteOrigin: origin, p: pl })) : html(res, shell('Not found', '<h1>Not found</h1>'), 404); }
    if (p.startsWith('/biz/')) { const [, , slug, sub] = p.split('/'); const pl = ALL_PLACES.find(x => x.site === slug); return pl ? html(res, bizHome(pl, origin, sub === 'kontak' ? 'kontak' : '')) : html(res, shell('Not found', '<h1>Not found</h1>'), 404); }
    if (p === '/companies') return html(res, companiesList());
    if (p.startsWith('/company/')) { const h = companyPage(p.slice(9)); return h ? html(res, h) : html(res, shell('Not found', '<h1>Not found</h1>'), 404); }
    if (p.startsWith('/people/')) { const h = profile(p.slice(8)); return h ? html(res, h) : html(res, shell('Not found', '<h1>Not found</h1>'), 404); }
    if (p === '/scholar') return html(res, u.searchParams.get('q')?.includes('Blocked') ? scholarBlocked() : scholarResults(u.searchParams.get('q') || ''));
    // OpenAlex
    if (p === '/openalex/authors') { const q = (u.searchParams.get('search') || '').toLowerCase(); return json(res, { results: OA_AUTHORS[q] || [] }); }
    if (p === '/openalex/works') { const m = (u.searchParams.get('filter') || '').match(/author\.id:(A\d+)/); return json(res, { results: OA_WORKS[m?.[1]] || [] }); }
    if (p.startsWith('/openalex/works/')) { const doi = decodeURIComponent(p.slice(16)).replace('https://doi.org/', ''); const w = Object.values(OA_WORKS).flat().find(x => x.doi.endsWith(doi)); return w ? json(res, { ...w, locations: [] }) : json(res, {}, 404); }
    if (p.startsWith('/crossref/')) return json(res, { message: { items: [] } });
    if (p.startsWith('/semanticscholar/')) return json(res, { data: [] });
    if (p.startsWith('/pubmed/')) return json(res, { esearchresult: { idlist: [] } });
    // Unpaywall: Anna's paper has an open PDF, the others do not
    if (p.startsWith('/unpaywall/v2/')) { stats.unpaywallCalls++; const doi = decodeURIComponent(p.slice(14)); if (doi === '10.1234/anna.latest') return json(res, { is_oa: true, oa_status: 'gold', best_oa_location: { url_for_pdf: `${origin}/files/anna-latest.pdf`, host_type: 'publisher' } }); return json(res, { is_oa: false, oa_status: 'closed' }); }
    if (p.startsWith('/europepmc/')) return json(res, { resultList: { result: [] } });
    // Brevo look-alike (a FAKE: nothing is ever delivered anywhere)
    if (p.startsWith('/brevo/v3/')) {
      const key = req.headers['api-key']; if (key !== 'test-key') return json(res, { code: 'unauthorized', message: 'Key not found' }, 401);
      if (p === '/brevo/v3/senders') return json(res, { senders: [{ id: 1, name: 'VierApparatus', email: 'info@vierapparatus.com', active: true }] });
      if (p === '/brevo/v3/smtp/email' && req.method === 'POST') { let raw = ''; req.on('data', d => (raw += d)); req.on('end', () => { const body = JSON.parse(raw); stats.brevoSent.push(body); json(res, { messageId: '<fake-' + stats.brevoSent.length + '@smtp.example>' }); }); return; }
      if (p === '/brevo/v3/smtp/statistics/events') { const id = u.searchParams.get('messageId'); return json(res, { events: (stats.brevoEvents[id] || []).map(e => ({ ...e, messageId: id })) }); }
    }
    if (p === '/files/anna-latest.pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF_BYTES.length }); return res.end(PDF_BYTES); }
    if (p.startsWith('/journal/')) return html(res, shell('Journal article', '<h1>Abstract only</h1>'));
    res.writeHead(404); res.end('not found');
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, log, stats, close: () => new Promise(r => { for (const x of hung) x.destroy(); server.closeAllConnections?.(); server.close(r); }) })));
}
