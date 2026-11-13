// TEST FIXTURES – look-alikes of Google Maps screens (result list, place panel) and of the small business websites they link to.
// Every business, phone number and address here is invented; the e-mail domains end in .example (they cannot be delivered).
// The structure follows what Maps serves – role="feed", an <a href="/maps/place/…"> per entry, data-item-id rows on the place panel – with
// obfuscated class names, so the reader is tested against what it will really meet, not against a page made for it.

const P = (slug, name, category, address, phone, site, rating, reviews, extra = {}) => ({ slug, name, category, address, phone, site, rating, reviews, ...extra });

export const MAPS_PLACES = [
  P('samudra-cargo', 'Samudra Cargo Express', 'Freight forwarder', 'Jl. Perak Timur No.12, Surabaya', '(031) 5551 0101', 'samudra-cargo', 4.6, 102, { mail: 'home' }),
  P('nusantara-logistik', 'Nusantara Logistik', 'Freight forwarder', 'Jl. Rungkut Industri 5, Surabaya', '0812-3456-7001', 'nusantara-logistik', 4.2, 58, { mail: 'contact' }),
  P('bahari-express', 'Bahari Express Cargo', 'Cargo and freight company', 'Jl. Kenjeran 88, Surabaya', '', 'bahari-express', 4.8, 310, { mail: 'home', cardNoPhone: true, detailPhone: '031-5559-0099' }),   // the card shows no phone: the place's own page does
  P('trans-pasifik', 'Trans Pasifik Forwarding', 'Freight forwarder', 'Jl. Margomulyo 27, Surabaya', '+62 31 7000 220', '', 3.9, 12, {}),                                                         // no website at all
  P('citra-kargo-jkt', 'Citra Kargo Jakarta', 'Freight forwarder', 'Jl. Pluit Raya 3, Jakarta Utara', '(021) 6600 1000', 'citra-kargo', 4.4, 230, { mail: 'cf' }),                                    // two branches of one chain share a website
  P('citra-kargo-sby', 'Citra Kargo Surabaya', 'Freight forwarder', 'Jl. Tanjung Perak 9, Surabaya', '(031) 5330 2000', 'citra-kargo', 4.1, 95, { mail: 'cf' }),
  P('mitra-lintas', 'Mitra Lintas Samudra', 'Shipping company', 'Jl. Gresik Baru 14, Gresik', '0813-9000-1234', 'mitra-lintas', 4.0, 41, { mail: 'none' }),                                              // a site without any e-mail address (WhatsApp + Instagram only)
  P('kos-melati', 'Kos Melati Putri', 'Boarding house', 'Jl. Ketintang Baru III No.5, Surabaya', '0857-1111-2222', '', 4.5, 33, { id: true }),                                                     // Indonesian interface labels
  ...Array.from({ length: 12 }, (_, i) => P(`logistik-${i + 1}`, `Logistik Mitra ${i + 1}`, 'Freight forwarder', `Jl. Industri ${i + 1}, Sidoarjo`, `0811-0000-${String(i + 1).padStart(4, '0')}`, '', 4 + (i % 10) / 10, 10 + i, {})),
];

/** a second search, one place of which was also in the first (found twice, saved once) */
export const SEMARANG_PLACES = [
  MAPS_PLACES[0],
  P('lintas-jawa', 'Lintas Jawa Cargo', 'Freight forwarder', 'Jl. Pemuda 10, Semarang', '(024) 8000 111', 'lintas-jawa', 4.3, 20, { mail: 'home' }),
  P('kos-sakura', 'Kos Sakura Semarang', 'Boarding house', 'Jl. Tembalang Raya 7, Semarang', '0821-5555-0000', '', 4.7, 64, {}),
];
export const ALL_PLACES = [...MAPS_PLACES, ...SEMARANG_PLACES.slice(1)];
export const placesFor = q => (/semarang/i.test(q) ? SEMARANG_PLACES : MAPS_PLACES);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const FEATURE = p => `0x2dd7${p.slug.length.toString(16)}:0x${Buffer.from(p.slug).toString('hex')}`;
/** link of a place as the list gives it (absolute, with the viewport and the click tracking parameters Maps adds) */
export const placeHref = (origin, p) => `${origin}/maps/place/${encodeURIComponent(p.name).replace(/%20/g, '+')}/@-7.2,112.7,17z/data=!4m7!3m6!1s${FEATURE(p)}!8m2!3d-7.2575!4d112.7521!16s%2Fg%2F11x?authuser=0&hl=en&rclk=1`;

/** one entry of the result list */
export function feedCard(p, origin, siteOrigin) {
  const id = !!p.id;                                                 // Indonesian labels
  const rating = id ? `${String(p.rating).replace('.', ',')} bintang ${p.reviews} Ulasan` : `${p.rating} stars ${p.reviews} Reviews`;
  const status = id ? '<span style="color:#188038">Buka</span><span> <span aria-hidden="true">⋅</span> Tutup pukul 22.00</span>' : '<span style="color:#d93025">Closed</span><span> <span aria-hidden="true">⋅</span> Opens 8 am</span>';
  const phone = p.cardNoPhone || !p.phone ? '' : `<span> <span aria-hidden="true">⋅</span> <span class="UsdlK">${esc(p.phone)}</span></span>`;
  const web = p.site ? `<div><a class="lcr4fd S9kvJb" href="https://www.google.com/url?q=${encodeURIComponent(`${siteOrigin}/biz/${p.site}`)}&amp;opi=89978449" aria-label="Visit ${esc(p.name)}'s website" data-value="Website"><span>Website</span></a></div>` : '';
  return `<div class="Nv2PK THOPZb CpccDe" jsaction="mouseover:pane.wfvdle2"><a class="hfpxzc" aria-label="${esc(p.name)}" href="${esc(placeHref(origin, p))}"></a>
  <div class="bfdHYd Ppzolf OFBs3e"><div class="lI9IFe"><div class="y7PRA"><div class="qBF1Pd fontHeadlineSmall">${esc(p.name)}</div>
    <div class="Hpl7ke"><div class="AJB7ye"><span class="e4rVHe fontBodyMedium"><span role="img" aria-label="${rating}"><span class="MW4etd" aria-hidden="true">${p.rating}</span><span class="UY7F9" aria-hidden="true">(${p.reviews})</span></span></span></div></div>
    <div class="W4Efsd"><div class="W4Efsd"><span><span>${esc(p.category)}</span></span><span> <span aria-hidden="true">⋅</span> <span>${esc(p.address)}</span></span></div><div class="W4Efsd"><span>${status}</span>${phone}</div></div></div></div>
  <div class="Rwjeuc">${web}<div><a data-value="Directions" aria-label="Directions to ${esc(p.name)}" href="https://www.google.com/maps/dir//${encodeURIComponent(p.name)}"><span>Directions</span></a></div></div></div></div>`;
}
const END_MSG = '<div class="PbZDve"><p class="fontBodyMedium"><span class="HlvSq">You\'ve reached the end of the list.</span></p></div>';

/** Result list page. The list scrolls and loads `batch` more places per scroll – like the real one. */
export function mapsSearchPage({ origin, siteOrigin, query, places = MAPS_PLACES, batch = 8, endMessage = true, endNow = false, delayMs = 250, title = 'Google Maps' }) {
  const first = places.slice(0, batch).map(p => feedCard(p, origin, siteOrigin)).join('');
  const rest = places.slice(batch).map(p => feedCard(p, origin, siteOrigin));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(query)} - ${title}</title><style>html,body{margin:0;height:100%}#pane{width:408px;height:100%}[role=feed]{height:420px;overflow-y:auto}.Nv2PK{position:relative;min-height:150px;border-bottom:1px solid #eee}.hfpxzc{position:absolute;inset:0}</style></head><body>
<div id="pane"><div role="main" aria-label="Results for ${esc(query)}"><h1 class="Q8Zj4c">Results</h1><div role="feed" class="m6QErb DxyBCb kA9KIf dS8AEf" aria-label="Results for ${esc(query)}">${first}${endNow ? END_MSG : ''}<div class="lXJj5c Hk4XGb" id="more"></div></div></div></div>
<script>
const queue=${JSON.stringify(rest)}; const feed=document.querySelector('[role=feed]'); let busy=false;
feed.addEventListener('scroll',()=>{ if(busy||feed.scrollTop+feed.clientHeight<feed.scrollHeight-60) return; busy=true;
  setTimeout(()=>{ const mk=document.createElement('div'); const chunk=queue.splice(0,${batch}); if(chunk.length){ feed.insertAdjacentHTML('beforeend',chunk.join('')); } ${endMessage ? `if(!queue.length) feed.insertAdjacentHTML('beforeend',${JSON.stringify(END_MSG)});` : ''} busy=false; },${delayMs}); });
</script></body></html>`;
}

/** The panel of an opened place. */
export function mapsPlacePage({ origin, siteOrigin, p, hoursRows = true }) {
  const digits = (p.detailPhone || p.phone || '').replace(/[^\d+]/g, '');
  const phone = p.detailPhone || p.phone;
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.name)} - Google Maps</title></head><body>
<div role="main" aria-label="${esc(p.name)}" class="m6QErb WNBkOb"><h1 class="DUwDvf lfPIob">${esc(p.name)}</h1>
<div class="F7nice"><span><span aria-hidden="true">${p.rating}</span><span role="img" aria-label="${p.rating} stars "></span></span><span><span><span aria-label="${p.reviews} reviews">(${p.reviews})</span></span></span></div>
<button class="DkEaL" jsaction="pane.rating.category">${esc(p.category)}</button>
<div><button data-item-id="address" aria-label="Address: ${esc(p.address)}"><div class="rogA2c"><div class="Io6YTe fontBodyMedium">${esc(p.address)}</div></div></button>
${p.site ? `<a data-item-id="authority" aria-label="Website: ${p.site}" href="${siteOrigin}/biz/${p.site}"><div class="Io6YTe">${p.site}</div></a>` : ''}
${phone ? `<button data-item-id="phone:tel:${digits}" aria-label="Phone: ${esc(phone)}"><div class="Io6YTe">${esc(phone)}</div></button>` : ''}
<button data-item-id="oloc" aria-label="Plus code: PRQ2+XJ Surabaya"><div class="Io6YTe">PRQ2+XJ Surabaya</div></button></div>
${hoursRows ? `<table class="eK4R0e">${days.map(d => `<tr><td><div>${d}</div></td><td>${d === 'Sunday' ? 'Closed' : '8 am–5 pm'}</td></tr>`).join('')}</table>` : ''}
</div></body></html>`;
}

// ---------------------------------------------------------------- the businesses' own websites
const cfHex = (email, key = 0x5a) => key.toString(16).padStart(2, '0') + [...email].map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
export function bizHome(p, origin, sub = '') {
  const slug = p.site; const social = `<a href="https://www.instagram.com/${slug}/"><i></i></a> <a href="https://www.facebook.com/${slug}.official"><i></i></a> <a href="https://wa.me/6281234560000">WhatsApp</a>`;
  const nav = `<nav><a href="${origin}/biz/${slug}">Home</a> <a href="${origin}/biz/${slug}/services">Services</a> ${p.mail === 'contact' ? `<a href="${origin}/biz/${slug}/kontak">Hubungi kami</a>` : ''}</nav>`;
  let body = `<h1>${esc(p.name)}</h1><p>We move cargo.</p>`;
  if (sub === 'kontak') body = `<h1>Hubungi kami</h1><p>Email: sales [at] ${slug} [dot] example · Telp ${esc(p.phone)}</p>`;
  else if (p.mail === 'home') body += `<p>Write to <a href="mailto:info@${slug}.example?subject=Quote">info@${slug}.example</a> or sales@${slug}.example</p><img src="/logo@2x.png" alt=""><span>no-reply@wixpress.com</span>`;
  else if (p.mail === 'cf') body += `<p>E-mail: <a href="/cdn-cgi/l/email-protection#${cfHex(`office@${slug}.example`)}"><span class="__cf_email__" data-cfemail="${cfHex(`office@${slug}.example`)}">[email&#160;protected]</span></a></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.name)}</title></head><body>${nav}${body}<footer>${social}</footer></body></html>`;
}
