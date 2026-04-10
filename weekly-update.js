const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'KevinKobayashi/pointsy-data';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'kevinrkobayashi@gmail.com';

const SOURCES = {
  giftCards: [
    'https://www.pointhacks.com.au/weekly-gift-card-offers/',
    'https://flighthacks.com.au/weekly-gift-card-points-offers/',
    'https://gcdb.com.au/article/weekly-gift-card-offers/'
  ],
  creditCards: [
    'https://www.finty.com.au/credit-cards/frequent-flyer/',
    'https://www.pointhacks.com.au/credit-cards/australia/'
  ]
};

const KNOWN_IDS = {
  woolworths: ['w-apple','w-uber','w-gplay','w-doordash','w-hoyts','w-webjet','w-redbal','w-timezone','w-amazon','w-ultimate','w-kids','w-teen','w-him','w-her','w-home','w-active','w-baby','w-birthday','w-celebrate','w-thankyou','w-party','w-love'],
  coles: ['c-apple','c-jbhifi','c-ubereats','c-gplay','c-mastercard','c-cinema','c-goodfood','c-him','c-her','c-pubbar','c-shop','c-pamper','c-gift','c-netflix','c-stan'],
  creditCards: ['amex-platinum','amex-platinum-edge','amex-explorer','anz-ff-black','anz-ff','westpac-altitude-black','westpac-altitude-platinum','cba-smart-awards','cba-diamond-awards','nab-qantas-signature']
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Pointsy/1.0)' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ body: data, status: res.statusCode, url }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function httpsPost(hostname, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({ hostname, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ body: d, status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsPut(hostname, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({ hostname, path, method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ body: d, status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function cleanHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, ' ').replace(/&#039;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\\/g, ' ').replace(/"/g, "'")
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 10000);
}

function extractDate(text) {
  const patterns = [
    /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})/i,
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i,
    /(\d{4})-(\d{2})-(\d{2})/
  ];
  for (const p of patterns) {
    const m = text.substring(0, 2000).match(p);
    if (m) {
      const d = new Date(m[0]);
      if (!isNaN(d)) { d.setUTCHours(12,0,0,0); return d; }
    }
  }
  return null;
}

async function fetchSources(urls, label) {
  const results = [];
  for (const url of urls) {
    try {
      const res = await httpsGet(url);
      const clean = cleanHtml(res.body);
      const date = extractDate(clean);
      const now = new Date(); now.setUTCHours(12,0,0,0);
      const daysAgo = date ? Math.floor((now - date) / 86400000) : null;
      const stale = daysAgo !== null && daysAgo > 3;
      results.push({ url, text: clean, date: date?.toISOString() || null, daysAgo, stale, status: res.status });
      console.log(`[${label}] ${url} — ${stale ? 'STALE' : 'OK'} (${daysAgo ?? '?'} days ago)`);
    } catch (e) {
      console.error(`[${label}] Failed: ${url} — ${e.message}`);
      results.push({ url, text: '', date: null, daysAgo: null, stale: false, error: e.message });
    }
  }
  return results;
}

async function callClaude(prompt) {
  const res = await httpsPost('api.anthropic.com', '/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  }, {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  });
  const data = JSON.parse(res.body);
  if (data.error) throw new Error(data.error.message);
  const text = data.content.map(b => b.text || '').join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no JSON');
  return JSON.parse(jsonMatch[0]);
}

async function getGitHubFile(filename) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${filename}`,
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'Pointsy', 'Accept': 'application/vnd.github.v3+json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject); req.end();
  });
}

async function updateGitHubFile(filename, content, sha, message) {
  const res = await httpsPut('api.github.com', `/repos/${GITHUB_REPO}/contents/${filename}`, {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    sha
  }, { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'Pointsy', 'Accept': 'application/vnd.github.v3+json' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`GitHub update failed: ${res.status} ${res.body}`);
  console.log(`[GitHub] Updated ${filename}`);
}

async function sendEmail(subject, htmlBody) {
  if (!RESEND_API_KEY) { console.log('[Email] No RESEND_API_KEY — skipping email'); return; }
  const res = await httpsPost('api.resend.com', '/emails', {
    from: 'Pointsy <updates@pointsy.site>',
    to: [NOTIFY_EMAIL],
    subject,
    html: htmlBody
  }, { 'Authorization': `Bearer ${RESEND_API_KEY}` });
  console.log(`[Email] Sent — status ${res.status}`);
}

function buildSourceReport(gcSources, ccSources) {
  const all = [...gcSources, ...ccSources];
  return all.map(s => {
    const icon = s.error ? '❌' : s.stale ? '❌' : s.daysAgo === null ? '⚠️' : '✅';
    const reason = s.error ? s.error : s.stale ? `${s.daysAgo} days old — ignored` : s.daysAgo === null ? 'No date detected — included with caution' : `Updated ${s.daysAgo} days ago`;
    return `<tr><td>${icon}</td><td style="font-family:monospace;font-size:12px">${s.url.replace('https://','')}</td><td>${reason}</td></tr>`;
  }).join('');
}

function buildDiff(prev, next, type) {
  const prevIds = new Set((prev[type] || []).filter(x => x.active).map(x => x.id));
  const nextIds = new Set((next[type] || []).filter(x => x.active).map(x => x.id));
  const added = [...nextIds].filter(id => !prevIds.has(id));
  const removed = [...prevIds].filter(id => !nextIds.has(id));
  const kept = [...nextIds].filter(id => prevIds.has(id));
  return { added, removed, kept };
}

async function main() {
  console.log('=== Pointsy Weekly Update ===');
  const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const weekStart = new Date(); weekStart.setUTCHours(0,0,0,0);
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const weekLabel = `${weekStart.toLocaleDateString('en-AU',{day:'numeric',month:'short'})} – ${weekEnd.toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}`;

  const gcSources = await fetchSources(SOURCES.giftCards, 'GiftCards');
  const ccSources = await fetchSources(SOURCES.creditCards, 'CreditCards');

  const validGC = gcSources.filter(s => !s.stale && !s.error && s.text.length > 100);
  const validCC = ccSources.filter(s => !s.stale && !s.error && s.text.length > 100);

  const giftCardText = validGC.map(s => `SOURCE: ${s.url}\n${s.text}`).join('\n\n---\n\n');
  const creditCardText = validCC.map(s => `SOURCE: ${s.url}\n${s.text}`).join('\n\n---\n\n');

  let promotions = { woolworths: [], coles: [] };
  let cards = { cards: [] };
  let unknownGiftCards = [];
  let unknownCreditCards = [];

  if (giftCardText.length > 100) {
    try {
      const gcPrompt = `Today is ${today}. Extract gift card promotions that are currently active (not future). Return ONLY valid JSON.

Valid Woolworths IDs: ${KNOWN_IDS.woolworths.join(',')}
Valid Coles IDs: ${KNOWN_IDS.coles.join(',')}

For each active promotion include: id, multiplier (as string: "20"/"10"/"5"), OR if fixed points use multiplier:"fixed_pts" and add promoMeta:{"pts":1000,"per_spend":50}, visas (array from ["whv","student","tss","pr"]), active:true, expires (YYYY-MM-DD).

If you find a brand not in the known IDs list, include it as: {"id":"c-unknown-netflix","unknown":true,"brand":"Netflix","store":"coles","multiplier":"20"}

Schema: {"woolworths":[{"id":"w-apple","multiplier":"20","visas":["whv","student","tss","pr"],"active":true,"expires":"2026-04-16"}],"coles":[],"unknownItems":[]}

SOURCE TEXT:
${giftCardText.substring(0, 8000)}`;

      const result = await callClaude(gcPrompt);
      promotions.woolworths = (result.woolworths || []).filter(x => !x.unknown);
      promotions.coles = (result.coles || []).filter(x => !x.unknown);
      unknownGiftCards = result.unknownItems || [];
      console.log(`[Claude] Gift cards: ${promotions.woolworths.length} Woolworths, ${promotions.coles.length} Coles`);
    } catch (e) {
      console.error('[Claude] Gift cards extraction failed:', e.message);
    }
  }

  if (creditCardText.length > 100) {
    try {
      const ccPrompt = `Extract current credit card bonus offers from the text. Return ONLY valid JSON.

Known card IDs: ${KNOWN_IDS.creditCards.join(',')}
Visa rules: WHV=never, Student=cba-smart-awards+anz-ff+westpac-altitude-platinum only, TSS=all except blocked, PR=all

For each card include: id, bonus_pts (number), bonus_pts_label, bonus_condition, earn_rate, annual_fee, annual_fee_label, transfers_to (array), visas (array), active:true, last_verified.

If you find a card not in known IDs, include it with unknown:true.

Schema: {"cards":[{"id":"amex-platinum-edge","bonus_pts":100000,"bonus_pts_label":"100,000 pts","bonus_condition":"Spend AU$3,000 in 3 months","earn_rate":"3 pts/$1 supermarkets","annual_fee":195,"annual_fee_label":"AU$195","transfers_to":["Qantas"],"visas":["tss","pr"],"active":true,"last_verified":"${today}"}],"unknownItems":[]}

SOURCE TEXT:
${creditCardText.substring(0, 8000)}`;

      const result = await callClaude(ccPrompt);
      cards.cards = (result.cards || []).filter(x => !x.unknown);
      unknownCreditCards = result.unknownItems || [];
      console.log(`[Claude] Credit cards: ${cards.cards.length} found`);
    } catch (e) {
      console.error('[Claude] Credit cards extraction failed:', e.message);
    }
  }

  promotions._meta = {
    week: weekLabel,
    generated_at: new Date().toISOString(),
    expires_at: weekEnd.toISOString(),
    source: 'github-actions'
  };

  cards._meta = {
    week: weekLabel,
    generated_at: new Date().toISOString(),
    source: 'github-actions'
  };

  let prevPromotions = { woolworths: [], coles: [] };
  let prevCards = { cards: [] };
  let promoSha, cardsSha;

  try {
    const f = await getGitHubFile('promotions.json');
    promoSha = f.sha;
    prevPromotions = JSON.parse(Buffer.from(f.content, 'base64').toString());
  } catch (e) { console.log('[GitHub] No existing promotions.json'); }

  try {
    const f = await getGitHubFile('cards.json');
    cardsSha = f.sha;
    prevCards = JSON.parse(Buffer.from(f.content, 'base64').toString());
  } catch (e) { console.log('[GitHub] No existing cards.json'); }

  if (promotions.woolworths.length > 0 || promotions.coles.length > 0) {
    await updateGitHubFile('promotions.json', promotions, promoSha, `Weekly update ${weekLabel}`);
  } else {
    console.log('[GitHub] Skipping promotions.json update — Claude found 0 promotions (manual update may be needed)');
  }

  if (cards.cards.length > 0) {
    await updateGitHubFile('cards.json', cards, cardsSha, `Credit cards update ${weekLabel}`);
  } else {
    console.log('[GitHub] Skipping cards.json update — Claude found 0 cards');
  }

  const wcDiff = buildDiff(prevPromotions, promotions, 'woolworths');
  const cDiff = buildDiff(prevPromotions, promotions, 'coles');
  const ccDiff = buildDiff(prevCards, cards, 'cards');

  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, sans-serif; color: #111; max-width: 600px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; border-top: 1px solid #eee; padding-top: 12px; }
  .badge-ok { background: #d1fae5; color: #065f46; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .badge-warn { background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .badge-err { background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; text-align: left; }
  .new { color: #16a34a; font-weight: 600; }
  .removed { color: #dc2626; }
  .kept { color: #6b7280; }
  .alert { background: #fef9c3; border-left: 4px solid #eab308; padding: 12px; border-radius: 4px; margin: 12px 0; }
  .footer { font-size: 12px; color: #6b7280; margin-top: 32px; border-top: 1px solid #eee; padding-top: 12px; }
</style>
</head>
<body>

<h1>Pointsy — Weekly Update</h1>
<p style="color:#6b7280;font-size:14px">${weekLabel} · Generated ${today}</p>

${unknownGiftCards.length > 0 ? `
<div class="alert">
  <strong>New gift card brands detected — add to index.html:</strong><br>
  ${unknownGiftCards.map(x => `${x.brand} (${x.store}) — suggested ID: ${x.id}`).join('<br>')}
</div>` : ''}

${unknownCreditCards.length > 0 ? `
<div class="alert">
  <strong>Unknown credit cards detected:</strong><br>
  ${unknownCreditCards.map(x => x.id || x.name).join('<br>')}
</div>` : ''}

<h2>Source validation</h2>
<table>
  <tr><th></th><th>Source</th><th>Status</th></tr>
  ${buildSourceReport(gcSources, ccSources)}
</table>

<h2>Woolworths (Everyday Rewards)</h2>
<table>
  <tr><th>Change</th><th>ID</th></tr>
  ${wcDiff.added.map(id => `<tr><td class="new">+ New</td><td>${id}</td></tr>`).join('')}
  ${wcDiff.removed.map(id => `<tr><td class="removed">- Removed</td><td>${id}</td></tr>`).join('')}
  ${wcDiff.kept.map(id => `<tr><td class="kept">= Active</td><td>${id}</td></tr>`).join('')}
  ${wcDiff.added.length + wcDiff.removed.length + wcDiff.kept.length === 0 ? '<tr><td colspan="2" style="color:#6b7280">No active promotions found this week</td></tr>' : ''}
</table>

<h2>Coles (Flybuys)</h2>
<table>
  <tr><th>Change</th><th>ID</th></tr>
  ${cDiff.added.map(id => `<tr><td class="new">+ New</td><td>${id}</td></tr>`).join('')}
  ${cDiff.removed.map(id => `<tr><td class="removed">- Removed</td><td>${id}</td></tr>`).join('')}
  ${cDiff.kept.map(id => `<tr><td class="kept">= Active</td><td>${id}</td></tr>`).join('')}
  ${cDiff.added.length + cDiff.removed.length + cDiff.kept.length === 0 ? '<tr><td colspan="2" style="color:#6b7280">No active promotions found this week</td></tr>' : ''}
</table>

<h2>Credit Cards</h2>
<table>
  <tr><th>Change</th><th>ID</th></tr>
  ${ccDiff.added.map(id => `<tr><td class="new">+ New</td><td>${id}</td></tr>`).join('')}
  ${ccDiff.removed.map(id => `<tr><td class="removed">- Removed</td><td>${id}</td></tr>`).join('')}
  ${ccDiff.kept.map(id => `<tr><td class="kept">= Active</td><td>${id}</td></tr>`).join('')}
  ${ccDiff.added.length + ccDiff.removed.length + ccDiff.kept.length === 0 ? '<tr><td colspan="2" style="color:#6b7280">No credit card data this week (check source URLs)</td></tr>' : ''}
</table>

<p class="footer">
  Pointsy · pointsy.site · Double-dipping tip: scan your Everyday Rewards or Flybuys card AND pay with a miles credit card on the same purchase.
</p>
</body>
</html>`;

  await sendEmail(`Pointsy — Weekly Update ${weekLabel}`, emailHtml);
  console.log('=== Done ===');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
