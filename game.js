// ---------- Uppsetning ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
// Leikurinn notar alltaf 320×180 hnit, en canvasinn er teiknaður í
// fullri upplausn skjásins svo texti og kubbar verði skarpir.
const W = 320;
const H = 180;
let scale = 1;
function resize() {
  const r = canvas.getBoundingClientRect();
  scale = Math.max(1, (r.width * (window.devicePixelRatio || 1)) / W);
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
}
addEventListener('resize', resize);
resize();

// ---------- Stillingar ----------
const SPACING = 6;     // bil milli kubba þegar raðað er
const THICK = 2;       // þykkt kubbs (í fallstefnu)
const WIDE = 6;        // breidd kubbs (þvert á fallstefnu)
const TALL = 10;       // hæð kubbs (lengd þegar hann liggur)
const ERASE_R = 7;     // radíus strokleðurs
const GRAVITY = 40;    // hve hratt kubbar hraða á sér þegar þeir falla
const GIANT = 2.5;     // hve miklu stærri risakubbar eru
const MAX_DOMINOES = 600;

// ---------- Inntak: lyklaborð ----------
const keys = {};
addEventListener('keydown', e => {
  if (!keys[e.code]) onKeyPress(e.code);
  keys[e.code] = true;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });

// ---------- Inntak: mús ----------
const mouse = { x: 0, y: 0, left: false, right: false };
let lastPlaced = null;   // síðasti kubbur í línunni sem verið er að teikna

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  mouse.sx = (e.clientX - r.left) * W / r.width;   // staða á skjánum
  mouse.sy = (e.clientY - r.top) * H / r.height;
  // Staða á gólfinu: hlutir á rampi eru teiknaðir ofar, svo við leiðréttum fyrir því
  [mouse.x, mouse.y] = toGround(mouse.sx, mouse.sy);
}

canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  toCanvas(e);
  initAudio();
  canvas.setPointerCapture(e.pointerId);
  // Hægri smellur eða strokleðrið í stikunni strokar út
  if (e.button === 2 || (e.button === 0 && tool === 'eraser')) {
    mouse.right = true;
    eraseAt(mouse.x, mouse.y);
    return;
  }
  if (e.button !== 0) return;

  // Kúluverkfæri: byrja að strekkja teygjubyssuna
  if (tool === 'ball') {
    aiming = { x: mouse.x, y: clamp(mouse.y, 10 + BALL_R, H - 10 - BALL_R) };
    return;
  }
  if (tool === 'melon') {
    placeMelon(mouse.x, mouse.y);
    return;
  }
  if (tool === 'ramp') {
    rampDraft = { x: mouse.sx, y: mouse.sy };
    return;
  }
  if (tool === 'spinner') {
    placeSpinner(mouse.x, mouse.y);
    return;
  }

  // Ýtt á standandi kubb -> bíða og sjá í hvaða átt er ýtt
  const hit = dominoAt(mouse.x, mouse.y, 3.5);
  if (hit && hit.state === 'standing') {
    pushing = { d: hit, x: mouse.x, y: mouse.y };
    return;
  }
  mouse.left = true;
  lastPlaced = placeDomino(mouse.x, mouse.y, null);
});
canvas.addEventListener('pointermove', e => {
  toCanvas(e);
  if (mouse.right) eraseAt(mouse.x, mouse.y);
  if (mouse.left) dragPlace();
  // Dregið frá kubbi -> fella hann í þá átt sem dregið var
  if (pushing) {
    const dx = mouse.x - pushing.x, dy = mouse.y - pushing.y;
    const l = Math.hypot(dx, dy);
    if (l > 2) {
      knock(pushing.d, dx / l, dy / l, 3);
      pushing = null;
    }
  }
});
addEventListener('pointerup', e => {
  if (e.button === 0) {
    mouse.left = false;
    if (tool === 'eraser') mouse.right = false;
    lastPlaced = null;
    // Bara smellt (ekki dregið) -> giska á réttu áttina
    if (pushing) {
      const [dx, dy] = smartDir(pushing.d);
      knock(pushing.d, dx, dy, 3);
      pushing = null;
    }
    if (aiming) {
      launchBall();
      aiming = null;
    }
    if (rampDraft) {
      addRamp(rampDraft.x, rampDraft.y, mouse.sx, mouse.sy);
      rampDraft = null;
    }
  }
  if (e.button === 2) mouse.right = false;
});
let pushing = null;

// ---------- Rampar ----------
// Rampur er brekka upp, sléttur toppur og brekka niður aftur.
// Hlutir á rampi fá hæð (z) og eru teiknaðir ofar á skjánum.
const RAMP_H = 12;        // hæð rampsins
const RAMP_W = 22;        // breidd rampsins
const RAMP_MIN = 45;      // stysti rampur
const LIFT = 0.6;         // hve mikið ofar á skjánum hlutir teiknast á hvern hæðarpixel
const RAMP_PULL = 150;    // hve mikið brekkan togar í kúlur og melónur
let ramps = [];
let rampDraft = null;     // { x, y } meðan verið er að draga út nýjan ramp

function makeRamp(x1, y1, x2, y2) {
  const len = dist(x1, y1, x2, y2);
  return { x1, y1, x2, y2, len, ux: (x2 - x1) / len, uy: (y2 - y1) / len, w: RAMP_W };
}

function addRamp(x1, y1, x2, y2) {
  if (dist(x1, y1, x2, y2) < RAMP_MIN) return;
  ramps.push(makeRamp(x1, y1, x2, y2));
  updateHeights();
}

// Hvar á rampinum er punkturinn? Skilar t (0..1 eftir endilöngu) eða null
function rampT(r, x, y) {
  const rx = x - r.x1, ry = y - r.y1;
  const along = rx * r.ux + ry * r.uy;
  const across = rx * r.uy - ry * r.ux;
  if (along < 0 || along > r.len || Math.abs(across) > r.w / 2) return null;
  return along / r.len;
}

const rampProfile = t => RAMP_H * Math.min(1, t * 3, (1 - t) * 3);

function heightAt(x, y) {
  let h = 0;
  for (const r of ramps) {
    const t = rampT(r, x, y);
    if (t !== null) h = Math.max(h, rampProfile(t));
  }
  return h;
}

// Í hvaða átt hallar gólfið (upp í móti)? Fyrir kúlur sem rúlla
function slopeAt(x, y) {
  let best = 0, gx = 0, gy = 0;
  for (const r of ramps) {
    const t = rampT(r, x, y);
    if (t === null) continue;
    const h = rampProfile(t);
    if (h < best) continue;
    best = h;
    const k = RAMP_H / (r.len / 3);
    const s = t < 1 / 3 ? k : t > 2 / 3 ? -k : 0;
    gx = r.ux * s; gy = r.uy * s;
  }
  return [gx, gy];
}

// Breyta skjápunkti í gólfpunkt (hlutir á rampi eru teiknaðir ofar)
function toGround(sx, sy) {
  let y = sy;
  for (let i = 0; i < 3; i++) y = sy + heightAt(sx, y) * LIFT;
  return [sx, y];
}

function updateHeights() {
  for (const d of dominoes) d.z = heightAt(d.x, d.y);
  for (const b of balls) b.z = heightAt(b.x, b.y);
  for (const p of spinners) p.z = heightAt(p.x, p.y);
}

function rampPoint(r, t, side, raised) {
  const a = r.len * t, c = side * r.w / 2;
  const x = r.x1 + r.ux * a + r.uy * c;
  const y = r.y1 + r.uy * a - r.ux * c;
  return [x, y - (raised ? rampProfile(t) * LIFT : 0)];
}

function drawRamp(r, preview) {
  const ts = [0, 1 / 3, 2 / 3, 1];
  ctx.globalAlpha = preview ? 0.5 : 1;
  // Hliðarnar (dökkar)
  ctx.fillStyle = '#3a2718';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    for (const t of ts) ctx.lineTo(...rampPoint(r, t, side, false));
    for (const t of [...ts].reverse()) ctx.lineTo(...rampPoint(r, t, side, true));
    ctx.fill();
  }
  // Yfirborðið: brekkur aðeins dekkri en toppurinn
  const colors = ['#b48a5e', '#d9b07c', '#9c7550'];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.lineTo(...rampPoint(r, ts[i], -1, true));
    ctx.lineTo(...rampPoint(r, ts[i + 1], -1, true));
    ctx.lineTo(...rampPoint(r, ts[i + 1], 1, true));
    ctx.lineTo(...rampPoint(r, ts[i], 1, true));
    ctx.fill();
  }
  // Rákir á brekkunum svo það sjáist hvert er upp
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 0.6;
  for (let t = 0.04; t < 1; t += 0.06) {
    if (t > 1 / 3 && t < 2 / 3) continue;
    ctx.beginPath();
    ctx.moveTo(...rampPoint(r, t, -1, true));
    ctx.lineTo(...rampPoint(r, t, 1, true));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawRampDraft() {
  if (!rampDraft) return;
  const l = dist(rampDraft.x, rampDraft.y, mouse.sx, mouse.sy);
  if (l < 2) return;
  drawRamp(makeRamp(rampDraft.x, rampDraft.y, mouse.sx, mouse.sy), true);
  if (l < RAMP_MIN) {
    ctx.fillStyle = '#ffb0a0';
    ctx.font = '600 7px system-ui, "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText('Dragðu lengra', mouse.sx, mouse.sy - 12);
    ctx.textAlign = 'left';
  }
}

// ---------- Kúlur ----------
const BALL_R = 3;
const BALL_POWER = 5;     // hraði á hvern pixel sem teygjan er dregin
const BALL_MAX_PULL = 40; // lengsta mögulega teygja
let tool = 'dominoes';    // 'dominoes', 'giant', 'ball', 'melon', 'ramp', 'spinner' eða 'eraser'
let aiming = null;        // { x, y } meðan verið er að miða
let balls = [];

// Teygjubyssa: dregið aftur, kúlan fer í hina áttina
function aimVector() {
  let dx = aiming.x - mouse.x, dy = aiming.y - mouse.y;
  const l = Math.hypot(dx, dy);
  if (l > BALL_MAX_PULL) { dx *= BALL_MAX_PULL / l; dy *= BALL_MAX_PULL / l; }
  return [dx, dy];
}

function launchBall() {
  const [dx, dy] = aimVector();
  if (Math.hypot(dx, dy) < 3) return; // of lítið dregið
  balls.push({
    kind: 'ball',
    x: aiming.x, y: aiming.y,
    vx: dx * BALL_POWER, vy: dy * BALL_POWER,
    r: BALL_R,
    mass: 1,
    friction: 0.7,
    fade: true, // skotkúlur hverfa þegar þær stoppa
    still: 0,   // hve lengi kúlan hefur legið kyrr
    alpha: 1,
  });
}

// ---------- Melónur ----------
// Melóna liggur kyrr á milli kubbaraða. Þegar kubbur dettur á hana
// rúllar hún af stað og fellir næstu röð.
const MELON_R = 5;
const MELON_KICK = 75;    // hraðinn sem melónan fær þegar kubbur dettur á hana

function placeMelon(x, y) {
  y = clamp(y, 10 + MELON_R, H - 10 - MELON_R);
  x = clamp(x, MELON_R, W - MELON_R);
  for (const b of balls) if (dist(x, y, b.x, b.y) < b.r + MELON_R) return;
  for (const p of spinners) if (dist(x, y, p.x, p.y) < p.r + MELON_R) return;
  // Taka burt kubba sem lentu undir melónunni
  dominoes = dominoes.filter(d => dist(x, y, d.x, d.y) > MELON_R + 1);
  balls.push({
    kind: 'melon',
    x, y, homeX: x, homeY: y,
    vx: 0, vy: 0,
    r: MELON_R,
    mass: 4,
    friction: 1.0,
    fade: false,
    still: 0,
    alpha: 1,
    roll: 0,                 // hve langt hún hefur rúllað (fyrir röndótt útlit)
    rollDir: 0,
  });
}

// ---------- Skopparakringlur ----------
// Skopparakringla stendur kyrr. Þegar kubbur dettur á hana grípur hún
// kubbinn og fer að snúast, og sveiflar honum í hring svo hann fellir
// allt sem verður fyrir.
const SPIN_R = 4;
const SPIN_TIME = 6;      // hve lengi (sek.) hún snýst
const SPIN_FAST = 7;      // snúningshraði (radíanar á sek.) á fullu
let spinners = [];

function placeSpinner(x, y) {
  y = clamp(y, 10 + SPIN_R, H - 10 - SPIN_R);
  x = clamp(x, SPIN_R, W - SPIN_R);
  for (const b of balls) if (dist(x, y, b.x, b.y) < b.r + SPIN_R) return;
  for (const p of spinners) if (dist(x, y, p.x, p.y) < SPIN_R * 2 + 2) return;
  dominoes = dominoes.filter(d => dist(x, y, d.x, d.y) > SPIN_R + 2);
  spinners.push({ x, y, z: heightAt(x, y), r: SPIN_R, rot: 0, arm: 0, w: 0, spin: 0, held: null });
}

// Lengd armsins (miðja -> toppur kubbsins sem hún heldur á)
const armLen = p => p.r - 1 + (THICK / 2 + TALL) * p.held.size;

// Kubbur sem er að detta athugar hvort hann lendi á skopparakringlu
function dominoHitsSpinners(d, reach) {
  for (const p of spinners) {
    if (p.held) continue;
    const ox = p.x - d.x, oy = p.y - d.y;
    const along = ox * d.dirX + oy * d.dirY;
    if (along <= 0 || along - p.r > reach) continue;
    const across = ox * d.dirY - oy * d.dirX;
    if (Math.abs(across) > p.r + WIDE * d.size / 2) continue;
    if (Math.abs(d.z - p.z) > TALL * d.size) continue;
    // Gríptu kubbinn!
    d.home ||= { x: d.x, y: d.y, z: d.z, fx: d.fx, fy: d.fy };
    d.state = 'carried';
    d.angle = Math.PI / 2;
    p.held = d;
    p.arm = Math.atan2(d.y - p.y, d.x - p.x);
    // Snýst í þá átt sem kubburinn ýtti
    const turn = across !== 0 ? -Math.sign(across) : (Math.random() < 0.5 ? -1 : 1);
    p.w = SPIN_FAST * turn;
    p.spin = SPIN_TIME;
    click(1.5);
    return true;
  }
  return false;
}

function updateSpinners(dt) {
  for (const p of spinners) {
    if (p.held && !dominoes.includes(p.held)) p.held = null; // strokaður út
    if (p.spin <= 0) continue;
    p.spin -= dt;
    // Hægir á sér síðustu tvær sekúndurnar
    const w = p.w * Math.min(1, p.spin / 2);
    p.arm += w * dt;
    p.rot += w * dt;
    if (p.spin <= 0) {
      // Hættir að snúast og missir kubbinn
      if (p.held) { p.held.state = 'down'; click(); }
      p.held = null;
      continue;
    }
    if (!p.held) continue;
    // Halda kubbnum úti á enda armsins
    const d = p.held, ux = Math.cos(p.arm), uy = Math.sin(p.arm);
    d.x = p.x + ux * (p.r - 1);
    d.y = p.y + uy * (p.r - 1);
    d.z = p.z + 2;           // aðeins lyftur upp
    d.dirX = ux; d.dirY = uy;
    const len = armLen(p);
    const tx = -uy * Math.sign(w), ty = ux * Math.sign(w); // hreyfiáttin
    const half = WIDE * d.size / 2;
    // Fella standandi kubba sem armurinn sópar á
    for (const o of dominoes) {
      if (o.state !== 'standing') continue;
      if (Math.abs(o.z - p.z) > TALL * o.size) continue;
      const ox = o.x - p.x, oy = o.y - p.y;
      const along = ox * ux + oy * uy;
      if (along < 0 || along > len + 1) continue;
      if (Math.abs(ox * -uy + oy * ux) > half + WIDE * o.size / 2) continue;
      knock(o, tx, ty, Math.min(6, 2 + Math.abs(w) * along / 20));
      click(o.size);
    }
    // Slá kúlur og melónur
    for (const b of balls) {
      const ox = b.x - p.x, oy = b.y - p.y;
      const along = ox * ux + oy * uy;
      if (along < 0 || along > len + b.r) continue;
      if (Math.abs(ox * -uy + oy * ux) > half + b.r) continue;
      const hit = Math.abs(w) * along * 1.2;
      if (b.vx * tx + b.vy * ty < hit) {
        b.vx += tx * hit / b.mass * 2; b.vy += ty * hit / b.mass * 2;
        click();
      }
    }
    // Ef armurinn rekst á aðra skopparakringlu fer hún líka að snúast
    for (const q of spinners) {
      if (q === p || q.spin > 0) continue;
      const ox = q.x - p.x, oy = q.y - p.y;
      const along = ox * ux + oy * uy;
      if (along < 0 || along > len + q.r) continue;
      if (Math.abs(ox * -uy + oy * ux) > half + q.r) continue;
      q.w = -p.w; q.spin = SPIN_TIME;
      click(1.5);
    }
  }
}

function drawSpinner(p) {
  ctx.save();
  ctx.translate(p.x, p.y - p.z * LIFT);
  // Skuggi
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(1.5, 2, p.r, 0, Math.PI * 2);
  ctx.fill();
  // Fjórir litaðir geirar sem snúast
  const colors = ['#e8463c', '#ffd23f', '#3fa7e8', '#7be08a'];
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, p.r, p.rot + i * Math.PI / 2, p.rot + (i + 1) * Math.PI / 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#1a110a';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.arc(0, 0, p.r, 0, Math.PI * 2);
  ctx.stroke();
  // Handfangið í miðjunni
  ctx.fillStyle = '#f3e6d6';
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function updateBalls(dt) {
  for (const b of balls) {
    const top = 10 + b.r, bottom = H - 10 - b.r;
    // Núningur
    const f = Math.exp(-b.friction * dt);
    b.vx *= f; b.vy *= f;
    // Brekkur toga kúlur niður
    const [gx, gy] = slopeAt(b.x, b.y);
    b.vx -= gx * RAMP_PULL * dt;
    b.vy -= gy * RAMP_PULL * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z = heightAt(b.x, b.y);
    const speed = Math.hypot(b.vx, b.vy);
    if (b.kind === 'melon' && speed > 0.5) {
      b.roll += speed * dt;
      b.rollDir = Math.atan2(b.vy, b.vx);
    }

    // Skoppa af veggjum
    if (b.x < b.r)     { b.x = b.r;     b.vx =  Math.abs(b.vx) * 0.8; click(); }
    if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * 0.8; click(); }
    if (b.y < top)     { b.y = top;     b.vy =  Math.abs(b.vy) * 0.8; click(); }
    if (b.y > bottom)  { b.y = bottom;  b.vy = -Math.abs(b.vy) * 0.8; click(); }

    // Skoppa af skopparakringlum (þær standa fastar)
    for (const p of spinners) {
      const dx = b.x - p.x, dy = b.y - p.y;
      const l = Math.hypot(dx, dy), minD = b.r + p.r;
      if (l === 0 || l >= minD) continue;
      const nx = dx / l, ny = dy / l;
      b.x = p.x + nx * minD; b.y = p.y + ny * minD;
      const v = b.vx * nx + b.vy * ny;
      if (v < 0) { b.vx -= 1.8 * v * nx; b.vy -= 1.8 * v * ny; click(); }
    }

    // Fella kubba sem kúlan rekst á
    if (speed > 8) {
      for (const d of dominoes) {
        if (d.state !== 'standing') continue;
        if (dist(b.x, b.y, d.x, d.y) > b.r + WIDE * d.size / 2) continue;
        if (Math.abs(b.z - d.z) > TALL * d.size) continue; // í annarri hæð
        knock(d, b.vx / speed, b.vy / speed, Math.min(6, 1.5 + speed / 40));
        const slow = b.kind === 'melon' ? 0.97 : 0.9;
        b.vx *= slow; b.vy *= slow;
        click();
      }
    }

    // Skotkúlur hverfa hægt þegar þær hafa legið kyrrar smá stund
    if (b.fade) {
      if (speed < 4) b.still += dt; else b.still = 0;
      if (b.still > 1.5) b.alpha -= dt;
    }
  }

  // Kúlur og melónur rekast hver á aðra (melónur eru þyngri)
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l = Math.hypot(dx, dy);
      const minD = a.r + b.r;
      if (l === 0 || l >= minD) continue;
      const nx = dx / l, ny = dy / l;
      const total = a.mass + b.mass;
      // Ýta þeim í sundur
      const overlap = minD - l;
      a.x -= nx * overlap * b.mass / total; a.y -= ny * overlap * b.mass / total;
      b.x += nx * overlap * a.mass / total; b.y += ny * overlap * a.mass / total;
      // Árekstur í árekstrarstefnunni
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      if (rel > 0) {
        const j2 = 1.9 * rel / total;
        a.vx -= j2 * b.mass * nx; a.vy -= j2 * b.mass * ny;
        b.vx += j2 * a.mass * nx; b.vy += j2 * a.mass * ny;
        click();
      }
    }
  }

  balls = balls.filter(b => b.alpha > 0);
}

// Kubbur sem er að detta athugar hvort toppurinn lendi á melónu
function dominoHitsMelons(d, reach) {
  for (const b of balls) {
    if (b.kind !== 'melon') continue;
    if (d.hitMelons && d.hitMelons.includes(b)) continue;
    const ox = b.x - d.x, oy = b.y - d.y;
    const along = ox * d.dirX + oy * d.dirY;
    if (along <= 0 || along - b.r > reach) continue;
    const across = Math.abs(ox * d.dirY - oy * d.dirX);
    if (across > b.r + WIDE * d.size / 2) continue;
    (d.hitMelons ||= []).push(b);
    // Risakubbar sparka fastar
    const kick = MELON_KICK * Math.sqrt(d.size);
    b.vx += d.dirX * kick;
    b.vy += d.dirY * kick;
    click();
  }
}

function drawMelon(b) {
  ctx.save();
  ctx.translate(b.x, b.y - (b.z || 0) * LIFT);
  // Skuggi
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(1.5, 2, b.r, 0, Math.PI * 2);
  ctx.fill();
  // Græn melóna
  ctx.beginPath();
  ctx.arc(0, 0, b.r, 0, Math.PI * 2);
  ctx.fillStyle = '#3fa34d';
  ctx.fill();
  // Dökkar rendur sem færast þegar hún rúllar
  ctx.save();
  ctx.clip();
  ctx.rotate(b.rollDir);
  ctx.fillStyle = '#1e6b2c';
  const gap = 3.2;
  const off = -(b.roll % gap);
  for (let x = -b.r - gap + off; x < b.r + gap; x += gap) {
    ctx.fillRect(x, -b.r, 1.2, b.r * 2);
  }
  ctx.restore();
  // Gljái
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(-1.8, -1.8, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBall(x, y, alpha) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.arc(x + 1, y + 1.5, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c8d0dc';
  ctx.beginPath();
  ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(x - 1, y - 1, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawAim() {
  if (!aiming) return;
  const [dx, dy] = aimVector();
  ctx.save();
  ctx.translate(0, -heightAt(aiming.x, aiming.y) * LIFT);
  // Teygjan
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(aiming.x, aiming.y);
  ctx.lineTo(aiming.x - dx, aiming.y - dy);
  ctx.stroke();
  // Punktalína sem sýnir hvert kúlan fer
  ctx.fillStyle = 'rgba(255,236,39,0.9)';
  const n = Math.floor(Math.hypot(dx, dy) / 3);
  for (let i = 1; i <= n; i++) {
    ctx.beginPath();
    ctx.arc(aiming.x + dx * i / 3, aiming.y + dy * i / 3, 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  drawBall(aiming.x, aiming.y, 1);
  ctx.restore();
}

// Finnur góða fallátt: ef kubburinn er endakubbur í röð fellur hann
// inn í röðina, annars í þá átt sem röðin var teiknuð.
function smartDir(d) {
  let ahead = 0, behind = 0;
  for (const o of dominoes) {
    if (o === d || o.state !== 'standing') continue;
    const ox = o.x - d.x, oy = o.y - d.y;
    if (Math.hypot(ox, oy) > SPACING * d.size + 2) continue;
    if (ox * d.fx + oy * d.fy > 0) ahead++; else behind++;
  }
  if (behind > 0 && ahead === 0) return [-d.fx, -d.fy];
  return [d.fx, d.fy];
}

// ---------- Hjálparföll ----------
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

// ---------- Hljóð (lítið "klikk" þegar kubbur skellur) ----------
let audio = null;
let lastClick = 0;
function initAudio() {
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  if (audio && audio.state === 'suspended') audio.resume();
}
function click(size = 1) {
  if (!audio) return;
  const t = audio.currentTime;
  if (t - lastClick < 0.025) return; // ekki of mörg í einu
  lastClick = t;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = (900 + Math.random() * 500) / size;
  gain.gain.setValueAtTime(0.06, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.05);
}

// ---------- Leikjastaða ----------
let dominoes = [];
let nextId = 0;

function makeDomino(x, y, fx, fy, size) {
  return {
    id: nextId++,
    x, y,
    z: heightAt(x, y), // hæð gólfsins undir kubbnum (t.d. á rampi)
    size,              // 1 = venjulegur, GIANT = risakubbur
    fx, fy,            // stefna kubbsins (einingavigur)
    dirX: fx, dirY: fy, // stefnan sem hann fellur í
    angle: 0,          // 0 = stendur, PI/2 = liggur
    vel: 0,
    state: 'standing', // standing | falling | down
    hue: (nextId * 9) % 360,
  };
}

function dominoAt(x, y, r) {
  let best = null, bestD = r;
  for (const d of dominoes) {
    const dd = dist(x, y, d.x, d.y) / d.size; // stórir kubbar eru auðveldari að hitta
    if (dd < bestD) { best = d; bestD = dd; }
  }
  return best;
}

// Stærð kubba sem verið er að raða
const placeSize = () => (tool === 'giant' ? GIANT : 1);

function placeDomino(x, y, prev) {
  const size = placeSize();
  if (dominoes.length >= MAX_DOMINOES) return prev;
  const m = WIDE * size / 2;
  if (x < m || y < 10 + m || x > W - m || y > H - 10 - m) return prev;
  // Ekki setja ofan í annan kubb
  for (const d of dominoes) {
    if (d !== prev && dist(x, y, d.x, d.y) < (SPACING - 1.5) * Math.max(size, d.size)) return prev;
  }
  // ...né ofan í melónu
  for (const b of balls) {
    if (b.kind === 'melon' && dist(x, y, b.x, b.y) < b.r + 2 * size) return prev;
  }
  for (const p of spinners) if (dist(x, y, p.x, p.y) < p.r + 2 * size) return prev;
  let fx = 1, fy = 0;
  if (prev) {
    const l = dist(prev.x, prev.y, x, y) || 1;
    fx = (x - prev.x) / l;
    fy = (y - prev.y) / l;
  }
  const d = makeDomino(x, y, fx, fy, size);
  dominoes.push(d);
  // Fyrsti kubbur línunnar fær stefnu þegar annar bætist við
  if (prev && prev.firstInLine) {
    prev.fx = prev.dirX = fx;
    prev.fy = prev.dirY = fy;
    prev.firstInLine = false;
  }
  if (!prev) d.firstInLine = true;
  return d;
}

function dragPlace() {
  if (!lastPlaced) {
    lastPlaced = placeDomino(mouse.x, mouse.y, null);
    return;
  }
  const gap = SPACING * placeSize();
  let guard = 0;
  while (dist(lastPlaced.x, lastPlaced.y, mouse.x, mouse.y) >= gap && guard++ < 50) {
    const l = dist(lastPlaced.x, lastPlaced.y, mouse.x, mouse.y);
    const nx = lastPlaced.x + (mouse.x - lastPlaced.x) / l * gap;
    const ny = lastPlaced.y + (mouse.y - lastPlaced.y) / l * gap;
    const placed = placeDomino(nx, ny, lastPlaced);
    // Ef ekki var pláss (t.d. farið yfir aðra línu) höldum við samt áfram
    // með "ósýnilegan" punkt svo bilin haldist jöfn hinum megin.
    lastPlaced = placed === lastPlaced ? { x: nx, y: ny } : placed;
  }
}

function eraseAt(x, y) {
  const before = dominoes.length + balls.length + spinners.length;
  dominoes = dominoes.filter(d => dist(x, y, d.x, d.y) > ERASE_R + (d.size - 1) * 3);
  balls = balls.filter(b => dist(x, y, b.x, b.y) > ERASE_R);
  spinners = spinners.filter(p => dist(x, y, p.x, p.y) > ERASE_R);
  // Ef ekkert annað var strokað út tekur strokleðrið rampinn
  if (dominoes.length + balls.length + spinners.length === before) {
    const n = ramps.length;
    ramps = ramps.filter(r => rampT(r, mouse.sx, mouse.sy) === null && rampT(r, x, y) === null);
    if (ramps.length !== n) updateHeights();
  }
}

function knock(d, dx, dy, speed) {
  if (d.state !== 'standing') return;
  // Fellur í þá stefnu kubbsins sem passar best við höggið
  const dot = d.fx * dx + d.fy * dy;
  if (Math.abs(dot) > 0.3) {
    const s = Math.sign(dot);
    d.dirX = d.fx * s;
    d.dirY = d.fy * s;
  } else {
    d.dirX = dx;
    d.dirY = dy;
  }
  d.state = 'falling';
  d.vel = speed;
}

function knockFirst() {
  // Fellir fyrsta standandi kubbinn sem var settur niður
  const first = dominoes.find(d => d.state === 'standing');
  if (first) {
    const [dx, dy] = smartDir(first);
    knock(first, dx, dy, 3);
  }
}

function resetAll() {
  for (const d of dominoes) {
    d.state = 'standing';
    d.angle = 0;
    d.vel = 0;
    d.dirX = d.fx;
    d.dirY = d.fy;
    d.hitMelons = null;
    // Kubbar sem skopparakringla tók fara aftur á sinn stað
    if (d.home) {
      d.x = d.home.x; d.y = d.home.y; d.z = d.home.z;
      d.fx = d.dirX = d.home.fx; d.fy = d.dirY = d.home.fy;
      d.home = null;
    }
  }
  for (const p of spinners) { p.spin = 0; p.held = null; p.w = 0; }
  // Skotkúlur hverfa, melónur fara aftur á sinn stað
  balls = balls.filter(b => b.kind === 'melon');
  for (const b of balls) {
    b.x = b.homeX; b.y = b.homeY;
    b.vx = b.vy = 0;
    b.roll = 0;
  }
}

function setTool(t) {
  tool = t;
  // Hætta við það sem var í gangi með gamla verkfærinu
  aiming = null;
  pushing = null;
  rampDraft = null;
  mouse.left = false;
  lastPlaced = null;
  for (const b of document.querySelectorAll('#toolbar [data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === t);
  }
}

function clearAll() {
  dominoes = [];
  balls = [];
  ramps = [];
  spinners = [];
}

// ---------- Verkfærastika ----------
const actions = { knock: knockFirst, reset: resetAll, clear: clearAll };
for (const b of document.querySelectorAll('#toolbar button')) {
  // Ekki láta takkann fá fókus, annars myndi bilstöngin líka „smella“ á hann
  b.addEventListener('pointerdown', e => e.preventDefault());
  b.addEventListener('click', () => {
    initAudio();
    if (b.dataset.tool) setTool(b.dataset.tool);
    if (b.dataset.action) actions[b.dataset.action]();
    b.blur();
  });
}

function onKeyPress(code) {
  if (code === 'Space') knockFirst();
  if (code === 'KeyR') resetAll();
  if (code === 'KeyC') clearAll();
  if (code === 'KeyK') {
    const order = ['dominoes', 'giant', 'ball', 'melon', 'ramp', 'spinner', 'eraser'];
    setTool(order[(order.indexOf(tool) + 1) % order.length]);
  }
  if (code === 'Digit1') setTool('dominoes');
  if (code === 'Digit2') setTool('giant');
  if (code === 'Digit3') setTool('ball');
  if (code === 'Digit4') setTool('melon');
  if (code === 'Digit5') setTool('ramp');
  if (code === 'Digit6') setTool('spinner');
  if (code === 'Digit7') setTool('eraser');
}

// ---------- Uppfærsla ----------
function update(dt) {
  updateBalls(dt);
  updateSpinners(dt);

  for (const d of dominoes) {
    if (d.state !== 'falling') continue;

    // Hærri kubbar falla hægar (eins og í alvörunni)
    d.vel += GRAVITY / d.size * Math.sin(d.angle + 0.15) * dt;
    d.angle += d.vel * dt;
    if (d.angle >= Math.PI / 2) d.angle = Math.PI / 2;

    // Hversu langt nær toppurinn núna, og í hvaða hæð er hann?
    const reach = (THICK / 2 + TALL * Math.sin(d.angle)) * d.size;
    const tipZ = d.z + TALL * d.size * Math.cos(d.angle);
    // Lenti toppurinn á gólfinu (eða á brekku upp í móti)?
    const groundZ = heightAt(d.x + d.dirX * reach, d.y + d.dirY * reach);
    if (d.angle >= Math.PI / 2 || (d.angle > 0.3 && tipZ <= groundZ + 0.5)) {
      d.state = 'down';
      click(d.size);
    }
    dominoHitsMelons(d, reach);
    if (dominoHitsSpinners(d, reach)) continue;
    for (const o of dominoes) {
      if (o.state !== 'standing') continue;
      const ox = o.x - d.x, oy = o.y - d.y;
      const along = ox * d.dirX + oy * d.dirY;
      if (along <= 0 || along > reach + THICK * o.size / 2) continue;
      const across = Math.abs(ox * d.dirY - oy * d.dirX);
      if (across > WIDE * (d.size + o.size) / 4 + 1.5) continue;
      // Toppurinn þarf að lenda á kubbnum, ekki fara yfir hann eða undir
      if (tipZ < o.z - 0.5 || tipZ > o.z + TALL * o.size + 0.5) continue;
      knock(o, d.dirX, d.dirY, Math.max(1.5, d.vel * 0.6 * d.size / o.size));
      click(o.size);
    }
  }
}

// ---------- Teikning ----------
function drawDomino(d) {
  const s = Math.sin(d.angle), c = Math.cos(d.angle);
  // Fótspor kubbsins séð ofan frá (vippar um frambrúnina)
  const from = THICK / 2 - THICK * c;
  const to = THICK / 2 + TALL * s;

  ctx.save();
  ctx.translate(d.x, d.y - d.z * LIFT);
  ctx.rotate(Math.atan2(d.dirY, d.dirX));
  ctx.scale(d.size, d.size);

  // Skuggi – lengri meðan kubburinn stendur
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(from + 1, -WIDE / 2 + 1, (to - from) + 2 * c, WIDE);

  // Kubburinn sjálfur
  const light = 45 + 25 * s;
  ctx.fillStyle = `hsl(${d.hue}, 80%, ${light}%)`;
  ctx.fillRect(from, -WIDE / 2, to - from, WIDE);

  // Þegar hann liggur sést framhliðin: strik í miðjunni og punktar
  if (s > 0.7) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const mid = (from + to) / 2;
    ctx.fillRect(mid - 0.5, -WIDE / 2 + 1, 1, WIDE - 2);
    ctx.fillStyle = '#fff';
    ctx.fillRect(from + 2, -0.5, 1, 1);
    ctx.fillRect(to - 3, -2, 1, 1);
    ctx.fillRect(to - 3, 1, 1, 1);
  }
  ctx.restore();
}

function draw() {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  // Borðplata
  ctx.fillStyle = '#5a3b26';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#634129';
  for (let y = 0; y < H; y += 12) ctx.fillRect(0, y, W, 1);
  for (const r of ramps) drawRamp(r, false);

  for (const d of dominoes) if (d.state !== 'standing') drawDomino(d);
  for (const d of dominoes) if (d.state === 'standing') drawDomino(d);
  for (const p of spinners) drawSpinner(p);
  for (const b of balls) {
    if (b.kind === 'melon') drawMelon(b);
    else drawBall(b.x, b.y - (b.z || 0) * LIFT, Math.max(0, b.alpha));
  }
  drawRampDraft();
  drawAim();

  // Strokleður
  if (mouse.right) {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, ERASE_R, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Upplýsingar
  const fallen = dominoes.filter(d => d.state !== 'standing').length;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, 10);
  ctx.fillRect(0, H - 10, W, 10);
  ctx.fillStyle = '#fff';
  ctx.font = '600 7px system-ui, "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`Kubbar: ${dominoes.length}   Fallnir: ${fallen}`, 3, 1);
  const help = {
    dominoes: 'Draga: raða   Draga frá kubbi: fella   Hægri: stroka',
    giant: 'Draga: raða risakubbum   Draga frá kubbi: fella   Hægri: stroka',
    ball: 'Dragðu aftur og slepptu til að skjóta kúlu   Hægri: stroka',
    melon: 'Smelltu til að setja melónu milli raða   Hægri: stroka',
    ramp: 'Dragðu til að búa til ramp upp og niður   Hægri: stroka',
    spinner: 'Smelltu til að setja skopparakringlu, felldu kubb á hana   Hægri: stroka',
    eraser: 'Dragðu yfir hluti til að stroka þá út',
  };
  ctx.fillText(help[tool], 3, H - 9);

  const busy = dominoes.some(d => d.state === 'falling');
  if (dominoes.length > 1 && fallen === dominoes.length && !busy) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffec27';
    ctx.fillText('Allir féllu! Ýttu á R til að reisa upp aftur', W / 2, 14);
    ctx.textAlign = 'left';
  }
}

// ---------- Leikjalykkja (föst tímaskref) ----------
const STEP = 1 / 60;
let last = performance.now();
let acc = 0;

function loop(now) {
  acc += Math.min((now - last) / 1000, 0.25); // forðast "spiral of death"
  last = now;
  while (acc >= STEP) {
    update(STEP);
    acc -= STEP;
  }
  draw();
  requestAnimationFrame(loop);
}
setTool(tool); // merkja virka verkfærið í stikunni
requestAnimationFrame(loop);
