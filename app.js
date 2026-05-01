'use strict';

/* ── Config ── */
const API_KEY  = 'AIzaSyCdawUowHGKF2MskQrrTUsU73kVAJ5CdCQ';
const GEMINI   = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${API_KEY}`;

/* ── State ── */
let faces          = [];   // { id, imageData, analysis, x, y, vx, vy, size, isDragging, element }
let pendingMatch   = null; // { face1, face2 }
let stream         = null;
let animId         = null;

const drag = {
  active: false,
  face:   null,
  ox:     0,   // offset from face center
  oy:     0,
};

/* ── DOM refs ── */
const faceCanvas    = document.getElementById('face-canvas');
const startSection  = document.getElementById('start-section');
const addBtn        = document.getElementById('add-btn');
const dragHint      = document.getElementById('drag-hint');
const webcamModal   = document.getElementById('webcam-modal');
const video         = document.getElementById('webcam-video');
const loadingEl     = document.getElementById('loading-overlay');
const matchPopup    = document.getElementById('match-popup');
const matchResult   = document.getElementById('match-result');

/* ════════════════════════════════
   Init
════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('start-btn').addEventListener('click', openWebcam);
  addBtn.addEventListener('click', openWebcam);
  document.getElementById('capture-btn').addEventListener('click', captureAndAnalyze);
  document.getElementById('close-webcam').addEventListener('click', closeWebcam);
  document.getElementById('cancel-match').addEventListener('click', hideMatchPopup);
  document.getElementById('close-result').addEventListener('click', () => matchResult.classList.add('hidden'));

  document.querySelectorAll('.match-btn').forEach(btn =>
    btn.addEventListener('click', () => handleMatchType(btn.dataset.type))
  );

  /* Global drag/touch handlers */
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup',   onMouseUp);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend',  onTouchEnd);

  startAnimation();
});

/* ════════════════════════════════
   Webcam
════════════════════════════════ */
async function openWebcam() {
  webcamModal.classList.remove('hidden');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
  } catch {
    alert('카메라 접근 불가. 브라우저 권한을 확인하라.');
    closeWebcam();
  }
}

function closeWebcam() {
  webcamModal.classList.add('hidden');
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

async function captureAndAnalyze() {
  const dataUrl = captureFrame();
  triggerFlash();
  closeWebcam();
  showLoading();

  try {
    const analysis = await analyzeWithGemini(dataUrl);
    addFaceToCanvas(dataUrl, analysis);
  } catch (err) {
    console.error(err);
    if (err.message === 'RATE_LIMIT') {
      alert('API 호출 한도 초과. 1분 후 다시 시도하라.');
    } else {
      alert('분석 실패. 다시 시도하라.');
    }
  } finally {
    hideLoading();
  }
}

function captureFrame() {
  const vw = video.videoWidth  || 640;
  const vh = video.videoHeight || 640;
  const size = Math.min(vw, vh);
  const ox = (vw - size) / 2;
  const oy = (vh - size) / 2;

  const cv = document.createElement('canvas');
  cv.width = cv.height = 300;
  const ctx = cv.getContext('2d');

  ctx.beginPath();
  ctx.arc(150, 150, 150, 0, Math.PI * 2);
  ctx.clip();

  /* un-mirror: flip horizontally to reverse the CSS scaleX(-1) */
  ctx.translate(300, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, ox, oy, size, size, 0, 0, 300, 300);

  return cv.toDataURL('image/jpeg', 0.88);
}

function triggerFlash() {
  const el = document.createElement('div');
  el.className = 'flash-overlay';
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ════════════════════════════════
   Gemini — Face Analysis
════════════════════════════════ */
async function analyzeWithGemini(dataUrl) {
  const base64 = dataUrl.split(',')[1];

  const prompt = `너는 냉철한 관상학자다. 감정 없이 이 사람의 얼굴을 관상학적으로 판단하라.
아래 JSON 형식으로만 응답하라. 다른 텍스트는 절대 붙이지 마라:
{
  "keyword": "관상 키워드 한 단어 (한국어)",
  "pros": "관상학적 장점 1~2문장. 직설적으로.",
  "cons": "관상학적 단점 1~2문장. 가차없이."
}
미화 금지. 위로 금지. 사실만.`;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 400 },
  };

  const res = await fetch(GEMINI, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const code = res.status;
    if (code === 429) throw new Error('RATE_LIMIT');
    if (code === 400) throw new Error('BAD_REQUEST');
    throw new Error(`Gemini error ${code}`);
  }

  const data = await res.json();
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const m    = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Unexpected response format');
  return JSON.parse(m[0]);
}

/* ════════════════════════════════
   Gemini — Match Analysis
════════════════════════════════ */
async function analyzeMatchWithGemini(type, f1, f2) {
  const label = { friend: '친구', team: '팀', lover: '연인' }[type];

  const prompt = `두 사람의 관상 데이터다:

[A] 키워드: ${f1.analysis.keyword}
장점: ${f1.analysis.pros}
단점: ${f1.analysis.cons}

[B] 키워드: ${f2.analysis.keyword}
장점: ${f2.analysis.pros}
단점: ${f2.analysis.cons}

이 두 사람의 ${label} 궁합을 냉정하게 3문장 이내로 판단하라. 미화 금지. 잘 맞으면 이유를, 최악이면 왜 최악인지 말해라.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 320 },
  };

  const res = await fetch(GEMINI, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '분석 실패.';
}

/* ════════════════════════════════
   Face canvas
════════════════════════════════ */
function addFaceToCanvas(imageData, analysis) {
  const size = 144;
  const face = {
    id:        Date.now(),
    imageData,
    analysis,
    size,
    x:         Math.random() * (window.innerWidth  - size * 2) + size,
    y:         Math.random() * (window.innerHeight - size * 2) + size,
    vx:        (Math.random() - 0.5) * 1.2,
    vy:        (Math.random() - 0.5) * 1.2,
    isDragging: false,
    element:   null,
  };

  face.element = buildFaceEl(face);
  faceCanvas.appendChild(face.element);
  faces.push(face);
  updateUI();

  /* trigger entry animation */
  requestAnimationFrame(() => face.element.classList.add('appearing'));
}

function buildFaceEl(face) {
  const el = document.createElement('div');
  el.className = 'face-bubble';
  el.dataset.id = face.id;
  el.innerHTML = `
    <div class="face-circle">
      <img src="${face.imageData}" alt="" draggable="false" />
      <div class="face-orbit"></div>
    </div>
    <span class="face-keyword">${face.analysis.keyword}</span>
    <div class="face-tooltip">
      <p class="t-tag">장점</p>
      <p class="t-pros">${face.analysis.pros}</p>
      <p class="t-tag">단점</p>
      <p>${face.analysis.cons}</p>
    </div>
  `;

  el.style.left = `${face.x - face.size / 2}px`;
  el.style.top  = `${face.y - face.size / 2}px`;

  /* drag start — mouse */
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    startDrag(face, e.clientX, e.clientY);
  });

  /* drag start — touch */
  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    startDrag(face, t.clientX, t.clientY);
  }, { passive: true });

  return el;
}

function startDrag(face, cx, cy) {
  drag.active = true;
  drag.face   = face;
  drag.ox     = cx - face.x;
  drag.oy     = cy - face.y;
  face.isDragging = true;
  face.element.classList.add('dragging');
}

/* ── Global move handlers ── */
function onMouseMove(e) {
  if (!drag.active) return;
  moveDrag(e.clientX, e.clientY);
}
function onTouchMove(e) {
  if (!drag.active) return;
  e.preventDefault();
  const t = e.touches[0];
  moveDrag(t.clientX, t.clientY);
}

function moveDrag(cx, cy) {
  const f = drag.face;
  f.x = cx - drag.ox;
  f.y = cy - drag.oy;
  f.element.style.left = `${f.x - f.size / 2}px`;
  f.element.style.top  = `${f.y - f.size / 2}px`;
  highlightNear(f);
}

/* ── Global release handlers ── */
function onMouseUp(e) {
  if (!drag.active) return;
  endDrag(e.clientX, e.clientY);
}
function onTouchEnd(e) {
  if (!drag.active) return;
  const t = e.changedTouches[0];
  endDrag(t.clientX, t.clientY);
}

function endDrag(cx, cy) {
  const f = drag.face;
  drag.active = false;
  drag.face   = null;
  f.isDragging = false;
  f.element.classList.remove('dragging');
  clearHighlights();

  const target = nearestFace(f);
  if (target) {
    pendingMatch = { face1: f, face2: target };
    showMatchPopup(f, target);
  }
}

/* ════════════════════════════════
   Proximity helpers
════════════════════════════════ */
function nearestFace(src) {
  const threshold = src.size * 0.75;
  return faces.find(f => {
    if (f.id === src.id) return false;
    const dx = f.x - src.x, dy = f.y - src.y;
    return Math.hypot(dx, dy) < threshold;
  }) ?? null;
}

function highlightNear(src) {
  const threshold = src.size * 1.1;
  faces.forEach(f => {
    if (f.id === src.id) return;
    const dx = f.x - src.x, dy = f.y - src.y;
    f.element.classList.toggle('highlight', Math.hypot(dx, dy) < threshold);
  });
}

function clearHighlights() {
  faces.forEach(f => f.element.classList.remove('highlight'));
}

/* ════════════════════════════════
   Match popup
════════════════════════════════ */
function showMatchPopup(f1, f2) {
  const mx = (f1.x + f2.x) / 2;
  const my = (f1.y + f2.y) / 2;
  const pw = 240, ph = 180;
  const lx = Math.max(pw / 2, Math.min(mx, window.innerWidth  - pw / 2));
  const ly = Math.max(ph / 2, Math.min(my, window.innerHeight - ph / 2));

  matchPopup.style.left = `${lx}px`;
  matchPopup.style.top  = `${ly}px`;
  matchPopup.classList.remove('hidden');
}

function hideMatchPopup() {
  matchPopup.classList.add('hidden');
  pendingMatch = null;
}

async function handleMatchType(type) {
  if (!pendingMatch) return;
  const { face1, face2 } = pendingMatch;
  hideMatchPopup();
  showLoading();

  try {
    const text = await analyzeMatchWithGemini(type, face1, face2);
    renderMatchResult(type, face1, face2, text);
  } catch {
    alert('궁합 분석 실패. 다시 시도하라.');
  } finally {
    hideLoading();
  }
}

function renderMatchResult(type, f1, f2, text) {
  const label = { friend: '친구 궁합', team: '팀 궁합', lover: '연인 궁합' }[type];

  document.querySelector('.result-type-label').textContent = label;
  document.querySelector('.result-body').textContent       = text;

  document.querySelector('.result-faces').innerHTML = `
    <div class="result-face-mini">
      <img src="${f1.imageData}" alt="" />
      <span>${f1.analysis.keyword}</span>
    </div>
    <div class="result-connector">×</div>
    <div class="result-face-mini">
      <img src="${f2.imageData}" alt="" />
      <span>${f2.analysis.keyword}</span>
    </div>
  `;

  matchResult.classList.remove('hidden');
}

/* ════════════════════════════════
   Floating animation
════════════════════════════════ */
function startAnimation() {
  function tick() {
    faces.forEach(f => {
      if (f.isDragging) return;

      f.x += f.vx;
      f.y += f.vy;

      const pad = f.size / 2 + 10;
      if (f.x < pad || f.x > window.innerWidth - pad) {
        f.vx *= -1;
        f.x   = Math.max(pad, Math.min(f.x, window.innerWidth - pad));
      }
      if (f.y < pad || f.y > window.innerHeight - pad) {
        f.vy *= -1;
        f.y   = Math.max(pad, Math.min(f.y, window.innerHeight - pad));
      }

      f.element.style.left = `${f.x - f.size / 2}px`;
      f.element.style.top  = `${f.y - f.size / 2}px`;
    });

    animId = requestAnimationFrame(tick);
  }
  animId = requestAnimationFrame(tick);
}

/* ════════════════════════════════
   UI helpers
════════════════════════════════ */
function showLoading() { loadingEl.classList.remove('hidden'); }
function hideLoading() { loadingEl.classList.add('hidden'); }

function updateUI() {
  const has = faces.length > 0;
  startSection.classList.toggle('hidden', has);
  addBtn.classList.toggle('hidden', !has);
  dragHint.classList.toggle('hidden', faces.length < 2);
}
