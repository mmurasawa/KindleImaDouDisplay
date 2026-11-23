/**
 * app.js — Kindle 7th gen (E-Ink 白黒・古い WebKit) 完全互換版
 * ES5 + XMLHttpRequest のみで実装
 */

(function () {
  'use strict';

  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  // E-Ink で文字化けしない漢字ラベルを使用
  var WMO = {
    0:  { icon: '快晴', text: '快晴',           rain: false },
    1:  { icon: '晴',   text: '晴れ',           rain: false },
    2:  { icon: '晴曇', text: 'くもり時々晴れ', rain: false },
    3:  { icon: '曇',   text: '曇り',           rain: false },
    45: { icon: '霧',   text: '霧',             rain: false },
    48: { icon: '霧',   text: '霧',             rain: false },
    51: { icon: '霧雨', text: '弱い霧雨',       rain: true },
    53: { icon: '霧雨', text: '霧雨',           rain: true },
    55: { icon: '霧雨', text: '強い霧雨',       rain: true },
    61: { icon: '小雨', text: '小雨',           rain: true },
    63: { icon: '雨',   text: '雨',             rain: true },
    65: { icon: '大雨', text: '大雨',           rain: true },
    71: { icon: '小雪', text: '小雪',           snow: true },
    73: { icon: '雪',   text: '雪',             snow: true },
    75: { icon: '大雪', text: '大雪',           snow: true },
    77: { icon: '霰',   text: '霰',             snow: true },
    80: { icon: '雨',   text: 'にわか雨',       rain: true },
    81: { icon: '強雨', text: '強いにわか雨',   rain: true },
    82: { icon: '豪雨', text: '激しいにわか雨', rain: true },
    85: { icon: '雪',   text: 'にわか雪',       snow: true },
    86: { icon: '強雪', text: '強いにわか雪',   snow: true },
    95: { icon: '雷雨', text: '雷雨',           rain: true },
    96: { icon: '雷雨', text: '雷雨',           rain: true },
    99: { icon: '雷雨', text: '激しい雷雨',     rain: true }
  };

  var lastDeparturesData = null;
  var clockOffsetMs = 0; // サーバー時刻 (NTP) と Kindle 本体時計の差分

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function getJson(url, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    xhr.open('GET', url + sep + '_t=' + new Date().getTime(), true);
    xhr.timeout = 12000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          onSuccess(JSON.parse(xhr.responseText));
        } catch (e) {
          if (onError) onError(e);
        }
      } else {
        if (onError) onError(new Error('HTTP ' + xhr.status));
      }
    };
    xhr.onerror = function () { if (onError) onError(new Error('Network error')); };
    xhr.ontimeout = function () { if (onError) onError(new Error('Timeout')); };
    xhr.send();
  }

  // ============================================================
  // 設定読み込み（地点名・アメッシュピン座標）
  // ============================================================
  function fetchConfig() {
    getJson('/api/config', function (cfg) {
      var pin = byId('amesh-pin');
      var lbl = byId('amesh-pin-label');
      if (pin) {
        if (typeof cfg.ameshPinX === 'number') pin.style.left = cfg.ameshPinX + '%';
        if (typeof cfg.ameshPinY === 'number') pin.style.top  = cfg.ameshPinY + '%';
      }
      if (lbl && cfg.locationLabel) {
        lbl.textContent = '● ' + cfg.locationLabel;
      }
      if (typeof cfg.serverNowMs === 'number') {
        clockOffsetMs = cfg.serverNowMs - new Date().getTime();
        updateClock();
      }
    });
  }

  function syncServerTime() {
    getJson('/api/time', function (data) {
      if (data && typeof data.nowMs === 'number') {
        clockOffsetMs = data.nowMs - new Date().getTime();
        updateClock();
      }
    });
  }

  // サーバー時刻 (NTP 同期) 基準で常に正確な日本時間 (JST = UTC+9) を返す
  function getJstNow() {
    var d = new Date(new Date().getTime() + clockOffsetMs + 9 * 60 * 60 * 1000);
    return {
      year:  d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      date:  d.getUTCDate(),
      day:   d.getUTCDay(),
      hour:  d.getUTCHours(),
      min:   d.getUTCMinutes(),
      totalMin: d.getUTCHours() * 60 + d.getUTCMinutes()
    };
  }

  // ============================================================
  // 時計（30秒ごとに更新・E-Ink 省電力・JST 固定）
  // ============================================================
  function updateClock() {
    var now = getJstNow();
    var timeEl = byId('clock-time');
    var dateEl = byId('clock-date');
    if (timeEl) {
      timeEl.textContent = pad2(now.hour) + ':' + pad2(now.min);
    }
    if (dateEl) {
      dateEl.textContent =
        now.month + '/' + now.date + '(' + WEEKDAYS[now.day] + ')';
    }
    if (lastDeparturesData) {
      renderDepartures(lastDeparturesData);
    }
  }

  // ============================================================
  // 天気・今の降水状況 & 2時間ごと予報
  // ============================================================
  function fetchWeather() {
    getJson('/api/weather', function (data) {
      renderWeather(data);
    }, function () {
      var stateEl = byId('rain-state');
      var metaEl  = byId('rain-meta');
      if (stateEl) stateEl.textContent = '天気を取得できません';
      if (metaEl)  metaEl.textContent  = '通信を確認してください';
    });
  }

  function renderWeather(data) {
    var c = data && data.current;
    var h = data && data.hourly;
    if (!c) return;

    var info = WMO[c.weather_code] || { icon: '不明', text: '不明', rain: false };
    var precip = Number(c.precipitation || 0);
    var temp = Math.round(Number(c.temperature_2m || 0));

    var prob = '--';
    if (h && h.time && h.precipitation_probability) {
      var nowHour = getJstNow().hour;
      if (nowHour < h.precipitation_probability.length) {
        prob = h.precipitation_probability[nowHour];
      }
    }

    var banner  = byId('rain-banner');
    var stateEl = byId('rain-state');
    var metaEl  = byId('rain-meta');

    if (info.snow) {
      banner.className = 'rain-banner is-raining';
      stateEl.textContent = '【雪】いま雪が降っています';
    } else if (precip > 0 || info.rain) {
      banner.className = 'rain-banner is-raining';
      stateEl.textContent = '【雨】いま雨が降っています';
    } else {
      banner.className = 'rain-banner';
      stateEl.textContent = 'いま雨は降っていません';
    }

    metaEl.textContent =
      temp + '℃ / ' + info.text + ' / 降水量 ' + precip.toFixed(1) + 'mm (確率 ' + prob + '%)';

    renderForecast(h);
  }

  function renderForecast(h) {
    var row = byId('forecast-row');
    if (!row) return;
    if (!h || !h.time || !h.temperature_2m || !h.weather_code || !h.precipitation_probability) {
      row.innerHTML = '<div class="fc-empty">予報データなし</div>';
      return;
    }

    var jst = getJstNow();
    var nowKey =
      jst.year + '-' + pad2(jst.month) + '-' + pad2(jst.date) + 'T' + pad2(jst.hour) + ':' + pad2(jst.min);
    var startIdx = 0;
    for (var i = 0; i < h.time.length; i++) {
      if (h.time[i] > nowKey) {
        startIdx = i;
        break;
      }
    }

    var rowsHtml = '';
    var count = 0;
    for (var idx = startIdx + 1; idx < h.time.length && count < 5; idx += 2) {
      var hr = parseInt(h.time[idx].split('T')[1].slice(0, 2), 10);
      var w = WMO[h.weather_code[idx]] || { icon: '--' };
      var t = Math.round(Number(h.temperature_2m[idx]));
      var p = h.precipitation_probability[idx];

      rowsHtml +=
        '<tr>' +
          '<td class="fc-c-time">' + hr + '時</td>' +
          '<td class="fc-c-icon">' + w.icon + '</td>' +
          '<td class="fc-c-temp">' + t + '℃</td>' +
          '<td class="fc-c-prob">' + p + '%</td>' +
        '</tr>';
      count++;
    }

    row.innerHTML = rowsHtml
      ? '<table class="fc-row-tbl" cellspacing="0" cellpadding="0">' + rowsHtml + '</table>'
      : '<div class="fc-empty">予報データなし</div>';
  }

  // ============================================================
  // 東京アメッシュ雨雲画像
  // ============================================================
  function fetchAmesh() {
    var errEl = byId('amesh-err');
    getJson('/api/amesh/latest', function (data) {
      var meshImg = byId('amesh-mesh');
      var timeEl  = byId('amesh-time');
      if (errEl) errEl.style.display = 'none';
      if (meshImg && data.meshUrl) {
        meshImg.onload = function () { meshImg.style.display = 'block'; };
        meshImg.src = data.meshUrl;
      }
      if (timeEl && data.timeLabel) {
        timeEl.textContent = 'アメッシュ (' + data.timeLabel + ')';
      }
    }, function () {
      var timeEl = byId('amesh-time');
      if (timeEl) timeEl.textContent = 'アメッシュ取得エラー';
      if (errEl) errEl.style.display = 'block';
    });
  }

  // ============================================================
  // 次の発車案内
  // ============================================================
  function calcMinutesUntil(hhmm) {
    var parts = String(hhmm).split(':');
    if (parts.length !== 2) return null;
    var jst = getJstNow();
    var targetMin = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    var diff = targetMin - jst.totalMin;
    if (diff < -720) diff += 1440;
    return diff;
  }

  function fetchDepartures() {
    getJson('/api/departures', function (data) {
      lastDeparturesData = data;
      renderDepartures(data);
    }, function () {
      var wrap = byId('departures-wrap');
      if (wrap && !lastDeparturesData) {
        wrap.innerHTML = '<div class="dep-card"><div class="dep-placeholder">発車時刻を取得できませんでした</div></div>';
      }
    });
  }

  function renderDepartures(data) {
    var wrap = byId('departures-wrap');
    if (!wrap || !data || !data.routes) return;

    var html = '';
    for (var i = 0; i < data.routes.length; i++) {
      var route = data.routes[i];
      var deps = route.departures || [];
      var upcoming = [];

      for (var j = 0; j < deps.length; j++) {
        var d = deps[j];
        var diff = calcMinutesUntil(d.depTime);
        if (diff === null || diff >= 0) {
          upcoming.push({
            depTime:  d.depTime,
            arrTime:  d.arrTime,
            duration: d.duration,
            lineText: d.lineText,
            diff:     diff
          });
        }
        if (upcoming.length >= 3) break;
      }

      var bodyHtml = '';
      if (upcoming.length === 0) {
        bodyHtml = '<div class="dep-placeholder">本日の案内終了 / データなし</div>';
      } else {
        var rows = '';
        for (var k = 0; k < upcoming.length; k++) {
          var item = upcoming[k];
          var isFirst = (k === 0);
          var minText = '';
          if (item.diff !== null) {
            minText = item.diff === 0 ? 'まもなく' : ('あと' + item.diff + '分');
          }
          rows +=
            '<tr class="' + (isFirst ? 'dep-row-first' : 'dep-row-sub') + '">' +
              '<td class="dep-c-time">' + item.depTime + '</td>' +
              '<td class="dep-c-min">' + (minText ? '<span class="min-badge">' + minText + '</span>' : '') + '</td>' +
              '<td class="dep-c-dest">' +
                (item.lineText || '') +
                '<span class="dep-arr">' + item.arrTime + '着' + (item.duration ? ' (' + item.duration + ')' : '') + '</span>' +
              '</td>' +
            '</tr>';
        }
        bodyHtml = '<table class="dep-list-tbl" cellspacing="0" cellpadding="0">' + rows + '</table>';
      }

      html +=
        '<div class="dep-card">' +
          '<table class="dep-head-tbl" cellspacing="0" cellpadding="0"><tr>' +
            '<td class="dep-title">' + route.title + '</td>' +
            '<td class="dep-line">' + route.line + '</td>' +
          '</tr></table>' +
          bodyHtml +
        '</div>';
    }

    wrap.innerHTML = html;
  }

  // ============================================================
  // 運行情報（主要路線はヘッダー / 異常時は下段に詳細）
  // ============================================================
  function fetchTrains() {
    getJson('/api/trains', function (data) {
      renderTrains(data);
    }, function () {
      var body = byId('other-trains-body');
      if (body) body.textContent = '運行情報を取得できませんでした';
    });
  }

  function renderTrains(data) {
    if (!data || !data.lines) return;

    var primaryHtml = '';
    var issueItems = [];

    for (var i = 0; i < data.lines.length; i++) {
      var l = data.lines[i];
      var lvl = l.status ? l.status.level : 'unknown';
      var txt = l.status ? l.status.text : '不明';

      if (l.primary) {
        var alertCls = (lvl !== 'normal') ? ' pill-alert' : '';
        primaryHtml += '<span class="pill' + alertCls + '">' + l.name + ':' + txt + '</span>';
      }
      if (lvl !== 'normal') {
        issueItems.push({ name: l.name, text: txt, detail: l.detail || '' });
      }
    }

    var primaryEl = byId('primary-status-list');
    if (primaryEl && primaryHtml) {
      primaryEl.innerHTML = primaryHtml;
    }

    var otherBox  = byId('other-trains');
    var otherBody = byId('other-trains-body');
    if (otherBox && otherBody) {
      if (issueItems.length === 0) {
        otherBox.className = 'other-trains';
        otherBody.innerHTML = 'メトロ・都営 全線平常運転';
      } else {
        otherBox.className = 'other-trains has-issue';
        var html = '';
        for (var j = 0; j < issueItems.length; j++) {
          var it = issueItems[j];
          html +=
            '<div class="issue-line">' +
              '<span>【' + it.name + ' ' + it.text + '】</span>' +
              (it.detail ? '<span class="issue-detail">' + it.detail + '</span>' : '') +
            '</div>';
        }
        otherBody.innerHTML = html;
      }
    }
  }

  // ============================================================
  // 更新制御
  // ============================================================
  function refreshAll() {
    fetchConfig();
    updateClock();
    fetchWeather();
    fetchAmesh();
    fetchDepartures();
    fetchTrains();
  }

  function init() {
    var reloadBtn = byId('reload-btn');
    if (reloadBtn) {
      reloadBtn.onclick = function () { refreshAll(); };
    }
    var mapImg = byId('amesh-map');
    if (mapImg) {
      mapImg.onerror = function () {
        var errEl = byId('amesh-err');
        if (errEl) errEl.style.display = 'block';
      };
    }

    refreshAll();

    // 時計 & あと〇分の再描画: 30秒ごと
    setInterval(updateClock, 30 * 1000);
    // 発車案内 & アメッシュ: 1分ごと
    setInterval(function () {
      fetchDepartures();
      fetchAmesh();
    }, 60 * 1000);
    // 天気 & 運行情報 & サーバー時刻再同期: 3分ごと
    setInterval(function () {
      syncServerTime();
      fetchWeather();
      fetchTrains();
    }, 3 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
