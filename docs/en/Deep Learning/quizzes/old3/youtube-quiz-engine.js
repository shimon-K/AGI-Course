/* ═══════════════════════════════════════════════════════════════
   youtube-quiz-engine.js  (v3)

   Global config read from the HTML page:
     VIDEO_ID, BACKGROUND, GROUPS, MOODLE
     DEFAULT_TIME_GAP  — seconds between auto-timed groups (default 10)

   Question types:
     (text input)  { x, y, w, ans, tol?, fs?, opacity? }
     label         { type:'label',    x, y, text, fs?, color?, opacity? }
     match         { type:'match',    x, y, w, left[], right[], ans[], dotSize?, dotGap?, colGap?, fs? }
                   — many-to-one: multiple left items may map to the same right item
     radio         { type:'radio',    x, y, w, choices[], ans (index), fs? }
     checkbox      { type:'checkbox', x, y, w, choices[], ans (index[]), fs? }
     image         { type:'image',    x, y, w, h, src, alt?, borderRadius?, border?, objectFit? }
     ordering      { type:'ordering', x, y, w, items[], ans (index[]), fs? }
     hotspot       { type:'hotspot',  x, y, w, h, src, spots[], ans (index or index[]), fs? }
     slider        { type:'slider',   x, y, w, min, max, step?, ans, tol?, unit?, fs? }
     cloze         { type:'cloze',    x, y, w, parts[], fs?, lineSpacing? }
                   — parts: mix of strings and { blank, ans, w?, h?, fs?, fontFamily?, type?, options? }
                   — blank type: 'text' (default), 'select' (dropdown), or 'open' (textarea)
                   — h (height in px): when set on a blank, renders a textarea for open-ended answers
                   — open-ended blanks are evaluated via AI after submit (green/red markup)
                   — OR template string + blanks array (for LaTeX-embedded blanks)

   AI Assistant (per group):
     Each question group gets an AI assistant icon that offers:
       Guide — step-by-step guidance toward the answer
       Hint  — a short clue without giving the answer away
       Chat  — free-form dialogue about the questions

   AI Configuration (optional):
     Default: Pollinations.ai free API (no key required).
     Override: set AI_CONFIG = { provider, endpoint, model, apiKey }
       provider: 'pollinations' (default) | 'anthropic' | 'openai'
     combobox      { type:'combobox', x, y, w, options[], ans, fs? }

   Bubble attributes (group.bubble or group.bubbles[]):
     x, y, w, h, text, style ('box'|'bubble'), bg, color, borderColor,
     borderRadius, fontSize/fs, padding, fontFamily,
     tail        — direction: top|bottom|left|right|top-left|top-right|bottom-left|bottom-right
     tailSize    — length in px  (default 11)
     tailOffset  — position along edge in % (default 50)

   LaTeX: wrap expressions in $...$ (inline) or $$...$$ (display).
          Requires KaTeX loaded in the HTML page.

   Newlines: use \n or <br> in any text string.  lineSpacing (number)
             sets line-height on the container.
   ═══════════════════════════════════════════════════════════════ */

/* ─── Helpers ──────────────────────────────────────────────────── */
var _timeGap = (typeof DEFAULT_TIME_GAP === 'number') ? DEFAULT_TIME_GAP : 10;
var _postQuizDuration = (typeof POST_QUIZ_DURATION === 'number') ? POST_QUIZ_DURATION : null; // NEW VARIABLE

function _fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
}

/** Render LaTeX ($...$, $$...$$) and newlines in a string → HTML */
function renderText(str) {
  if (typeof str !== 'string') return '';
  /* newlines */
  var html = str.replace(/\\n/g, '<br>').replace(/<\\?br\\?>/g, '<br>');
  /* display math $$...$$ */
  html = html.replace(/\$\$([^$]+?)\$\$/g, function (_, tex) {
    return _katex(tex, true);
  });
  /* inline math $...$ */
  html = html.replace(/\$([^$]+?)\$/g, function (_, tex) {
    return _katex(tex, false);
  });
  return html;
}

function _katex(tex, displayMode) {
  if (typeof katex !== 'undefined') {
    try {
      return katex.renderToString(tex, {
        displayMode: displayMode,
        throwOnError: false,
        trust: true,
        strict: false
      });
    } catch (e) { /* fall through */ }
  }
  return (displayMode ? '$$' : '$') + tex + (displayMode ? '$$' : '$');
}

/** Set innerHTML with rendered LaTeX + newlines */
function setRenderedText(el, text) {
  el.innerHTML = renderText(text);
}

/** Visual helpers */
function getBgOpacity(el) {
  return el.dataset.bgOpacity !== undefined ? parseFloat(el.dataset.bgOpacity) : 1;
}
function applyBg(el, status) {
  var a = getBgOpacity(el);
  if      (status === 'ok') el.style.background = 'rgba(39,174,96,'  + Math.max(0.18, a) + ')';
  else if (status === 'no') el.style.background = 'rgba(231,76,60,'  + Math.max(0.15, a) + ')';
  else                      el.style.background = 'rgba(255,255,255,' + a + ')';
}

/* ─── Detect blank-background mode ──────────────────────────────── */
var _bgMode     = (typeof BACKGROUND !== 'undefined' && BACKGROUND.enabled);
var _bgStartMs  = null;
var _bgBaseTime = 0;
var _bgPlaying  = false;
var _bgSpeed    = 1;

/* ─── Core DOM refs ─────────────────────────────────────────────── */
var ytFrame   = document.getElementById('yt-player');
var overlay   = document.getElementById('overlay-layer');
var videoWrap = document.getElementById('video-wrap');

/* ─── Set up iframe OR blank canvas ─────────────────────────────── */
(function () {
  if (_bgMode) {
    ytFrame.style.display = 'none';
    var bgCanvas = document.createElement('div');
    bgCanvas.id = 'bg-canvas';
    bgCanvas.style.background = (BACKGROUND.color || '#1a1a2e');
    if (BACKGROUND.image) {
      bgCanvas.style.backgroundImage    = 'url(' + BACKGROUND.image + ')';
      bgCanvas.style.backgroundSize     = 'cover';
      bgCanvas.style.backgroundPosition = 'center';
    }
    videoWrap.insertBefore(bgCanvas, ytFrame);

    var bgCtrl = document.createElement('div');
    bgCtrl.id = 'bg-controls';
    bgCtrl.innerHTML =
      '<button id="bg-play-btn">&#9654;</button>' +
      '<div id="bg-timeline"><div id="bg-progress"></div></div>' +
      '<span id="bg-time-display">0:00 / ' + _fmtTime(BACKGROUND.duration || 0) + '</span>' +
      '<button id="bg-speed-btn">Speed X1</button>';
    videoWrap.appendChild(bgCtrl);

    document.getElementById('bg-play-btn').addEventListener('click', function () {
      if (_bgPlaying) _bgPause(); else _bgPlay();
    });
    document.getElementById('bg-speed-btn').addEventListener('click', _bgCycleSpeed);
    document.getElementById('bg-timeline').addEventListener('click', function (e) {
      var rect = this.getBoundingClientRect();
      var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      _bgBaseTime = pct * (BACKGROUND.duration || 300);
      if (_bgPlaying) _bgStartMs = Date.now();
    });

    if (BACKGROUND.autoPlay) setTimeout(_bgPlay, 300);
  } else if (typeof VIDEO_ID !== 'undefined' && VIDEO_ID) {
    ytFrame.src = 'https://www.youtube.com/embed/' + VIDEO_ID +
      '?enablejsapi=1&controls=1&rel=0&modestbranding=1';
  }
})();

/* ─── Blank-background timer ────────────────────────────────────── */
function _bgGetCurrentTime() {
  if (_bgPlaying && _bgStartMs !== null)
    return _bgBaseTime + (Date.now() - _bgStartMs) / 1000 * _bgSpeed;
  return _bgBaseTime;
}

var _bgSpeedSteps  = [1, 1.5, 2, 4];
var _bgSpeedLabels = ['Speed X1', 'Speed X1.5', 'Speed X2', 'Speed X4'];
var _bgSpeedIdx    = 0;

function _bgCycleSpeed() {
  if (_bgPlaying) { _bgBaseTime = _bgGetCurrentTime(); _bgStartMs = Date.now(); }
  _bgSpeedIdx = (_bgSpeedIdx + 1) % _bgSpeedSteps.length;
  _bgSpeed = _bgSpeedSteps[_bgSpeedIdx];
  var btn = document.getElementById('bg-speed-btn');
  if (btn) btn.textContent = _bgSpeedLabels[_bgSpeedIdx];
}

function _bgPlay() {
  if (_bgPlaying) return;
  _bgPlaying = true;
  _bgStartMs = Date.now();
  ytState = 1;
  var btn = document.getElementById('bg-play-btn');
  if (btn) btn.innerHTML = '&#9646;&#9646;';
  var notice = document.getElementById('pause-notice');
  if (notice) notice.classList.remove('on');
  if (activeId) { var ag = groupById(activeId); if (ag) hideGroup(ag); activeId = null; }
  document.querySelectorAll('.quiz-bubble.show').forEach(function (el) { el.classList.remove('show'); });
}

function _bgPause() {
  if (!_bgPlaying) return;
  _bgBaseTime = _bgGetCurrentTime();
  _bgPlaying = false;
  _bgStartMs = null;
  ytState = 2;
  var btn = document.getElementById('bg-play-btn');
  if (btn) btn.innerHTML = '&#9654;';
}

/* ─── Auto-generate IDs & default times ─────────────────────────── */
var _qn = 0;
GROUPS.forEach(function (g, gi) {
  if (!g.id) g.id = 'g' + gi;

  /* default time: first group → 5s, others → prev.time + gap */
  if (g.time === undefined) {
    if (gi === 0) g.time = 5;
    else          g.time = GROUPS[gi - 1].time + _timeGap;
  }

  g.questions.forEach(function (q) {
    if (!q.id) q.id = 'q' + (_qn++);
    if (q.type === 'label' || q.type === 'image') return;

    q.bestCorrect = false;

    if (q.type === 'match') {
      q.userAns = new Array(q.left.length).fill(-1);
    } else if (q.type === 'radio') {
      q.userAns = -1;
    } else if (q.type === 'checkbox') {
      q.userAns = [];
    } else if (q.type === 'ordering') {
      q.userAns = q.items.map(function (_, i) { return i; });
    } else if (q.type === 'hotspot') {
      q.userAns = Array.isArray(q.ans) ? [] : -1;
    } else if (q.type === 'slider') {
      q.userAns = q.min !== undefined ? q.min : 0;
    } else if (q.type === 'cloze') {
      _initClozeBlanks(q);
    } else if (q.type === 'combobox') {
      q.userAns = '';
    }
  });
});

/* ─── Auto-calculate BACKGROUND duration ────────────────────────── */
if (_bgMode && typeof POST_QUIZ_DURATION === 'number' && GROUPS.length > 0) {
  var lastGroupTime = GROUPS[GROUPS.length - 1].time;
  BACKGROUND.duration = lastGroupTime + POST_QUIZ_DURATION;
  
  // Update the initial UI display with the newly calculated duration
  var disp = document.getElementById('bg-time-display');
  if (disp) {
    disp.textContent = '0:00 / ' + _fmtTime(BACKGROUND.duration);
  }
}

/** Initialise cloze blanks from either parts[] or template+blanks */
function _initClozeBlanks(q) {
  q._blanks = [];
  if (q.template && q.blanks) {
    /* template mode */
    q.blanks.forEach(function (b, i) {
      q._blanks.push({ idx: i, ans: (b.ans + '').trim(), userAns: '', cfg: b });
    });
  } else if (q.parts) {
    var bi = 0;
    q.parts.forEach(function (p, pi) {
      if (typeof p === 'object' && p.blank) {
        q._blanks.push({ idx: pi, ans: (p.ans + '').trim(), userAns: '', cfg: p });
        p._bi = bi++;
      }
    });
  }
}

/* ─── Global state ──────────────────────────────────────────────── */
var ytState      = -1;
var ytTime       = 0;
var ytDuration   = 0;
var activeId     = null;
var summaryShown = false;

/* ══════════════════════════════════════════════════════════════════
   ANSWER CHECKING
   ══════════════════════════════════════════════════════════════════ */
function checkAnswer(q) {
  if (q.type === 'match') {
    for (var i = 0; i < q.ans.length; i++) {
      if (q.userAns[i] !== q.ans[i]) return false;
    }
    return true;
  }
  if (q.type === 'radio') return q.userAns === q.ans;

  if (q.type === 'checkbox') {
    var sa = q.ans.slice().sort(), su = (q.userAns || []).slice().sort();
    if (sa.length !== su.length) return false;
    for (var j = 0; j < sa.length; j++) { if (sa[j] !== su[j]) return false; }
    return true;
  }
  if (q.type === 'ordering') {
    if (!q.userAns || q.userAns.length !== q.ans.length) return false;
    for (var k = 0; k < q.ans.length; k++) { if (q.userAns[k] !== q.ans[k]) return false; }
    return true;
  }
  if (q.type === 'hotspot') return _checkHotspot(q);
  if (q.type === 'slider') {
    var tol = typeof q.tol === 'number' ? q.tol : 0;
    return Math.abs(q.userAns - q.ans) <= tol;
  }
  if (q.type === 'cloze') return _checkCloze(q);
  if (q.type === 'combobox') {
    var sel = document.getElementById('cb-' + q.id);
    return sel && sel.value.trim().toLowerCase() === (q.ans + '').trim().toLowerCase();
  }
  /* default: text input */
  var inp = document.getElementById('i-' + q.id);
  if (!inp) return false;
  var val = inp.value.trim(), correct = (q.ans + '').trim();
  if (typeof q.tol === 'number') {
    var uNum = parseFloat(val), cNum = parseFloat(correct);
    return !isNaN(uNum) && !isNaN(cNum) && Math.abs(uNum - cNum) <= q.tol;
  }
  return val.toLowerCase() === correct.toLowerCase();
}

function _checkHotspot(q) {
  if (Array.isArray(q.ans)) {
    var sa = q.ans.slice().sort(), su = (q.userAns || []).slice().sort();
    if (sa.length !== su.length) return false;
    for (var i = 0; i < sa.length; i++) { if (sa[i] !== su[i]) return false; }
    return true;
  }
  return q.userAns === q.ans;
}

/** Check cloze & sync DOM values into blanks */
function _checkCloze(q) {
  var allOk = true;
  var hasOpenBlanks = false;
  q._blanks.forEach(function (bObj, bi) {
    var el = document.getElementById('cloze-' + q.id + '-' + bi);
    if (!el) { allOk = false; return; }
    bObj.userAns = (el.tagName === 'SELECT' ? el.value : el.value).trim();

    /* open-ended blanks — defer to AI evaluation */
    if (el.dataset.open === '1') {
      hasOpenBlanks = true;
      if (!bObj.userAns) allOk = false;
      return; /* skip exact-match check */
    }

    /* short-phrase resemblance (up to 3 words) */
    var userWords = bObj.userAns.toLowerCase().split(/\s+/).filter(Boolean);
    var ansWords  = bObj.ans.toLowerCase().split(/\s+/).filter(Boolean);
    if (ansWords.length <= 3 && userWords.length <= 3) {
      if (!_resembles(bObj.userAns, bObj.ans)) allOk = false;
    } else {
      if (bObj.userAns.toLowerCase() !== bObj.ans.toLowerCase()) allOk = false;
    }
  });
  if (hasOpenBlanks) q._hasOpenBlanks = true;
  return allOk;
}

/** Fuzzy resemblance check for short phrases (up to 3 words).
    Uses normalized Levenshtein on each word pair. */
function _resembles(userStr, correctStr) {
  var uWords = userStr.toLowerCase().split(/\s+/).filter(Boolean);
  var cWords = correctStr.toLowerCase().split(/\s+/).filter(Boolean);
  if (uWords.length !== cWords.length) {
    /* allow minor word-count difference */
    if (Math.abs(uWords.length - cWords.length) > 1) return false;
  }
  var len = Math.max(uWords.length, cWords.length);
  var matchCount = 0;
  var used = {};
  for (var i = 0; i < uWords.length; i++) {
    for (var j = 0; j < cWords.length; j++) {
      if (used[j]) continue;
      if (_wordSimilarity(uWords[i], cWords[j]) >= 0.7) {
        matchCount++; used[j] = true; break;
      }
    }
  }
  return matchCount >= Math.ceil(len * 0.7);
}

function _wordSimilarity(a, b) {
  if (a === b) return 1;
  var maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - (_levenshtein(a, b) / maxLen);
}

function _levenshtein(a, b) {
  var m = a.length, n = b.length;
  var dp = [];
  for (var i = 0; i <= m; i++) {
    dp[i] = [i];
    for (var j = 1; j <= n; j++) {
      dp[i][j] = i === 0 ? j :
        Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
    }
  }
  return dp[m][n];
}

/** Per-blank feedback colouring */
function _feedbackCloze(q) {
  q._blanks.forEach(function (bObj, bi) {
    var el = document.getElementById('cloze-' + q.id + '-' + bi);
    if (!el) return;

    /* open-ended blanks — show 'pending' style; AI will update later */
    if (el.dataset.open === '1') {
      el.classList.remove('ok', 'no');
      el.classList.add('ai-pending');
      return;
    }

    /* short-phrase resemblance */
    var uWords = bObj.userAns.toLowerCase().split(/\s+/).filter(Boolean);
    var aWords = bObj.ans.toLowerCase().split(/\s+/).filter(Boolean);
    var ok;
    if (aWords.length <= 3 && uWords.length <= 3) {
      ok = _resembles(bObj.userAns, bObj.ans);
    } else {
      ok = bObj.userAns.toLowerCase() === bObj.ans.toLowerCase();
    }
    el.classList.remove('ok', 'no');
    el.classList.add(ok ? 'ok' : 'no');
  });
}

/* ─── YouTube postMessage helpers ───────────────────────────────── */
function ytPost(func, args) {
  if (!ytFrame || !ytFrame.contentWindow) return;
  ytFrame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), '*');
}
  
function pauseVideo() {
  if (_bgMode) _bgPause(); else ytPost('pauseVideo');
}

// NEW FUNCTION BELOW
function playVideo() {
  if (_bgMode) _bgPlay(); else ytPost('playVideo');
}

/* ─── YouTube postMessage listener ─────────────────────────────── */
window.addEventListener('message', function (e) {
  if (_bgMode) return;
  var data;
  try { data = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data; } catch (err) { return; }

  var newState = null;
  if (data.event === 'infoDelivery' && data.info) {
    if (typeof data.info.currentTime === 'number') ytTime    = data.info.currentTime;
    if (typeof data.info.playerState === 'number') newState  = data.info.playerState;
    if (typeof data.info.duration    === 'number' && data.info.duration > 0) ytDuration = data.info.duration;
  }
  if (data.event === 'onStateChange') newState = data.info;

  if (newState === 1 && ytState !== 1) {
    document.querySelectorAll('.q-wrap.show, .match-wrap.show, .q-mc-wrap.show, .q-image-wrap.show, .q-ordering-wrap.show, .q-hotspot-wrap.show, .q-slider-wrap.show, .q-cloze-wrap.show, .q-combo-wrap.show')
      .forEach(function (el) { el.classList.remove('show'); });
    document.querySelectorAll('.bottom-bar.show, .group-tag.show, .quiz-bubble.show')
      .forEach(function (el) { el.classList.remove('show'); });
    var notice = document.getElementById('pause-notice');
    if (notice) notice.classList.remove('on');
    var sum = document.getElementById('quiz-summary');
    if (sum) sum.classList.remove('show');
    activeId = null;
  }
  if (newState !== null) ytState = newState;
});

if (ytFrame) {
  ytFrame.addEventListener('load', function () {
    ytFrame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1 }), '*');
  });
}

/* ─── Keyboard Play/Pause Listener ──────────────────────────────── */
document.addEventListener('keydown', function(e) {
  // Prevent triggering when the user is typing in a quiz input
  var tag = e.target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;

  // Check for Space bar
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault(); // Prevents the page from scrolling down
    if (_bgMode) {
      if (_bgPlaying) _bgPause(); else _bgPlay();
    } else {
      if (ytState === 1) { // 1 = playing
        pauseVideo();
      } else {
        playVideo();
      }
    }
  }
});

/* ─── Summary overlay element ───────────────────────────────────── */
var summaryEl = document.createElement('div');
summaryEl.id = 'quiz-summary';
videoWrap.appendChild(summaryEl);

/* ══════════════════════════════════════════════════════════════════
   MATCH WIDGET — aligned rows, configurable column gap
   ══════════════════════════════════════════════════════════════════ */
var _drag = null;

function buildMatchWidget(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'match-wrap';
  wrap.id = 'w-' + q.id;
  wrap.style.cssText = 'left:' + q.x + '%;top:' + q.y + '%;';

  var box = document.createElement('div');
  box.className = 'match-box';
  box.id = 'mb-' + q.id;
  if (q.w) box.style.width = q.w + 'px';

  var bgOpacity = (typeof q.opacity === 'number') ? q.opacity : 1;
  box.style.background  = 'rgba(255,255,255,' + bgOpacity + ')';
  box.dataset.bgOpacity = bgOpacity;

  var svgNS = 'http://www.w3.org/2000/svg';
  var svg   = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'match-svg');
  svg.id = 'ms-' + q.id;

  var baseFontSize = q.fs  || 11;
  var dSize  = q.dotSize || 14;
  var dGap   = q.dotGap  || 10;
  var colGap = q.colGap  || 40;

  /* Use a grid so rows align across columns */
  var rowCount = Math.max(q.left.length, q.right.length);
  var grid = document.createElement('div');
  grid.className = 'match-grid';
  grid.style.columnGap = colGap + 'px';
  grid.style.rowGap    = dGap + 'px';
  grid.style.gridTemplateRows = 'repeat(' + rowCount + ', auto)';

  q._dots = { left: [], right: [] };

  for (var r = 0; r < rowCount; r++) {
    /* left cell */
    var lCell = document.createElement('div');
    lCell.className = 'match-cell match-cell-left';
    if (r < q.left.length) {
      lCell.style.fontSize = baseFontSize + 'px';
      var lSpan = document.createElement('span');
      lSpan.innerHTML = renderText(q.left[r]);
      var lDot = _matchDot(q, 'left', r, dSize);
      lCell.appendChild(lSpan);
      lCell.appendChild(lDot);
      q._dots.left.push(lDot);
    }
    grid.appendChild(lCell);

    /* right cell */
    var rCell = document.createElement('div');
    rCell.className = 'match-cell match-cell-right';
    if (r < q.right.length) {
      rCell.style.fontSize = baseFontSize + 'px';
      var rDot = _matchDot(q, 'right', r, dSize);
      var rSpan = document.createElement('span');
      rSpan.innerHTML = renderText(q.right[r]);
      rCell.appendChild(rDot);
      rCell.appendChild(rSpan);
      q._dots.right.push(rDot);
    }
    grid.appendChild(rCell);
  }

  box.appendChild(svg);
  box.appendChild(grid);
  wrap.appendChild(box);
  overlay.appendChild(wrap);
}

function _matchDot(q, side, idx, size) {
  var dot = document.createElement('div');
  dot.className  = 'match-dot';
  dot.style.width  = size + 'px';
  dot.style.height = size + 'px';
  dot.dataset.qid  = q.id;
  dot.dataset.side = side;
  dot.dataset.idx  = idx;
  return dot;
}

function dotCenter(dot, svg) {
  var dr = dot.getBoundingClientRect(), sr = svg.getBoundingClientRect();
  return { x: dr.left + dr.width / 2 - sr.left, y: dr.top + dr.height / 2 - sr.top };
}

function findQ(qid) {
  for (var gi = 0; gi < GROUPS.length; gi++)
    for (var qi = 0; qi < GROUPS[gi].questions.length; qi++)
      if (GROUPS[gi].questions[qi].id === qid) return GROUPS[gi].questions[qi];
  return null;
}

function disconnectLeft(q, li) {
  var ri = q.userAns[li]; if (ri < 0) return;
  q.userAns[li] = -1;
  q._dots.left[li].classList.remove('connected');
  /* only remove right dot highlight if no other left item still points to it */
  var stillUsed = false;
  for (var i = 0; i < q.userAns.length; i++) {
    if (q.userAns[i] === ri) { stillUsed = true; break; }
  }
  if (!stillUsed) q._dots.right[ri].classList.remove('connected');
  redrawMatchLines(q);
}
function disconnectRight(q, ri) {
  var changed = false;
  for (var i = 0; i < q.userAns.length; i++) {
    if (q.userAns[i] === ri) {
      q.userAns[i] = -1;
      q._dots.left[i].classList.remove('connected');
      changed = true;
    }
  }
  if (changed) {
    q._dots.right[ri].classList.remove('connected');
    redrawMatchLines(q);
  }
}
function connectPair(q, li, ri) {
  if (q.userAns[li] >= 0) disconnectLeft(q, li);
  /* many-to-one: do NOT disconnect other left items from the same right item */
  q.userAns[li] = ri;
  q._dots.left[li].classList.add('connected');
  q._dots.right[ri].classList.add('connected');
  redrawMatchLines(q);
}
function redrawMatchLines(q) {
  var svg = document.getElementById('ms-' + q.id);
  var svgNS = 'http://www.w3.org/2000/svg';
  svg.querySelectorAll('line.conn, line.ok-line, line.no-line').forEach(function (l) { l.remove(); });
  q.userAns.forEach(function (ri, li) {
    if (ri < 0) return;
    var p1 = dotCenter(q._dots.left[li], svg);
    var p2 = dotCenter(q._dots.right[ri], svg);
    var line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
    line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
    line.setAttribute('class', 'conn');
    svg.appendChild(line);
  });
}

/* match drag listeners */
document.addEventListener('mousedown', function (e) {
  var dot = e.target.closest('.match-dot');
  if (!dot || dot.closest('[data-locked]')) return;
  e.preventDefault();
  var q = findQ(dot.dataset.qid); if (!q) return;
  var side = dot.dataset.side, idx = parseInt(dot.dataset.idx);
  if (side === 'left')  disconnectLeft(q, idx);
  /* right-side drag: don't disconnect — many-to-one allows multiple connections */
  dot.classList.add('dragging');
  var svg = document.getElementById('ms-' + q.id);
  var svgNS = 'http://www.w3.org/2000/svg';
  var p = dotCenter(dot, svg);
  var tl = document.createElementNS(svgNS, 'line');
  tl.setAttribute('x1', p.x); tl.setAttribute('y1', p.y);
  tl.setAttribute('x2', p.x); tl.setAttribute('y2', p.y);
  tl.setAttribute('class', 'temp');
  svg.appendChild(tl);
  _drag = { q: q, side: side, idx: idx, dot: dot, svg: svg, line: tl };
});
document.addEventListener('mousemove', function (e) {
  if (!_drag) return;
  var sr = _drag.svg.getBoundingClientRect();
  _drag.line.setAttribute('x2', e.clientX - sr.left);
  _drag.line.setAttribute('y2', e.clientY - sr.top);
});
document.addEventListener('mouseup', function (e) {
  if (!_drag) return;
  _drag.dot.classList.remove('dragging');
  _drag.line.remove();
  var target = e.target.closest('.match-dot');
  if (target && target.dataset.qid === _drag.q.id && target.dataset.side !== _drag.side) {
    var li = _drag.side === 'left'  ? _drag.idx : parseInt(target.dataset.idx);
    var ri = _drag.side === 'right' ? _drag.idx : parseInt(target.dataset.idx);
    connectPair(_drag.q, li, ri);
  }
  _drag = null;
});
/* touch support for match */
document.addEventListener('touchstart', function (e) {
  var dot = e.target.closest('.match-dot');
  if (!dot || dot.closest('[data-locked]')) return;
  e.preventDefault();
  document.dispatchEvent(new MouseEvent('mousedown', {
    clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, target: dot, bubbles: true
  }));
}, { passive: false });
document.addEventListener('touchmove', function (e) {
  if (!_drag) return;
  e.preventDefault();
  var sr = _drag.svg.getBoundingClientRect();
  _drag.line.setAttribute('x2', e.touches[0].clientX - sr.left);
  _drag.line.setAttribute('y2', e.touches[0].clientY - sr.top);
}, { passive: false });
document.addEventListener('touchend', function (e) {
  if (!_drag) return;
  var touch = e.changedTouches[0];
  var target = document.elementFromPoint(touch.clientX, touch.clientY);
  if (target) target = target.closest('.match-dot');
  _drag.dot.classList.remove('dragging');
  _drag.line.remove();
  if (target && target.dataset.qid === _drag.q.id && target.dataset.side !== _drag.side) {
    var li = _drag.side === 'left'  ? _drag.idx : parseInt(target.dataset.idx);
    var ri = _drag.side === 'right' ? _drag.idx : parseInt(target.dataset.idx);
    connectPair(_drag.q, li, ri);
  }
  _drag = null;
});

/* ══════════════════════════════════════════════════════════════════
   MULTIPLE-CHOICE WIDGET (radio / checkbox) — no outer box
   ══════════════════════════════════════════════════════════════════ */
function buildMCWidget(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-mc-wrap';
  wrap.id = 'w-' + q.id;

  var css = 'left:' + q.x + '%;top:' + q.y + '%;';
  if (q.w) css += 'width:' + q.w + '%;';
  wrap.style.cssText = css;

  if (q.bg)          wrap.style.background   = q.bg;
  if (q.borderColor) wrap.style.borderColor  = q.borderColor;
  if (q.borderRadius !== undefined) wrap.style.borderRadius = q.borderRadius + 'px';

  if (q.question) {
    var qEl = document.createElement('div');
    qEl.className = 'q-mc-question';
    setRenderedText(qEl, q.question);
    if (q.fs)    qEl.style.fontSize = q.fs + 'px';
    if (q.color) qEl.style.color    = q.color;
    wrap.appendChild(qEl);
  }

  var isMulti = (q.type === 'checkbox');
  q.choices.forEach(function (choice, i) {
    var opt = document.createElement('label');
    opt.className   = 'q-mc-option';
    opt.dataset.idx = i;

    var inp  = document.createElement('input');
    inp.type  = isMulti ? 'checkbox' : 'radio';
    inp.name  = 'mc-' + q.id;
    inp.value = i;
    inp.addEventListener('change', function () {
      if (isMulti) {
        var checked = [];
        wrap.querySelectorAll('input:checked').forEach(function (cb) { checked.push(parseInt(cb.value)); });
        q.userAns = checked.sort(function (a, b) { return a - b; });
      } else {
        q.userAns = parseInt(this.value);
      }
    });

    var span = document.createElement('span');
    span.innerHTML = renderText(choice);
    if (q.fs)    span.style.fontSize = q.fs + 'px';
    if (q.color) span.style.color    = q.color;

    opt.appendChild(inp);
    opt.appendChild(span);
    wrap.appendChild(opt);
  });

  overlay.appendChild(wrap);
}

/* ══════════════════════════════════════════════════════════════════
   IMAGE WIDGET
   ══════════════════════════════════════════════════════════════════ */
function buildImageWidget(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-image-wrap';
  wrap.id = 'w-' + q.id;
  var css = 'left:' + q.x + '%;top:' + q.y + '%;';
  if (q.w) css += 'width:'  + q.w + '%;';
  if (q.h) css += 'height:' + q.h + '%;';
  wrap.style.cssText = css;

  var img = document.createElement('img');
  img.src = q.src || '';
  img.alt = q.alt || '';
  img.style.width  = '100%';
  img.style.height = q.h ? '100%' : 'auto';
  if (q.objectFit)                  img.style.objectFit    = q.objectFit;
  if (q.borderRadius !== undefined) img.style.borderRadius = q.borderRadius + 'px';
  if (q.border)                     img.style.border       = q.border;
  if (q.opacity !== undefined)      img.style.opacity      = q.opacity;

  wrap.appendChild(img);
  overlay.appendChild(wrap);
}

/* ══════════════════════════════════════════════════════════════════
   ORDERING WIDGET
   ══════════════════════════════════════════════════════════════════ */
function buildOrderingWidget(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-ordering-wrap';
  wrap.id = 'w-' + q.id;
  var css = 'left:' + q.x + '%;top:' + q.y + '%;';
  if (q.w) css += 'width:' + q.w + '%;';
  wrap.style.cssText = css;
  if (q.bg)          wrap.style.background  = q.bg;
  if (q.borderColor) wrap.style.borderColor = q.borderColor;
  if (q.borderRadius !== undefined) wrap.style.borderRadius = q.borderRadius + 'px';

  if (q.question) {
    var qEl = document.createElement('div');
    qEl.className = 'q-ordering-question';
    setRenderedText(qEl, q.question);
    if (q.fs)    qEl.style.fontSize = q.fs + 'px';
    if (q.color) qEl.style.color    = q.color;
    wrap.appendChild(qEl);
  }

  var list = document.createElement('div');
  list.className = 'q-ordering-list';
  list.id = 'ol-' + q.id;

  q.userAns.forEach(function (origIdx) {
    var item = document.createElement('div');
    item.className = 'q-ordering-item';
    item.dataset.origIdx = origIdx;
    item.setAttribute('draggable', 'true');

    var handle = document.createElement('span');
    handle.className   = 'q-ordering-handle';
    handle.textContent = '\u2630';

    var label = document.createElement('span');
    label.className = 'q-ordering-label';
    label.innerHTML = renderText(q.items[origIdx]);
    if (q.fs)    label.style.fontSize = q.fs + 'px';
    if (q.color) label.style.color    = q.color;

    item.appendChild(handle);
    item.appendChild(label);
    list.appendChild(item);
  });

  wrap.appendChild(list);
  overlay.appendChild(wrap);

  /* drag reorder */
  var _oDrag = null;
  list.addEventListener('dragstart', function (e) {
    if (list.closest('[data-locked]')) { e.preventDefault(); return; }
    _oDrag = e.target.closest('.q-ordering-item');
    if (_oDrag) _oDrag.classList.add('dragging');
  });
  list.addEventListener('dragover', function (e) {
    e.preventDefault();
    var after = _getODragAfter(list, e.clientY);
    if (after) list.insertBefore(_oDrag, after); else list.appendChild(_oDrag);
  });
  list.addEventListener('dragend', function () {
    if (_oDrag) _oDrag.classList.remove('dragging');
    _oDrag = null;
    q.userAns = [];
    list.querySelectorAll('.q-ordering-item').forEach(function (it) { q.userAns.push(parseInt(it.dataset.origIdx)); });
  });
  /* touch fallback */
  var _oTouch = null;
  list.addEventListener('touchstart', function (e) {
    if (list.closest('[data-locked]')) return;
    var it = e.target.closest('.q-ordering-item'); if (!it) return;
    e.preventDefault(); _oTouch = it; it.classList.add('dragging');
  }, { passive: false });
  list.addEventListener('touchmove', function (e) {
    if (!_oTouch) return; e.preventDefault();
    var after = _getODragAfter(list, e.touches[0].clientY);
    if (after) list.insertBefore(_oTouch, after); else list.appendChild(_oTouch);
  }, { passive: false });
  list.addEventListener('touchend', function () {
    if (!_oTouch) return;
    _oTouch.classList.remove('dragging');
    q.userAns = [];
    list.querySelectorAll('.q-ordering-item').forEach(function (it) { q.userAns.push(parseInt(it.dataset.origIdx)); });
    _oTouch = null;
  });
}

function _getODragAfter(list, y) {
  var items = list.querySelectorAll('.q-ordering-item:not(.dragging)');
  var closest = null, closestOffset = Number.NEGATIVE_INFINITY;
  items.forEach(function (child) {
    var box = child.getBoundingClientRect();
    var offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = child; }
  });
  return closest;
}

/* ══════════════════════════════════════════════════════════════════
   HOTSPOT WIDGET — supports single or multiple correct answers
   ══════════════════════════════════════════════════════════════════ */
function buildHotspotWidget(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-hotspot-wrap';
  wrap.id = 'w-' + q.id;
  var css = 'left:' + q.x + '%;top:' + q.y + '%;';
  if (q.w) css += 'width:'  + q.w + '%;';
  if (q.h) css += 'height:' + q.h + '%;';
  wrap.style.cssText = css;

  var isMulti = Array.isArray(q.ans);

  if (q.question) {
    var qEl = document.createElement('div');
    qEl.className = 'q-hotspot-question';
    setRenderedText(qEl, q.question);
    if (q.fs)    qEl.style.fontSize = q.fs + 'px';
    if (q.color) qEl.style.color    = q.color;
    wrap.appendChild(qEl);
  }

  var imgBox = document.createElement('div');
  imgBox.className = 'q-hotspot-imgbox';
  var img = document.createElement('img');
  img.src = q.src || ''; img.alt = q.alt || ''; img.draggable = false;
  if (q.borderRadius !== undefined) img.style.borderRadius = q.borderRadius + 'px';
  if (q.border) img.style.border = q.border;
  imgBox.appendChild(img);

  q._spotEls = [];
  (q.spots || []).forEach(function (spot, si) {
    var dot = document.createElement('div');
    dot.className = 'q-hotspot-spot';
    dot.style.left   = spot.x + '%';
    dot.style.top    = spot.y + '%';
    dot.style.width  = (spot.r || 8) * 2 + '%';
    dot.style.height = (spot.r || 8) * 2 + '%';
    dot.style.marginLeft = '-' + (spot.r || 8) + '%';
    dot.style.marginTop  = '-' + (spot.r || 8) + '%';
    dot.dataset.idx = si;
    if (spot.label) dot.title = spot.label;

    dot.addEventListener('click', function () {
      if (wrap.getAttribute('data-locked')) return;
      if (isMulti) {
        /* toggle selection */
        var idx = q.userAns.indexOf(si);
        if (idx >= 0) { q.userAns.splice(idx, 1); dot.classList.remove('selected'); }
        else          { q.userAns.push(si);        dot.classList.add('selected'); }
      } else {
        q._spotEls.forEach(function (s) { s.classList.remove('selected'); });
        dot.classList.add('selected');
        q.userAns = si;
      }
    });

    imgBox.appendChild(dot);
    q._spotEls.push(dot);
  });

  wrap.appendChild(imgBox);
  overlay.appendChild(wrap);
}

/* ══════════════════════════════════════════════════════════════════
   SLIDER WIDGET
   ══════════════════════════════════════════════════════════════════ */
function buildSliderWidget(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-slider-wrap';
  wrap.id = 'w-' + q.id;
  var css = 'left:' + q.x + '%;top:' + q.y + '%;';
  if (q.w) css += 'width:' + q.w + '%;';
  wrap.style.cssText = css;
  if (q.bg)          wrap.style.background  = q.bg;
  if (q.borderColor) wrap.style.borderColor = q.borderColor;
  if (q.borderRadius !== undefined) wrap.style.borderRadius = q.borderRadius + 'px';

  if (q.question) {
    var qEl = document.createElement('div');
    qEl.className = 'q-slider-question';
    setRenderedText(qEl, q.question);
    if (q.fs)    qEl.style.fontSize = q.fs + 'px';
    if (q.color) qEl.style.color    = q.color;
    wrap.appendChild(qEl);
  }

  var sliderRow = document.createElement('div');
  sliderRow.className = 'q-slider-row';
  var inp = document.createElement('input');
  inp.type = 'range'; inp.id = 'sl-' + q.id;
  inp.min = q.min !== undefined ? q.min : 0;
  inp.max = q.max !== undefined ? q.max : 100;
  inp.step = q.step || 1;
  inp.value = inp.min;
  inp.className = 'q-slider-input';

  var valDisp = document.createElement('span');
  valDisp.className = 'q-slider-value';
  valDisp.id = 'sv-' + q.id;
  valDisp.textContent = inp.value + (q.unit || '');
  if (q.fs) valDisp.style.fontSize = q.fs + 'px';

  inp.addEventListener('input', function () {
    q.userAns = parseFloat(this.value);
    valDisp.textContent = this.value + (q.unit || '');
  });
  q.userAns = parseFloat(inp.value);

  var minL = document.createElement('span'); minL.className = 'q-slider-minmax'; minL.textContent = inp.min;
  var maxL = document.createElement('span'); maxL.className = 'q-slider-minmax'; maxL.textContent = inp.max;
  sliderRow.appendChild(minL); sliderRow.appendChild(inp); sliderRow.appendChild(maxL);
  wrap.appendChild(sliderRow);
  wrap.appendChild(valDisp);
  overlay.appendChild(wrap);
}

/* ══════════════════════════════════════════════════════════════════
   CLOZE / FILL-IN-THE-BLANK
   Supports:
     • parts[] mode  — mix of strings and blank objects
     • template+blanks[] mode — single string with {{0}}, {{1}} placeholders
   Blank objects: { blank:true, ans, w?, fs?, fontFamily?, type?, options? }
     type:'text' (default) or 'select' (dropdown)
   Per-blank individual styling and per-blank feedback on submit.
   LaTeX rendered in text parts; blanks inside LaTeX via template mode.
   ══════════════════════════════════════════════════════════════════ */
function buildClozeWidget(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-cloze-wrap';
  wrap.id = 'w-' + q.id;
  var css = 'left:' + q.x + '%;top:' + q.y + '%;';
  if (q.w) css += 'width:' + q.w + '%;';
  wrap.style.cssText = css;
  if (q.bg)          wrap.style.background  = q.bg;
  if (q.borderColor) wrap.style.borderColor = q.borderColor;
  if (q.borderRadius !== undefined) wrap.style.borderRadius = q.borderRadius + 'px';

  var sentence = document.createElement('div');
  sentence.className = 'q-cloze-sentence';
  if (q.fs) sentence.style.fontSize = q.fs + 'px';
  if (q.color) sentence.style.color = q.color;
  if (q.lineSpacing) sentence.style.lineHeight = q.lineSpacing;

  if (q.template && q.blanks) {
    _buildClozeFromTemplate(q, sentence, g);
  } else {
    _buildClozeFromParts(q, sentence, g);
  }

  wrap.appendChild(sentence);
  overlay.appendChild(wrap);
}

/** Build cloze from parts[] array */
function _buildClozeFromParts(q, container, g) {
  var blankIdx = 0;
  q.parts.forEach(function (part) {
    if (typeof part === 'string') {
      var span = document.createElement('span');
      span.innerHTML = renderText(part);
      container.appendChild(span);
    } else if (part.blank) {
      container.appendChild(_makeClozeInput(q, blankIdx, part, g));
      blankIdx++;
    }
  });
}

/** Build cloze from template string with {{n}} placeholders.
    Supports LaTeX: blanks inside math are rendered as placeholder spans,
    then swapped with real inputs after KaTeX renders. */
function _buildClozeFromTemplate(q, container, g) {
  /* Replace {{n}} with a marker span in the rendered HTML */
  var markerPrefix = 'cloze-marker-' + q.id + '-';
  var html = q.template;

  /* Handle LaTeX first — replace placeholders inside math with \htmlId markers */
  html = html.replace(/\$\$([^$]+?)\$\$/g, function (_, tex) {
    var processed = tex.replace(/\{\{(\d+)\}\}/g, function (__, idx) {
      var b = q.blanks[parseInt(idx)] || {};
      var w = b.w || 40;
      return '\\htmlId{' + markerPrefix + idx + '}{\\enspace\\rule{' + w + 'px}{0pt}\\enspace}';
    });
    return _katex(processed, true);
  });
  html = html.replace(/\$([^$]+?)\$/g, function (_, tex) {
    var processed = tex.replace(/\{\{(\d+)\}\}/g, function (__, idx) {
      var b = q.blanks[parseInt(idx)] || {};
      var w = b.w || 40;
      return '\\htmlId{' + markerPrefix + idx + '}{\\enspace\\rule{' + w + 'px}{0pt}\\enspace}';
    });
    return _katex(processed, false);
  });

  /* Replace remaining (non-LaTeX) {{n}} with marker spans */
  html = html.replace(/\{\{(\d+)\}\}/g, function (_, idx) {
    return '<span id="' + markerPrefix + idx + '"></span>';
  });

  /* Newlines */
  html = html.replace(/\\n/g, '<br>').replace(/<\\?br\\?>/g, '<br>');

  container.innerHTML = html;

  /* Swap markers with real inputs */
  q.blanks.forEach(function (b, i) {
    var marker = container.querySelector('#' + markerPrefix + i);
    if (!marker) return;
    var input = _makeClozeInput(q, i, b, g);
    /* If marker is inside KaTeX (a <span> in .katex), replace inline */
    marker.parentNode.replaceChild(input, marker);
  });
}

/** Create a single cloze input or select element */
function _makeClozeInput(q, blankIdx, cfg, g) {
  var id = 'cloze-' + q.id + '-' + blankIdx;

  if (cfg.type === 'select' && cfg.options) {
    var sel = document.createElement('select');
    sel.className = 'q-cloze-input q-cloze-select';
    sel.id = id;
    if (cfg.w)  sel.style.width = cfg.w + 'px';
    if (cfg.fs) sel.style.fontSize = cfg.fs + 'px';
    if (cfg.fontFamily) sel.style.fontFamily = cfg.fontFamily;

    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '\u2026';
    placeholder.disabled = true;
    placeholder.selected = true;
    sel.appendChild(placeholder);

    cfg.options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    });

    return sel;
  }

  /* open-ended textarea (when h is set or type is 'open') */
  if (cfg.type === 'open' || cfg.h) {
    var ta = document.createElement('textarea');
    ta.className = 'q-cloze-input q-cloze-textarea';
    ta.id = id;
    ta.style.width  = (cfg.w || 220) + 'px';
    ta.style.height = (cfg.h || 60) + 'px';
    if (cfg.fs)         ta.style.fontSize   = cfg.fs + 'px';
    if (cfg.fontFamily) ta.style.fontFamily = cfg.fontFamily;
    ta.placeholder  = cfg.placeholder || 'Type your answer\u2026';
    ta.autocomplete = 'off';
    ta.spellcheck   = true;
    ta.dataset.open = '1';
    return ta;
  }

  /* default: text input */
  var inp = document.createElement('input');
  inp.type      = 'text';
  inp.className = 'q-cloze-input';
  inp.id        = id;
  inp.style.width = (cfg.w || 80) + 'px';
  if (cfg.fs)         inp.style.fontSize   = cfg.fs + 'px';
  if (cfg.fontFamily) inp.style.fontFamily = cfg.fontFamily;
  inp.placeholder  = '\u2026';
  inp.autocomplete = 'off';
  inp.spellcheck   = false;
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doSubmit(g); }
  });
  return inp;
}

/* ══════════════════════════════════════════════════════════════════
   COMBOBOX WIDGET — native <select> dropdown, no preceding text
   ══════════════════════════════════════════════════════════════════ */
function buildComboboxWidget(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-combo-wrap';
  wrap.id = 'w-' + q.id;
  var css = 'left:' + q.x + '%;top:' + q.y + '%;';
  if (q.w) css += 'width:' + q.w + '%;';
  wrap.style.cssText = css;

  var sel = document.createElement('select');
  sel.className = 'q-combo-select';
  sel.id = 'cb-' + q.id;
  if (q.fs) sel.style.fontSize = q.fs + 'px';

  var placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '\u2026';
  placeholder.disabled = true;
  placeholder.selected = true;
  sel.appendChild(placeholder);

  (q.options || []).forEach(function (optText) {
    var o = document.createElement('option');
    o.value = optText;
    o.textContent = optText;
    sel.appendChild(o);
  });

  wrap.appendChild(sel);
  overlay.appendChild(wrap);
}

/* ══════════════════════════════════════════════════════════════════
   SPEECH BUBBLE / EXPLANATION BOX
   Supports adjustable tail: tailSize (px), tailOffset (%)
   Can appear as a standalone group item (type:'bubble')
   ══════════════════════════════════════════════════════════════════ */
function buildBubble(b, uid) {
  var wrap = document.createElement('div');
  wrap.className = 'quiz-bubble';
  wrap.id = 'bubble-' + uid;
  var css = 'left:' + b.x + '%;top:' + b.y + '%;';
  if (b.w) css += 'width:' + b.w + '%;';
  wrap.style.cssText = css;

  var inner = document.createElement('div');
  inner.className = 'quiz-bubble-inner';

  var bg          = b.bg          || 'rgba(255,248,200,0.96)';
  var borderColor = b.borderColor || '#aaa';
  var color       = b.color       || '#222';
  var fs          = b.fontSize || b.fs || 12;
  var br          = b.borderRadius !== undefined ? b.borderRadius : 10;
  var pad         = b.padding !== undefined ? b.padding : 10;
  var ff          = b.fontFamily || "'Calibri','Carlito',sans-serif";
  var tailSize    = b.tailSize   || 11;
  var tailOffset  = b.tailOffset !== undefined ? b.tailOffset : 50;

  inner.style.background   = bg;
  inner.style.borderColor  = borderColor;
  inner.style.color        = color;
  inner.style.fontSize     = fs + 'px';
  inner.style.borderRadius = br + 'px';
  inner.style.padding      = pad + 'px ' + (pad + 4) + 'px';
  inner.style.fontFamily   = ff;
  if (b.h)    inner.style.height    = b.h + 'px';
  if (b.minH) inner.style.minHeight = b.minH + 'px';
  if (b.lineSpacing) inner.style.lineHeight = b.lineSpacing;

  /* tail via CSS custom properties */
  if (b.style === 'bubble' && b.tail) {
    inner.classList.add('tail-' + b.tail);
    inner.style.setProperty('--tail-bg',     bg);
    inner.style.setProperty('--tail-border', borderColor);
    inner.style.setProperty('--tail-size',   tailSize + 'px');
    inner.style.setProperty('--tail-offset', tailOffset + '%');
  }

  setRenderedText(inner, b.text || '');
  wrap.appendChild(inner);
  return wrap;
}

/* ══════════════════════════════════════════════════════════════════
   BUILD UI — one pass over GROUPS
   ══════════════════════════════════════════════════════════════════ */
GROUPS.forEach(function (g) {
  g.triesLeft = g.maxTries;

  /* group label */
  var tag = document.createElement('div');
  tag.className   = 'group-tag';
  tag.id          = 'tag-' + g.id;
  tag.textContent = g.label || '';
  videoWrap.appendChild(tag);

  /* bottom bar */
  var bar = document.createElement('div');
  bar.className = 'bottom-bar';
  bar.id = 'bar-' + g.id;

  var info = document.createElement('div');
  info.className = 'score-info';
  info.id = 'info-' + g.id;
  info.innerHTML = 'Score: &mdash;<br>' + g.maxTries + ' tries left';

  var btnCol = document.createElement('div');
  btnCol.className = 'btn-col';

  var btn = document.createElement('button');
  btn.className   = 'submit-btn';
  btn.id          = 'btn-' + g.id;
  btn.textContent = 'Submit';
  btn.addEventListener('click', function () { doSubmit(g); });

  var ansBtn = document.createElement('button');
  ansBtn.className   = 'answer-btn';
  ansBtn.id          = 'ans-' + g.id;
  ansBtn.textContent = 'Answer';
  ansBtn.addEventListener('click', function () { showAnswers(g); });

  btnCol.appendChild(btn);
  btnCol.appendChild(ansBtn);
  bar.appendChild(info);
  bar.appendChild(btnCol);

  /* AI assistant icon */
  var aiBtn = document.createElement('button');
  aiBtn.className = 'ai-assist-btn';
  aiBtn.id = 'ai-btn-' + g.id;
  aiBtn.title = 'AI Assistant';
  aiBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v1a3 3 0 0 1-3 3h-1v4a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-4H7a3 3 0 0 1-3-3v-1a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4z"/><circle cx="9.5" cy="10" r="1"/><circle cx="14.5" cy="10" r="1"/><path d="M9.5 15a3.5 3.5 0 0 0 5 0"/></svg>';
  aiBtn.addEventListener('click', function () { _openAiAssistant(g); });
  bar.appendChild(aiBtn);

  videoWrap.appendChild(bar);

  /* questions */
  g.questions.forEach(function (q) {
    if      (q.type === 'match')                         buildMatchWidget(g, q);
    else if (q.type === 'radio' || q.type === 'checkbox') buildMCWidget(g, q);
    else if (q.type === 'image')                         buildImageWidget(g, q);
    else if (q.type === 'ordering')                      buildOrderingWidget(g, q);
    else if (q.type === 'hotspot')                       buildHotspotWidget(g, q);
    else if (q.type === 'slider')                        buildSliderWidget(g, q);
    else if (q.type === 'cloze')                         buildClozeWidget(g, q);
    else if (q.type === 'combobox')                      buildComboboxWidget(g, q);
    else if (q.type === 'bubble')                        _buildBubbleQuestion(g, q);
    else if (q.type === 'label')                         _buildLabel(q);
    else                                                 _buildTextInput(g, q);
  });

  /* explanation bubbles */
  var bList = g.bubbles ? g.bubbles : (g.bubble ? [g.bubble] : []);
  g._bubbleEls = [];
  bList.forEach(function (b, bi) {
    var bEl = buildBubble(b, g.id + '-b' + bi);
    videoWrap.appendChild(bEl);
    g._bubbleEls.push(bEl);
  });
});

function _buildLabel(q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-wrap';
  wrap.id = 'w-' + q.id;
  wrap.style.cssText = 'left:' + q.x + '%;top:' + q.y + '%;';
  var txt = document.createElement('div');
  txt.className = 'q-label-text';
  setRenderedText(txt, q.text || '');
  if (q.fs)    txt.style.fontSize  = q.fs + 'px';
  if (q.color) txt.style.color     = q.color;
  if (q.lineSpacing) txt.style.lineHeight = q.lineSpacing;
  txt.style.background = 'rgba(255,255,255,' + (typeof q.opacity === 'number' ? q.opacity : 1) + ')';
  wrap.appendChild(txt);
  overlay.appendChild(wrap);
}

function _buildTextInput(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-wrap';
  wrap.id = 'w-' + q.id;
  wrap.style.cssText = 'left:' + q.x + '%;top:' + q.y + '%;';

  var inp = document.createElement('input');
  inp.type      = 'text';
  inp.className = 'q-inp';
  inp.id        = 'i-' + q.id;
  inp.placeholder = '\u2026';
  inp.style.width = q.w + 'px';
  if (q.fs) inp.style.fontSize = q.fs + 'px';
  var bgOpacity = (typeof q.opacity === 'number') ? q.opacity : 1;
  inp.style.background  = 'rgba(255,255,255,' + bgOpacity + ')';
  inp.dataset.bgOpacity = bgOpacity;
  inp.autocomplete = 'off';
  inp.spellcheck   = false;
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doSubmit(g); }
  });

  wrap.appendChild(inp);
  overlay.appendChild(wrap);
}

/** Bubble as a question item (type:'bubble') — multiple per group */
function _buildBubbleQuestion(g, q) {
  var wrap = document.createElement('div');
  wrap.className = 'q-wrap quiz-bubble-item';
  wrap.id = 'w-' + q.id;

  var bEl = buildBubble(q, q.id);
  /* make it flow inside the wrap instead of absolute */
  bEl.style.position = 'relative';
  bEl.style.left = 'auto'; bEl.style.top = 'auto';
  bEl.classList.add('show');

  wrap.style.cssText = 'left:' + q.x + '%;top:' + q.y + '%;';
  wrap.appendChild(bEl);
  overlay.appendChild(wrap);
}

/* ══════════════════════════════════════════════════════════════════
   SHOW / HIDE A GROUP
   ══════════════════════════════════════════════════════════════════ */
function showGroup(g) {
  if (activeId && activeId !== g.id) {
    var prev = groupById(activeId);
    if (prev) hideGroup(prev);
  }
  activeId = g.id;
  g.questions.forEach(function (q) { document.getElementById('w-' + q.id).classList.add('show'); });
  document.getElementById('bar-' + g.id).classList.add('show');
  document.getElementById('tag-' + g.id).classList.add('show');
  pauseVideo();
  document.getElementById('pause-notice').classList.add('on');

  /* focus first text input */
  for (var i = 0; i < g.questions.length; i++) {
    var qt = g.questions[i].type;
    if (!qt || qt === 'text') {
      var el = document.getElementById('i-' + g.questions[i].id);
      if (el && !el.readOnly) { (function(e){ setTimeout(function(){ e.focus(); }, 80); })(el); break; }
    }
  }
}

function hideGroup(g) {
  g.questions.forEach(function (q) { document.getElementById('w-' + q.id).classList.remove('show'); });
  document.getElementById('bar-' + g.id).classList.remove('show');
  document.getElementById('tag-' + g.id).classList.remove('show');
  if (g._bubbleEls) g._bubbleEls.forEach(function (b) { b.classList.remove('show'); });
}

function groupById(id) {
  for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === id) return GROUPS[i];
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   TIME-BASED POLL
   ══════════════════════════════════════════════════════════════════ */
setInterval(function () {
  if (_bgMode) {
    ytTime     = _bgGetCurrentTime();
    ytDuration = BACKGROUND.duration || 300;
    if (ytTime >= ytDuration && _bgPlaying) { _bgPause(); ytTime = ytDuration; }
    var prog = document.getElementById('bg-progress');
    if (prog) prog.style.width = Math.min(100, (ytTime / ytDuration) * 100) + '%';
    var disp = document.getElementById('bg-time-display');
    if (disp) disp.textContent = _fmtTime(ytTime) + ' / ' + _fmtTime(ytDuration);
  }

  if (ytState !== 1) return;
  var t = Math.floor(ytTime);

  for (var i = 0; i < GROUPS.length; i++) {
    var g = GROUPS[i];
    var inWindow = (t >= g.time && t < g.time + 2);
    if (inWindow && !g.shown && activeId !== g.id) { g.shown = true; showGroup(g); return; }
    if (!inWindow && g.shown) g.shown = false;
  }

  if (ytDuration > 0 && ytTime >= ytDuration - 5 && !summaryShown) { summaryShown = true; showSummary(); }
  if (ytDuration > 0 && ytTime <  ytDuration - 5 && summaryShown)  { summaryShown = false; summaryEl.classList.remove('show'); }
}, 400);

/* ══════════════════════════════════════════════════════════════════
   SUBMIT
   ══════════════════════════════════════════════════════════════════ */
function doSubmit(g) {
  if (g.triesLeft <= 0) return;
  g.triesLeft--;
  var correct = 0, total = 0;

  g.questions.forEach(function (q) {
    if (q.type === 'label' || q.type === 'image' || q.type === 'bubble') return;
    total++;

    var wrap = document.getElementById('w-' + q.id) || document.getElementById('mb-' + q.id);
    if (wrap && wrap.getAttribute('data-locked')) { if (q.bestCorrect) correct++; return; }

    var isOk = checkAnswer(q);

    if (q.type === 'match') {
      var box = document.getElementById('mb-' + q.id);
      box.classList.remove('ok', 'no');
      if (isOk) { box.classList.add('ok'); q.bestCorrect = true; correct++; }
      else      { box.classList.add('no'); if (q.bestCorrect) correct++; }
      applyBg(box, isOk ? 'ok' : 'no');
      /* recolour lines */
      var svg = document.getElementById('ms-' + q.id);
      var svgNS = 'http://www.w3.org/2000/svg';
      svg.querySelectorAll('line.conn, line.ok-line, line.no-line').forEach(function (l) { l.remove(); });
      q.userAns.forEach(function (ri, li) {
        if (ri < 0) return;
        var p1 = dotCenter(q._dots.left[li], svg), p2 = dotCenter(q._dots.right[ri], svg);
        var ln = document.createElementNS(svgNS, 'line');
        ln.setAttribute('x1', p1.x); ln.setAttribute('y1', p1.y);
        ln.setAttribute('x2', p2.x); ln.setAttribute('y2', p2.y);
        ln.setAttribute('class', ri === q.ans[li] ? 'ok-line' : 'no-line');
        svg.appendChild(ln);
      });

    } else if (q.type === 'cloze') {
      wrap.classList.remove('ok', 'no');
      if (isOk) { wrap.classList.add('ok'); q.bestCorrect = true; correct++; }
      else      { wrap.classList.add('no'); if (q.bestCorrect) correct++; }
      _feedbackCloze(q);
      /* trigger AI evaluation for open-ended blanks */
      if (q._hasOpenBlanks) _aiEvaluateOpenBlanks(q);

    } else if (q.type === 'combobox') {
      wrap.classList.remove('ok', 'no');
      if (isOk) { wrap.classList.add('ok'); q.bestCorrect = true; correct++; }
      else      { wrap.classList.add('no'); if (q.bestCorrect) correct++; }

    } else if (q.type === 'hotspot') {
      wrap.classList.remove('ok', 'no');
      if (isOk) { wrap.classList.add('ok'); q.bestCorrect = true; correct++; }
      else      { wrap.classList.add('no'); if (q.bestCorrect) correct++; }

    } else if (q.type === 'radio' || q.type === 'checkbox') {
      wrap.classList.remove('ok', 'no');
      if (isOk) { wrap.classList.add('ok'); q.bestCorrect = true; correct++; }
      else      { wrap.classList.add('no'); if (q.bestCorrect) correct++; }
      wrap.style.background = isOk ? 'rgba(39,174,96,0.15)' : 'rgba(231,76,60,0.12)';

    } else if (q.type === 'ordering' || q.type === 'slider') {
      wrap.classList.remove('ok', 'no');
      if (isOk) { wrap.classList.add('ok'); q.bestCorrect = true; correct++; }
      else      { wrap.classList.add('no'); if (q.bestCorrect) correct++; }

    } else {
      /* text input */
      var inp = document.getElementById('i-' + q.id);
      if (inp.readOnly) { if (q.bestCorrect) correct++; return; }
      inp.classList.remove('ok', 'no');
      if (isOk) { inp.classList.add('ok'); applyBg(inp, 'ok'); q.bestCorrect = true; correct++; }
      else      { inp.classList.add('no'); applyBg(inp, 'no'); if (q.bestCorrect) correct++; }
    }
  });

  var trieLine =
    g.triesLeft === 0 ? 'No tries left' :
    g.triesLeft === 1 ? '1 try left'    :
    g.triesLeft + ' tries left';

  document.getElementById('info-' + g.id).innerHTML =
    'Score: ' + correct + '/' + total + '<br>' + trieLine;

  if (g.triesLeft === 0) _lockGroup(g);
}

function _lockGroup(g) {
  var submitBtn = document.getElementById('btn-' + g.id);
  submitBtn.disabled    = true;
  submitBtn.textContent = 'Done';

  g.questions.forEach(function (q) {
    if (q.type === 'label' || q.type === 'image' || q.type === 'bubble') return;
    var wrap = document.getElementById('w-' + q.id);

    if (q.type === 'match') {
      var box = document.getElementById('mb-' + q.id);
      box.setAttribute('data-locked', '1');
      applyBg(box, 'neutral');
    } else if (q.type === 'radio' || q.type === 'checkbox') {
      wrap.querySelectorAll('input').forEach(function (i) { i.disabled = true; });
      wrap.setAttribute('data-locked', '1');
      /* keep ok/no feedback visible until Answer is clicked */
    } else if (q.type === 'ordering') {
      wrap.setAttribute('data-locked', '1');
      wrap.querySelectorAll('.q-ordering-item').forEach(function (it) { it.removeAttribute('draggable'); });
      wrap.classList.remove('ok', 'no');
    } else if (q.type === 'hotspot') {
      wrap.setAttribute('data-locked', '1');
      wrap.classList.remove('ok', 'no');
    } else if (q.type === 'slider') {
      wrap.setAttribute('data-locked', '1');
      var sl = document.getElementById('sl-' + q.id); if (sl) sl.disabled = true;
      wrap.classList.remove('ok', 'no');
    } else if (q.type === 'cloze') {
      wrap.setAttribute('data-locked', '1');
      wrap.querySelectorAll('.q-cloze-input').forEach(function (i) { i.disabled = true; });
      wrap.classList.remove('ok', 'no');
    } else if (q.type === 'combobox') {
      wrap.setAttribute('data-locked', '1');
      var cb = document.getElementById('cb-' + q.id); if (cb) cb.disabled = true;
      wrap.classList.remove('ok', 'no');
    } else {
      var inp = document.getElementById('i-' + q.id);
      inp.readOnly = true;
      applyBg(inp, 'neutral');
      inp.style.opacity = '1';
    }
  });

  document.getElementById('ans-' + g.id).classList.add('show');
}

/* ══════════════════════════════════════════════════════════════════
   SHOW ANSWERS
   ══════════════════════════════════════════════════════════════════ */
function showAnswers(g) {
  g.questions.forEach(function (q) {
    if (q.type === 'label' || q.type === 'image' || q.type === 'bubble') return;

    if (q.type === 'match') {
      q.userAns = q.ans.slice();
      q._dots.left.forEach(function (d) { d.classList.add('connected'); });
      /* only mark right dots that are referenced in the answer */
      var usedRight = {};
      q.ans.forEach(function (ri) { usedRight[ri] = true; });
      q._dots.right.forEach(function (d, i) {
        if (usedRight[i]) d.classList.add('connected');
        else d.classList.remove('connected');
      });
      var box = document.getElementById('mb-' + q.id);
      box.classList.remove('no'); box.classList.add('ok');
      applyBg(box, 'neutral');
      var svg = document.getElementById('ms-' + q.id);
      var svgNS = 'http://www.w3.org/2000/svg';
      svg.querySelectorAll('line').forEach(function (l) { l.remove(); });
      q.ans.forEach(function (ri, li) {
        var p1 = dotCenter(q._dots.left[li], svg), p2 = dotCenter(q._dots.right[ri], svg);
        var ln = document.createElementNS(svgNS, 'line');
        ln.setAttribute('x1', p1.x); ln.setAttribute('y1', p1.y);
        ln.setAttribute('x2', p2.x); ln.setAttribute('y2', p2.y);
        ln.setAttribute('class', 'ok-line');
        svg.appendChild(ln);
      });

    } else if (q.type === 'radio') {
      var wrap = document.getElementById('w-' + q.id);
      wrap.style.background = '';
      var correctR = wrap.querySelector('input[value="' + q.ans + '"]');
      if (correctR) correctR.checked = true;
      wrap.querySelectorAll('.q-mc-option').forEach(function (opt) {
        var idx = parseInt(opt.querySelector('input').value);
        opt.classList.remove('ok', 'no');
        if (idx === q.ans) opt.classList.add('ok');
      });
      wrap.querySelectorAll('input').forEach(function (i) { i.disabled = true; });
      wrap.classList.remove('no'); wrap.classList.add('ok');
      wrap.setAttribute('data-locked', '1');

    } else if (q.type === 'checkbox') {
      var wrap = document.getElementById('w-' + q.id);
      wrap.style.background = '';
      var ansSet = {}; q.ans.forEach(function (a) { ansSet[a] = true; });
      wrap.querySelectorAll('.q-mc-option').forEach(function (opt) {
        var idx = parseInt(opt.querySelector('input').value);
        var inp = opt.querySelector('input');
        opt.classList.remove('ok', 'no');
        if (ansSet[idx]) { opt.classList.add('ok'); inp.checked = true; }
        else inp.checked = false;
      });
      wrap.querySelectorAll('input').forEach(function (i) { i.disabled = true; });
      wrap.classList.remove('no'); wrap.classList.add('ok');
      wrap.setAttribute('data-locked', '1');

    } else if (q.type === 'ordering') {
      var wrap = document.getElementById('w-' + q.id);
      var list = document.getElementById('ol-' + q.id);
      q.ans.forEach(function (origIdx) {
        var item = list.querySelector('[data-orig-idx="' + origIdx + '"]');
        if (item) list.appendChild(item);
      });
      q.userAns = q.ans.slice();
      wrap.classList.remove('no'); wrap.classList.add('ok');
      wrap.setAttribute('data-locked', '1');
      wrap.querySelectorAll('.q-ordering-item').forEach(function (it) { it.removeAttribute('draggable'); });

    } else if (q.type === 'hotspot') {
      var wrap = document.getElementById('w-' + q.id);
      var correctSet = Array.isArray(q.ans) ? q.ans : [q.ans];
      q._spotEls.forEach(function (s, si) {
        s.classList.remove('selected', 'spot-ok', 'spot-no');
        if (correctSet.indexOf(si) >= 0) s.classList.add('selected', 'spot-ok');
      });
      q.userAns = Array.isArray(q.ans) ? q.ans.slice() : q.ans;
      wrap.classList.remove('no'); wrap.classList.add('ok');
      wrap.setAttribute('data-locked', '1');

    } else if (q.type === 'slider') {
      var wrap = document.getElementById('w-' + q.id);
      var sl = document.getElementById('sl-' + q.id);
      var sv = document.getElementById('sv-' + q.id);
      if (sl) { sl.value = q.ans; sl.disabled = true; }
      if (sv) sv.textContent = q.ans + (q.unit || '');
      q.userAns = q.ans;
      wrap.classList.remove('no'); wrap.classList.add('ok');
      wrap.setAttribute('data-locked', '1');

    } else if (q.type === 'cloze') {
      var wrap = document.getElementById('w-' + q.id);
      /* remove any AI feedback displays that replaced textareas */
      wrap.querySelectorAll('.ai-feedback-display').forEach(function (fb) { fb.remove(); });
      q._blanks.forEach(function (bObj, bi) {
        var el = document.getElementById('cloze-' + q.id + '-' + bi);
        if (!el) return;
        el.style.display = ''; /* restore if hidden by AI eval */
        if (el.tagName === 'SELECT') {
          el.value = bObj.ans;
        } else {
          el.value = bObj.ans;
          el.readOnly = true;
        }
        el.classList.remove('no', 'ai-pending'); el.classList.add('ok');
        el.disabled = true;
      });
      wrap.classList.remove('no'); wrap.classList.add('ok');
      wrap.setAttribute('data-locked', '1');

    } else if (q.type === 'combobox') {
      var wrap = document.getElementById('w-' + q.id);
      var cb = document.getElementById('cb-' + q.id);
      if (cb) { cb.value = q.ans; cb.disabled = true; }
      wrap.classList.remove('no'); wrap.classList.add('ok');
      wrap.setAttribute('data-locked', '1');

    } else {
      var inp = document.getElementById('i-' + q.id);
      inp.value = q.ans;
      inp.classList.remove('no'); inp.classList.add('ok');
      applyBg(inp, 'neutral');
      inp.style.opacity = '1';
    }
  });

  /* show explanation bubbles */
  if (g._bubbleEls) g._bubbleEls.forEach(function (bel) { bel.classList.add('show'); });
  document.getElementById('ans-' + g.id).classList.remove('show');
}

/* ══════════════════════════════════════════════════════════════════
   SUMMARY
   ══════════════════════════════════════════════════════════════════ */
function showSummary() {
  var html      = '<div class="sum-title">Summary</div>';
  var sumOfPcts = 0;

  GROUPS.forEach(function (g, gi) {
    var gc = 0, gt = 0;
    g.questions.forEach(function (q) {
      if (q.type === 'label' || q.type === 'image' || q.type === 'bubble') return;
      gt++; if (q.bestCorrect) gc++;
    });
    var pct      = gt > 0 ? Math.round((gc / gt) * 100) : 0;
    sumOfPcts   += pct;
    var cls      = pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'bad';
    var triesUsed = g.maxTries - g.triesLeft;
    html += '<div class="sum-row">'
          +   '<span>' + (g.label || ('Question ' + (gi + 1)))
          +     '<span class="tries-detail">(' + triesUsed + '/' + g.maxTries + ' tries)</span>'
          +   '</span>'
          +   '<span class="pct ' + cls + '">' + pct + '/100%</span>'
          + '</div>';
  });

  var totalPct = GROUPS.length > 0 ? Math.round(sumOfPcts / GROUPS.length) : 0;
  var totalCls = totalPct >= 70 ? 'good' : totalPct >= 40 ? 'mid' : 'bad';
  html += '<div class="sum-total">'
        +   '<span>Total</span>'
        +   '<span class="pct ' + totalCls + '">' + totalPct + '/100%</span>'
        + '</div>';

  summaryEl.innerHTML = html;
  summaryEl.classList.add('show');
  pauseVideo();
  document.getElementById('pause-notice').classList.add('on');

  if (typeof MOODLE !== 'undefined' && MOODLE.enabled) {
    var perGroupData = GROUPS.map(function (g, gi) {
      var gc = 0;
      g.questions.forEach(function (q) { if (q.bestCorrect) gc++; });
      return {
        group: gi + 1, correct: gc, total: g.questions.length,
        pct: g.questions.length > 0 ? Math.round((gc / g.questions.length) * 100) : 0,
        triesUsed: g.maxTries - g.triesLeft, maxTries: g.maxTries
      };
    });
    try { MOODLE.send(totalPct, perGroupData); }
    catch (err) { console.error('Moodle send failed:', err); }
  }
}

/* ══════════════════════════════════════════════════════════════════
   AI CONFIGURATION
   Default: Pollinations.ai free text API (no key required).
   Override with AI_CONFIG = { endpoint, model, apiKey, provider }.
   provider: 'pollinations' (default) | 'anthropic' | 'openai'
   ══════════════════════════════════════════════════════════════════ */
var _aiCfg      = (typeof AI_CONFIG !== 'undefined') ? AI_CONFIG : {};
var _aiProvider = _aiCfg.provider  || 'pollinations';
var _aiEndpoint = _aiCfg.endpoint  || 'https://text.pollinations.ai/openai';
var _aiModel    = _aiCfg.model     || 'openai';

/**
 * Call the AI model. Returns a promise resolving to the text response.
 * Supports Pollinations (OpenAI-compatible) and Anthropic formats.
 */
function _aiCall(systemPrompt, userMessage) {
  return _aiCallMulti(systemPrompt, [{ role: 'user', content: userMessage }]);
}

function _aiCallMulti(systemPrompt, messages) {
  var body, headers = { 'Content-Type': 'application/json' };

  if (_aiProvider === 'anthropic') {
    /* ── Anthropic format ── */
    body = { model: _aiModel, max_tokens: 1024, system: systemPrompt, messages: messages };
    if (_aiCfg.apiKey) {
      headers['x-api-key'] = _aiCfg.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  } else {
    /* ── OpenAI-compatible format (Pollinations default) ── */
    var allMsgs = [{ role: 'system', content: systemPrompt }].concat(messages);
    body = { model: _aiModel, messages: allMsgs, temperature: 0.4, max_tokens: 1024 };
    if (_aiCfg.apiKey) headers['Authorization'] = 'Bearer ' + _aiCfg.apiKey;
  }

  return fetch(_aiEndpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      /* Anthropic response */
      if (data.content && Array.isArray(data.content)) {
        return data.content.map(function (c) { return c.text || ''; }).join('');
      }
      /* OpenAI-compatible response */
      if (data.choices && data.choices[0]) {
        return (data.choices[0].message && data.choices[0].message.content) ||
               data.choices[0].text || '';
      }
      /* plain text fallback (Pollinations simple endpoint) */
      if (typeof data === 'string') return data;
      if (data.error) throw new Error(data.error.message || 'AI API error');
      return '';
    });
}

/* ══════════════════════════════════════════════════════════════════
   AI EVALUATION FOR OPEN-ENDED CLOZE BLANKS
   ══════════════════════════════════════════════════════════════════ */
function _aiEvaluateOpenBlanks(q) {
  var openBlanks = [];
  q._blanks.forEach(function (bObj, bi) {
    var el = document.getElementById('cloze-' + q.id + '-' + bi);
    if (el && el.dataset.open === '1' && bObj.userAns) {
      openBlanks.push({ idx: bi, userAns: bObj.userAns, correctAns: bObj.ans, el: el });
    }
  });
  if (openBlanks.length === 0) return;

  var systemPrompt =
    'You are evaluating answers in an educational quiz. ' +
    'Each blank is an open-ended edit box within a fill-in-the-blank (cloze) question. ' +
    'For each blank, compare the student\'s answer to the correct answer. ' +
    'Provide precise, fine-detail feedback: identify which specific parts, phrases, or sentences in the student\'s answer are correct and which are incorrect or missing. ' +
    'Respond ONLY with a JSON array (no markdown fences). Each element must be: ' +
    '{ "blankIdx": <number>, "segments": [ { "text": "<segment>", "correct": true|false } ], "score": <0-100>, "note": "<brief explanation>" }. ' +
    'The segments array must cover the ENTIRE student answer text, split at meaningful boundaries (clauses, key terms). ' +
    'Mark each segment as correct (true) if it aligns with the correct answer, or incorrect (false) if it is wrong or irrelevant.';

  var userMsg = 'Evaluate these open-ended blanks:\n\n';
  openBlanks.forEach(function (ob) {
    userMsg += 'Blank #' + ob.idx + ':\n';
    userMsg += '  Correct answer: ' + ob.correctAns + '\n';
    userMsg += '  Student answer: ' + ob.userAns + '\n\n';
  });

  _aiCall(systemPrompt, userMsg).then(function (text) {
    var results;
    try {
      var clean = text.replace(/```json|```/g, '').trim();
      results = JSON.parse(clean);
    } catch (e) { console.error('AI eval parse error:', e, text); return; }

    results.forEach(function (r) {
      var ob = openBlanks.filter(function (o) { return o.idx === r.blankIdx; })[0];
      if (!ob) return;

      /* replace textarea content with color-coded feedback */
      var feedbackEl = document.createElement('div');
      feedbackEl.className = 'ai-feedback-display';
      feedbackEl.style.width  = ob.el.style.width;
      feedbackEl.style.minHeight = ob.el.style.height;
      if (ob.el.style.fontSize) feedbackEl.style.fontSize = ob.el.style.fontSize;

      (r.segments || []).forEach(function (seg) {
        var sp = document.createElement('span');
        sp.className = seg.correct ? 'ai-seg-ok' : 'ai-seg-no';
        sp.textContent = seg.text;
        feedbackEl.appendChild(sp);
      });

      if (r.note) {
        var noteEl = document.createElement('div');
        noteEl.className = 'ai-feedback-note';
        noteEl.textContent = r.note;
        feedbackEl.appendChild(noteEl);
      }

      ob.el.classList.remove('ai-pending');
      ob.el.style.display = 'none';
      ob.el.parentNode.insertBefore(feedbackEl, ob.el.nextSibling);
    });
  }).catch(function (err) {
    console.error('AI evaluation failed:', err);
    openBlanks.forEach(function (ob) {
      ob.el.classList.remove('ai-pending');
      ob.el.classList.add('no');
    });
  });
}

/* ══════════════════════════════════════════════════════════════════
   AI ASSISTANT PANEL — per question group
   ══════════════════════════════════════════════════════════════════ */
var _aiPanelEl = null;
var _aiPanelGroup = null;
var _aiChatHistory = {};  /* keyed by group id */

function _buildQuizContext(g) {
  var ctx = 'This is an educational quiz. The current question group is "' +
    (g.label || 'Group') + '" and contains these questions:\n\n';
  g.questions.forEach(function (q, qi) {
    if (q.type === 'label' || q.type === 'image' || q.type === 'bubble') return;
    ctx += 'Q' + (qi + 1) + ': ';
    if (q.type === 'cloze') {
      var txt = '';
      if (q.template) txt = q.template;
      else if (q.parts) q.parts.forEach(function (p) {
        txt += (typeof p === 'string') ? p : ' [____] ';
      });
      ctx += '(cloze) ' + txt + '\n';
    } else if (q.type === 'radio' || q.type === 'checkbox') {
      ctx += '(' + q.type + ') ' + (q.question || '') + ' — choices: ' + (q.choices || []).join(', ') + '\n';
    } else if (q.type === 'match') {
      ctx += '(match) left: ' + q.left.join(', ') + ' | right: ' + q.right.join(', ') + '\n';
    } else if (q.type === 'ordering') {
      ctx += '(ordering) ' + (q.question || '') + ' — items: ' + q.items.join(', ') + '\n';
    } else if (q.type === 'slider') {
      ctx += '(slider) ' + (q.question || '') + ' [' + q.min + '–' + q.max + ']\n';
    } else if (q.type === 'combobox') {
      ctx += '(combobox) options: ' + (q.options || []).join(', ') + '\n';
    } else {
      ctx += '(text input) answer expected\n';
    }
  });
  return ctx;
}

function _openAiAssistant(g) {
  if (_aiPanelEl && _aiPanelGroup === g.id) {
    /* toggle off */
    _aiPanelEl.classList.remove('show');
    _aiPanelGroup = null;
    return;
  }

  if (!_aiPanelEl) {
    _aiPanelEl = document.createElement('div');
    _aiPanelEl.id = 'ai-assist-panel';
    _aiPanelEl.innerHTML =
      '<div class="ai-panel-header">' +
        '<span class="ai-panel-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v1a3 3 0 0 1-3 3h-1v4a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-4H7a3 3 0 0 1-3-3v-1a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4z"/><circle cx="9.5" cy="10" r="1"/><circle cx="14.5" cy="10" r="1"/><path d="M9.5 15a3.5 3.5 0 0 0 5 0"/></svg> AI Assistant</span>' +
        '<button class="ai-panel-close" id="ai-panel-close">&times;</button>' +
      '</div>' +
      '<div class="ai-mode-bar">' +
        '<button class="ai-mode-btn" data-mode="guide">Guide</button>' +
        '<button class="ai-mode-btn" data-mode="hint">Hint</button>' +
        '<button class="ai-mode-btn" data-mode="chat">Chat</button>' +
      '</div>' +
      '<div class="ai-chat-messages" id="ai-chat-messages"></div>' +
      '<div class="ai-chat-input-row">' +
        '<input type="text" class="ai-chat-input" id="ai-chat-input" placeholder="Ask about the questions\u2026" />' +
        '<button class="ai-chat-send" id="ai-chat-send">&#10148;</button>' +
      '</div>';
    videoWrap.appendChild(_aiPanelEl);

    document.getElementById('ai-panel-close').addEventListener('click', function () {
      _aiPanelEl.classList.remove('show');
      _aiPanelGroup = null;
    });

    _aiPanelEl.querySelectorAll('.ai-mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mode = this.dataset.mode;
        _aiPanelEl.querySelectorAll('.ai-mode-btn').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        _sendAiModeMessage(mode);
      });
    });

    document.getElementById('ai-chat-send').addEventListener('click', _sendAiChatMessage);
    document.getElementById('ai-chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); _sendAiChatMessage(); }
    });
  }

  _aiPanelGroup = g.id;
  _aiPanelEl.classList.add('show');

  /* restore or reset chat */
  var msgBox = document.getElementById('ai-chat-messages');
  if (!_aiChatHistory[g.id]) _aiChatHistory[g.id] = [];
  _renderAiChat(g.id);

  /* activate 'chat' mode by default */
  _aiPanelEl.querySelectorAll('.ai-mode-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.mode === 'chat');
  });
}

function _getActiveAiMode() {
  var active = _aiPanelEl.querySelector('.ai-mode-btn.active');
  return active ? active.dataset.mode : 'chat';
}

function _sendAiModeMessage(mode) {
  var g = groupById(_aiPanelGroup);
  if (!g) return;

  var presetMsg;
  if (mode === 'guide') presetMsg = 'Please guide me step-by-step toward solving these questions. Don\'t give away the answers directly.';
  else if (mode === 'hint') presetMsg = 'Give me a short hint for the questions in this group. Don\'t reveal the full answers.';
  else return;

  _aiChatHistory[g.id].push({ role: 'user', text: presetMsg });
  _renderAiChat(g.id);
  _doAiChat(g);
}

function _sendAiChatMessage() {
  var inp = document.getElementById('ai-chat-input');
  var text = inp.value.trim();
  if (!text || !_aiPanelGroup) return;
  inp.value = '';

  var g = groupById(_aiPanelGroup);
  if (!g) return;

  _aiChatHistory[g.id].push({ role: 'user', text: text });
  _renderAiChat(g.id);
  _doAiChat(g);
}

function _doAiChat(g) {
  var history = _aiChatHistory[g.id];
  var mode = _getActiveAiMode();

  var systemPrompt =
    'You are a helpful AI assistant embedded in an educational quiz application. ' +
    'The quiz contains multiple question groups, each with several questions of various types. ' +
    'You are currently assisting with one specific group of questions. ' +
    'You should address any question the user refers to within this group.\n\n';

  if (mode === 'guide') {
    systemPrompt += 'MODE: GUIDE — Lead the student step-by-step toward the answer. ' +
      'Ask Socratic questions. Do NOT give away answers directly. ' +
      'Help them reason through the problem.\n\n';
  } else if (mode === 'hint') {
    systemPrompt += 'MODE: HINT — Provide a brief, helpful clue. ' +
      'Do NOT reveal the full answer. Keep hints concise (1-2 sentences).\n\n';
  } else {
    systemPrompt += 'MODE: CHAT — Have a natural dialogue about the questions. ' +
      'Answer the student\'s questions helpfully. ' +
      'You may explain concepts, clarify questions, or discuss related topics.\n\n';
  }

  systemPrompt += _buildQuizContext(g);

  /* Build messages for the API */
  var msgs = history.map(function (m) {
    return { role: m.role === 'user' ? 'user' : 'assistant', content: m.text };
  });

  /* add a thinking indicator */
  history.push({ role: 'assistant', text: '…', pending: true });
  _renderAiChat(g.id);

  _aiCallMulti(systemPrompt, msgs)
    .then(function (reply) {
      /* remove pending */
      for (var i = history.length - 1; i >= 0; i--) {
        if (history[i].pending) { history.splice(i, 1); break; }
      }
      history.push({ role: 'assistant', text: reply || '(No response)' });
      _renderAiChat(g.id);
    })
    .catch(function (err) {
      for (var i = history.length - 1; i >= 0; i--) {
        if (history[i].pending) { history.splice(i, 1); break; }
      }
      history.push({ role: 'assistant', text: 'Sorry, I could not connect to the AI service.' });
      _renderAiChat(g.id);
    });
}

function _renderAiChat(gid) {
  var box = document.getElementById('ai-chat-messages');
  if (!box) return;
  var history = _aiChatHistory[gid] || [];
  box.innerHTML = '';
  history.forEach(function (m) {
    var div = document.createElement('div');
    div.className = 'ai-chat-msg ai-chat-' + m.role;
    if (m.pending) div.classList.add('ai-pending-msg');
    div.textContent = m.text;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}
