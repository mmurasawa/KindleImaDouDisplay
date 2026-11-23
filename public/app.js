/**
 * app.js — Kindle 7th gen サイネージ（超軽量・古いWebView完全互換版）
 * ES5 + XMLHttpRequest のみで実装（async/await, fetch, padStart 不使用）
 */

(function () {
  'use strict';

  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  var WMO = {
    0:  { icon: '☀',  text: '快晴',           rain: false },
    1:  { icon: '☀',  text: '晴れ',           rain: false },
    2:  { icon: '⛅', text: 'くもり時々晴れ', rain: false },
    3:  { icon: '☁',  text: '曇り',           rain: false },
    45: { icon: '☁',  text: '霧',             rain: false },
    48: { icon: '☁',  text: '霧',             rain: false },
    51: { icon: '☔', text: '弱い霧雨',       rain: true },
    53: { icon: '☔', text: '霧雨',           rain: true },
    55: { icon: '☔', text: '強い霧雨',       rain: true },
    61: { icon: '☔', text: '小雨',           rain: true },
    63: { icon: '☔', text: '雨',             rain: true },
    65: { icon: '☔', text: '大雨',           rain: true },
    71: { icon: '❄',  text: '小雪',           snow: true },
    73: { icon: '❄',  text: '雪',             snow: true },
    75: { icon: '❄',  text: '大雪',           snow: true },
    77: { icon: '❄',  text: '霰',             snow: true },
    80: { icon: '☔', text: 'にわか雨',       rain: true },
    81: { icon: '☔', text: '強いにわか雨',   rain: true },
    82: { icon: '☔', text: '激しいにわか雨', rain: true },
    85: { icon: '❄',  text: 'にわか雪',       snow: true },
    86: { icon: '❄',  text: '強いにわか雪',   snow: true },
    95: { icon: '⚡', text: '雷雨',           rain: true },
    96: { icon: '⚡', text: '雷雨',           rain: true },
    99: { icon: '⚡', text: '激しい雷雨',     rain: true }
  };

  var lastDeparturesData = null;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function getJson(url, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 12000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var data = JSON.parse(xhr.responseText);
          onSuccess(data);
        } catch (e) {
          if (onError) onError(e);
        }
      } else {
        if (onError) onError(new Error('HTTP ' + xhr.status));
      }
    };
    xhr.onerror = function () {
      if (onError) onError(new Error('Network error'));
    };
    xhr.ontimeout = function () {
      if (onError) onError(new Error('Timeout'));
    };
    xhr.send();
  }

  // ============================================================
  // 時計（15秒ごとに更新・低負荷）
  // ============================================================
  function updateClock() {
    var now = new Date();
    var timeEl = byId('clock-time');
    var dateEl = byId('clock-date');
    if (timeEl) {
      timeEl.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    }
    if (dateEl) {
      dateEl.textContent =
        (now.getMonth() + 1) + '/' + now.getDate() + ' (' + WEEKDAYS[now.getDay()] + ')';
    }
    if (lastDeparturesData) {
      renderDepartures(lastDeparturesData);
    }
  }

  // ============================================================
  // 天気・今の降水状況
  // ============================================================
  function fetchWeather() {
    getJson('/api/weather', function (data) {
      renderWeather(data);
    }, function () {
      var banner = byId('rain-banner');
      var stateEl = byId('rain-state');
      var metaEl  = byId('rain-meta');
      if (banner)  banner.className = 'rain-banner';
      if (stateEl) stateEl.textContent = '天気を取得できません';
      if (metaEl)  metaEl.textContent  = '通信を確認してください';
    });
  }

  function renderWeather(data) {
    var c = data && data.current;
    var h = data && data.hourly;
    if (!c) return;

    var info = WMO[c.weather_code] || { text: '不明', rain: false };
    var precip = Number(c.precipitation || 0);
    var temp = Math.round(Number(c.temperature_2m || 0));

    // 現在時刻に最も近い降水確率を取得
    var prob = '--';
    if (h && h.time && h.precipitation_probability) {
      var nowHour = new Date().getHours();
      if (nowHour < h.precipitation_probability.length) {
        prob = h.precipitation_probability[nowHour];
      }
    }

    var banner  = byId('rain-banner');
    var stateEl = byId('rain-state');
    var metaEl  = byId('rain-meta');

    if (info.snow) {
      banner.className = 'rain-banner is-raining';
      stateEl.textContent = 'いま雪が降っています';
    } else if (precip > 0 || info.rain) {
      banner.className = 'rain-banner is-raining';
      stateEl.textContent = 'いま雨が降っています';
    } else {
      banner.className = 'rain-banner is-dry';
      stateEl.textContent = 'いま雨は降っていません';
    }

    metaEl.textContent =
      temp + '℃  /  ' + info.text + '  /  降水量 ' + precip.toFixed(1) + 'mm (確率 ' + prob + '%)';

    renderForecast(h);
  }

  function renderForecast(h) {
    var row = byId('forecast-row');
    if (!row) return;
    if (!h || !h.time || !h.temperature_2m || !h.weather_code || !h.precipitation_probability) {
      row.innerHTML = '<div class="fc-empty">予報データなし</div>';
      return;
    }

    var nowMs = new Date().getTime();
    var startIdx = 0;
    for (var i = 0; i < h.time.length; i++) {
      // "YYYY-MM-DDTHH:MM" をローカル時刻として解釈
      var tParts = h.time[i].split('T');
      var dParts = tParts[0].split('-');
      var hmParts = tParts[1].split(':');
      var dt = new Date(
        parseInt(dParts[0], 10),
        parseInt(dParts[1], 10) - 1,
        parseInt(dParts[2], 10),
        parseInt(hmParts[0], 10),
        parseInt(hmParts[1], 10),
        0
      );
      if (dt.getTime() > nowMs) {
        startIdx = i;
        break;
      }
    }

    var html = '';
    var count = 0;
    for (var idx = startIdx + 1; idx < h.time.length && count < 5; idx += 2) {
      var hr = h.time[idx].split('T')[1].slice(0, 2);
      var w = WMO[h.weather_code[idx]] || { icon: '☁', text: '不明' };
      var t = Math.round(Number(h.temperature_2m[idx]));
      var p = h.precipitation_probability[idx];

      html +=
        '<div class="fc-item">' +
          '<div class="fc-time">' + parseInt(hr, 10) + '時</div>' +
          '<div class="fc-icon">' + w.icon + '</div>' +
          '<div class="fc-temp">' + t + '℃</div>' +
          '<div class="fc-prob">' + p + '%</div>' +
        '</div>';
      count++;
    }
    row.innerHTML = html || '<div class="fc-empty">予報データなし</div>';
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
        meshImg.onload = function () {
          meshImg.style.display = 'block';
        };
        meshImg.src = data.meshUrl;
      }
      if (timeEl && data.timeLabel) {
        timeEl.textContent = '東京アメッシュ (' + data.timeLabel + ' 観測)';
      }
    }, function () {
      var timeEl = byId('amesh-time');
      if (timeEl) timeEl.textContent = '東京アメッシュ 取得エラー';
      if (errEl) errEl.style.display = 'block';
    });
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
    });
  }

  // ============================================================
  // 次の発車案内
  // ============================================================
  function calcMinutesUntil(hhmm) {
    var parts = String(hhmm).split(':');
    if (parts.length !== 2) return null;
    var now = new Date();
    var target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      parseInt(parts[0], 10),
      parseInt(parts[1], 10),
      0
    );
    var diff = Math.ceil((target.getTime() - now.getTime()) / 60000);
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

      var rowsHtml = '';
      if (upcoming.length === 0) {
        rowsHtml = '<div class="dep-placeholder">本日の案内終了 / データなし</div>';
      } else {
        for (var k = 0; k < upcoming.length; k++) {
          var item = upcoming[k];
          var isFirst = (k === 0);
          var minText = '';
          var soonCls = '';
          if (item.diff !== null) {
            minText = item.diff === 0 ? 'まもなく' : ('あと' + item.diff + '分');
            if (item.diff <= 4) soonCls = ' soon';
          }
          rowsHtml +=
            '<div class="dep-row' + (isFirst ? ' dep-first' : '') + '">' +
              '<div class="dep-left">' +
                '<span class="dep-time">' + item.depTime + '</span>' +
                (minText ? '<span class="dep-min' + soonCls + '">' + minText + '</span>' : '') +
              '</div>' +
              '<div class="dep-right">' +
                '<div class="dep-dest">' + (item.lineText || '') + '</div>' +
                '<div class="dep-arr">' + item.arrTime + '着' + (item.duration ? ' (' + item.duration + ')' : '') + '</div>' +
              '</div>' +
            '</div>';
        }
      }

      html +=
        '<div class="dep-card" style="border-left-color:' + route.color + ';">' +
          '<div class="dep-card-head">' +
            '<span class="dep-title">' + route.title + '</span>' +
            '<span class="dep-line">' + route.line + '</span>' +
          '</div>' +
          rowsHtml +
        '</div>';
    }

    wrap.innerHTML = html;
  }

  // ============================================================
  // 運行情報（有楽町線・大江戸線は常時 / 他は異常時のみ）
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
        primaryHtml +=
          '<span class="status-pill status-' + lvl + '">' +
            l.name + ': ' + txt +
          '</span>';
      }
      if (lvl !== 'normal') {
        issueItems.push({
          name:   l.name,
          text:   txt,
          detail: l.detail || ''
        });
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
        otherBody.innerHTML = 'その他メトロ・都営 全線平常運転';
      } else {
        otherBox.className = 'other-trains has-issue';
        var html = '';
        for (var j = 0; j < issueItems.length; j++) {
          var it = issueItems[j];
          html +=
            '<div class="issue-line">' +
              '<span class="issue-name">' + it.name + '（' + it.text + '）</span>' +
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
    updateClock();
    fetchWeather();
    fetchAmesh();
    fetchDepartures();
    fetchTrains();
  }

  function init() {
    var reloadBtn = byId('reload-btn');
    if (reloadBtn) {
      reloadBtn.onclick = function () {
        fetchConfig();
    refreshAll();
      };
    }

    var mapImg = byId('amesh-map');
    if (mapImg) {
      mapImg.onerror = function () {
        var errEl = byId('amesh-err');
        if (errEl) errEl.style.display = 'block';
      };
    }

    fetchConfig();
    refreshAll();

    // 時計 & あと〇分の再描画: 15秒ごと
    setInterval(updateClock, 15 * 1000);
    // 発車案内 & アメッシュ最新チェック: 1分ごと
    setInterval(function () {
      fetchDepartures();
      fetchAmesh();
    }, 60 * 1000);
    // 天気 & 運行情報: 3分ごと
    setInterval(function () {
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
