/* ═══════════════════════════════════════════════════════════════
   youtube-quiz-engine.js
   Shared engine for all interactive video quizzes.
   Reads VIDEO_ID, GROUPS, and MOODLE from global scope.
   ═══════════════════════════════════════════════════════════════ */

// ── Set iframe src from VIDEO_ID ──────────────────────────────────
(function () {
  var frame = document.getElementById('yt-player');
  if (frame && typeof VIDEO_ID !== 'undefined') {
    frame.src = 'https://www.youtube.com/embed/' + VIDEO_ID +
      '?enablejsapi=1&controls=1&rel=0&modestbranding=1';
  }
})();

// ── Auto-generate IDs ─────────────────────────────────────────────
var _qn = 0;
GROUPS.forEach(function (g, gi) {
  if (!g.id) g.id = 'g' + gi;
  g.questions.forEach(function (q) {
    if (!q.id) q.id = 'q' + (_qn++);
    if (q.type === 'label') return;
    q.bestCorrect = false;
    if (q.type === 'match') {
      q.userAns = new Array(q.left.length).fill(-1);
    }
  });
});

var ytFrame   = document.getElementById('yt-player');
var overlay   = document.getElementById('overlay-layer');
var videoWrap = document.getElementById('video-wrap');
var ytState   = -1;
var ytTime    = 0;
var ytDuration = 0;
var activeId  = null;
var summaryShown = false;

// ── Answer checking (supports text, numeric tolerance, match) ─────
function checkAnswer(q) {
  if (q.type === 'match') {
    if (!q.userAns) return false;
    for (var i = 0; i < q.ans.length; i++) {
      if (q.userAns[i] !== q.ans[i]) return false;
    }
    return true;
  }
  var inp = document.getElementById('i-' + q.id);
  var val = inp.value.trim();
  var correct = (q.ans + '').trim();
  if (typeof q.tol === 'number') {
    var uNum = parseFloat(val);
    var cNum = parseFloat(correct);
    return !isNaN(uNum) && !isNaN(cNum) && Math.abs(uNum - cNum) <= q.tol;
  }
  return val.toLowerCase() === correct.toLowerCase();
}

// ── Background helper ─────────────────────────────────────────────
function getBgOpacity(el) {
  return el.dataset.bgOpacity !== undefined ? parseFloat(el.dataset.bgOpacity) : 1;
}
function applyBg(el, status) {
  var a = getBgOpacity(el);
  if      (status === 'ok') el.style.background = 'rgba(39,174,96,' + Math.max(0.18, a) + ')';
  else if (status === 'no') el.style.background = 'rgba(231,76,60,' + Math.max(0.15, a) + ')';
  else                      el.style.background = 'rgba(255,255,255,' + a + ')';
}

// ── postMessage helpers ───────────────────────────────────────────
function ytPost(func, args) {
  ytFrame.contentWindow.postMessage(JSON.stringify({
    event: 'command', func: func, args: args || []
  }), '*');
}
function pauseVideo() { ytPost('pauseVideo'); }

window.addEventListener('message', function (e) {
  var data;
  try { data = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data; }
  catch (err) { return; }

  var newState = null;
  if (data.event === 'infoDelivery' && data.info) {
    if (typeof data.info.currentTime === 'number') ytTime = data.info.currentTime;
    if (typeof data.info.playerState === 'number') newState = data.info.playerState;
    if (typeof data.info.duration    === 'number' && data.info.duration > 0) ytDuration = data.info.duration;
  }
  if (data.event === 'onStateChange') newState = data.info;

  if (newState === 1 && ytState !== 1) {
    document.querySelectorAll('.q-wrap.show').forEach(function(el) { el.classList.remove('show'); });
    document.querySelectorAll('.match-wrap.show').forEach(function(el) { el.classList.remove('show'); });
    document.querySelectorAll('.bottom-bar.show').forEach(function(el) { el.classList.remove('show'); });
    document.querySelectorAll('.group-tag.show').forEach(function(el) { el.classList.remove('show'); });
    var notice = document.getElementById('pause-notice');
    if (notice) notice.classList.remove('on');
    var sum = document.getElementById('quiz-summary');
    if (sum) sum.classList.remove('show');
    activeId = null;
  }

  if (newState !== null) ytState = newState;
});

ytFrame.addEventListener('load', function () {
  ytFrame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1 }), '*');
});

// ── Build summary overlay ─────────────────────────────────────────
var summaryEl = document.createElement('div');
summaryEl.id = 'quiz-summary';
videoWrap.appendChild(summaryEl);

// ══════════════════════════════════════════════════════════════════
//  MATCH WIDGET — drag-to-connect columns
// ══════════════════════════════════════════════════════════════════
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

  // Apply background opacity (default: 1)
  var bgOpacity = (typeof q.opacity === 'number') ? q.opacity : 1;
  box.style.background = 'rgba(255,255,255,' + bgOpacity + ')';
  box.dataset.bgOpacity = bgOpacity;

  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'match-svg');
  svg.id = 'ms-' + q.id;

  var cols = document.createElement('div');
  cols.className = 'match-cols';

  var leftCol = document.createElement('div');
  leftCol.className = 'match-col';
  var rightCol = document.createElement('div');
  rightCol.className = 'match-col';

  var baseFontSize = q.fs || 11;
  var dSize = q.dotSize || 14;
  var dGap  = q.dotGap  || 10;

  leftCol.style.gap  = dGap + 'px';
  rightCol.style.gap = dGap + 'px';

  q._dots = { left: [], right: [] };
  q._lines = [];

  q.left.forEach(function (txt, i) {
    var item = document.createElement('div');
    item.className = 'match-item';
    item.style.fontSize = baseFontSize + 'px';
    var span = document.createElement('span');
    span.textContent = txt;
    var dot = document.createElement('div');
    dot.className = 'match-dot';
    dot.style.width  = dSize + 'px';
    dot.style.height = dSize + 'px';
    dot.dataset.qid = q.id;
    dot.dataset.side = 'left';
    dot.dataset.idx = i;
    item.appendChild(span);
    item.appendChild(dot);
    leftCol.appendChild(item);
    q._dots.left.push(dot);
  });

  q.right.forEach(function (txt, i) {
    var item = document.createElement('div');
    item.className = 'match-item';
    item.style.fontSize = baseFontSize + 'px';
    var dot = document.createElement('div');
    dot.className = 'match-dot';
    dot.style.width  = dSize + 'px';
    dot.style.height = dSize + 'px';
    dot.dataset.qid = q.id;
    dot.dataset.side = 'right';
    dot.dataset.idx = i;
    var span = document.createElement('span');
    span.textContent = txt;
    item.appendChild(dot);
    item.appendChild(span);
    rightCol.appendChild(item);
    q._dots.right.push(dot);
  });

  cols.appendChild(leftCol);
  cols.appendChild(rightCol);
  box.appendChild(svg);
  box.appendChild(cols);
  wrap.appendChild(box);
  overlay.appendChild(wrap);
}

function dotCenter(dot, svg) {
  var dr = dot.getBoundingClientRect();
  var sr = svg.getBoundingClientRect();
  return { x: dr.left + dr.width/2 - sr.left, y: dr.top + dr.height/2 - sr.top };
}

function findQ(qid) {
  for (var gi = 0; gi < GROUPS.length; gi++) {
    for (var qi = 0; qi < GROUPS[gi].questions.length; qi++) {
      if (GROUPS[gi].questions[qi].id === qid) return GROUPS[gi].questions[qi];
    }
  }
  return null;
}

function disconnectLeft(q, li) {
  var ri = q.userAns[li];
  if (ri < 0) return;
  q.userAns[li] = -1;
  q._dots.left[li].classList.remove('connected');
  q._dots.right[ri].classList.remove('connected');
  redrawMatchLines(q);
}

function disconnectRight(q, ri) {
  for (var i = 0; i < q.userAns.length; i++) {
    if (q.userAns[i] === ri) { disconnectLeft(q, i); return; }
  }
}

function connectPair(q, li, ri) {
  if (q.userAns[li] >= 0) disconnectLeft(q, li);
  disconnectRight(q, ri);
  q.userAns[li] = ri;
  q._dots.left[li].classList.add('connected');
  q._dots.right[ri].classList.add('connected');
  redrawMatchLines(q);
}

function redrawMatchLines(q) {
  var svg = document.getElementById('ms-' + q.id);
  svg.querySelectorAll('line.conn, line.ok-line, line.no-line').forEach(function(l) { l.remove(); });
  var svgNS = 'http://www.w3.org/2000/svg';
  q.userAns.forEach(function (ri, li) {
    if (ri < 0) return;
    var p1 = dotCenter(q._dots.left[li], svg);
    var p2 = dotCenter(q._dots.right[ri], svg);
    var line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', p1.x);
    line.setAttribute('y1', p1.y);
    line.setAttribute('x2', p2.x);
    line.setAttribute('y2', p2.y);
    line.setAttribute('class', 'conn');
    svg.appendChild(line);
  });
}

// Global mouse handlers for match dragging
document.addEventListener('mousedown', function (e) {
  var dot = e.target.closest('.match-dot');
  if (!dot || dot.closest('[data-locked]')) return;
  e.preventDefault();
  var q = findQ(dot.dataset.qid);
  if (!q) return;
  var side = dot.dataset.side;
  var idx = parseInt(dot.dataset.idx);

  if (side === 'left' && q.userAns[idx] >= 0) disconnectLeft(q, idx);
  if (side === 'right') disconnectRight(q, idx);

  dot.classList.add('dragging');
  var svg = document.getElementById('ms-' + q.id);
  var svgNS = 'http://www.w3.org/2000/svg';
  var p = dotCenter(dot, svg);
  var tempLine = document.createElementNS(svgNS, 'line');
  tempLine.setAttribute('x1', p.x);
  tempLine.setAttribute('y1', p.y);
  tempLine.setAttribute('x2', p.x);
  tempLine.setAttribute('y2', p.y);
  tempLine.setAttribute('class', 'temp');
  svg.appendChild(tempLine);

  _drag = { q: q, side: side, idx: idx, dot: dot, svg: svg, line: tempLine };
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
    var li = _drag.side === 'left' ? _drag.idx : parseInt(target.dataset.idx);
    var ri = _drag.side === 'right' ? _drag.idx : parseInt(target.dataset.idx);
    connectPair(_drag.q, li, ri);
  }
  _drag = null;
});

// Touch support
document.addEventListener('touchstart', function (e) {
  var dot = e.target.closest('.match-dot');
  if (!dot || dot.closest('[data-locked]')) return;
  e.preventDefault();
  document.dispatchEvent(new MouseEvent('mousedown', {
    clientX: e.touches[0].clientX, clientY: e.touches[0].clientY,
    target: dot, bubbles: true
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
    var li = _drag.side === 'left' ? _drag.idx : parseInt(target.dataset.idx);
    var ri = _drag.side === 'right' ? _drag.idx : parseInt(target.dataset.idx);
    connectPair(_drag.q, li, ri);
  }
  _drag = null;
});

// ══════════════════════════════════════════════════════════════════
//  BUILD UI FOR EACH GROUP
// ══════════════════════════════════════════════════════════════════
GROUPS.forEach(function (g) {
  g.triesLeft = g.maxTries;

  var tag = document.createElement('div');
  tag.className = 'group-tag';
  tag.id = 'tag-' + g.id;
  tag.textContent = g.label;
  videoWrap.appendChild(tag);

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
  btn.className = 'submit-btn';
  btn.id = 'btn-' + g.id;
  btn.textContent = 'Submit';
  btn.addEventListener('click', function () { doSubmit(g); });

  var ansBtn = document.createElement('button');
  ansBtn.className = 'answer-btn';
  ansBtn.id = 'ans-' + g.id;
  ansBtn.textContent = 'Answer';
  ansBtn.addEventListener('click', function () { showAnswers(g); });

  btnCol.appendChild(btn);
  btnCol.appendChild(ansBtn);
  bar.appendChild(info);
  bar.appendChild(btnCol);
  videoWrap.appendChild(bar);

  g.questions.forEach(function (q) {
    if (q.type === 'match') {
      buildMatchWidget(g, q);
    } else if (q.type === 'label') {
      var wrap = document.createElement('div');
      wrap.className = 'q-wrap';
      wrap.id = 'w-' + q.id;
      wrap.style.cssText = 'left:' + q.x + '%;top:' + q.y + '%;';
      var txt = document.createElement('div');
      txt.className = 'q-label-text';
      txt.textContent = q.text || '';
      if (q.fs) txt.style.fontSize = q.fs + 'px';
      if (q.color) txt.style.color = q.color;
      txt.style.background = 'rgba(255,255,255,' + (typeof q.opacity === 'number' ? q.opacity : 1) + ')';
      wrap.appendChild(txt);
      overlay.appendChild(wrap);
    } else {
      var wrap = document.createElement('div');
      wrap.className = 'q-wrap';
      wrap.id = 'w-' + q.id;
      wrap.style.cssText = 'left:' + q.x + '%;top:' + q.y + '%;';

      var lbl = document.createElement('div');
      lbl.className = 'q-lbl';
      lbl.textContent = q.label;

      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'q-inp';
      inp.id = 'i-' + q.id;
      inp.placeholder = '\u2026';
      inp.style.width = q.w + 'px';
      if (q.fs) inp.style.fontSize = q.fs + 'px';
      var bgOpacity = (typeof q.opacity === 'number') ? q.opacity : 1;
      inp.style.background = 'rgba(255,255,255,' + bgOpacity + ')';
      inp.dataset.bgOpacity = bgOpacity;
      inp.autocomplete = 'off';
      inp.spellcheck  = false;
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doSubmit(g); }
      });

      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      overlay.appendChild(wrap);
    }
  });
});

// ── Show / hide a group ───────────────────────────────────────────
function showGroup(g) {
  if (activeId && activeId !== g.id) {
    var prev = groupById(activeId);
    if (prev) hideGroup(prev);
  }
  activeId = g.id;

  g.questions.forEach(function (q) {
    document.getElementById('w-' + q.id).classList.add('show');
  });
  document.getElementById('bar-' + g.id).classList.add('show');
  document.getElementById('tag-' + g.id).classList.add('show');

  pauseVideo();
  document.getElementById('pause-notice').classList.add('on');

  // Focus first non-match, non-label input
  for (var i = 0; i < g.questions.length; i++) {
    if (g.questions[i].type !== 'match' && g.questions[i].type !== 'label') {
      var el = document.getElementById('i-' + g.questions[i].id);
      if (el) { setTimeout(function() { el.focus(); }, 80); }
      break;
    }
  }
}

function hideGroup(g) {
  g.questions.forEach(function (q) {
    document.getElementById('w-' + q.id).classList.remove('show');
  });
  document.getElementById('bar-' + g.id).classList.remove('show');
  document.getElementById('tag-' + g.id).classList.remove('show');
}

function groupById(id) {
  for (var i = 0; i < GROUPS.length; i++) {
    if (GROUPS[i].id === id) return GROUPS[i];
  }
  return null;
}

// ── Poll time & trigger ───────────────────────────────────────────
setInterval(function () {
  if (ytState !== 1) return;
  var t = Math.floor(ytTime);
  for (var i = 0; i < GROUPS.length; i++) {
    var g = GROUPS[i];
    var inWindow = (t >= g.time && t < g.time + 2);
    if (inWindow && !g.shown && activeId !== g.id) {
      g.shown = true;
      showGroup(g);
      return;
    }
    if (!inWindow && g.shown) {
      g.shown = false;
    }
  }
  if (ytDuration > 0 && ytTime >= ytDuration - 5 && !summaryShown) {
    summaryShown = true;
    showSummary();
  }
  if (ytDuration > 0 && ytTime < ytDuration - 6 && summaryShown) {
    summaryShown = false;
  }
}, 400);

// ── Submit logic ──────────────────────────────────────────────────
function doSubmit(g) {
  if (g.triesLeft <= 0) return;
  g.triesLeft--;

  var correct = 0;
  var total = 0;

  g.questions.forEach(function (q) {
    if (q.type === 'label') return;
    total++;
    if (q.type === 'match') {
      var box = document.getElementById('mb-' + q.id);
      box.classList.remove('ok', 'no');
      var isOk = checkAnswer(q);
      if (isOk) {
        box.classList.add('ok');
        q.bestCorrect = true;
        correct++;
      } else {
        box.classList.add('no');
        if (q.bestCorrect) correct++;
      }
      applyBg(box, isOk ? 'ok' : 'no');
      // color individual lines
      var svg = document.getElementById('ms-' + q.id);
      svg.querySelectorAll('line.conn, line.ok-line, line.no-line').forEach(function(l) { l.remove(); });
      var svgNS = 'http://www.w3.org/2000/svg';
      q.userAns.forEach(function (ri, li) {
        if (ri < 0) return;
        var p1 = dotCenter(q._dots.left[li], svg);
        var p2 = dotCenter(q._dots.right[ri], svg);
        var line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
        line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
        line.setAttribute('class', ri === q.ans[li] ? 'ok-line' : 'no-line');
        svg.appendChild(line);
      });
    } else {
      var inp = document.getElementById('i-' + q.id);
      if (inp.readOnly) {
        if (q.bestCorrect) correct++;
        return;
      }
      inp.classList.remove('ok', 'no');
      if (checkAnswer(q)) {
        inp.classList.add('ok');
        applyBg(inp, 'ok');
        q.bestCorrect = true;
        correct++;
      } else {
        inp.classList.add('no');
        applyBg(inp, 'no');
        if (q.bestCorrect) correct++;
      }
    }
  });

  var trieLine =
    g.triesLeft === 0 ? 'No tries left' :
    g.triesLeft === 1 ? '1 try left'    :
    g.triesLeft + ' tries left';

  document.getElementById('info-' + g.id).innerHTML =
    'Score: ' + correct + '/' + total + '<br>' + trieLine;

  if (g.triesLeft === 0) {
    var btn = document.getElementById('btn-' + g.id);
    btn.disabled = true;
    btn.textContent = 'Done';
    g.questions.forEach(function (q) {
      if (q.type === 'label') return;
      if (q.type === 'match') {
        var box = document.getElementById('mb-' + q.id);
        box.setAttribute('data-locked', '1');
        applyBg(box, 'neutral');
      } else {
        var inp = document.getElementById('i-' + q.id);
        inp.readOnly = true;
        applyBg(inp, 'neutral');
        inp.style.opacity = '1';
      }
    });
    document.getElementById('ans-' + g.id).classList.add('show');
  }
}

// ── Show correct answers ──────────────────────────────────────────
function showAnswers(g) {
  g.questions.forEach(function (q) {
    if (q.type === 'label') return;
    if (q.type === 'match') {
      q.userAns = q.ans.slice();
      q._dots.left.forEach(function(d) { d.classList.add('connected'); });
      q._dots.right.forEach(function(d) { d.classList.add('connected'); });
      var box = document.getElementById('mb-' + q.id);
      box.classList.remove('no');
      box.classList.add('ok');
      applyBg(box, 'neutral');
      var svg = document.getElementById('ms-' + q.id);
      svg.querySelectorAll('line').forEach(function(l) { l.remove(); });
      var svgNS = 'http://www.w3.org/2000/svg';
      q.ans.forEach(function (ri, li) {
        var p1 = dotCenter(q._dots.left[li], svg);
        var p2 = dotCenter(q._dots.right[ri], svg);
        var line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
        line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
        line.setAttribute('class', 'ok-line');
        svg.appendChild(line);
      });
    } else {
      var inp = document.getElementById('i-' + q.id);
      inp.value = q.ans;
      inp.classList.remove('no');
      inp.classList.add('ok');
      applyBg(inp, 'neutral');
      inp.style.opacity = '1';
    }
  });
  document.getElementById('ans-' + g.id).classList.remove('show');
}

// ── Summary (per group, average of group %) ───────────────────────
function showSummary() {
  var html = '<div class="sum-title">Summary</div>';
  var sumOfPcts = 0;

  GROUPS.forEach(function (g, gi) {
    var groupCorrect = 0;
    var groupTotal   = 0;
    g.questions.forEach(function (q) {
      if (q.type === 'label') return;
      groupTotal++;
      if (q.bestCorrect) groupCorrect++;
    });

    var pct = groupTotal > 0 ? Math.round((groupCorrect / groupTotal) * 100) : 0;
    sumOfPcts += pct;
    var cls = pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'bad';
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

  // ── Moodle grade submission ──────────────────────────────────
  if (typeof MOODLE !== 'undefined' && MOODLE.enabled) {
    var perGroupData = GROUPS.map(function (g, gi) {
      var gc = 0;
      g.questions.forEach(function (q) { if (q.bestCorrect) gc++; });
      return {
        group:   gi + 1,
        correct: gc,
        total:   g.questions.length,
        pct:     g.questions.length > 0 ? Math.round((gc / g.questions.length) * 100) : 0,
        triesUsed: g.maxTries - g.triesLeft,
        maxTries:  g.maxTries
      };
    });
    try { MOODLE.send(totalPct, perGroupData); }
    catch (err) { console.error('Moodle send failed:', err); }
  }
}
