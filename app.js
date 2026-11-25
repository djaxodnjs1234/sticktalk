/* =========================================================
   캐나다 회화 500 — app.js
   - 프레임워크 없이 동작하는 단일 스크립트
   - 학습 데이터는 words.js 의 window.WORDS 배열 (형식은 words.js 상단 주석 참고)
   - 진도는 localStorage 에 저장 (실패하면 메모리에만 저장하고 경고 배너 표시)
   - 음성은 사람 녹음만 사용 (브라우저 음성 합성·AI TTS 사용 안 함)
   ========================================================= */
(function () {
  'use strict';

  /* ---------------------------------------------------------
     0. 설정 상수 — 필요하면 여기만 바꾸면 됨
     --------------------------------------------------------- */
  var CONFIG = {
    APP_VERSION: '1.0.0',
    PROGRAM_START: '2027-01-04',          // UVic 수업 시작일 (D-day 기준)
    PROGRAM_END: '2027-01-29',            // 연수 종료일
    PROGRAM_NAME: 'UVic 수업 시작',
    INTERVALS: [1, 3, 7, 14, 30],         // Leitner 상자 1~5의 다음 복습 간격(일)
    MASTERED_BOX: 4,                      // 이 상자 이상이면 "외움" (7일 복습까지 통과)
    DAILY_NEW_OPTIONS: [10, 15, 20, 30],  // 설정에서 고를 수 있는 하루 새 항목 수
    XP_CORRECT: 10,                       // 정답 XP
    XP_GOAL: 50,                          // 일일 목표 달성 보너스 XP
    STORAGE_KEY: 'canada500.state.v1',    // 진도 저장 키
    AUDIO_KEY: 'canada500.audio.v1',      // 찾은 음성 주소 캐시 키
    AUDIO_CACHE: 'canada500-audio-v1',    // 들은 음성 파일을 저장하는 Cache Storage 이름
    NONE_RETRY_DAYS: 14                   // "음성 없음" 결과를 다시 찾아보기까지의 일수
  };
  var SITUATIONS = ['홈스테이', '수업', '카페·식당', '교통', '쇼핑', '친구', '일반'];
  var MODES = {
    flash:  { ico: '🃏', name: '플래시카드', desc: '보고 → 뜻 확인 → 스와이프' },
    mean:   { ico: '🇰🇷', name: '뜻 고르기', desc: '영어 → 한국어 4지선다' },
    listen: { ico: '🎧', name: '듣고 고르기', desc: '원어민 음성 → 영어 4지선다' },
    reverse:{ ico: '🔤', name: '한→영 고르기', desc: '한국어 → 영어 4지선다' },
    blank:  { ico: '✍️', name: '빈칸 채우기', desc: '예문 빈칸에 맞는 표현' }
  };

  /* ---------------------------------------------------------
     1. 학습 데이터 불러오기 (words.js)
     --------------------------------------------------------- */
  var ITEMS = (Array.isArray(window.WORDS) ? window.WORDS : []).filter(function (w) {
    return w && w.id != null && w.en && w.ko;   // 필수 필드 없는 항목은 무시
  }).map(function (w) {
    return Object.assign({ type: 'word', situation: '일반', rank: 9999 }, w);
  }).sort(function (a, b) { return a.rank - b.rank; });
  var BY_ID = {};
  ITEMS.forEach(function (w) { BY_ID[w.id] = w; });
  var TOTAL = ITEMS.length;

  /* ---------------------------------------------------------
     2. 저장소 (localStorage 실패 시 메모리로 대체 — 사파리 개인정보 보호 모드 등)
     --------------------------------------------------------- */
  var store = (function () {
    var ok = false, mem = {}, warned = false;
    try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); ok = true; } catch (e) { ok = false; }
    function warn() {
      if (warned) return; warned = true;
      showBanner('⚠️ 이 브라우저에서는 진도를 저장할 수 없어요 (개인정보 보호 모드?). 설정 > 내보내기로 백업하세요.');
    }
    return {
      ok: function () { return ok; },
      get: function (key) {
        try {
          var raw = ok ? localStorage.getItem(key) : mem[key];
          return raw == null ? null : JSON.parse(raw);
        } catch (e) { return null; }
      },
      set: function (key, val) {
        var s;
        try { s = JSON.stringify(val); } catch (e) { return false; }
        mem[key] = s;
        if (!ok) { warn(); return false; }
        try { localStorage.setItem(key, s); return true; } catch (e) { warn(); return false; }
      },
      remove: function (key) {
        delete mem[key];
        try { if (ok) localStorage.removeItem(key); } catch (e) { /* 무시 */ }
      }
    };
  })();

  /* ---------------------------------------------------------
     3. 날짜 유틸 (기기 현지 시간 기준 'YYYY-MM-DD')
     --------------------------------------------------------- */
  function dayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parseDay(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = parseDay(s); d.setDate(d.getDate() + n); return dayStr(d); }
  function diffDays(a, b) { return Math.round((parseDay(b) - parseDay(a)) / 86400000); } // b - a (일)
  function today() { return dayStr(new Date()); }

  /* ---------------------------------------------------------
     4. 진도 상태
     state.items[id] = { b: 상자(1~5), d: 다음 복습일, n: 처음 배운 날, s: 본 횟수, c: 정답, w: 오답, l: 마지막 학습일, rd: 복습으로 센 날 }
     state.days[날짜] = { n: 새 항목 수, r: 복습 수, a: 답한 수, c: 정답 수, x: XP, g: 목표 달성 여부 }
     --------------------------------------------------------- */
  function defaultState() {
    return {
      v: 1,
      items: {},
      wrong: {},        // 오답 노트 { id: { c: 틀린 횟수, l: 마지막 날짜 } }
      favs: {},         // 즐겨찾기 { id: true }
      days: {},
      xp: 0,
      streak: { cur: 0, best: 0, last: null },
      settings: { dailyNew: 20, sfx: true, volume: 0.7, autoplay: true, vibrate: true }
    };
  }
  var state = loadState();

  function loadState() {
    var base = defaultState();
    var saved = store.get(CONFIG.STORAGE_KEY);
    if (!saved || typeof saved !== 'object') return base;
    var s = Object.assign(base, saved);
    s.settings = Object.assign(defaultState().settings, saved.settings || {});
    s.streak = Object.assign(defaultState().streak, saved.streak || {});
    ['items', 'wrong', 'favs', 'days'].forEach(function (k) { if (!s[k] || typeof s[k] !== 'object') s[k] = {}; });
    return s;
  }
  function save() { store.set(CONFIG.STORAGE_KEY, state); }

  function dayRec(day, create) {
    var d = state.days[day];
    if (!d && create) d = state.days[day] = { n: 0, r: 0, a: 0, c: 0, x: 0, g: false };
    return d || null;
  }
  function statusOf(id) {
    var r = state.items[id];
    if (!r) return 'new';
    return r.b >= CONFIG.MASTERED_BOX ? 'mastered' : 'learning';
  }
  var STATUS_KO = { 'new': '새 항목', learning: '학습 중', mastered: '외움' };

  /* 오늘 복습할 항목 (복습일이 오늘이거나 지난 것) */
  function dueItems() {
    var t = today();
    return ITEMS.filter(function (w) { var r = state.items[w.id]; return r && r.d <= t; })
      .sort(function (a, b) {
        var ra = state.items[a.id], rb = state.items[b.id];
        return ra.d < rb.d ? -1 : ra.d > rb.d ? 1 : ra.b - rb.b;
      });
  }
  /* 아직 안 배운 항목 (빈도 순) — situation 을 주면 그 상황만 */
  function newItems(situation) {
    return ITEMS.filter(function (w) {
      return !state.items[w.id] && (!situation || w.situation === situation);
    });
  }
  function counts() {
    var c = { 'new': 0, learning: 0, mastered: 0 };
    ITEMS.forEach(function (w) { c[statusOf(w.id)]++; });
    return c;
  }
  /* 오늘 목표 계산 */
  function todayInfo() {
    var dr = dayRec(today(), false) || { n: 0, r: 0, a: 0, g: false };
    var due = dueItems().length;
    var remainingNew = newItems().length;
    var newGoal = Math.min(state.settings.dailyNew, dr.n + remainingNew);
    var revGoal = dr.r + due;
    return {
      newDone: dr.n, newGoal: newGoal, newLeft: Math.max(0, newGoal - dr.n),
      revDone: dr.r, revGoal: revGoal, due: due,
      goalMet: dr.n >= newGoal && due === 0,
      goalMarked: !!dr.g, answers: dr.a
    };
  }

  /* 레벨: 레벨 L → L+1 에 필요한 XP = 100 + (L-1)*25 */
  function levelInfo(xp) {
    var lvl = 1, acc = 0, need = 100;
    while (xp >= acc + need) { acc += need; lvl++; need = 100 + (lvl - 1) * 25; }
    return { lvl: lvl, into: xp - acc, need: need };
  }
  function currentStreak() {
    var s = state.streak;
    if (!s.last) return 0;
    var gap = diffDays(s.last, today());
    return gap <= 1 ? s.cur : 0;
  }
  /* 오늘 첫 학습이면 스트릭 갱신. 'record' = 최고 기록 경신 */
  function touchStreak() {
    var t = today(), s = state.streak;
    if (s.last === t) return null;
    var prevBest = s.best;
    s.cur = (s.last && diffDays(s.last, t) === 1) ? s.cur + 1 : 1;
    s.last = t;
    if (s.cur > s.best) s.best = s.cur;
    return (s.cur > 1 && s.cur > prevBest) ? 'record' : 'extended';
  }
  function addXP(n) {
    if (!n) return false;
    var before = levelInfo(state.xp).lvl;
    state.xp += n;
    var d = dayRec(today(), true); d.x += n;
    return levelInfo(state.xp).lvl > before;   // 레벨업 여부
  }

  /* ---------------------------------------------------------
     5. SRS 규칙 (Leitner 5단계)
     - 새 항목: 처음 답하면 상자 1, 내일 복습
     - 복습일이 된 항목: 맞히면 상자 +1 (간격 1→3→7→14→30일), 틀리면 상자 1
     - 복습일 전 연습(오답 노트·자유 연습)에서 틀려도 상자 1로
     --------------------------------------------------------- */
  function recordAnswer(item, correct, opts) {
    opts = opts || {};
    var t = today();
    var d = dayRec(t, true);
    var ev = { streak: null, introduced: false, reviewed: false, mastered: false, graduated: false, goal: false, levelUp: false };
    if (d.a === 0) ev.streak = touchStreak();
    d.a++; if (correct) d.c++;

    var rec = state.items[item.id];
    var wasMastered = rec && rec.b >= CONFIG.MASTERED_BOX;
    if (!rec) {
      rec = state.items[item.id] = { b: 1, d: addDays(t, CONFIG.INTERVALS[0]), n: t, s: 0, c: 0, w: 0 };
      d.n++; ev.introduced = true;
    } else if (rec.d <= t) {
      if (rec.rd !== t) { d.r++; rec.rd = t; ev.reviewed = true; }
      rec.b = correct ? Math.min(rec.b + 1, CONFIG.INTERVALS.length) : 1;
      rec.d = addDays(t, CONFIG.INTERVALS[rec.b - 1]);
    } else if (!correct) {
      rec.b = 1; rec.d = addDays(t, CONFIG.INTERVALS[0]);
    }
    rec.s++; if (correct) rec.c++; else rec.w++;
    rec.l = t;
    if (!wasMastered && rec.b >= CONFIG.MASTERED_BOX) ev.mastered = true;

    // 오답 노트: 처음 보는 항목을 플래시카드에서 "몰라요" 한 것은 오답으로 치지 않음
    if (!correct && !(ev.introduced && opts.mode === 'flash')) {
      var w = state.wrong[item.id] || { c: 0 };
      w.c++; w.l = t; state.wrong[item.id] = w;
    } else if (correct && opts.kind === 'wrong' && state.wrong[item.id]) {
      delete state.wrong[item.id]; ev.graduated = true;
    }

    // XP
    if (opts.xp) ev.levelUp = addXP(opts.xp) || ev.levelUp;
    // 일일 목표 달성 체크
    var info = todayInfo();
    if (!d.g && info.goalMet) {
      d.g = true; ev.goal = true;
      ev.levelUp = addXP(CONFIG.XP_GOAL) || ev.levelUp;
    }
    save();
    return ev;
  }

  /* ---------------------------------------------------------
     6. 효과음 — 외부 파일 없이 Web Audio API로 합성
     iOS 사파리는 첫 터치 후에만 소리가 나므로 unlock()을 첫 터치에서 호출
     --------------------------------------------------------- */
  var Sfx = (function () {
    var ctx = null, master = null, wet = null, noiseBuf = null;
    function midi(m) { return 440 * Math.pow(2, (m - 69) / 12); }
    function vol() { return state.settings.sfx ? Math.max(0, Math.min(1, state.settings.volume)) * 0.9 : 0; }
    function ensure() {
      if (ctx) {
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(function () {});
        return ctx;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      master = ctx.createGain(); master.gain.value = vol();
      master.connect(ctx.destination);
      // "살짝 울리는 느낌": 저역 통과 필터를 거친 짧은 피드백 딜레이
      var delay = ctx.createDelay(1); delay.delayTime.value = 0.11;
      var fb = ctx.createGain(); fb.gain.value = 0.28;
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
      wet = ctx.createGain(); wet.gain.value = 0.22;
      wet.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay); lp.connect(master);
      return ctx;
    }
    function unlock() {
      var c = ensure(); if (!c) return;
      try { // 무음 버퍼를 한 번 재생해 iOS 오디오 잠금 해제
        var b = c.createBuffer(1, 1, 22050), s = c.createBufferSource();
        s.buffer = b; s.connect(c.destination); s.start(0);
      } catch (e) { /* 무시 */ }
    }
    function setVolume() { if (master) master.gain.value = vol(); }
    /* 기본 음 하나: 빠른 어택 + 지수 감쇠, 옥타브 배음을 살짝 섞음 */
    function tone(freq, t0, dur, o) {
      o = o || {};
      var type = o.type || 'sine', gain = o.gain || 0.2, attack = o.attack || 0.004, harm = o.harm == null ? 0.16 : o.harm;
      [[freq, gain, dur], harm ? [freq * 2, gain * harm, dur * 0.6] : null].forEach(function (p) {
        if (!p) return;
        var osc = ctx.createOscillator(), g = ctx.createGain();
        osc.type = p === null ? 'sine' : (p[0] === freq ? type : 'sine');
        osc.frequency.setValueAtTime(p[0], t0);
        if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo * (p[0] / freq), t0 + p[2]);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(p[1], t0 + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + p[2]);
        osc.connect(g);
        if (o.filter) { var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.filter; g.connect(f); f.connect(master); }
        else g.connect(master);
        if (o.send !== false) g.connect(wet);
        osc.start(t0); osc.stop(t0 + p[2] + 0.05);
      });
    }
    function noise(t0, dur, from, to, gain) {
      if (!noiseBuf) {
        noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
        var ch = noiseBuf.getChannelData(0);
        for (var i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
      }
      var src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = noiseBuf; bp.type = 'bandpass'; bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(from, t0); bp.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + dur + 0.05);
    }
    function ready() { return vol() > 0 && ensure() && ctx.state !== 'closed'; }
    function now() { return ctx.currentTime + 0.01; }

    return {
      unlock: unlock,
      setVolume: setVolume,
      /* 정답: C6→E6→G6 상승 아르페지오. 콤보가 쌓일수록 반음씩 올라감 (최대 +12) */
      correct: function (combo) {
        if (!ready()) return;
        var t = now(), up = Math.min(Math.max(combo - 1, 0), 12);
        [84, 88, 91].forEach(function (m, i) { tone(midi(m + up), t + i * 0.055, 0.28, { gain: 0.16 }); });
        if (combo === 3) {          // 3콤보: 반짝이는 고음 두 개
          [96, 100].forEach(function (m, i) { tone(midi(m), t + 0.2 + i * 0.06, 0.3, { gain: 0.08, type: 'triangle' }); });
        } else if (combo === 5) {   // 5콤보: 화음 쉬머
          [84, 88, 91, 96].forEach(function (m) { tone(midi(m + 2), t + 0.2, 0.6, { gain: 0.06, type: 'triangle' }); });
          tone(midi(103), t + 0.32, 0.5, { gain: 0.05 });
        } else if (combo >= 10 && combo % 5 === 0) { // 10·15·20…콤보: 미니 팡파르 런
          [79, 84, 88, 91, 96, 100].forEach(function (m, i) { tone(midi(m), t + 0.18 + i * 0.045, 0.22, { gain: 0.07, type: 'triangle' }); });
          [84, 88, 91, 96].forEach(function (m) { tone(midi(m), t + 0.48, 0.8, { gain: 0.06, type: 'triangle' }); });
        }
      },
      /* 오답: 낮고 부드러운 "툭" 한 음 */
      wrong: function () {
        if (!ready()) return;
        tone(midi(55), now(), 0.16, { type: 'triangle', gain: 0.2, glideTo: midi(50), harm: 0, send: false, filter: 900 });
      },
      /* 일일 목표 달성: 짧은 팡파르 */
      goal: function () {
        if (!ready()) return;
        var t = now();
        [72, 76, 79].forEach(function (m, i) { tone(midi(m), t + i * 0.1, 0.18, { type: 'triangle', gain: 0.13 }); });
        tone(midi(84), t + 0.3, 0.2, { type: 'triangle', gain: 0.14 });
        [72, 76, 79, 84].forEach(function (m) { tone(midi(m), t + 0.52, 1.1, { type: 'triangle', gain: 0.08 }); });
        [96, 100, 103, 108].forEach(function (m, i) { tone(midi(m), t + 0.6 + i * 0.07, 0.35, { gain: 0.04 }); });
      },
      /* 레벨업: 상승 스윕 + 밝은 화음 */
      levelUp: function () {
        if (!ready()) return;
        var t = now();
        tone(midi(72), t, 0.35, { gain: 0.1, glideTo: midi(91), harm: 0.3 });
        [79, 83, 86, 91].forEach(function (m) { tone(midi(m), t + 0.34, 0.7, { type: 'triangle', gain: 0.07 }); });
        tone(midi(98), t + 0.42, 0.5, { gain: 0.05 });
      },
      /* 스트릭 기록 갱신: "화르륵" 노이즈 + 종소리 3음 */
      streak: function () {
        if (!ready()) return;
        var t = now();
        noise(t, 0.35, 500, 3500, 0.07);
        [89, 93, 96].forEach(function (m, i) { tone(midi(m), t + 0.18 + i * 0.12, 0.55, { gain: 0.1, harm: 0.35 }); });
      },
      /* 항목 "외움" 달성: 작은 반짝임 */
      mastered: function () {
        if (!ready()) return;
        var t = now() + 0.25;
        [100, 103].forEach(function (m, i) { tone(midi(m), t + i * 0.07, 0.3, { gain: 0.05 }); });
      }
    };
  })();

  /* 진동 (안드로이드). iOS는 navigator.vibrate 가 없어서 조용히 무시 */
  function buzz(pattern) {
    if (!state.settings.vibrate) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* 무시 */ }
  }

  /* ---------------------------------------------------------
     7. 원어민 음성 (사람 녹음만! 브라우저 음성 합성·TTS 사용 안 함)
     찾는 순서
       단어: ① Free Dictionary API phonetics[].audio (US > CA > UK > AU > 기타)
             ② Wikimedia Commons File:En-us/ca/uk/au-{단어}.ogg (MP3 변환본 우선)
             ③ Lingua Libre 사람 녹음 (Commons)
       숙어: ① Tatoeba 사람 녹음 예문 (그 표현이 들어간 짧은 문장)
             ② (한 단어 표현이면) 단어와 같은 경로
             ③ 없으면 "원어민 음성 없음" + YouGlish 버튼
     찾은 주소는 localStorage 에, 들은 음성 파일은 Cache Storage 에 저장 → 오프라인 재생
     --------------------------------------------------------- */
  var Voice = (function () {
    var SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    var REGION_RANK = { US: 0, CA: 1, UK: 2, AU: 3, '': 4 };
    var audio = null, unlocked = false, objUrl = null, token = 0, tatoebaFails = 0, tatoebaQueue = Promise.resolve();
    var cache = store.get(CONFIG.AUDIO_KEY) || {};
    var inflight = {};

    function el() {
      if (!audio) { audio = new Audio(); audio.preload = 'auto'; audio.setAttribute('playsinline', ''); }
      return audio;
    }
    /* iOS: 첫 터치 때 같은 audio 요소를 한 번 재생해 두면 이후 자동 재생이 허용됨 */
    function unlock() {
      if (unlocked) return; unlocked = true;
      try { var a = el(); a.src = SILENT; var p = a.play(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* 무시 */ }
    }
    function keyOf(item) { return item.type + ':' + item.en.toLowerCase(); }
    function saveCache() { store.set(CONFIG.AUDIO_KEY, cache); }

    function regionOf(url) {
      var u = '';
      try { u = decodeURIComponent(url).toLowerCase(); } catch (e) { u = String(url).toLowerCase(); }
      if (/-us\.(mp3|ogg|wav)|en-us-|[_(]us[_).]/.test(u)) return 'US';
      if (/-ca\.(mp3|ogg|wav)|en-ca-/.test(u)) return 'CA';
      if (/-(uk|gb)\.(mp3|ogg|wav)|en-(uk|gb)-/.test(u)) return 'UK';
      if (/-au\.(mp3|ogg|wav)|en-au-/.test(u)) return 'AU';
      return '';
    }
    function byRegion(a, b) { return REGION_RANK[a.region] - REGION_RANK[b.region]; }

    function timeoutFetch(url, opts, ms) {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 8000);
      return fetch(url, Object.assign({}, opts || {}, ctrl ? { signal: ctrl.signal } : {}))
        .finally(function () { clearTimeout(timer); });
    }
    function fetchJSON(url) {
      return timeoutFetch(url, { mode: 'cors' }, 9000).then(function (r) {
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json();
      });
    }
    /* 음성 파일 가져오기: Cache Storage → 네트워크(성공하면 캐시에 저장) */
    function getAudioBlob(url) {
      var hasCache = typeof caches !== 'undefined';
      var fromCache = hasCache
        ? caches.open(CONFIG.AUDIO_CACHE).then(function (c) { return c.match(url); }).catch(function () { return null; })
        : Promise.resolve(null);
      return fromCache.then(function (hit) {
        if (hit) return hit.blob();
        return timeoutFetch(url, { mode: 'cors' }, 12000).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          var ct = (res.headers.get('content-type') || '').toLowerCase();
          if (ct && !/audio|ogg|octet|mpeg|wav/.test(ct)) throw new Error('not audio');
          var copy = res.clone();
          if (hasCache) caches.open(CONFIG.AUDIO_CACHE).then(function (c) { return c.put(url, copy); }).catch(function () {});
          return res.blob();
        });
      });
    }
    function works(url) { return getAudioBlob(url).then(function () { return true; }, function () { return false; }); }
    /* 후보 목록을 순서대로 시도해 처음 재생 가능한 것을 반환 */
    function firstWorking(cands) {
      var i = 0;
      function next() {
        if (i >= cands.length) return Promise.resolve(null);
        var c = cands[i++];
        return works(c.url).then(function (ok) { return ok ? c : next(); });
      }
      return next();
    }

    /* Commons 파일 정보 → 후보. MP3 변환본(모든 브라우저 재생)을 우선 사용 */
    function commonsQuery(titles, src) {
      var url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=videoinfo&viprop=url%7Cderivatives&titles='
        + encodeURIComponent(titles.join('|'));
      return fetchJSON(url).then(function (data) {
        var pages = (data && data.query && data.query.pages) ? Object.keys(data.query.pages).map(function (k) { return data.query.pages[k]; }) : [];
        var out = [];
        pages.forEach(function (p) {
          var vi = p.videoinfo && p.videoinfo[0];
          if (!vi || !vi.url) return;
          var mp3 = (vi.derivatives || []).filter(function (d) { return /mpeg|mp3/.test(d.type || '') || /\.mp3$/.test(d.src || ''); })[0];
          var orig = vi.url.split('?')[0];
          var region = regionOf(p.title);
          if (mp3) out.push({ url: mp3.src, src: src, region: region, page: vi.descriptionurl });
          var canOgg = false;
          try { canOgg = !!el().canPlayType('audio/ogg; codecs="vorbis"'); } catch (e) { /* 무시 */ }
          if (canOgg || /\.(mp3|wav)$/i.test(orig)) out.push({ url: orig, src: src, region: region, page: vi.descriptionurl });
        });
        return out.sort(byRegion);
      });
    }

    function resolveWord(word) {
      word = word.toLowerCase().trim();
      var netOk = false;
      var derived = [];
      // ① Free Dictionary API
      return fetchJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word))
        .then(function (data) {
          netOk = true;
          var cands = [];
          (Array.isArray(data) ? data : []).forEach(function (e) {
            (e.phonetics || []).forEach(function (p) {
              if (!p.audio) return;
              var u = p.audio.indexOf('//') === 0 ? 'https:' + p.audio : p.audio;
              cands.push({ url: u, src: 'Wiktionary', region: regionOf(u) });
              // dictionaryapi.dev 의 .../en/figure-us.mp3 → 원본 Commons 파일 File:En-us-figure.ogg
              var m = u.match(/\/pronunciations\/en\/(.+)-(us|uk|ca|au)\.mp3$/i);
              if (m) derived.push('File:En-' + m[2].toLowerCase() + '-' + decodeURIComponent(m[1]) + '.ogg');
            });
          });
          return firstWorking(cands.sort(byRegion));
        }, function (e) { if (e && e.status) netOk = true; return null; })
        .then(function (hit) {
          if (hit) return hit;
          // ② Wikimedia Commons (위키낱말사전 녹음 원본)
          var titles = ['us', 'ca', 'uk', 'au'].map(function (r) { return 'File:En-' + r + '-' + word + '.ogg'; });
          derived.forEach(function (t) { if (titles.indexOf(t) < 0) titles.push(t); });
          return commonsQuery(titles, 'Wiktionary').then(function (c) { netOk = true; return firstWorking(c); }, function () { return null; });
        })
        .then(function (hit) {
          if (hit) return hit;
          // ③ Lingua Libre (Commons 의 사람 녹음, 지역 정보 없음)
          var q = 'intitle:"LL-Q1860" intitle:"-' + word + '.wav"';
          var url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&list=search&srnamespace=6&srlimit=20&srsearch=' + encodeURIComponent(q);
          return fetchJSON(url).then(function (data) {
            netOk = true;
            var titles = ((data.query && data.query.search) || []).map(function (r) { return r.title; })
              .filter(function (t) { return t.toLowerCase().slice(-(word.length + 5)) === '-' + word + '.wav'; }).slice(0, 3);
            if (!titles.length) return null;
            return commonsQuery(titles, 'Lingua Libre').then(firstWorking);
          }, function () { return null; });
        })
        .then(function (hit) { return hit || (netOk ? null : undefined); }); // undefined = 네트워크 실패(캐시 안 함)
    }

    function norm(s) {
      return ' ' + String(s).toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function transient(e) { return !e || !e.status || e.status === 429 || e.status >= 500; } // 네트워크·과부하 오류 (확정 아님)
    /* Tatoeba 요청은 한 번에 하나씩 보냄 (동시에 많이 보내면 실패함). 일시 오류면 1.5초 뒤 한 번 재시도 */
    function tatoebaFetch(url) {
      var run = function () {
        return fetchJSON(url).catch(function (e) {
          if (!transient(e)) throw e;
          return wait(1500).then(function () { return fetchJSON(url); });
        });
      };
      var p = tatoebaQueue.then(run, run);
      tatoebaQueue = p.then(function () { return wait(250); }, function () { return wait(250); });
      return p;
    }
    function resolvePhrase(phrase) {
      var q = phrase.replace(/[?!.,…]+$/g, '').trim();
      var netOk = false;
      // 3번 연속 실패하면 CORS 차단 등으로 보고 이번 실행 동안 Tatoeba 단계를 건너뜀
      var step1 = tatoebaFails >= 3 ? Promise.resolve(null) : tatoebaFetch('https://api.tatoeba.org/v1/sentences?' + [
        'lang=eng', 'q=' + encodeURIComponent('="' + q + '"'), 'has_audio=yes', 'sort=words', 'limit=12', 'include=audios'
      ].join('&')).then(function (data) {
        netOk = true; tatoebaFails = 0;
        var target = norm(q);
        var list = ((data && data.data) || []).filter(function (s) {
          return s.audios && s.audios.length && norm(s.text).indexOf(target) >= 0;
        });
        var cands = list.slice(0, 4).map(function (s) {
          var a = s.audios[0];
          return {
            url: 'https://api.tatoeba.org/v1/audios/' + a.id + '/file', src: 'Tatoeba', region: '',
            text: s.text, author: a.author || '', license: a.license || '', attribution: a.attribution_url || '',
            page: 'https://tatoeba.org/sentences/show/' + s.id
          };
        });
        return firstWorking(cands);
      }, function (e) {
        if (!transient(e)) netOk = true;                 // 확정 응답 (결과 없음)
        else if (navigator.onLine !== false) tatoebaFails++;
        return null;                                    // netOk=false 면 "음성 없음"으로 저장하지 않고 다음에 다시 찾음
      });
      return step1.then(function (hit) {
        if (hit) return hit;
        if (/^[a-z]+$/i.test(q)) return resolveWord(q).then(function (r) { if (r !== undefined) netOk = true; return r; });
        return null;
      }).then(function (hit) { return hit || (netOk ? null : undefined); });
    }

    /* 항목의 음성 찾기 (캐시 우선). 결과: {url, src, region, ...} 또는 null(음성 없음) */
    function resolve(item) {
      var key = keyOf(item), c = cache[key];
      if (c && c.url) return Promise.resolve(c);
      if (c && c.none && diffDays(c.t, today()) < CONFIG.NONE_RETRY_DAYS) return Promise.resolve(null);
      if (navigator.onLine === false) return Promise.resolve(null);
      if (inflight[key]) return inflight[key];
      var p = (item.type === 'word' ? resolveWord(item.en) : resolvePhrase(item.en))
        .catch(function () { return undefined; })
        .then(function (r) {
          delete inflight[key];
          if (r) cache[key] = r;
          else if (r === null) cache[key] = { none: true, t: today() };
          saveCache();
          return r || null;
        });
      inflight[key] = p;
      return p;
    }
    function cached(item) { var c = cache[keyOf(item)]; return c && c.url ? c : (c && c.none ? false : undefined); }

    function stop() { token++; try { if (audio) audio.pause(); } catch (e) { /* 무시 */ } }
    /* 재생. rate = 0.75 면 느리게 (음높이 유지) */
    function play(item, rate) {
      var my = ++token;
      rate = rate || 1;
      try { if (audio) audio.pause(); } catch (e) { /* 무시 */ }
      return resolve(item).then(function (r) {
        if (!r) return { ok: false, reason: 'none' };
        if (my !== token) return { ok: false, reason: 'stale', info: r };
        return getAudioBlob(r.url).then(function (blob) {
          if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) { /* 무시 */ } }
          objUrl = URL.createObjectURL(blob);
          return objUrl;
        }, function () { return r.url; }).then(function (src) {
          if (my !== token) return { ok: false, reason: 'stale', info: r };
          var a = el();
          a.defaultPlaybackRate = rate;
          a.src = src;
          a.playbackRate = rate;
          try { a.preservesPitch = true; a.webkitPreservesPitch = true; } catch (e) { /* 무시 */ }
          var p = a.play();
          return Promise.resolve(p).then(function () { return { ok: true, info: r }; }, function (e) {
            return { ok: false, reason: e && e.name === 'NotAllowedError' ? 'blocked' : 'error', info: r };
          });
        });
      }).catch(function () { return { ok: false, reason: 'error' }; });
    }
    function badge(r) {
      if (!r) return '원어민 음성 없음';
      if (r.src === 'Tatoeba') return '🎙 사람 녹음 예문 · Tatoeba' + (r.author ? ' · ' + r.author : '');
      if (r.src === 'Lingua Libre') return '🎙 사람 녹음 · Lingua Libre';
      return '🎙 원어민' + (r.region ? ' · ' + r.region : '') + ' · ' + r.src;
    }
    function youglish(item) {
      return 'https://youglish.com/pronounce/' + encodeURIComponent(item.en.replace(/[?!.,…]+$/g, '').trim()) + '/english/us';
    }
    function clear() {
      cache = {}; store.remove(CONFIG.AUDIO_KEY);
      var p = typeof caches !== 'undefined' ? caches.delete(CONFIG.AUDIO_CACHE).catch(function () {}) : Promise.resolve();
      return p;
    }
    function stats() {
      var found = 0, none = 0;
      Object.keys(cache).forEach(function (k) { if (cache[k].url) found++; else if (cache[k].none) none++; });
      return { found: found, none: none };
    }
    return { unlock: unlock, resolve: resolve, cached: cached, play: play, stop: stop, badge: badge, youglish: youglish, clear: clear, stats: stats };
  })();

  /* ---------------------------------------------------------
     8. UI 공통
     --------------------------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function showBanner(msg) {
    var b = document.getElementById('banner');
    if (!b) return;
    b.textContent = msg; b.hidden = false;
  }
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }
  function typeKo(w) { return w.type === 'word' ? '단어' : '표현'; }

  /* 시트(바텀시트) */
  function openSheet(html, onBind) {
    var sh = $('#sheet'), bd = $('#sheet-backdrop');
    sh.innerHTML = '<div class="grab"></div>' + html;
    sh.hidden = false; bd.hidden = false; sh.scrollTop = 0;
    if (onBind) onBind(sh);
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; Voice.stop(); }

  /* 음성 버튼 묶음 HTML — bindAudio()로 이벤트 연결 */
  function audioRowHTML(opts) {
    opts = opts || {};
    return '<div class="audio-block">' +
      '<div class="audio-row">' +
        '<button class="play-btn' + (opts.big ? ' big' : '') + '" data-play="1" aria-label="원어민 음성 듣기">▶</button>' +
        '<button class="play-btn slow" data-play="0.75" aria-label="0.75배속으로 듣기">0.75×</button>' +
        '<span class="src-badge" data-badge>음성 찾는 중…</span>' +
      '</div>' +
      '<div class="tts-sent" data-sent hidden></div>' +
      '<div class="audio-row" data-yg hidden><a class="btn btn-ghost btn-sm yg-btn" target="_blank" rel="noopener" data-yglink>▶ 원어민 영상에서 듣기 (YouGlish)</a></div>' +
    '</div>';
  }
  function setAudioInfo(root, item, r) {
    var badge = $('[data-badge]', root), sent = $('[data-sent]', root), yg = $('[data-yg]', root);
    if (!badge) return;
    if (r) {
      badge.textContent = Voice.badge(r); badge.classList.remove('none');
      $$('[data-play]', root).forEach(function (b) { b.disabled = false; });
      if (r.text && sent && !root.hasAttribute('data-hide-sent')) { sent.textContent = '“' + r.text + '”'; sent.hidden = false; }
      if (yg) yg.hidden = !root.hasAttribute('data-always-yg');
    } else if (r === null) {
      badge.textContent = navigator.onLine === false ? '오프라인 · 아직 안 들어본 음성' : '원어민 음성 없음';
      badge.classList.add('none');
      $$('[data-play]', root).forEach(function (b) { b.disabled = true; });
      if (yg) yg.hidden = false;
    }
    var link = $('[data-yglink]', root);
    if (link) link.href = Voice.youglish(item);
  }
  /* autoplay: true 면 음성을 찾는 대로 재생 */
  function bindAudio(root, item, autoplay) {
    var known = Voice.cached(item);
    if (known) setAudioInfo(root, item, known);
    else if (known === false) setAudioInfo(root, item, null);
    $$('[data-play]', root).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        playInto(root, item, parseFloat(b.getAttribute('data-play')));
      });
    });
    if (autoplay) playInto(root, item, 1);
    else if (known === undefined) Voice.resolve(item).then(function (r) { if (root.isConnected) setAudioInfo(root, item, r); });
  }
  function playInto(root, item, rate) {
    var btn = $('[data-play="' + (rate === 1 ? '1' : '0.75') + '"]', root);
    if (btn) btn.classList.add('loading');
    return Voice.play(item, rate).then(function (res) {
      if (btn) btn.classList.remove('loading');
      if (!root.isConnected) return res;
      if (res.reason === 'none') setAudioInfo(root, item, null);
      else if (res.info) setAudioInfo(root, item, res.info);
      if (res.reason === 'blocked') toast('화면을 한 번 터치한 뒤 ▶를 눌러 주세요');
      return res;
    });
  }

  /* ---------------------------------------------------------
     9. 탭 전환
     --------------------------------------------------------- */
  var currentTab = 'home';
  var listState = { q: '', status: 'all', cat: 'all', limit: 100 };
  function go(tab) {
    currentTab = tab;
    $$('.tab').forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === tab); });
    $$('.view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== tab; });
    render();
    window.scrollTo(0, 0);
  }
  function render() {
    var info = todayInfo();
    $('#review-dot').hidden = info.due === 0;
    ({ home: renderHome, learn: renderLearn, review: renderReview, list: renderList, settings: renderSettings })[currentTab]();
  }

  /* ---------------------------------------------------------
     10. 홈
     --------------------------------------------------------- */
  function ringSVG(val, max, color) {
    var r = 46, c = 2 * Math.PI * r, p = max > 0 ? Math.min(1, val / max) : 1;
    return '<svg class="ring" viewBox="0 0 112 112" role="img" aria-label="' + val + ' / ' + max + '">' +
      '<circle class="track" cx="56" cy="56" r="' + r + '" fill="none" stroke-width="12"/>' +
      '<circle class="val" cx="56" cy="56" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="12" stroke-linecap="round" ' +
      'stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - p)).toFixed(1) + '" transform="rotate(-90 56 56)"/>' +
      '<text x="56" y="54" text-anchor="middle" font-size="26">' + val + '</text>' +
      '<text x="56" y="76" text-anchor="middle" font-size="14" style="fill:var(--text-2);font-weight:600">/ ' + max + '</text>' +
    '</svg>';
  }
  function ddayHTML() {
    var t = today(), toStart = diffDays(t, CONFIG.PROGRAM_START), sinceStart = diffDays(CONFIG.PROGRAM_START, t);
    var label, num;
    if (toStart > 0) { label = CONFIG.PROGRAM_NAME + '까지'; num = 'D-' + toStart; }
    else if (t <= CONFIG.PROGRAM_END) { label = sinceStart === 0 ? 'D-DAY · 오늘 수업 시작!' : 'UVic 어학연수'; num = '연수 ' + (sinceStart + 1) + '일차'; }
    else { label = 'UVic 어학연수'; num = '연수 완료! 👏'; }
    return '<div class="dday"><div><div class="dd-label">' + esc(label) + '</div><div class="dd-num">' + esc(num) + '</div></div><div class="dd-leaf" aria-hidden="true">🍁</div></div>';
  }
  function heatmapHTML() {
    var now = new Date(), t = today();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - 21); // 3주 전 일요일
    var html = '<div class="heatmap">' + ['일', '월', '화', '수', '목', '금', '토'].map(function (d) { return '<div class="heat-dow">' + d + '</div>'; }).join('');
    for (var i = 0; i < 28; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), ds = dayStr(d), r = state.days[ds];
      var a = r ? r.a : 0, lv = a === 0 ? '' : a < 20 ? ' l1' : a < 50 ? ' l2' : ' l3';
      var cls = 'heat' + lv + (ds === t ? ' today' : '') + (r && r.g ? ' goal' : '') + (ds > t ? ' future' : '');
      html += '<div class="' + cls + '" title="' + ds + ' · ' + a + '문제' + (r && r.g ? ' · 목표 달성' : '') + '"></div>';
    }
    return html + '</div>';
  }
  function renderHome() {
    var info = todayInfo(), c = counts(), lv = levelInfo(state.xp), st = currentStreak();
    var learned = c.learning + c.mastered;
    var cta, ctaAct;
    if (info.due > 0) { cta = '🔁 복습 ' + info.due + '개 시작'; ctaAct = 'review'; }
    else if (info.newLeft > 0) { cta = '📚 새 항목 ' + info.newLeft + '개 학습'; ctaAct = 'new'; }
    else if (learned > 0) { cta = '🎉 오늘 목표 완료 · 자유 연습'; ctaAct = 'practice'; }
    else { cta = '모든 항목 학습 완료!'; ctaAct = ''; }
    var html = ddayHTML() +
      '<div class="card"><h2>오늘의 목표 ' + (info.goalMarked ? '· ✅ 달성!' : '') + '</h2>' +
        '<div class="rings">' +
          '<div class="ring-wrap">' + ringSVG(info.newDone, info.newGoal, 'var(--ring-new)') + '<div class="ring-label">새 항목</div></div>' +
          '<div class="ring-wrap">' + ringSVG(info.revDone, info.revGoal, 'var(--ring-rev)') + '<div class="ring-label">복습</div></div>' +
        '</div>' +
      '</div>' +
      '<button class="btn btn-primary cta" id="home-cta"' + (ctaAct ? '' : ' disabled') + '>' + cta + '</button>' +
      '<div class="streak-row">' +
        '<div class="card"><h2>연속 학습</h2><div class="big-num">🔥 ' + st + '<span class="small muted">일</span></div><div class="small muted">최고 ' + state.streak.best + '일</div></div>' +
        '<div class="card"><h2>레벨</h2><div class="big-num">Lv.' + lv.lvl + '</div><div class="xpbar"><i style="width:' + Math.round(lv.into / lv.need * 100) + '%"></i></div><div class="small muted">' + lv.into + ' / ' + lv.need + ' XP</div></div>' +
      '</div>' +
      '<div class="card"><h2>전체 진도 · ' + TOTAL + '개</h2>' +
        '<div class="stats3">' +
          '<div class="stat"><b>' + learned + '</b><span>학습함</span></div>' +
          '<div class="stat"><b style="color:var(--good)">' + c.mastered + '</b><span>외움</span></div>' +
          '<div class="stat"><b>' + c['new'] + '</b><span>남음</span></div>' +
        '</div>' +
        '<div class="bar"><i style="width:' + (c.mastered / TOTAL * 100) + '%;background:var(--good)"></i><i style="width:' + (c.learning / TOTAL * 100) + '%;background:var(--ring-rev)"></i></div>' +
        '<div class="small muted">외움 = 7일 뒤 복습까지 맞힌 항목</div>' +
      '</div>' +
      '<div class="card"><h2>최근 4주 학습</h2>' + heatmapHTML() + '</div>';
    if (!TOTAL) html = '<div class="card">words.js 를 불러오지 못했어요. 파일이 같은 폴더에 있는지 확인하세요.</div>';
    $('#view-home').innerHTML = html;
    var b = $('#home-cta');
    if (b) b.addEventListener('click', function () {
      if (ctaAct === 'review') startSession('review', 'mix');
      else if (ctaAct === 'new') startSession('new', 'flash');
      else if (ctaAct === 'practice') startSession('practice', 'mix');
    });
  }

  /* ---------------------------------------------------------
     11. 학습 탭 (새 항목 · 상황별)
     --------------------------------------------------------- */
  var learnSit = '';
  function renderLearn() {
    var info = todayInfo();
    var nextNew = newItems(learnSit).slice(0, 5);
    var sitCounts = {};
    SITUATIONS.forEach(function (s) { sitCounts[s] = 0; });
    ITEMS.forEach(function (w) { if (!state.items[w.id] && sitCounts[w.situation] != null) sitCounts[w.situation]++; });
    var learnedInSit = learnSit ? ITEMS.filter(function (w) { return w.situation === learnSit && state.items[w.id]; }).length : 0;
    var html = '<h1 class="page-title">학습</h1>' +
      '<div class="card"><h2>오늘의 새 항목</h2>' +
        '<div class="hero-num">' + info.newDone + '<span class="muted" style="font-size:20px"> / ' + info.newGoal + '</span></div>' +
        '<p class="small muted">빈도가 높은 순서대로 하루 ' + state.settings.dailyNew + '개씩 배워요.</p>' +
        (info.newLeft > 0
          ? '<button class="btn btn-primary" data-act="new">새 항목 ' + info.newLeft + '개 학습</button>'
          : (newItems().length ? '<button class="btn" data-act="extra">오늘 목표 완료! 10개 더 배우기</button>' : '<p>🎉 ' + TOTAL + '개 모두 학습을 시작했어요!</p>')) +
      '</div>' +
      '<div class="card"><h2>상황별 학습</h2>' +
        '<div class="chips" id="sit-chips"><button class="chip' + (learnSit ? '' : ' is-on') + '" data-sit="">전체</button>' +
          SITUATIONS.map(function (s) { return '<button class="chip' + (learnSit === s ? ' is-on' : '') + '" data-sit="' + s + '">' + s + ' <span class="muted">' + sitCounts[s] + '</span></button>'; }).join('') +
        '</div>' +
        (learnSit ? '<div class="row" style="margin-top:12px">' +
            '<button class="btn btn-primary" data-act="sit-new"' + (sitCounts[learnSit] ? '' : ' disabled') + '>새 항목 배우기</button>' +
            '<button class="btn" data-act="sit-practice"' + (learnedInSit ? '' : ' disabled') + '>배운 것 연습 ' + learnedInSit + '</button>' +
          '</div>' : '<p class="small muted" style="margin:10px 0 0">상황을 고르면 그 상황 표현만 골라 배울 수 있어요.</p>') +
      '</div>' +
      '<div class="card"><h2>다음에 배울 ' + (learnSit ? '‘' + esc(learnSit) + '’ ' : '') + '항목</h2>' +
        (nextNew.length ? '<ul class="list-mini">' + nextNew.map(function (w) {
          return '<li><span class="en">' + esc(w.en) + '</span><span class="muted small">' + typeKo(w) + ' · ' + esc(w.situation) + '</span></li>';
        }).join('') + '</ul>' : '<p class="muted small">없음</p>') +
      '</div>' +
      '<div class="card"><h2>학습 방식</h2><div class="mode-grid">' +
        Object.keys(MODES).map(function (k) { var m = MODES[k]; return '<div class="mode-btn" style="cursor:default"><span class="m-ico">' + m.ico + '</span><b>' + m.name + '</b><span>' + m.desc + '</span></div>'; }).join('') +
      '</div><p class="small muted" style="margin:10px 0 0">학습을 시작할 때 방식을 고를 수 있어요.</p></div>';
    var v = $('#view-learn');
    v.innerHTML = html;
    $$('[data-sit]', v).forEach(function (b) { b.addEventListener('click', function () { learnSit = b.getAttribute('data-sit'); renderLearn(); }); });
    v.onclick = onLearnAct;
  }
  function onLearnAct(e) {
    var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    if (act === 'new') pickMode('새 항목 학습', 'new', {});
    else if (act === 'extra') pickMode('10개 더 배우기', 'new', { extra: 10 });
    else if (act === 'sit-new') pickMode('‘' + learnSit + '’ 새 항목', 'new', { situation: learnSit, extra: 10 });
    else if (act === 'sit-practice') pickMode('‘' + learnSit + '’ 연습', 'practice', { situation: learnSit });
  }

  /* 학습 방식 고르기 시트 */
  function pickMode(title, kind, opts) {
    var rec = kind === 'new' ? 'flash' : 'mix';
    var html = '<h3>' + esc(title) + '</h3><div class="mode-grid">' +
      '<button class="mode-btn wide" data-mode="' + rec + '"><span class="m-ico">' + (rec === 'flash' ? '🃏' : '🎲') + '</span><b>' +
        (rec === 'flash' ? '플래시카드 (추천)' : '섞어서 (추천)') + '</b><span>' + (rec === 'flash' ? '처음 보는 항목은 카드로 먼저 익혀요' : '여러 방식을 골고루 섞어요') + '</span></button>' +
      Object.keys(MODES).filter(function (k) { return k !== rec; }).map(function (k) {
        var m = MODES[k]; return '<button class="mode-btn" data-mode="' + k + '"><span class="m-ico">' + m.ico + '</span><b>' + m.name + '</b><span>' + m.desc + '</span></button>';
      }).join('') +
      (rec === 'flash' ? '<button class="mode-btn" data-mode="mix"><span class="m-ico">🎲</span><b>섞어서</b><span>여러 방식 골고루</span></button>' : '') +
      '</div><div style="height:10px"></div><button class="btn" data-close>취소</button>';
    openSheet(html, function (sh) {
      $$('[data-mode]', sh).forEach(function (b) {
        b.addEventListener('click', function () { closeSheet(); startSession(kind, b.getAttribute('data-mode'), opts); });
      });
      $('[data-close]', sh).addEventListener('click', closeSheet);
    });
  }

  /* ---------------------------------------------------------
     12. 복습 탭 (SRS 복습 · 오답 노트 · 자유 연습)
     --------------------------------------------------------- */
  function renderReview() {
    var info = todayInfo();
    var wrongIds = Object.keys(state.wrong).filter(function (id) { return BY_ID[id]; })
      .sort(function (a, b) { return state.wrong[b].c - state.wrong[a].c; });
    var boxes = [0, 0, 0, 0, 0];
    Object.keys(state.items).forEach(function (id) { if (BY_ID[id]) boxes[state.items[id].b - 1]++; });
    var tomorrow = addDays(today(), 1);
    var dueTomorrow = ITEMS.filter(function (w) { var r = state.items[w.id]; return r && r.d === tomorrow; }).length;
    var favCount = Object.keys(state.favs).filter(function (id) { return BY_ID[id]; }).length;
    var learned = Object.keys(state.items).length;
    var html = '<h1 class="page-title">복습</h1>' +
      '<div class="card"><h2>오늘 복습할 항목</h2>' +
        '<div class="hero-num">' + info.due + '<span class="muted" style="font-size:16px"> 개 · 내일 ' + dueTomorrow + '개</span></div>' +
        '<div style="height:12px"></div>' +
        '<button class="btn btn-primary" data-act="review"' + (info.due ? '' : ' disabled') + '>' + (info.due ? '복습 시작' : '오늘 복습 끝! 👍') + '</button>' +
      '</div>' +
      '<div class="card"><h2>오답 노트 · ' + wrongIds.length + '개</h2>' +
        (wrongIds.length
          ? '<button class="btn" data-act="wrong">오답만 복습</button><ul class="list-mini" style="margin-top:8px">' + wrongIds.slice(0, 30).map(function (id) {
              var w = BY_ID[id];
              return '<li data-detail="' + id + '"><span><span class="en">' + esc(w.en) + '</span> <span class="muted small">' + esc(w.ko) + '</span></span><span class="small" style="color:var(--bad);white-space:nowrap">✕' + state.wrong[id].c + '</span></li>';
            }).join('') + '</ul>' + (wrongIds.length > 30 ? '<p class="small muted">외 ' + (wrongIds.length - 30) + '개</p>' : '') +
            '<p class="small muted" style="margin:8px 0 0">오답 복습에서 맞히면 노트에서 빠져요.</p>'
          : '<p class="muted small" style="margin:0">틀린 항목이 여기에 모여요.</p>') +
      '</div>' +
      '<div class="card"><h2>자유 연습</h2><div class="row">' +
        '<button class="btn" data-act="practice"' + (learned ? '' : ' disabled') + '>배운 것 10개</button>' +
        '<button class="btn" data-act="fav"' + (favCount ? '' : ' disabled') + '>⭐ 즐겨찾기 ' + favCount + '</button>' +
      '</div></div>' +
      '<div class="card"><h2>복습 상자 (Leitner)</h2><ul class="list-mini">' + boxes.map(function (n, i) {
        return '<li><span>상자 ' + (i + 1) + ' <span class="muted small">· ' + CONFIG.INTERVALS[i] + '일 뒤 복습</span></span><b>' + n + '</b></li>';
      }).join('') + '</ul><p class="small muted" style="margin:8px 0 0">맞히면 다음 상자로, 틀리면 상자 1로 돌아가요.</p></div>';
    var v = $('#view-review');
    v.innerHTML = html;
    v.onclick = function (e) {
      var d = e.target.closest('[data-detail]');
      if (d) { openDetail(BY_ID[d.getAttribute('data-detail')]); return; }
      var b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      var act = b.getAttribute('data-act');
      if (act === 'review') pickMode('오늘 복습 ' + info.due + '개', 'review', {});
      else if (act === 'wrong') pickMode('오답 노트 복습', 'wrong', {});
      else if (act === 'practice') pickMode('자유 연습', 'practice', {});
      else if (act === 'fav') pickMode('즐겨찾기 연습', 'fav', {});
    };
  }

  /* ---------------------------------------------------------
     13. 단어장 (검색 · 상태 필터 · 즐겨찾기)
     --------------------------------------------------------- */
  function listFiltered() {
    var q = listState.q.trim().toLowerCase();
    return ITEMS.filter(function (w) {
      if (listState.status === 'fav') { if (!state.favs[w.id]) return false; }
      else if (listState.status !== 'all' && statusOf(w.id) !== listState.status) return false;
      if (listState.cat === 'word' && w.type !== 'word') return false;
      if (listState.cat === 'phrase' && w.type !== 'phrase') return false;
      if (SITUATIONS.indexOf(listState.cat) >= 0 && w.situation !== listState.cat) return false;
      if (q && (w.en + ' ' + w.ko + ' ' + (w.example_en || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function renderList() {
    var v = $('#view-list');
    if (!$('#list-search', v)) {
      var st = [['all', '전체'], ['new', '새 항목'], ['learning', '학습 중'], ['mastered', '외움'], ['fav', '⭐ 즐겨찾기']];
      var cat = [['all', '전체'], ['word', '단어'], ['phrase', '숙어·표현']].concat(SITUATIONS.map(function (s) { return [s, s]; }));
      v.innerHTML = '<h1 class="page-title">단어장</h1>' +
        '<input id="list-search" class="search" type="search" placeholder="영어나 한국어로 검색" autocomplete="off" enterkeyhint="search">' +
        '<div class="chips" id="st-chips">' + st.map(function (s) { return '<button class="chip" data-st="' + s[0] + '">' + s[1] + '</button>'; }).join('') + '</div>' +
        '<div class="chips" id="cat-chips" style="margin-top:6px">' + cat.map(function (s) { return '<button class="chip" data-cat="' + s[0] + '">' + s[1] + '</button>'; }).join('') + '</div>' +
        '<div class="count-line" id="list-count"></div><ul class="vlist" id="vlist"></ul>';
      var inp = $('#list-search', v), timer = null;
      inp.value = listState.q;
      inp.addEventListener('input', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { listState.q = inp.value; listState.limit = 100; renderListItems(); }, 150);
      });
      $$('[data-st]', v).forEach(function (b) { b.addEventListener('click', function () { listState.status = b.getAttribute('data-st'); listState.limit = 100; renderListItems(); }); });
      $$('[data-cat]', v).forEach(function (b) { b.addEventListener('click', function () { listState.cat = b.getAttribute('data-cat'); listState.limit = 100; renderListItems(); }); });
      $('#vlist', v).addEventListener('click', function (e) {
        var star = e.target.closest('[data-star]');
        if (star) {
          e.stopPropagation();
          toggleFav(star.getAttribute('data-star'));
          star.classList.toggle('on', !!state.favs[star.getAttribute('data-star')]);
          return;
        }
        if (e.target.closest('[data-more]')) { listState.limit += 100; renderListItems(); return; }
        var row = e.target.closest('[data-id]');
        if (row) openDetail(BY_ID[row.getAttribute('data-id')]);
      });
    }
    renderListItems();
  }
  function renderListItems() {
    var v = $('#view-list');
    $$('[data-st]', v).forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-st') === listState.status); });
    $$('[data-cat]', v).forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-cat') === listState.cat); });
    var list = listFiltered();
    $('#list-count').textContent = list.length + '개';
    var html = list.slice(0, listState.limit).map(function (w) {
      var s = statusOf(w.id);
      return '<li class="vitem" data-id="' + w.id + '"><div class="vmain"><div class="ven">' + esc(w.en) + '</div>' +
        '<div class="vko">' + esc(w.ko) + '</div></div>' +
        '<span class="pill ' + s + '">' + STATUS_KO[s] + '</span>' +
        '<button class="star' + (state.favs[w.id] ? ' on' : '') + '" data-star="' + w.id + '" aria-label="즐겨찾기">⭐</button></li>';
    }).join('');
    if (list.length > listState.limit) html += '<li><button class="btn" data-more>더 보기 (' + (list.length - listState.limit) + '개)</button></li>';
    if (!list.length) html = '<li class="muted" style="padding:20px;text-align:center">검색 결과가 없어요</li>';
    $('#vlist').innerHTML = html;
  }
  function toggleFav(id) {
    if (state.favs[id]) delete state.favs[id]; else state.favs[id] = true;
    save();
  }

  /* 항목 상세 시트 */
  function openDetail(w) {
    if (!w) return;
    var r = state.items[w.id], s = statusOf(w.id);
    var srs = r ? '상자 ' + r.b + ' · 다음 복습 ' + (r.d <= today() ? '오늘' : r.d) + ' · 정답 ' + r.c + ' / 오답 ' + r.w : '아직 안 배움';
    var html = '<div class="small muted">' + typeKo(w) + ' · ' + esc(w.pos || '') + ' · ' + esc(w.situation) + ' · 빈도 ' + w.rank + '위</div>' +
      '<div class="detail-en" style="margin:4px 0">' + esc(w.en) + '</div>' +
      (w.ipa ? '<div class="q-ipa">' + esc(w.ipa) + '</div>' : '') +
      '<div style="margin:12px 0" data-always-yg>' + audioRowHTML() + '</div>' +
      '<dl class="kv">' +
        '<dt>뜻</dt><dd style="font-size:20px;font-weight:800;color:var(--accent)">' + esc(w.ko) + '</dd>' +
        '<dt>예문</dt><dd class="en">' + esc(w.example_en) + '</dd><dd class="muted">' + esc(w.example_ko) + '</dd>' +
        (w.tip ? '<dt>팁</dt><dd>' + esc(w.tip) + '</dd>' : '') +
        '<dt>학습 상태</dt><dd><span class="pill ' + s + '">' + STATUS_KO[s] + '</span> <span class="small muted">' + srs + '</span></dd>' +
      '</dl>' +
      '<div class="row"><button class="btn" data-fav>' + (state.favs[w.id] ? '⭐ 즐겨찾기 해제' : '☆ 즐겨찾기') + '</button>' +
      (state.wrong[w.id] ? '<button class="btn" data-unwrong>오답 노트에서 빼기</button>' : '') + '</div>' +
      '<div style="height:10px"></div><button class="btn btn-ghost" data-close>닫기</button>';
    openSheet(html, function (sh) {
      var box = $('[data-always-yg]', sh);
      bindAudio(box, w, false);
      // 상세 화면에서는 YouGlish 버튼을 항상 보여 줌
      var yg = $('[data-yg]', box); yg.hidden = false; $('[data-yglink]', box).href = Voice.youglish(w);
      $('[data-fav]', sh).addEventListener('click', function () { toggleFav(w.id); openDetail(w); if (currentTab === 'list') renderListItems(); });
      var uw = $('[data-unwrong]', sh);
      if (uw) uw.addEventListener('click', function () { delete state.wrong[w.id]; save(); closeSheet(); render(); });
      $('[data-close]', sh).addEventListener('click', closeSheet);
    });
  }

  /* ---------------------------------------------------------
     14. 설정
     --------------------------------------------------------- */
  function switchHTML(key, label) {
    return '<div class="set-row"><label for="sw-' + key + '">' + label + '</label><span class="switch"><input type="checkbox" id="sw-' + key + '" data-sw="' + key + '"' +
      (state.settings[key] ? ' checked' : '') + '><span></span></span></div>';
  }
  function renderSettings() {
    var vs = Voice.stats();
    var html = '<h1 class="page-title">설정</h1>' +
      '<div class="card"><h2>학습</h2>' +
        '<div class="set-row"><label>하루 새 항목</label><div class="seg" id="seg-daily">' +
          CONFIG.DAILY_NEW_OPTIONS.map(function (n) { return '<button data-daily="' + n + '" class="' + (state.settings.dailyNew === n ? 'is-on' : '') + '">' + n + '</button>'; }).join('') +
        '</div></div>' +
        '<p class="small muted" style="margin:4px 0 0">' + TOTAL + '개 ÷ ' + state.settings.dailyNew + '개 = 약 ' + Math.ceil(TOTAL / state.settings.dailyNew) + '일</p>' +
      '</div>' +
      '<div class="card"><h2>소리 · 진동</h2>' +
        switchHTML('sfx', '효과음') +
        '<div class="set-row"><label for="vol">볼륨</label><input id="vol" type="range" min="0" max="1" step="0.05" value="' + state.settings.volume + '"></div>' +
        switchHTML('autoplay', '음성 자동 재생') +
        switchHTML('vibrate', '진동 (안드로이드)') +
        '<div class="chips" style="margin-top:10px">' +
          [['correct', '정답'], ['combo', '5콤보'], ['wrong', '오답'], ['goal', '목표 달성'], ['level', '레벨업'], ['streak', '스트릭']].map(function (s) {
            return '<button class="chip" data-test="' + s[0] + '">▶ ' + s[1] + '</button>';
          }).join('') + '</div>' +
        '<p class="small muted" style="margin:8px 0 0">아이폰 무음 모드에서는 효과음이 작게 나거나 안 날 수 있어요.</p>' +
      '</div>' +
      '<div class="card"><h2>진도 백업</h2>' +
        '<div class="row"><button class="btn" id="btn-export">⬇️ 내보내기</button><button class="btn" id="btn-import">⬆️ 가져오기</button></div>' +
        '<input type="file" id="file-import" accept="application/json,.json" hidden>' +
        '<p class="small muted">폰을 바꿀 때: 내보내기로 받은 JSON 파일을 새 폰에서 가져오기 하세요.</p>' +
        '<div class="row"><button class="btn btn-ghost btn-sm" id="btn-clear-audio">음성 캐시 지우기 (' + vs.found + ')</button>' +
        '<button class="btn btn-ghost btn-sm" id="btn-reset" style="color:var(--bad)">진도 초기화</button></div>' +
      '</div>' +
      '<div class="card about"><h2>정보</h2>' +
        '<p><b>캐나다 회화 500</b> v' + CONFIG.APP_VERSION + ' · 항목 ' + TOTAL + '개 (단어 ' + ITEMS.filter(function (w) { return w.type === 'word'; }).length +
          ' · 숙어·표현 ' + ITEMS.filter(function (w) { return w.type === 'phrase'; }).length + ')</p>' +
        '<p><b>복습 규칙</b> 맞히면 1일 → 3일 → 7일 → 14일 → 30일 뒤 다시 나오고, 틀리면 1일로 돌아가요. 상자 4 이상이면 "외움".</p>' +
        '<p><b>원어민 음성</b> 기계 음성(TTS)은 쓰지 않고 사람이 직접 녹음한 음성만 재생해요. 한 번 들은 음성은 기기에 저장돼 오프라인에서도 들을 수 있어요. 찾은 음성 ' + vs.found + '개 · 없음 ' + vs.none + '개.</p>' +
        '<p><b>라이선스 · 출처</b><br>' +
          '· 단어 발음: <a href="https://en.wiktionary.org" target="_blank" rel="noopener">Wiktionary</a> · <a href="https://commons.wikimedia.org" target="_blank" rel="noopener">Wikimedia Commons</a> 녹음 (CC BY-SA, 녹음자별 표기는 각 파일 페이지), <a href="https://lingualibre.org" target="_blank" rel="noopener">Lingua Libre</a> (CC BY-SA)<br>' +
          '· 사전 조회: <a href="https://dictionaryapi.dev" target="_blank" rel="noopener">Free Dictionary API</a><br>' +
          '· 숙어 예문 음성: <a href="https://tatoeba.org" target="_blank" rel="noopener">Tatoeba</a> (문장 CC BY 2.0 FR, 음성은 녹음자별 라이선스: CC BY 등. 재생 시 녹음자 이름 표시)<br>' +
          '· 영상 발음: <a href="https://youglish.com" target="_blank" rel="noopener">YouGlish</a> (외부 사이트로 연결)</p>' +
        '<p>이 앱은 개인 학습용이며, 음성 파일은 각 출처 서버에서 직접 받아 재생해요.</p>' +
      '</div>';
    var v = $('#view-settings');
    v.innerHTML = html;
    $$('[data-daily]', v).forEach(function (b) {
      b.addEventListener('click', function () { state.settings.dailyNew = parseInt(b.getAttribute('data-daily'), 10); save(); renderSettings(); toast('하루 새 항목 ' + state.settings.dailyNew + '개'); });
    });
    $$('[data-sw]', v).forEach(function (inp) {
      inp.addEventListener('change', function () { state.settings[inp.getAttribute('data-sw')] = inp.checked; save(); Sfx.setVolume(); });
    });
    $('#vol').addEventListener('input', function (e) { state.settings.volume = parseFloat(e.target.value); Sfx.setVolume(); });
    $('#vol').addEventListener('change', function () { save(); Sfx.correct(1); });
    $$('[data-test]', v).forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-test');
        if (k === 'correct') Sfx.correct(1); else if (k === 'combo') Sfx.correct(5); else if (k === 'wrong') Sfx.wrong();
        else if (k === 'goal') { Sfx.goal(); Confetti.burst(); } else if (k === 'level') Sfx.levelUp(); else if (k === 'streak') Sfx.streak();
      });
    });
    $('#btn-export').addEventListener('click', exportProgress);
    $('#btn-import').addEventListener('click', function () { $('#file-import').click(); });
    $('#file-import').addEventListener('change', importProgress);
    $('#btn-clear-audio').addEventListener('click', function () {
      if (!confirm('찾아 둔 음성 주소와 저장된 음성 파일을 지울까요? (진도는 그대로)')) return;
      Voice.clear().then(function () { toast('음성 캐시를 지웠어요'); renderSettings(); });
    });
    $('#btn-reset').addEventListener('click', function () {
      if (!confirm('모든 학습 진도를 지울까요? 되돌릴 수 없어요. (먼저 내보내기를 권장)')) return;
      if (!confirm('정말 초기화할까요?')) return;
      var keep = state.settings;
      state = defaultState(); state.settings = keep; save();
      toast('진도를 초기화했어요'); go('home');
    });
  }

  /* 진도 내보내기 / 가져오기 (JSON 파일) */
  function exportProgress() {
    try {
      var data = { app: 'canada500', exportedAt: new Date().toISOString(), state: state };
      var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'canada500-progress-' + today() + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('진도 파일을 저장했어요');
    } catch (e) { toast('내보내기에 실패했어요'); }
  }
  function importProgress(e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var data = JSON.parse(rd.result);
        var s = data && data.state;
        if (!s || typeof s.items !== 'object') throw new Error('형식 오류');
        if (!confirm('지금 진도를 이 파일(' + Object.keys(s.items).length + '개 학습)로 바꿀까요?')) return;
        store.set(CONFIG.STORAGE_KEY, s);
        state = loadState();
        if (!store.ok()) state = Object.assign(defaultState(), s); // 저장소가 막힌 경우 메모리에만
        save(); toast('진도를 불러왔어요'); go('home');
      } catch (err) { toast('올바른 진도 파일이 아니에요'); }
    };
    rd.onerror = function () { toast('파일을 읽지 못했어요'); };
    rd.readAsText(f);
  }

  /* ---------------------------------------------------------
     15. 학습 세션
     kind: new(새 항목) | review(SRS 복습) | wrong(오답 노트) | practice(자유 연습) | fav(즐겨찾기)
     mode: flash | mean | listen | reverse | blank | mix(섞어서)
     --------------------------------------------------------- */
  var S = null;

  function normText(s) { return String(s || '').toLowerCase().replace(/[’‘`]/g, "'").replace(/[?!.,…]+$/g, '').trim(); }

  /* 예문에서 표현 위치 찾기 (빈칸 채우기용). 정확히 없으면 간단한 활용형(-s, -ed, -ing …)까지 찾음 */
  function findInExample(w) {
    var ex = String(w.example_en || '').replace(/[’‘]/g, "'");
    var base = normText(w.en);
    if (!ex || !base) return null;
    var words = base.split(/\s+/);
    var first = words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var rest = words.slice(1).map(function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('\\s+');
    var stem = first.replace(/e$/, '');
    var forms = [first, first + 's', first + 'es', first + 'ed', first + 'd', first + 'ing', stem + 'ing', first.replace(/y$/, 'ies'), first.replace(/y$/, 'ied')];
    if (/[^aeiou][aeiou][bdgmnprt]$/.test(first)) { var dbl = first + first.slice(-1); forms.push(dbl + 'ed', dbl + 'ing'); }
    var re = new RegExp("(^|[^a-z'])(" + forms.join('|') + ')' + (rest ? '\\s+' + rest : '') + "(?![a-z])", 'i');
    var m = re.exec(ex);
    if (!m) return null;
    var start = m.index + m[1].length;
    return { start: start, end: start + m[0].length - m[1].length, text: ex.slice(start, start + m[0].length - m[1].length), sentence: ex };
  }
  var blankCache = {};
  function canBlank(w) { if (!(w.id in blankCache)) blankCache[w.id] = findInExample(w); return !!blankCache[w.id]; }

  /* 오답 선택지: 같은 type, 비슷한 빈도 순위대에서 뽑음 (너무 쉽지 않게) */
  function distractors(item, field, n) {
    var target = normText(item[field]);
    var firstKo = field === 'ko' ? item.ko.split(/[,·/]/)[0].trim() : null;
    var pool = ITEMS.filter(function (w) {
      if (w.id === item.id || w.type !== item.type || !w[field]) return false;
      if (normText(w[field]) === target) return false;
      if (firstKo && w.ko.split(/[,·/]/)[0].trim() === firstKo) return false;
      return true;
    }).sort(function (a, b) { return Math.abs(a.rank - item.rank) - Math.abs(b.rank - item.rank); });
    var near = shuffle(pool.slice(0, 30));
    var out = [], seen = {};
    seen[target] = 1;
    for (var i = 0; i < near.length && out.length < n; i++) {
      var t = normText(near[i][field]);
      if (seen[t]) continue;
      seen[t] = 1; out.push(near[i]);
    }
    return out;
  }

  function buildItems(kind, opts) {
    opts = opts || {};
    var list = [];
    if (kind === 'new') {
      var n = opts.extra || todayInfo().newLeft;
      list = newItems(opts.situation).slice(0, n);
    } else if (kind === 'review') {
      list = dueItems();
    } else if (kind === 'wrong') {
      list = shuffle(Object.keys(state.wrong).map(function (id) { return BY_ID[id]; }).filter(Boolean)
        .sort(function (a, b) { return state.wrong[b.id].c - state.wrong[a.id].c; }).slice(0, 30));
    } else if (kind === 'practice') {
      var learned = ITEMS.filter(function (w) { return state.items[w.id] && (!opts.situation || w.situation === opts.situation); });
      list = shuffle(shuffle(learned).sort(function (a, b) { return state.items[a.id].b - state.items[b.id].b; }).slice(0, 10));
    } else if (kind === 'fav') {
      list = shuffle(ITEMS.filter(function (w) { return state.favs[w.id]; })).slice(0, 20);
    }
    return list;
  }

  /* 섞어서: 항목마다 쓸 수 있는 방식 중 무작위 */
  function modeFor(item, mode) {
    if (mode !== 'mix') {
      if (mode === 'blank' && !canBlank(item)) return 'mean';
      if (mode === 'listen' && !Voice.cached(item)) return 'mean';
      return mode;
    }
    var opts = ['mean', 'reverse', 'mean', 'reverse'];
    if (canBlank(item)) opts.push('blank', 'blank');
    if (Voice.cached(item)) opts.push('listen');
    return opts[Math.floor(Math.random() * opts.length)];
  }

  function startSession(kind, mode, opts) {
    var items = buildItems(kind, opts);
    if (!items.length) { toast('지금 학습할 항목이 없어요'); return; }
    Voice.stop();
    S = {
      kind: kind, mode: mode, opts: opts || {}, queue: [], idx: 0, uniq: items.length,
      answered: 0, correct: 0, xp: 0, combo: 0, maxCombo: 0, wrongIds: [], retried: {},
      goalHit: false, newCount: 0, revCount: 0, locked: false
    };
    var el = $('#session');
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    if (mode === 'listen') {
      // 듣기 모드: 먼저 음성을 찾아 두고, 음성 없는 항목은 뜻 고르기로 대체
      el.innerHTML = '<div class="s-body" style="text-align:center"><div style="font-size:48px">🎧</div><p class="q-ko">원어민 음성 찾는 중…</p><p class="muted" id="pre-count">0 / ' + items.length + '</p>' +
        '<button class="btn btn-ghost" id="pre-cancel" style="margin-top:20px">취소</button></div>';
      $('#pre-cancel').onclick = function () { S = null; closeSession(); };
      var done = 0, i = 0, my = S;
      var worker = function () {
        if (i >= items.length) return Promise.resolve();
        var it = items[i++];
        return Voice.resolve(it).then(function () {
          done++; var c = $('#pre-count'); if (c) c.textContent = done + ' / ' + items.length;
          return worker();
        });
      };
      Promise.all([worker(), worker(), worker()]).then(function () {
        if (S !== my) return;
        var noAudio = items.filter(function (it) { return !Voice.cached(it); }).length;
        S.queue = items.map(function (it) { return { item: it, mode: modeFor(it, mode) }; });
        if (noAudio) toast('음성이 없는 ' + noAudio + '개는 뜻 고르기로 나와요', 2800);
        nextQuestion();
      });
      return;
    }
    S.queue = items.map(function (it) { return { item: it, mode: modeFor(it, mode) }; });
    nextQuestion();
  }

  function closeSession() {
    Voice.stop();
    $('#session').hidden = true; $('#session').innerHTML = '';
    document.body.style.overflow = '';
    S = null;
    render();
  }

  function sessionShell(q) {
    var pct = Math.round(S.idx / Math.max(1, S.queue.length) * 100);
    return '<div class="s-top">' +
        '<button class="icon-btn" id="s-close" aria-label="그만하기">✕</button>' +
        '<div class="s-progress"><i style="width:' + pct + '%"></i></div>' +
        '<div class="s-count">' + Math.min(S.idx + 1, S.queue.length) + ' / ' + S.queue.length + '</div>' +
      '</div>' +
      '<div class="combo' + (S.combo >= 2 ? ' show' : '') + '" id="combo">🔥 ' + S.combo + ' 콤보</div>' +
      '<div class="s-body" id="s-body"></div>' +
      '<div class="feedback" id="feedback"></div>' +
      '<div class="s-bottom" id="s-bottom"></div>';
  }

  function nextQuestion() {
    if (!S) return;
    if (S.idx >= S.queue.length) { finishSession(); return; }
    var q = S.queue[S.idx];
    S.locked = false;
    var el = $('#session');
    el.innerHTML = sessionShell(q);
    $('#s-close').onclick = function () { if (S.answered) finishSession(); else closeSession(); };
    if (q.mode === 'flash') renderFlash(q); else renderChoice(q);
    // 다음 두 항목 음성 미리 찾기 (자동 재생이 바로 되도록)
    S.queue.slice(S.idx + 1, S.idx + 3).forEach(function (n) { Voice.resolve(n.item); });
  }

  /* 정답/오답 처리 공통 */
  function answer(q, correct) {
    if (!S || S.locked) return null;
    S.locked = true;
    S.answered++;
    var xp = 0;
    if (correct) {
      S.correct++; S.combo++; S.maxCombo = Math.max(S.maxCombo, S.combo);
      xp = CONFIG.XP_CORRECT + (S.combo >= 3 ? 2 * (Math.min(S.combo, 10) - 2) : 0); // 콤보 보너스
    } else {
      S.combo = 0;
      if (S.wrongIds.indexOf(q.item.id) < 0) S.wrongIds.push(q.item.id);
    }
    S.xp += xp;
    var ev = recordAnswer(q.item, correct, { mode: q.mode, kind: S.kind, xp: xp });
    if (ev.introduced) S.newCount++;
    if (ev.reviewed) S.revCount++;
    if (ev.goal) { S.goalHit = true; S.xp += CONFIG.XP_GOAL; }

    // 효과음 · 진동 · 애니메이션
    if (correct) {
      Sfx.correct(S.combo); buzz(15);
      floatXP('+' + xp + ' XP');
      if (S.combo === 10 || (S.combo > 10 && S.combo % 10 === 0)) Confetti.burst(70);
    } else { Sfx.wrong(); buzz(40); }
    var cb = $('#combo');
    if (cb) {
      cb.textContent = '🔥 ' + S.combo + ' 콤보' + (S.combo === 3 ? '!' : S.combo === 5 ? '!!' : S.combo >= 10 ? ' 대박!' : '');
      cb.classList.remove('show'); void cb.offsetWidth;
      if (S.combo >= 2) cb.classList.add('show');
    }
    // 이벤트 알림 (순서대로)
    var later = 450;
    if (ev.streak === 'record') { setTimeout(function () { Sfx.streak(); toast('🔥 ' + state.streak.cur + '일 연속! 최고 기록 경신'); }, later); later += 900; }
    else if (ev.streak === 'extended' && state.streak.cur > 1) { setTimeout(function () { toast('🔥 ' + state.streak.cur + '일 연속 학습 중'); }, later); later += 600; }
    if (ev.levelUp) { setTimeout(function () { Sfx.levelUp(); toast('⬆️ 레벨 업! Lv.' + levelInfo(state.xp).lvl); }, later); later += 900; }
    if (ev.mastered) { setTimeout(function () { Sfx.mastered(); toast('🏅 ‘' + q.item.en + '’ 외웠어요!'); }, later); }
    if (ev.graduated) { setTimeout(function () { toast('✅ 오답 노트 졸업!'); }, later); }

    // 틀린 항목은 세션 뒤쪽에 한 번 더 (같은 항목은 한 번만)
    if (!correct && !S.retried[q.item.id]) {
      S.retried[q.item.id] = true;
      var pos = Math.min(S.queue.length, S.idx + 4);
      S.queue.splice(pos, 0, { item: q.item, mode: q.mode === 'flash' ? 'flash' : modeFor(q.item, S.mode), retry: true });
    }
    return ev;
  }
  function advance(delay) {
    setTimeout(function () { if (!S) return; S.idx++; nextQuestion(); }, delay || 0);
  }
  function floatXP(text) {
    var body = $('#s-body'); if (!body) return;
    var f = document.createElement('div');
    f.className = 'xp-float'; f.textContent = text;
    body.appendChild(f);
    setTimeout(function () { f.remove(); }, 1100);
  }

  function finishSession() {
    if (!S) return;
    Voice.stop();
    var acc = S.answered ? Math.round(S.correct / S.answered * 100) : 0;
    var info = todayInfo();
    var emoji = acc >= 90 ? '🏆' : acc >= 70 ? '🎉' : acc >= 50 ? '👍' : '💪';
    var more = info.due > 0 ? ['review', '복습 ' + info.due + '개 더'] : info.newLeft > 0 ? ['new', '새 항목 ' + info.newLeft + '개 더'] : null;
    var wrongs = S.wrongIds.map(function (id) { return BY_ID[id]; });
    var html = '<div class="s-body"><div class="result">' +
        '<div class="r-emoji">' + emoji + '</div><h2>세션 완료!</h2>' +
        '<div class="stats3">' +
          '<div class="stat"><b>' + acc + '%</b><span>정답률</span></div>' +
          '<div class="stat"><b style="color:var(--gold)">+' + S.xp + '</b><span>XP</span></div>' +
          '<div class="stat"><b>' + S.maxCombo + '</b><span>최고 콤보</span></div>' +
        '</div>' +
        '<p class="muted small" style="margin:12px 0 0">새 항목 ' + S.newCount + '개 · 복습 ' + S.revCount + '개 · 문제 ' + S.answered + '개</p>' +
        (wrongs.length ? '<div class="card" style="text-align:left;margin-top:14px"><h2>다시 볼 항목 (오답 노트에 저장됨)</h2><ul class="list-mini">' + wrongs.map(function (w) {
          return '<li><span class="en">' + esc(w.en) + '</span><span class="muted small" style="text-align:right">' + esc(w.ko) + '</span></li>';
        }).join('') + '</ul></div>' : '') +
      '</div></div>' +
      '<div class="s-bottom">' +
        (more ? '<button class="btn btn-primary" id="r-more">' + more[1] + '</button>' : '') +
        '<button class="btn" id="r-home">홈으로</button>' +
      '</div>';
    var goalHit = S.goalHit;
    $('#session').innerHTML = html;
    $('#r-home').onclick = function () { closeSession(); go('home'); };
    if (more) $('#r-more').onclick = function () { closeSession(); startSession(more[0], more[0] === 'new' ? 'flash' : 'mix'); };
    S.locked = true;
    if (goalHit) setTimeout(celebrate, 300);
  }

  /* 플래시카드: 앞면(영어+음성) → 탭하면 뒷면(뜻·예문). 오른쪽 스와이프 = 알아요, 왼쪽 = 몰라요 */
  function renderFlash(q) {
    var w = q.item, flipped = false, revealed = false;
    $('#s-body').innerHTML =
      '<div class="flash-wrap" id="fw"><div class="flash" id="flash">' +
        '<div class="face front"><span class="sit-tag">' + typeKo(w) + ' · ' + esc(w.situation) + (q.retry ? ' · 다시' : '') + '</span>' +
          '<div class="q-en">' + esc(w.en) + '</div>' + (w.ipa ? '<div class="q-ipa">' + esc(w.ipa) + '</div>' : '') +
          '<div class="tap-hint">탭해서 뜻 보기</div></div>' +
        '<div class="face back"><div class="b-en">' + esc(w.en) + '</div><div class="b-ko">' + esc(w.ko) + '</div>' +
          '<div class="b-ex">' + esc(w.example_en) + '</div><div class="b-exko">' + esc(w.example_ko) + '</div>' +
          (w.tip ? '<div class="b-tip">💡 ' + esc(w.tip) + '</div>' : '') + '</div>' +
      '</div><div class="swipe-tag know">알아요</div><div class="swipe-tag dont">몰라요</div></div>' +
      '<div style="margin-top:14px" id="aud">' + audioRowHTML() + '</div>';
    var bottom = $('#s-bottom');
    bottom.innerHTML = '<div class="row"><button class="btn btn-bad" id="b-dont">← 몰라요</button><button class="btn btn-good" id="b-know">알아요 →</button></div>';
    bindAudio($('#aud'), w, state.settings.autoplay);

    var fw = $('#fw'), fl = $('#flash'), tagK = $('.swipe-tag.know', fw), tagD = $('.swipe-tag.dont', fw);
    function flip() { flipped = !flipped; fl.classList.toggle('flipped', flipped); }
    function resetPos() { fw.style.transition = 'transform .25s ease'; fw.style.transform = ''; tagK.style.opacity = 0; tagD.style.opacity = 0; }
    function fly(dir) {
      fw.style.transition = 'transform .3s ease-in, opacity .3s ease-in';
      fw.style.transform = 'translateX(' + (dir * 130) + '%) rotate(' + (dir * 18) + 'deg)';
      fw.style.opacity = '0';
    }
    function decide(known) {
      if (revealed) { fly(-1); advance(260); return; }
      if (S.locked) return;
      if (!known && !flipped) {
        // 몰라요: 뜻을 먼저 보여 주고 "다음"으로 넘어감
        answer(q, false); revealed = true; resetPos(); flip();
        $('#feedback').className = 'feedback bad'; $('#feedback').textContent = '괜찮아요, 뜻을 보고 넘어가요';
        bottom.innerHTML = '<button class="btn btn-primary" id="b-next">다음 →</button>';
        $('#b-next').onclick = function () { decide(false); };
        return;
      }
      answer(q, known);
      if (known) { $('#feedback').className = 'feedback good'; $('#feedback').textContent = '좋아요!'; }
      fly(known ? 1 : -1);
      advance(known ? 380 : 300);
    }
    $('#b-know').onclick = function () { decide(true); };
    $('#b-dont').onclick = function () { decide(false); };

    var sx = 0, sy = 0, dx = 0, t0 = 0, pid = null, drag = false;
    fw.addEventListener('pointerdown', function (e) {
      if (S.locked && !revealed) return;
      if (e.target.closest('button')) return;
      drag = true; pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; t0 = Date.now();
      fw.style.transition = 'none';
    });
    fw.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== pid) return;
      dx = e.clientX - sx;
      var dy = e.clientY - sy;
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { try { fw.setPointerCapture(pid); } catch (err) { /* 무시 */ } }
      fw.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / 18) + 'deg)';
      tagK.style.opacity = Math.max(0, Math.min(1, dx / 90));
      tagD.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    });
    function end(e) {
      if (!drag || (e && e.pointerId !== pid)) return;
      drag = false;
      var dt = Math.max(1, Date.now() - t0), v = Math.abs(dx) / dt;
      if (Math.abs(dx) > 90 || (Math.abs(dx) > 40 && v > 0.5)) { decide(dx > 0); return; }
      resetPos();
      if (Math.abs(dx) < 8 && Math.abs(e.clientY - sy) < 8 && dt < 600) flip();
    }
    fw.addEventListener('pointerup', end);
    fw.addEventListener('pointercancel', function () { drag = false; resetPos(); });
    S.onKey = function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (revealed) decide(false); else flip(); }
      else if (e.key === 'ArrowRight') decide(true);
      else if (e.key === 'ArrowLeft') decide(false);
    };
  }

  /* 4지선다 (뜻 고르기 · 듣고 고르기 · 한→영 · 빈칸 채우기) */
  function renderChoice(q) {
    var w = q.item, m = q.mode, field = m === 'mean' ? 'ko' : 'en';
    var opts = shuffle([w].concat(distractors(w, field, 3)));
    var head = '', hasAudio = false;
    if (m === 'mean') {
      head = '<div class="q-type">뜻 고르기</div><div class="q-en">' + esc(w.en) + '</div>' + (w.ipa ? '<div class="q-ipa">' + esc(w.ipa) + '</div>' : '') +
        '<div id="aud">' + audioRowHTML() + '</div>';
      hasAudio = true;
    } else if (m === 'reverse') {
      head = '<div class="q-type">알맞은 영어 고르기</div><div class="q-ko">' + esc(w.ko) + '</div><div class="q-hint">' + typeKo(w) + ' · ' + esc(w.situation) + '</div>';
    } else if (m === 'listen') {
      var info = Voice.cached(w);
      head = '<div class="q-type">듣고 고르기' + (info && info.text ? ' · 문장 속에 들어 있는 표현' : '') + '</div>' +
        '<div id="aud" data-hide-sent>' + audioRowHTML({ big: true }) + '</div>';
      hasAudio = true;
    } else if (m === 'blank') {
      var b = blankCache[w.id] || findInExample(w);
      head = '<div class="q-type">빈칸 채우기</div><div class="q-sent">' + esc(b.sentence.slice(0, b.start)) + '<span class="blank" id="blank">&nbsp;</span>' + esc(b.sentence.slice(b.end)) + '</div>' +
        '<button class="btn btn-ghost btn-sm" id="hint">해석 보기</button><div class="q-hint" id="hint-text" hidden>' + esc(w.example_ko) + '</div>';
    }
    if (q.retry) head = '<span class="sit-tag">다시 도전</span>' + head;
    $('#s-body').innerHTML = '<div class="qcard" id="qcard">' + head + '</div>';
    $('#s-bottom').innerHTML = '<div class="choices">' + opts.map(function (o, i) {
      return '<button class="choice' + (field === 'en' ? ' en-choice' : '') + '" data-i="' + i + '"><span class="muted small">' + (i + 1) + '</span>&nbsp; ' + esc(o[field]) + '</button>';
    }).join('') + '</div>';
    if (hasAudio) bindAudio($('#aud'), w, m === 'listen' ? true : state.settings.autoplay);
    var hint = $('#hint');
    if (hint) hint.onclick = function () { $('#hint-text').hidden = false; hint.hidden = true; };

    var buttons = $$('.choice');
    function choose(i) {
      if (!S || S.locked) return;
      var correct = opts[i].id === w.id;
      answer(q, correct);
      buttons.forEach(function (bt, j) {
        bt.disabled = true;
        if (opts[j].id === w.id) bt.classList.add('is-correct');
        else if (j === i) bt.classList.add('is-wrong');
      });
      var card = $('#qcard');
      card.classList.add(correct ? 'correct' : 'wrong');
      var bl = $('#blank');
      if (bl) { bl.className = 'fill'; bl.textContent = blankCache[w.id].text; }
      if (m === 'listen') { var a = $('#aud'); a.removeAttribute('data-hide-sent'); var ci = Voice.cached(w); if (ci) setAudioInfo(a, w, ci); }
      var fb = $('#feedback');
      if (correct) {
        fb.className = 'feedback good';
        fb.textContent = S.combo >= 3 ? '정답! 🔥 ' + S.combo + '연속' : '정답!';
        advance(950);
      } else {
        fb.className = 'feedback bad';
        fb.textContent = '정답: ' + (field === 'ko' ? w.ko : w.en);
        // 작은 화면에서도 "다음" 버튼이 보이도록, 고른 답과 정답만 남기고 나머지 선택지는 숨김
        buttons.forEach(function (bt, j) { if (opts[j].id !== w.id && j !== i) bt.hidden = true; });
        var det = document.createElement('div');
        det.className = 'detail-box';
        det.innerHTML = '<div><span class="en">' + esc(w.en) + '</span> · ' + esc(w.ko) + '</div>' +
          '<div class="d-ex">' + esc(w.example_en) + '</div><div class="muted">' + esc(w.example_ko) + '</div>' +
          (w.tip ? '<div class="small muted">💡 ' + esc(w.tip) + '</div>' : '') +
          (hasAudio ? '' : '<div style="margin-top:8px" id="aud2">' + audioRowHTML() + '</div>');
        card.appendChild(det);
        if (!hasAudio) bindAudio($('#aud2'), w, state.settings.autoplay);
        else if (state.settings.autoplay && m !== 'listen') playInto($('#aud'), w, 1);
        var nx = document.createElement('button');
        nx.className = 'btn btn-primary'; nx.id = 'b-next'; nx.textContent = '다음 →';
        nx.onclick = function () { nx.disabled = true; advance(0); };
        $('#s-bottom').appendChild(nx);
        var body = $('#s-body'); if (body) body.scrollTop = body.scrollHeight;
      }
    }
    buttons.forEach(function (bt, i) { bt.onclick = function () { choose(i); }; });
    S.onKey = function (e) {
      var n = parseInt(e.key, 10);
      if (n >= 1 && n <= buttons.length) choose(n - 1);
      else if (e.key === 'Enter') { var nx = $('#b-next'); if (nx && !nx.disabled) nx.click(); }
    };
  }

  /* ---------------------------------------------------------
     16. 일일 목표 달성 축하 + 내일 미리보기
     --------------------------------------------------------- */
  function celebrate() {
    Sfx.goal(); buzz([60, 40, 60, 40, 160]); Confetti.burst(170);
    var tomorrow = addDays(today(), 1);
    var dueT = ITEMS.filter(function (w) { var r = state.items[w.id]; return r && r.d <= tomorrow; }).length;
    var nextNew = newItems().slice(0, state.settings.dailyNew);
    var c = $('#celebrate');
    c.innerHTML = '<div class="c-emoji">🎉</div><h2>오늘 목표 달성!</h2>' +
      '<p class="muted">+' + CONFIG.XP_GOAL + ' XP 보너스 · 🔥 ' + currentStreak() + '일 연속 · Lv.' + levelInfo(state.xp).lvl + '</p>' +
      '<div class="card" style="text-align:left"><h2>내일 학습 미리보기</h2>' +
        '<div class="stats3" style="grid-template-columns:1fr 1fr"><div class="stat"><b>' + dueT + '</b><span>복습</span></div><div class="stat"><b>' + nextNew.length + '</b><span>새 항목</span></div></div>' +
        (nextNew.length ? '<ul class="list-mini" style="margin-top:8px">' + nextNew.slice(0, 5).map(function (w) {
          return '<li><span class="en">' + esc(w.en) + '</span><span class="muted small">' + esc(w.situation) + '</span></li>';
        }).join('') + (nextNew.length > 5 ? '<li class="muted small">외 ' + (nextNew.length - 5) + '개</li>' : '') + '</ul>' : '') +
      '</div>' +
      '<button class="btn btn-primary" id="c-ok">좋아요!</button>';
    c.hidden = false;
    $('#c-ok').onclick = function () { c.hidden = true; };
  }

  /* 컨페티 (canvas 직접 구현) */
  var Confetti = (function () {
    var cv = null, ctx = null, parts = [], raf = null, W = 0, H = 0;
    var COLORS = ['#d52b1e', '#f2b84b', '#2f6fdb', '#1f9d55', '#ff8fa3', '#8e6cf0'];
    function burst(n) {
      cv = cv || document.getElementById('confetti');
      if (!cv || !cv.getContext) return;
      ctx = ctx || cv.getContext('2d');
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) n = Math.round(n / 4);
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (var i = 0; i < n; i++) {
        parts.push({
          x: W / 2 + (Math.random() - 0.5) * W * 0.4, y: H * 0.38,
          vx: (Math.random() - 0.5) * 13, vy: -Math.random() * 13 - 5,
          w: 6 + Math.random() * 6, h: 9 + Math.random() * 8, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.35,
          c: COLORS[i % COLORS.length], life: 0
        });
      }
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function tick() {
      ctx.clearRect(0, 0, W, H);
      parts = parts.filter(function (p) { return p.y < H + 40 && p.life < 260; });
      parts.forEach(function (p) {
        p.vy += 0.3; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life++;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.scale(1, Math.cos(p.life / 6));
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      });
      if (parts.length) raf = requestAnimationFrame(tick);
      else { raf = null; ctx.clearRect(0, 0, W, H); }
    }
    return { burst: burst };
  })();

  /* ---------------------------------------------------------
     17. 시작
     --------------------------------------------------------- */
  function init() {
    // 첫 터치 때 오디오 활성화 (iOS 사파리)
    var unlock = function () {
      Sfx.unlock(); Voice.unlock();
      ['touchend', 'click', 'keydown'].forEach(function (ev) { document.removeEventListener(ev, unlock, true); });
    };
    ['touchend', 'click', 'keydown'].forEach(function (ev) { document.addEventListener(ev, unlock, true); });
    // 핀치 확대 방지 (iOS)
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });

    $$('.tab').forEach(function (t) { t.addEventListener('click', function () { go(t.getAttribute('data-tab')); }); });
    $('#sheet-backdrop').addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (!$('#celebrate').hidden) $('#celebrate').hidden = true; else if (!$('#sheet').hidden) closeSheet(); return; }
      if (S && S.onKey && !$('#session').hidden && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) S.onKey(e);
    });
    // 날짜가 바뀌면 홈 갱신
    var lastDay = today();
    function refreshIfNewDay() { if (today() !== lastDay) { lastDay = today(); if (!S) render(); } }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshIfNewDay(); });
    setInterval(refreshIfNewDay, 60000);

    if (!store.ok()) showBanner('⚠️ 이 브라우저에서는 진도를 저장할 수 없어요 (개인정보 보호 모드?). 설정 > 내보내기로 백업하세요.');
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* 무시 */ }
    // 서비스 워커 (오프라인 · 홈 화면 앱)
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 미리보기 환경 등에서는 실패해도 무시 */ });
    }
    render();
  }

  // 예기치 못한 오류가 나도 앱이 멈추지 않게
  window.addEventListener('error', function (e) { try { console.warn('[app error]', e.message); } catch (x) { /* 무시 */ } });
  window.addEventListener('unhandledrejection', function (e) { try { e.preventDefault(); } catch (x) { /* 무시 */ } });

  // 테스트·디버깅용
  window.__app = { CONFIG: CONFIG, ITEMS: ITEMS, state: function () { return state; }, todayInfo: todayInfo, recordAnswer: recordAnswer,
    findInExample: findInExample, distractors: distractors, Voice: Voice, levelInfo: levelInfo, startSession: startSession, go: go };

  try { init(); } catch (e) {
    showBanner('앱을 시작하지 못했어요: ' + e.message);
  }
})();
