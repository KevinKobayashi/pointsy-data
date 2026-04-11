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
    // Finty removido — certificado SSL expirado
    'https://www.pointhacks.com.au/credit-cards/australia/'
  ]
};

const KNOWN_IDS = {
  woolworths: ['w-apple','w-uber','w-gplay','w-doordash','w-hoyts','w-webjet','w-redbal','w-timezone','w-amazon','w-ultimate','w-kids','w-teen','w-him','w-her','w-home','w-active','w-baby','w-birthday','w-celebrate','w-thankyou','w-party','w-love','w-student','w-everyone'],
  coles: ['c-apple','c-jbhifi','c-ubereats','c-gplay','c-mastercard','c-cinema','c-goodfood','c-him','c-her','c-pubbar','c-shop','c-pamper','c-gift','c-netflix','c-stan'],
  creditCards: ['amex-platinum','amex-platinum-edge','amex-explorer','anz-ff-black','anz-ff','westpac-altitude-black','westpac-altitude-platinum','cba-smart-awards','cba-diamond-awards','nab-qantas-signature']
};

function httpsGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Pointsy/1.0)' },
      rejectUnauthorized: false
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
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
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let d = ''; res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ body: d, status: res.statusCode }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function httpsPut(hostname, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname, path, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    }, res => {
      let d = ''; res.on('data', chunk => d += chunk);
      res.on('end', () => resolve({ body: d, status: res.statusCode }));
    });
    req.on('error', reject); req.write(body); req.end();
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
      if (!isNaN(d)) { d.setUTCHours(12, 0, 0, 0); return d; }
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
      const now = new Date(); now.setUTCHours(12, 0, 0, 0);
      const daysAgo = date ? Math.floor((now - date) / 86400000) : null;
      const stale = daysAgo !== null && daysAgo > 3;
      results.push({ url, text: clean, date: date?.toISOString() || null, daysAgo, stale, status: res.status });
      console.log(`[${label}] ${url} — ${stale ? 'STALE' : 'OK'} (${daysAgo ?? '?'} days ago, ${clean.length} chars)`);
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
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'Pointsy',
        'Accept': 'application/vnd.github.v3+json'
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const parsed = JSON.parse(d);
        if (parsed.message === 'Not Found') reject(new Error('File not found'));
        else resolve(parsed);
      });
    });
    req.on('error', reject); req.end();
  });
}

async function updateGitHubFile(filename, content, sha, message) {
  const res = await httpsPut('api.github.com', `/repos/${GITHUB_REPO}/contents/${filename}`, {
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    sha
  }, {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'User-Agent': 'Pointsy',
    'Accept': 'application/vnd.github.v3+json'
  });
  if (res.status !== 200 && res.status !== 201) throw new Error(`GitHub update failed: ${res.status} ${res.body}`);
  console.log(`[GitHub] Updated ${filename}`);
}

async function sendEmail(subject, htmlBody) {
  if (!RESEND_API_KEY) { console.log('[Email] No RESEND_API_KEY — skipping'); return; }
  const res = await httpsPost('api.resend.com', '/emails', {
    from: 'Pointsy <updates@pointsy.site>',
    to: [NOTIFY_EMAIL],
    subject,
    html: htmlBody
  }, { 'Authorization': `Bearer ${RESEND_API_KEY}` });
  console.log(`[Email] Sent — status ${res.status}`);
}

// KEY FIX: diff compara prev (GitHub antes) vs final (GitHub depois ou igual se Claude nao encontrou nada)
// Resultado: "Removed" so aparece quando Claude confirmou que o item sumiu das fontes
function buildDiff(prev, final, type) {
  const prevActive = new Set((prev[type] || []).filter(x => x.active !== false).map(x => x.id));
  const finalActive = new Set((final[type] || []).filter(x => x.active !== false).map(x => x.id));
  return {
    added:   [...finalActive].filter(id => !prevActive.has(id)),
    removed: [...prevActive].filter(id => !finalActive.has(id)),
    kept:    [...finalActive].filter(id => prevActive.has(id))
  };
}

function buildSourceReport(gcSources, ccSources) {
  return [...gcSources, ...ccSources].map(s => {
    const icon = s.error ? '❌' : s.stale ? '❌' : s.daysAgo === null ? '⚠️' : '✅';
    const reason = s.error ? s.error
      : s.stale ? `${s.daysAgo} days old — ignored`
      : s.daysAgo === null ? 'No date detected — included with caution'
      : `Updated ${s.daysAgo} day${s.daysAgo === 1 ? '' : 's'} ago`;
    return `<tr><td>${icon}</td><td style="font-family:monospace;font-size:12px">${s.url.replace('https://','')}</td><td>${reason}</td></tr>`;
  }).join('');
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

  // Carregar arquivos atuais do GitHub PRIMEIRO (baseline para o diff)
  let prevPromotions = { woolworths: [], coles: [] };
  let prevCards = { cards: [] };
  let promoSha, cardsSha;

  try {
    const f = await getGitHubFile('promotions.json');
    promoSha = f.sha;
    prevPromotions = JSON.parse(Buffer.from(f.content, 'base64').toString());
    console.log(`[GitHub] promotions.json loaded (${(prevPromotions.woolworths||[]).length}W + ${(prevPromotions.coles||[]).length}C)`);
  } catch (e) { console.log('[GitHub] No promotions.json found'); }

  try {
    const f = await getGitHubFile('cards.json');
    cardsSha = f.sha;
    prevCards = JSON.parse(Buffer.from(f.content, 'base64').toString());
    console.log(`[GitHub] cards.json loaded (${(prevCards.cards||[]).length} cards)`);
  } catch (e) { console.log('[GitHub] No cards.json found'); }

  // Extracao pelo Claude
  let newPromotions = null;
  let newCards = null;
  let unknownGiftCards = [];
  let unknownCreditCards = [];
  let claudeGCError = null;
  let claudeCCError = null;

  if (giftCardText.length > 100) {
    try {
      const gcPrompt = `Today is ${today}. Extract gift card promotions that are CURRENTLY ACTIVE (not future dated). Return ONLY valid JSON.

Valid Woolworths IDs: ${KNOWN_IDS.woolworths.join(',')}
Valid Coles IDs: ${KNOWN_IDS.coles.join(',')}

Rules:
- multiplier: use string "20", "10", or "5"
- Fixed-points deals (e.g. "1000 points per $50"): use multiplier:"fixed_pts" and promoMeta:{"pts":1000,"per_spend":50}
- Unknown brands not in the ID lists: add to unknownItems with {id, brand, store, multiplier}
- Only include promotions active RIGHT NOW (today is ${today})

Schema: {"woolworths":[{"id":"w-apple","multiplier":"20","visas":["whv","student","tss","pr"],"active":true,"expires":"2026-04-16"}],"coles":[],"unknownItems":[]}

SOURCE TEXT:
${giftCardText.substring(0, 8000)}`;

      const result = await callClaude(gcPrompt);
      const wItems = (result.woolworths || []).filter(x => x.id && !x.unknown);
      const cItems = (result.coles || []).filter(x => x.id && !x.unknown);
      unknownGiftCards = result.unknownItems || [];
      console.log(`[Claude GC] Found: ${wItems.length}W + ${cItems.length}C, unknown: ${unknownGiftCards.length}`);

      if (wItems.length > 0 || cItems.length > 0) {
        newPromotions = { woolworths: wItems, coles: cItems };
      } else {
        console.log('[Claude GC] 0 promotions — keeping promotions.json unchanged');
      }
    } catch (e) {
      claudeGCError = e.message;
      console.error('[Claude GC] Error:', e.message);
    }
  }

  if (creditCardText.length > 100) {
    try {
      const ccPrompt = `Extract current credit card bonus offers. Return ONLY valid JSON.

Known IDs: ${KNOWN_IDS.creditCards.join(',')}
Visa rules: WHV=never, Student=only cba-smart-awards+anz-ff+westpac-altitude-platinum, TSS=most, PR=all

Schema: {"cards":[{"id":"amex-platinum-edge","bonus_pts":100000,"bonus_pts_label":"100,000 pts","bonus_condition":"Spend AU$3,000 in 3 months","earn_rate":"3 pts/$1 supermarkets","annual_fee":195,"annual_fee_label":"AU$195","transfers_to":["Qantas"],"visas":["tss","pr"],"active":true,"last_verified":"${today}"}],"unknownItems":[]}

SOURCE TEXT:
${creditCardText.substring(0, 8000)}`;

      const result = await callClaude(ccPrompt);
      const cItems = (result.cards || []).filter(x => x.id && !x.unknown);
      unknownCreditCards = result.unknownItems || [];
      console.log(`[Claude CC] Found: ${cItems.length} cards, unknown: ${unknownCreditCards.length}`);

      if (cItems.length > 0) {
        newCards = { cards: cItems };
      } else {
        console.log('[Claude CC] 0 cards — keeping cards.json unchanged');
      }
    } catch (e) {
      claudeCCError = e.message;
      console.error('[Claude CC] Error:', e.message);
    }
  }

  // Definir estado final: novo se Claude encontrou, ou manter o existente
  const finalPromotions = newPromotions
    ? { ...newPromotions, _meta: { week: weekLabel, generated_at: new Date().toISOString(), expires_at: weekEnd.toISOString(), source: 'github-actions' } }
    : prevPromotions;

  const finalCards = newCards
    ? { ...newCards, _meta: { week: weekLabel, generated_at: new Date().toISOString(), source: 'github-actions' } }
    : prevCards;

  // Atualizar GitHub somente se Claude encontrou dados novos
  if (newPromotions && promoSha) {
    await updateGitHubFile('promotions.json', finalPromotions, promoSha, `Weekly update ${weekLabel}`);
  } else {
    console.log('[GitHub] promotions.json not updated');
  }

  if (newCards && cardsSha) {
    await updateGitHubFile('cards.json', finalCards, cardsSha, `Cards update ${weekLabel}`);
  } else {
    console.log('[GitHub] cards.json not updated');
  }

  // Diff correto: prev (antes desta execucao) vs final (apos esta execucao)
  const wcDiff = buildDiff(prevPromotions, finalPromotions, 'woolworths');
  const cDiff  = buildDiff(prevPromotions, finalPromotions, 'coles');
  const ccDiff = buildDiff(prevCards, finalCards, 'cards');

  const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body{font-family:-apple-system,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:20px}
  h1{font-size:22px;margin-bottom:4px}
  h2{font-size:16px;margin:24px 0 8px;border-top:1px solid #eee;padding-top:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td,th{padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:left}
  .new{color:#16a34a;font-weight:600}
  .removed{color:#dc2626}
  .kept{color:#6b7280}
  .alert{background:#fef9c3;border-left:4px solid #eab308;padding:12px;border-radius:4px;margin:12px 0;font-size:13px}
  .info{background:#e0f2fe;border-left:4px solid #0284c7;padding:12px;border-radius:4px;margin:12px 0;font-size:13px}
  .footer{font-size:12px;color:#6b7280;margin-top:32px;border-top:1px solid #eee;padding-top:12px}
</style>
</head>
<body>

<h1>Pointsy — Weekly Update</h1>
<p style="color:#6b7280;font-size:14px">${weekLabel} · Generated ${today}</p>

${!newPromotions ? `<div class="info"><strong>Gift cards:</strong> Claude found 0 active promotions — promotions.json kept unchanged. Manual update may be needed.</div>` : ''}
${!newCards ? `<div class="info"><strong>Credit cards:</strong> Claude found 0 cards — cards.json kept unchanged.</div>` : ''}
${claudeGCError ? `<div class="alert"><strong>Claude error (gift cards):</strong> ${claudeGCError}</div>` : ''}
${claudeCCError ? `<div class="alert"><strong>Claude error (credit cards):</strong> ${claudeCCError}</div>` : ''}
${unknownGiftCards.length > 0 ? `<div class="alert"><strong>New brands detected — add to index.html:</strong><br>${unknownGiftCards.map(x=>`${x.brand} (${x.store}) → ${x.id}`).join('<br>')}</div>` : ''}
${unknownCreditCards.length > 0 ? `<div class="alert"><strong>Unknown credit cards:</strong><br>${unknownCreditCards.map(x=>x.id||x.name||JSON.stringify(x)).join('<br>')}</div>` : ''}

<h2>Source validation</h2>
<table>
  <tr><th></th><th>Source</th><th>Status</th></tr>
  ${buildSourceReport(gcSources, ccSources)}
</table>

<h2>Woolworths${newPromotions ? '' : ' — unchanged'}</h2>
<table>
  <tr><th>Change</th><th>ID</th></tr>
  ${wcDiff.added.map(id=>`<tr><td class="new">+ New</td><td>${id}</td></tr>`).join('')}
  ${wcDiff.removed.map(id=>`<tr><td class="removed">- Removed</td><td>${id}</td></tr>`).join('')}
  ${wcDiff.kept.map(id=>`<tr><td class="kept">= Active</td><td>${id}</td></tr>`).join('')}
  ${!wcDiff.added.length && !wcDiff.removed.length && !wcDiff.kept.length ? '<tr><td colspan="2" style="color:#6b7280">No active promotions</td></tr>' : ''}
</table>

<h2>Coles${newPromotions ? '' : ' — unchanged'}</h2>
<table>
  <tr><th>Change</th><th>ID</th></tr>
  ${cDiff.added.map(id=>`<tr><td class="new">+ New</td><td>${id}</td></tr>`).join('')}
  ${cDiff.removed.map(id=>`<tr><td class="removed">- Removed</td><td>${id}</td></tr>`).join('')}
  ${cDiff.kept.map(id=>`<tr><td class="kept">= Active</td><td>${id}</td></tr>`).join('')}
  ${!cDiff.added.length && !cDiff.removed.length && !cDiff.kept.length ? '<tr><td colspan="2" style="color:#6b7280">No active promotions</td></tr>' : ''}
</table>

<h2>Credit Cards${newCards ? '' : ' — unchanged'}</h2>
<table>
  <tr><th>Change</th><th>ID</th></tr>
  ${ccDiff.added.map(id=>`<tr><td class="new">+ New</td><td>${id}</td></tr>`).join('')}
  ${ccDiff.removed.map(id=>`<tr><td class="removed">- Removed</td><td>${id}</td></tr>`).join('')}
  ${ccDiff.kept.map(id=>`<tr><td class="kept">= Active</td><td>${id}</td></tr>`).join('')}
  ${!ccDiff.added.length && !ccDiff.removed.length && !ccDiff.kept.length ? '<tr><td colspan="2" style="color:#6b7280">No active credit card data</td></tr>' : ''}
</table>

<p class="footer">Pointsy · pointsy.site · Double-dipping: scan Everyday Rewards or Flybuys AND pay with a miles card on the same purchase.</p>
</body>
</html>`;

  await sendEmail(`Pointsy — Weekly Update ${weekLabel}`, emailHtml);
  console.log('=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
