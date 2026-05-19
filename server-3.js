/**
 * STOCKLAB PRO - 서버 (Alpha Vantage 무료 API)
 * Railway 배포용 - npm 불필요
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const pathModule = require('path');

const PORT = process.env.PORT || 3000;

// !! Alpha Vantage 무료 API 키 (https://www.alphavantage.co/support/#api-key 에서 무료 발급)
// 기본 데모키는 하루 25회 제한 → 본인 키 발급 권장
const AV_KEY = process.env.AV_KEY || 'demo';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function httpsGet(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    }, (r) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', c => data += c);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Yahoo Finance (가장 안정적) ──
async function fetchYahoo(code) {
  const suffixes = ['.KS', '.KQ'];
  for (const suffix of suffixes) {
    try {
      const { body } = await httpsGet(
        `https://query2.finance.yahoo.com/v8/finance/chart/${code}${suffix}?interval=1d&range=1d`
      );
      const json = JSON.parse(body);
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || !meta.regularMarketPrice) continue;
      const price = meta.regularMarketPrice;
      const prev = meta.previousClose || meta.chartPreviousClose || price;
      const changeRate = Math.round((price - prev) / prev * 10000) / 100;
      return {
        code,
        name: (meta.longName || meta.shortName || code)
          .replace(' Co., Ltd.', '').replace(' Corp.', '').replace(', Inc.', ''),
        price: Math.round(price),
        changeRate,
        volume: meta.regularMarketVolume ? meta.regularMarketVolume.toLocaleString() : '-',
        marketCap: meta.marketCap ? Math.round(meta.marketCap / 100000000).toLocaleString() : '-',
        updatedAt: new Date().toLocaleTimeString('ko-KR'),
        source: 'Yahoo Finance'
      };
    } catch { continue; }
  }
  return null;
}

// ── Alpha Vantage fallback ──
async function fetchAlphaVantage(code) {
  try {
    const { body } = await httpsGet(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${code}.KS&apikey=${AV_KEY}`
    );
    const json = JSON.parse(body);
    const q = json['Global Quote'];
    if (!q || !q['05. price']) throw new Error('no data');
    const price = Math.round(parseFloat(q['05. price']));
    const changeRate = Math.round(parseFloat(q['10. change percent']) * 100) / 100;
    return {
      code,
      name: code,
      price,
      changeRate,
      volume: q['06. volume'] || '-',
      marketCap: '-',
      updatedAt: new Date().toLocaleTimeString('ko-KR'),
      source: 'Alpha Vantage'
    };
  } catch { return null; }
}

// ── 종목 조회 (Yahoo 우선, 실패시 AV) ──
async function fetchStock(code) {
  const yahoo = await fetchYahoo(code);
  if (yahoo) return yahoo;
  const av = await fetchAlphaVantage(code);
  if (av) return av;
  throw new Error(`${code} 주가 데이터를 가져올 수 없습니다`);
}

// ── 종목 검색 ──
async function searchStock(query) {
  try {
    const { body } = await httpsGet(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&lang=ko-KR&region=KR&quotesCount=8&newsCount=0`
    );
    const json = JSON.parse(body);
    return (json?.quotes || [])
      .filter(q => q.symbol && (q.symbol.endsWith('.KS') || q.symbol.endsWith('.KQ')))
      .slice(0, 8)
      .map(q => ({
        code: q.symbol.replace('.KS', '').replace('.KQ', ''),
        name: (q.longname || q.shortname || q.symbol)
          .replace(' Co., Ltd.', '').replace(' Corp.', ''),
        market: q.symbol.endsWith('.KS') ? 'KOSPI' : 'KOSDAQ'
      }));
  } catch { return []; }
}

// ── 서버 ──
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // HTML 서빙
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = pathModule.join(__dirname, 'stocklab-pro.html');
    if (fs.existsSync(htmlPath)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(404); res.end('stocklab-pro.html 없음');
    }
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (pathname === '/api/stock' && query.code) {
      const data = await fetchStock(query.code.trim());
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }

    if (pathname === '/api/stocks' && query.codes) {
      const codes = query.codes.split(',').map(c => c.trim()).filter(Boolean).slice(0, 20);
      const results = await Promise.allSettled(codes.map(fetchStock));
      const data = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { code: codes[i], error: r.reason.message, price: null, changeRate: 0 }
      );
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }

    if (pathname === '/api/search' && query.query) {
      const data = await searchStock(query.query);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }

    if (pathname === '/api/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'STOCKLAB PRO 정상', port: PORT }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: '없는 경로' }));

  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`STOCKLAB PRO → http://localhost:${PORT}`);
});
