/**
 * STOCKLAB PRO - 프록시 서버 (KRX + 네이버 fallback)
 * Railway 배포용
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const pathModule = require('path');

const PORT = process.env.PORT || 3000;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function httpsPost(hostname, path, postData, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = typeof postData === 'string' ? postData : JSON.stringify(postData);
    const options = {
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.krx.co.kr',
        'Origin': 'https://www.krx.co.kr',
        ...headers
      }
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', c => data += c);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function httpsGet(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        ...headers
      }
    };
    const req = https.request(options, (r) => {
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

// ── Yahoo Finance로 주가 조회 (해외서버에서 안정적) ──
async function fetchYahooStock(code) {
  // 한국 종목은 .KS (KOSPI) 또는 .KQ (KOSDAQ) 붙임
  const symbols = [code + '.KS', code + '.KQ'];
  
  for (const symbol of symbols) {
    try {
      const { body } = await httpsGet(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
        { 'Accept': 'application/json' }
      );
      const json = JSON.parse(body);
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      const prevClose = meta.previousClose || meta.chartPreviousClose;
      const changeRate = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
      const name = meta.longName || meta.shortName || code;
      
      if (!price) continue;
      
      return {
        code,
        name: name.replace(' Co., Ltd.', '').replace(' Corp.', '').replace(', Inc.', ''),
        price: Math.round(price),
        changeRate: Math.round(changeRate * 100) / 100,
        volume: meta.regularMarketVolume?.toLocaleString() || '-',
        marketCap: meta.marketCap ? Math.round(meta.marketCap / 100000000).toLocaleString() : '-',
        currency: meta.currency || 'KRW',
        updatedAt: new Date().toLocaleTimeString('ko-KR'),
        source: 'Yahoo Finance'
      };
    } catch (e) {
      continue;
    }
  }
  throw new Error(`${code} 주가 데이터를 찾을 수 없습니다`);
}

// ── 종목 검색 (KRX OTP 방식) ──
async function searchStock(query) {
  try {
    // Yahoo Finance 검색
    const { body } = await httpsGet(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query + ' korea')}&lang=ko-KR&region=KR&quotesCount=8&newsCount=0`,
      { 'Accept': 'application/json' }
    );
    const json = JSON.parse(body);
    const quotes = json?.quotes || [];
    return quotes
      .filter(q => q.symbol && (q.symbol.endsWith('.KS') || q.symbol.endsWith('.KQ')))
      .slice(0, 8)
      .map(q => ({
        code: q.symbol.replace('.KS', '').replace('.KQ', ''),
        name: (q.longname || q.shortname || q.symbol).replace(' Co., Ltd.', '').replace(' Corp.', ''),
        market: q.symbol.endsWith('.KS') ? 'KOSPI' : 'KOSDAQ'
      }));
  } catch {
    return [];
  }
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
      res.writeHead(404);
      res.end('stocklab-pro.html 없음');
    }
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // 단일 종목
    if (pathname === '/api/stock' && query.code) {
      const data = await fetchYahooStock(query.code.trim());
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }

    // 복수 종목
    if (pathname === '/api/stocks' && query.codes) {
      const codes = query.codes.split(',').map(c => c.trim()).filter(Boolean).slice(0, 20);
      const results = await Promise.allSettled(codes.map(fetchYahooStock));
      const data = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { code: codes[i], error: r.reason.message, price: null, changeRate: 0 }
      );
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }

    // 종목 검색
    if (pathname === '/api/search' && query.query) {
      const data = await searchStock(query.query);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }

    // 헬스체크
    if (pathname === '/api/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'STOCKLAB PRO 서버 정상', port: PORT }));
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
  console.log(`STOCKLAB PRO 서버 실행중 → http://localhost:${PORT}`);
});
