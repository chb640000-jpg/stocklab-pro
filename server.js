const https = require('https');
/**
 * STOCKLAB PRO - 프록시 서버 (Railway 배포용)
 * 로컬: node server.js
 * Railway: 자동 실행
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const pathModule = require('path');

const PORT = process.env.PORT || 3000;

// ── CORS 헤더 ──
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── HTTPS GET ──
function httpsGet(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://finance.naver.com'
      }
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', chunk => data += chunk);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── 주가 조회 ──
async function fetchNaverStock(code) {
  const { body } = await httpsGet(`https://finance.naver.com/item/main.naver?code=${code}`);
  const priceMatch = body.match(/id="\_nowVal"[^>]*>([\d,]+)</);
  const changeMatch = body.match(/id="\_rate"[^>]*><span[^>]*>([\d.]+)<\/span>/);
  const signMatch = body.match(/class="(increase|decrease|even)"[^>]*id="\_nowDiff"/);
  const nameMatch = body.match(/<title>([^:]+)\s*:\s*네이버\s*금융/);
  const volMatch = body.match(/거래량<\/em>\s*<span[^>]*>([\d,]+)<\/span>/);
  const capMatch = body.match(/시가총액<\/em>\s*<span[^>]*>([\d,]+)<\/span>/);
  if (!priceMatch) throw new Error('주가 데이터 없음 (종목코드 확인)');
  const sign = signMatch?.[1] === 'decrease' ? -1 : 1;
  return {
    code,
    name: nameMatch?.[1]?.trim() || code,
    price: parseInt(priceMatch[1].replace(/,/g, '')),
    changeRate: sign * parseFloat(changeMatch?.[1] || '0'),
    volume: volMatch?.[1] || '-',
    marketCap: capMatch?.[1] || '-',
    updatedAt: new Date().toLocaleTimeString('ko-KR')
  };
}

// ── 종목 검색 ──
async function searchNaverStock(query) {
  const encoded = encodeURIComponent(query);
  const { body } = await httpsGet(`https://ac.finance.naver.com/ac?q=${encoded}&q_enc=UTF-8&t_koreng=1&st=111&r_lt=111&r_enc=UTF-8`);
  try {
    const json = JSON.parse(body);
    const items = json.items?.[0] || [];
    return items.slice(0, 8).map(item => ({
      name: item[0]?.[0] || '',
      code: item[1]?.[0] || '',
      market: item[3]?.[0] || ''
    })).filter(i => i.code);
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
      res.writeHead(404);
      res.end('stocklab-pro.html 없음');
    }
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    if (pathname === '/api/stock' && query.code) {
      const data = await fetchNaverStock(query.code.trim());
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }
    if (pathname === '/api/stocks' && query.codes) {
      const codes = query.codes.split(',').map(c => c.trim()).filter(Boolean).slice(0, 20);
      const results = await Promise.allSettled(codes.map(fetchNaverStock));
      const data = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { code: codes[i], error: r.reason.message }
      );
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }
    if (pathname === '/api/search' && query.query) {
      const data = await searchNaverStock(query.query);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data }));
      return;
    }
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
