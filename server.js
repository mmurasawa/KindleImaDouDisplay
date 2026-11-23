/**
 * Kindle 7th gen サイネージ サーバー（超軽量・環境変数設定対応版）
 * - 今の天気/降水: Open-Meteo API（無料・APIキー不要）
 * - 雨雲レーダー:  東京アメッシュ（地図・メッシュ画像をプロキシ＆キャッシュ）
 * - 次発案内:      Yahoo! 乗換案内（環境変数 DEPARTURE_ROUTES_JSON で設定）
 * - 運行情報:      Yahoo! 路線情報（東京メトロ・都営地下鉄）
 */

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');
const path    = require('path');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// 環境変数による設定（デフォルトは汎用的な東京駅周辺）
// ============================================================
const WEATHER_LAT    = parseFloat(process.env.WEATHER_LAT || '35.6812');
const WEATHER_LON    = parseFloat(process.env.WEATHER_LON || '139.7671');
const LOCATION_LABEL = process.env.LOCATION_LABEL || '東京';
const AMESH_PIN_X    = parseFloat(process.env.AMESH_PIN_X || '62');
const AMESH_PIN_Y    = parseFloat(process.env.AMESH_PIN_Y || '43');

const PRIMARY_LINE_NAMES = (process.env.PRIMARY_LINES || '丸ノ内線,大江戸線')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DEFAULT_ROUTES = [
  {
    id:    'route1',
    from:  '東京',
    to:    '新宿',
    title: '東京 → 新宿',
    line:  '中央線・丸ノ内線',
    color: '#e60012',
  },
];

function loadDepartureRoutes() {
  if (!process.env.DEPARTURE_ROUTES_JSON) return DEFAULT_ROUTES;
  try {
    const parsed = JSON.parse(process.env.DEPARTURE_ROUTES_JSON);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch (e) {
    console.error('DEPARTURE_ROUTES_JSON のパースに失敗しました:', e.message);
  }
  return DEFAULT_ROUTES;
}

const DEPARTURE_ROUTES = loadDepartureRoutes();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ============================================================
// 0. フロントエンド用設定 & サーバー時刻（TrueNAS の NTP 同期時刻）
// ============================================================
app.get('/api/config', (req, res) => {
  res.json({
    locationLabel: LOCATION_LABEL,
    ameshPinX:     AMESH_PIN_X,
    ameshPinY:     AMESH_PIN_Y,
    serverNowMs:   Date.now(),
  });
});

app.get('/api/time', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ nowMs: Date.now() });
});

// ============================================================
// 1. 天気・今の降水状況（Open-Meteo・3分キャッシュ）
// ============================================================
let weatherCache     = null;
let weatherCacheTime = 0;
const WEATHER_TTL    = 3 * 60 * 1000;

app.get('/api/weather', async (req, res) => {
  try {
    if (weatherCache && Date.now() - weatherCacheTime < WEATHER_TTL) {
      return res.json(weatherCache);
    }
    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude:      WEATHER_LAT,
        longitude:     WEATHER_LON,
        current:       'temperature_2m,precipitation,rain,showers,weather_code',
        hourly:        'temperature_2m,precipitation_probability,weather_code',
        timezone:      'Asia/Tokyo',
        forecast_days: 2,
      },
      timeout: 10000,
    });
    weatherCache     = response.data;
    weatherCacheTime = Date.now();
    res.json(weatherCache);
  } catch (error) {
    if (weatherCache) return res.json(weatherCache);
    res.status(500).json({ error: '天気取得エラー', details: error.message });
  }
});

// ============================================================
// 2. 東京アメッシュ（プロキシ＆キャッシュ）
// ============================================================
let ameshIndexCache     = null;
let ameshIndexCacheTime = 0;
const AMESH_INDEX_TTL   = 60 * 1000;

let ameshMapBuf  = null;
let ameshMaskBuf = null;

app.get('/api/amesh/latest', async (req, res) => {
  try {
    if (ameshIndexCache && Date.now() - ameshIndexCacheTime < AMESH_INDEX_TTL) {
      return res.json(ameshIndexCache);
    }
    const r = await axios.get('https://tokyo-ame.jwa.or.jp/scripts/mesh_index.js', {
      timeout: 8000,
      responseType: 'text',
    });
    const m = r.data.match(/"(\d{12})"/);
    if (!m) throw new Error('アメッシュのタイムスタンプ解析に失敗');
    const stamp = m[1];
    const hh = stamp.slice(8, 10);
    const mm = stamp.slice(10, 12);

    ameshIndexCache = {
      stamp,
      timeLabel: `${hh}:${mm}`,
      meshUrl:   `/api/amesh/mesh/${stamp}`,
    };
    ameshIndexCacheTime = Date.now();
    res.json(ameshIndexCache);
  } catch (error) {
    if (ameshIndexCache) return res.json(ameshIndexCache);
    res.status(500).json({ error: 'アメッシュ取得エラー', details: error.message });
  }
});

app.get('/api/amesh/map', async (req, res) => {
  try {
    if (!ameshMapBuf) {
      const r = await axios.get('https://tokyo-ame.jwa.or.jp/map/map000.jpg', {
        timeout: 10000,
        responseType: 'arraybuffer',
      });
      ameshMapBuf = Buffer.from(r.data);
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(ameshMapBuf);
  } catch (error) {
    res.status(502).end();
  }
});

app.get('/api/amesh/mask', async (req, res) => {
  try {
    if (!ameshMaskBuf) {
      const r = await axios.get('https://tokyo-ame.jwa.or.jp/map/msk000.png', {
        timeout: 10000,
        responseType: 'arraybuffer',
      });
      ameshMaskBuf = Buffer.from(r.data);
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(ameshMaskBuf);
  } catch (error) {
    res.status(502).end();
  }
});

app.get('/api/amesh/mesh/:stamp', async (req, res) => {
  const { stamp } = req.params;
  if (!/^\d{12}$/.test(stamp)) return res.status(400).end();
  try {
    const r = await axios.get(`https://tokyo-ame.jwa.or.jp/mesh/000/${stamp}.gif`, {
      timeout: 8000,
      responseType: 'arraybuffer',
    });
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(Buffer.from(r.data));
  } catch (error) {
    res.status(502).end();
  }
});

// ============================================================
// 3. 次発案内（Yahoo! 乗換案内・1分キャッシュ）
// ============================================================
let depCache     = null;
let depCacheTime = 0;
const DEP_TTL    = 60 * 1000;

async function fetchSingleRoute(route) {
  const url = `https://transit.yahoo.co.jp/search/result?from=${encodeURIComponent(route.from)}&to=${encodeURIComponent(route.to)}`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9' },
    timeout: 12000,
  });

  const $ = cheerio.load(res.data);
  const items = [];
  const seenTimes = new Set();

  $('#rsltlst > li').each((i, el) => {
    const timeText = $(el).find('.time').text().replace(/\s+/g, ' ').trim();
    const m = timeText.match(/(\d{2}:\d{2}).*?(\d{2}:\d{2})/);
    if (!m) return;

    const depTime = m[1];
    const arrTime = m[2];
    if (seenTimes.has(depTime)) return;
    seenTimes.add(depTime);

    const restText = timeText.slice(m.index + m[0].length);
    const durMatch = restText.match(/(?:\d+時間)?\d+分/);
    const duration = durMatch ? durMatch[0] : '';

    const routeId = `#route0${i + 1}`;
    const firstAccess = $(routeId).find('.routeDetail .access').first();
    let lineText = firstAccess.find('.transport').text().replace(/\s+/g, ' ').trim();
    if (!lineText) {
      lineText = firstAccess.text().replace(/\s+/g, ' ').trim().split('[発]')[0].trim();
    }
    lineText = lineText
      .replace(/^東京メトロ/, '')
      .replace(/^都営/, '');

    items.push({ depTime, arrTime, duration, lineText });
  });

  return {
    id:         route.id || route.from,
    title:      route.title || `${route.from} → ${route.to}`,
    line:       route.line || '',
    color:      route.color || '#38bdf8',
    departures: items.slice(0, 3),
    error:      null,
  };
}

app.get('/api/departures', async (req, res) => {
  try {
    if (depCache && Date.now() - depCacheTime < DEP_TTL) {
      return res.json(depCache);
    }
    const routes = await Promise.all(
      DEPARTURE_ROUTES.map(r =>
        fetchSingleRoute(r).catch(err => ({
          id: r.id || r.from,
          title: r.title || `${r.from} → ${r.to}`,
          line: r.line || '',
          color: r.color || '#38bdf8',
          departures: [],
          error: err.message,
        }))
      )
    );
    depCache     = { routes, fetchedAt: new Date().toISOString() };
    depCacheTime = Date.now();
    res.json(depCache);
  } catch (error) {
    if (depCache) return res.json(depCache);
    res.status(500).json({ error: '発車案内取得エラー', details: error.message });
  }
});

// ============================================================
// 4. 運行情報（Yahoo! 路線情報・完全一致＋異常時詳細取得・3分キャッシュ）
// ============================================================
const ALL_LINES = [
  { name: '有楽町線', exactName: '東京メトロ有楽町線' },
  { name: '大江戸線', exactName: '都営大江戸線' },
  { name: '副都心線', exactName: '東京メトロ副都心線' },
  { name: '銀座線',   exactName: '東京メトロ銀座線' },
  { name: '丸ノ内線', exactName: '東京メトロ丸ノ内線' },
  { name: '日比谷線', exactName: '東京メトロ日比谷線' },
  { name: '東西線',   exactName: '東京メトロ東西線' },
  { name: '千代田線', exactName: '東京メトロ千代田線' },
  { name: '半蔵門線', exactName: '東京メトロ半蔵門線' },
  { name: '南北線',   exactName: '東京メトロ南北線' },
  { name: '浅草線',   exactName: '都営浅草線' },
  { name: '三田線',   exactName: '都営三田線' },
  { name: '新宿線',   exactName: '都営新宿線' },
];

const TARGET_LINES = ALL_LINES.map(l => ({
  name:      l.name,
  exactName: l.exactName,
  primary:   PRIMARY_LINE_NAMES.includes(l.name),
}));

function classifyStatus(text) {
  if (!text) return { level: 'normal', text: '平常' };
  if (text.match(/平常|通常/))       return { level: 'normal',  text: '平常' };
  if (text.match(/運転見合わせ/))    return { level: 'stopped', text: '見合わせ' };
  if (text.match(/遅延/))            return { level: 'delay',   text: '遅延' };
  if (text.match(/一部区間|折返し/)) return { level: 'partial', text: '一部変更' };
  if (text.match(/影響|情報あり/))   return { level: 'check',   text: '情報あり' };
  return { level: 'normal', text: '平常' };
}

let trainCache     = null;
let trainCacheTime = 0;
const TRAIN_TTL    = 3 * 60 * 1000;

async function fetchLineDetail(href) {
  if (!href) return '';
  try {
    const url = href.startsWith('http') ? href : `https://transit.yahoo.co.jp${href}`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9' },
      timeout: 8000,
      responseType: 'text',
    });
    const $ = cheerio.load(res.data);
    let detail = $('#mdServiceStatus dd p').text().replace(/\s+/g, ' ').trim();
    detail = detail.replace(/（\d+月\d+日[^）]*掲載）$/, '').trim();
    return detail;
  } catch (e) {
    return '';
  }
}

async function fetchTrainData() {
  if (trainCache && Date.now() - trainCacheTime < TRAIN_TTL) {
    return trainCache;
  }
  try {
    const response = await axios.get('https://transit.yahoo.co.jp/traininfo/area/4/', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9' },
      timeout: 12000,
      responseType: 'text',
    });
    const $ = cheerio.load(response.data);
    const rowMap = new Map();

    $('tr').each((i, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 2) return;
      const lineName = $(tds[0]).text().replace(/\s+/g, '').trim();
      const statusTxt = $(tds[1]).text().replace(/\s+/g, ' ').trim();
      const summaryTxt = tds.length >= 3 ? $(tds[2]).text().replace(/\s+/g, ' ').trim() : '';
      const href = $(tds[0]).find('a').attr('href') || '';
      if (lineName && !rowMap.has(lineName)) {
        rowMap.set(lineName, { statusTxt, summaryTxt, href });
      }
    });

    const lines = [];
    let detailFetchCount = 0;

    for (const line of TARGET_LINES) {
      const row = rowMap.get(line.exactName);
      const status = row ? classifyStatus(row.statusTxt) : { level: 'normal', text: '平常' };
      let detail = '';

      if (status.level !== 'normal' && row) {
        if (detailFetchCount < 4 && row.href) {
          detailFetchCount++;
          detail = await fetchLineDetail(row.href);
        }
        if (!detail) detail = row.summaryTxt || '';
      }

      lines.push({ name: line.name, primary: line.primary, status, detail });
    }

    trainCache = { lines, fetchedAt: new Date().toISOString(), error: null };
    trainCacheTime = Date.now();
    return trainCache;
  } catch (error) {
    if (trainCache) return Object.assign({}, trainCache, { error: 'キャッシュ表示中' });
    return {
      lines: TARGET_LINES.map(l => ({ name: l.name, primary: l.primary, status: { level: 'unknown', text: '不明' }, detail: '' })),
      fetchedAt: new Date().toISOString(),
      error: error.message,
    };
  }
}

app.get('/api/trains', async (req, res) => {
  const data = await fetchTrainData();
  res.json(data);
});

// ============================================================
// サーバー起動
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  const ips = Object.values(interfaces)
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log('\n=== Kindle サイネージ サーバー 起動完了 ===');
  console.log(`Location: ${LOCATION_LABEL} (${WEATHER_LAT}, ${WEATHER_LON})`);
  console.log(`PC:       http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`Kindle:   http://${ip}:${PORT}`));
  console.log('停止するには Ctrl+C を押してください\n');
});
