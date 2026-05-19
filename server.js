const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function get(targetUrl) {
  return new Promise((resolve, reject) => {
    const u = url.parse(targetUrl);
    const opts = {
      hostname: u.hostname,
      path: u.path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
    };
    const req = https.request(opts, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve(data); });
    });
    req.on('error', reject);
    req.setTimeout(10000, function() { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

var nameMap = {
  '005930': '삼성전자', '000660': 'SK하이닉스', '005380': '현대차',
  '035420': 'NAVER', '068270': '셀트리온', '247540': '에코프로비엠',
  '005490': 'POSCO홀딩스', '000270': '기아', '105560': 'KB금융',
  '055550': '신한지주', '086790': '하나금융지주', '035720': '카카오',
  '259960': '크래프톤', '011200': 'HMM', '051910': 'LG화학',
  '006400': '삼성SDI', '207940': '삼성바이오로직스', '003550': 'LG',
  '017670': 'SK텔레콤', '030200': 'KT', '009150': '삼성전기'
};

function fetchStock(code) {
  var symbol = code + '.KS';
  return get('https://stooq.com/q/d/l/?s=' + symbol + '&i=d').then(function(body) {
    var lines = body.trim().split('\n');
    if (lines.length < 2) {
      return get('https://stooq.com/q/d/l/?s=' + code + '.KQ&i=d').then(function(body2) {
        var lines2 = body2.trim().split('\n');
        if (lines2.length < 2) throw new Error('데이터 없음');
        return parseStooq(code, lines2);
      });
    }
    return parseStooq(code, lines);
  });
}

function parseStooq(code, lines) {
  var latest = lines[lines.length - 1].split(',');
  var prev = lines.length > 2 ? lines[lines.length - 2].split(',') : null;
  var close = parseFloat(latest[4]);
  var prevClose = prev ? parseFloat(prev[4]) : close;
  if (!close || isNaN(close)) throw new Error('파싱 실패');
  var changeRate = Math.round((close - prevClose) / prevClose * 10000) / 100;
  var volume = latest[5] ? parseInt(latest[5]) : 0;
  return {
    code: code,
    name: nameMap[code] || code,
    price: Math.round(close),
    changeRate: changeRate,
    volume: volume ? volume.toLocaleString() : '-',
    marketCap: '-',
    updatedAt: new Date().toLocaleTimeString('ko-KR'),
    source: 'stooq'
  };
}

function searchStock(query) {
  var results = [];
  var keys = Object.keys(nameMap);
  for (var i = 0; i < keys.length; i++) {
    var code = keys[i];
    var name = nameMap[code];
    if (name.indexOf(query) !== -1 || code.indexOf(query) !== -1) {
      results.push({ code: code, name: name, market: parseInt(code) < 200000 ? 'KOSPI' : 'KOSDAQ' });
    }
  }
  return results.slice(0, 8);
}

var server = http.createServer(function(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;
  var query = parsed.query;

  if (pathname === '/' || pathname === '/index.html') {
    var htmlPath = path.join(__dirname, 'stocklab-pro.html');
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

  if (pathname === '/api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, message: 'STOCKLAB PRO 정상' }));
    return;
  }

  if (pathname === '/api/stock' && query.code) {
    fetchStock(query.code.trim()).then(function(data) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data: data }));
    }).catch(function(err) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  if (pathname === '/api/stocks' && query.codes) {
    var codes = query.codes.split(',').map(function(c) { return c.trim(); }).filter(Boolean).slice(0, 20);
    var promises = codes.map(function(c) {
      return fetchStock(c).then(function(d) { return { status: 'ok', data: d }; }).catch(function(e) { return { status: 'err', code: c, error: e.message }; });
    });
    Promise.all(promises).then(function(results) {
      var data = results.map(function(r) {
        return r.status === 'ok' ? r.data : { code: r.code, name: nameMap[r.code] || r.code, error: r.error, price: null, changeRate: 0 };
      });
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, data: data }));
    });
    return;
  }

  if (pathname === '/api/search' && query.query) {
    var data = searchStock(query.query);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, data: data }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: '없는 경로' }));
});

server.listen(PORT, function() {
  console.log('STOCKLAB PRO 서버 실행중 -> http://localhost:' + PORT);
});
