/**
 * ARTE PROCEDURAL
 *
 * Nenhum sprite é baixado: tudo é desenhado em canvas na inicialização e vira
 * textura do Phaser. As formigas são desenhadas em tons claros para receberem
 * tint da cor da colônia — assim cada colônia tem sua identidade visual.
 */

import { ROLE, BUILDING, RESOURCE, BUILDING_INFO } from '@shared/constants.js';

export const ANT_FRAMES = 4;

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function addTexture(scene, key, canvas) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  scene.textures.addCanvas(key, canvas);
}

function ellipse(ctx, x, y, rx, ry, fill, stroke, lw = 1.2) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

// ---------------------------------------------------------------- formigas
/**
 * Desenha uma formiga virada para a direita, em tons neutros (para tint).
 * @param {number} frame 0..3 fase da caminhada
 */
function drawAnt(ctx, size, role, frame) {
  const s = size / 48;
  ctx.save();
  ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const bodyLight = '#f2f2f2';
  const bodyMid = '#cfcfcf';
  const bodyDark = '#8f8f8f';
  const outline = 'rgba(40,40,40,0.85)';

  const big = role === ROLE.SOLDIER;
  const queen = role === ROLE.QUEEN;
  const scout = role === ROLE.SCOUT;

  const cx = 22;
  const cy = 24;
  const thoraxR = queen ? 5.4 : big ? 5.6 : scout ? 3.6 : 4.4;
  const headR = queen ? 4.6 : big ? 6.2 : scout ? 3.8 : 4.2;
  const abdR = queen ? 10.5 : big ? 6.4 : scout ? 4.6 : 6.2;

  const headX = cx + (queen ? 8 : 9);
  const abdX = cx - (queen ? 13 : big ? 10 : 9);

  // pernas (3 pares) — animação alterna
  const phase = (frame / ANT_FRAMES) * Math.PI * 2;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.5;
  const legPairs = [
    { x: cx + 3, spread: 1.0 },
    { x: cx, spread: 1.15 },
    { x: cx - 3, spread: 0.95 },
  ];
  legPairs.forEach((leg, i) => {
    for (const side of [-1, 1]) {
      const swing = Math.sin(phase + i * 1.4 + (side > 0 ? 0 : Math.PI)) * 3.2;
      const kneeX = leg.x + swing * 0.4;
      const kneeY = cy + side * (7 + leg.spread * 2.5);
      const footX = leg.x + swing + (i - 1) * 1.6;
      const footY = cy + side * (11.5 + leg.spread * 2);
      ctx.beginPath();
      ctx.moveTo(leg.x, cy + side * 3);
      ctx.quadraticCurveTo(kneeX, kneeY, footX, footY);
      ctx.stroke();
    }
  });

  // abdômen
  ellipse(ctx, abdX, cy, abdR, abdR * (queen ? 0.88 : 0.78), bodyMid, outline);
  ellipse(ctx, abdX - abdR * 0.18, cy - abdR * 0.22, abdR * 0.5, abdR * 0.34, 'rgba(255,255,255,0.45)');
  // listras discretas
  ctx.strokeStyle = 'rgba(60,60,60,0.35)';
  ctx.lineWidth = 1;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.ellipse(abdX + i * abdR * 0.42, cy, abdR * 0.16, abdR * 0.72, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // cintura (pecíolo)
  ctx.strokeStyle = bodyMid;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(abdX + abdR * 0.7, cy);
  ctx.lineTo(cx - thoraxR * 0.6, cy);
  ctx.stroke();

  // tórax
  ellipse(ctx, cx, cy, thoraxR, thoraxR * 0.86, bodyLight, outline);
  ellipse(ctx, cx - 1, cy - 2, thoraxR * 0.55, thoraxR * 0.32, 'rgba(255,255,255,0.6)');

  // cabeça
  ellipse(ctx, headX, cy, headR, headR * 0.9, bodyLight, outline);
  ellipse(ctx, headX - 0.5, cy - headR * 0.4, headR * 0.5, headR * 0.26, 'rgba(255,255,255,0.7)');

  // olhos
  ctx.fillStyle = 'rgba(30,30,30,0.9)';
  ctx.beginPath(); ctx.arc(headX + headR * 0.35, cy - headR * 0.3, headR * 0.19, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(headX + headR * 0.42, cy + headR * 0.3, headR * 0.15, 0, Math.PI * 2); ctx.fill();

  // mandíbulas
  ctx.strokeStyle = bodyDark;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  if (big) {
    ctx.moveTo(headX + headR * 0.8, cy - 2.4);
    ctx.quadraticCurveTo(headX + headR + 4, cy - 1.2, headX + headR * 0.75, cy + 1.2);
    ctx.moveTo(headX + headR * 0.8, cy + 2.6);
    ctx.quadraticCurveTo(headX + headR + 3.4, cy + 1.5, headX + headR * 0.7, cy - 0.4);
  } else {
    ctx.moveTo(headX + headR * 0.85, cy - 2);
    ctx.quadraticCurveTo(headX + headR + 3, cy - 0.5, headX + headR * 0.9, cy + 1);
  }
  ctx.stroke();

  // antenas (com "joelho")
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.2;
  const antLen = scout ? 11 : 7.5;
  for (const side of [-1, 1]) {
    const wob = Math.sin(phase * 0.8 + (side > 0 ? 1 : 0)) * 1.4;
    ctx.beginPath();
    ctx.moveTo(headX + 1, cy + side * 2.2);
    ctx.quadraticCurveTo(headX + 5, cy + side * (4 + wob), headX + antLen, cy + side * (6 + wob));
    ctx.stroke();
  }

  ctx.restore();
}

function drawLarva(ctx, size) {
  const s = size / 48;
  ctx.save(); ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(90,80,60,0.6)';
  ctx.fillStyle = '#efe6cf';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.ellipse(24, 24, 11, 7.5, -0.25, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(180,160,120,0.7)';
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(24 + i * 3.4, 18.4);
    ctx.lineTo(24 + i * 3.4, 29.4);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath(); ctx.ellipse(20, 20, 4, 2.2, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawEgg(ctx, size) {
  const s = size / 48;
  ctx.save(); ctx.scale(s, s);
  ctx.fillStyle = '#f4ecd8';
  ctx.strokeStyle = 'rgba(120,105,80,0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(24, 24, 6.5, 8.5, 0.15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath(); ctx.ellipse(22, 20, 2.4, 3.1, 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------- predadores
function drawPredator(ctx, size, kind) {
  const s = size / 64;
  ctx.save(); ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (kind === 'beetle') {
    ctx.strokeStyle = '#20180f';
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(28 + i * 5, 32 + side * 6);
        ctx.lineTo(24 + i * 7, 32 + side * 18);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#3a2a1c';
    ctx.strokeStyle = '#171008';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(34, 32, 19, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#523a25';
    ctx.beginPath(); ctx.ellipse(32, 28, 12, 6, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#20160d';
    ctx.beginPath(); ctx.ellipse(52, 32, 7, 6.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#20160d'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(54, 28); ctx.quadraticCurveTo(62, 24, 63, 30); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(54, 36); ctx.quadraticCurveTo(60, 38, 61, 34); ctx.stroke();
    ctx.fillStyle = 'rgba(255,220,150,0.5)';
    ctx.beginPath(); ctx.arc(52, 28, 1.6, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'spider') {
    ctx.strokeStyle = '#1b1417';
    ctx.lineWidth = 2.6;
    for (let i = 0; i < 4; i++) {
      for (const side of [-1, 1]) {
        const baseX = 30 + i * 2;
        const spread = 10 + i * 3.2;
        ctx.beginPath();
        ctx.moveTo(baseX, 32);
        ctx.quadraticCurveTo(baseX + 4 - i * 2, 32 + side * spread * 0.55, baseX - 6 + i * 2, 32 + side * spread);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#241a1e';
    ctx.strokeStyle = '#0d080a';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(28, 32, 15, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(45, 32, 9, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#b8332a';
    ctx.beginPath(); ctx.arc(46, 29, 1.8, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(49, 33, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(230,220,200,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(27, 30, 10, 6, -0.3, 0, Math.PI * 2); ctx.stroke();
  } else if (kind === 'wasp') {
    ctx.strokeStyle = '#1a1708';
    ctx.lineWidth = 1.6;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(28 + i * 5, 32 + side * 4);
        ctx.lineTo(24 + i * 6, 32 + side * 11);
        ctx.stroke();
      }
    }
    // asas translúcidas
    ctx.fillStyle = 'rgba(220,235,245,0.35)';
    ctx.strokeStyle = 'rgba(180,200,215,0.5)';
    ctx.beginPath(); ctx.ellipse(30, 20, 14, 7, -0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(30, 44, 14, 7, 0.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // corpo listrado
    ctx.save();
    ctx.beginPath(); ctx.ellipse(32, 32, 17, 8, 0, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#e8c34a'; ctx.fillRect(10, 20, 50, 28);
    ctx.fillStyle = '#201a10';
    for (let i = 0; i < 4; i++) ctx.fillRect(16 + i * 8, 20, 3.6, 28);
    ctx.restore();
    ctx.strokeStyle = '#201a10'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.ellipse(32, 32, 17, 8, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#2a2113';
    ctx.beginPath(); ctx.ellipse(52, 32, 6, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#e8c34a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(58, 26); ctx.lineTo(63, 22); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(58, 38); ctx.lineTo(63, 42); ctx.stroke();
  } else if (kind === 'termite') {
    ctx.strokeStyle = '#3b2c1c';
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(28 + i * 5, 32 + side * 5);
        ctx.lineTo(26 + i * 6, 32 + side * 13);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#d8c6a4';
    ctx.strokeStyle = '#6a5236';
    ctx.beginPath(); ctx.ellipse(24, 32, 15, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(40, 32, 8, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f0e2c6';
    ctx.beginPath(); ctx.ellipse(49, 32, 7, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8a6a3e';
    ctx.beginPath(); ctx.ellipse(47, 29, 1.4, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'lizard') {
    ctx.fillStyle = '#4f6b3a';
    ctx.strokeStyle = '#2b3a22';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(10, 32);
    ctx.quadraticCurveTo(24, 16, 44, 26);
    ctx.quadraticCurveTo(56, 30, 58, 32);
    ctx.quadraticCurveTo(50, 36, 40, 40);
    ctx.quadraticCurveTo(22, 46, 10, 32);
    ctx.fill(); ctx.stroke();
    // cabeça
    ctx.beginPath(); ctx.ellipse(54, 31, 9, 6, 0.1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#120f0a';
    ctx.beginPath(); ctx.arc(57, 28.5, 1.7, 0, Math.PI * 2); ctx.fill();
    // patas
    ctx.strokeStyle = '#3c522c'; ctx.lineWidth = 3;
    [[30, 40, 24, 52], [42, 38, 40, 52], [26, 26, 18, 14], [38, 25, 34, 14]].forEach(([x1, y1, x2, y2]) => {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    });
    // escamas
    ctx.strokeStyle = 'rgba(200,220,160,0.28)'; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath(); ctx.arc(24 + i * 6, 31 + (i % 2 ? 2 : -2), 3, 0, Math.PI * 2); ctx.stroke();
    }
  } else if (kind === 'antlion') {
    // areia em funil
    const grad = ctx.createRadialGradient(32, 34, 4, 32, 34, 28);
    grad.addColorStop(0, 'rgba(80,58,32,0.95)');
    grad.addColorStop(1, 'rgba(140,112,70,0.15)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(32, 34, 27, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(60,44,24,0.8)'; ctx.lineWidth = 1.6;
    for (let r = 8; r < 26; r += 5) { ctx.beginPath(); ctx.arc(32, 34, r, 0, Math.PI * 2); ctx.stroke(); }
    // mandíbulas
    ctx.fillStyle = '#4a3620';
    ctx.strokeStyle = '#241a10';
    ctx.beginPath();
    ctx.moveTo(32, 30); ctx.quadraticCurveTo(46, 20, 52, 32);
    ctx.quadraticCurveTo(44, 34, 32, 34); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(32, 30); ctx.quadraticCurveTo(18, 20, 12, 32);
    ctx.quadraticCurveTo(20, 34, 32, 34); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7a5c34';
    ctx.beginPath(); ctx.arc(32, 34, 4, 0, Math.PI * 2); ctx.fill();
  }

  ctx.restore();
}

// ---------------------------------------------------------------- estruturas
function drawStructure(ctx, size, type) {
  const s = size / 96; // desenhamos em base 96 e escalamos
  ctx.save(); ctx.scale(s, s);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const dirt = '#5b4128';
  const dirtDark = '#33220f';
  const rim = '#7a5836';

  const chamber = (x, y, rx, ry, fill = '#2b1d11') => {
    ctx.fillStyle = fill;
    ctx.strokeStyle = rim;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,220,170,0.12)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(x, y - 2, rx * 0.72, ry * 0.62, 0, 0, Math.PI * 2); ctx.stroke();
  };

  switch (type) {
    case BUILDING.TUNNEL: {
      ctx.strokeStyle = dirtDark; ctx.lineWidth = 22;
      ctx.beginPath(); ctx.moveTo(8, 48); ctx.bezierCurveTo(30, 30, 62, 66, 88, 46); ctx.stroke();
      ctx.strokeStyle = dirt; ctx.lineWidth = 16;
      ctx.beginPath(); ctx.moveTo(8, 48); ctx.bezierCurveTo(30, 30, 62, 66, 88, 46); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,220,170,0.10)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(10, 44); ctx.bezierCurveTo(30, 27, 62, 63, 86, 42); ctx.stroke();
      break;
    }
    case BUILDING.CHAMBER:
      chamber(48, 48, 40, 34);
      // grãos espalhados
      ctx.fillStyle = 'rgba(200,160,100,0.25)';
      for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.arc(28 + (i * 17) % 42, 40 + (i * 23) % 26, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case BUILDING.STORAGE:
      chamber(48, 52, 38, 30);
      // cesto/folhas armazenadas
      ctx.fillStyle = '#6fbf4a';
      for (let i = 0; i < 5; i++) {
        ctx.save();
        ctx.translate(30 + i * 10, 44 + (i % 2) * 9);
        ctx.rotate(-0.4 + i * 0.2);
        ctx.beginPath(); ctx.ellipse(0, 0, 7, 3.4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = '#d7b45a';
      ctx.beginPath(); ctx.arc(64, 58, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(72, 54, 2.6, 0, Math.PI * 2); ctx.fill();
      break;
    case BUILDING.NURSERY:
      chamber(48, 48, 40, 34, '#2e1f12');
      // ovos e larvas
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = '#f4ecd8';
        ctx.strokeStyle = 'rgba(120,100,70,0.5)';
        ctx.lineWidth = 1;
        const x = 30 + (i % 3) * 18;
        const y = 42 + Math.floor(i / 3) * 16;
        ctx.beginPath(); ctx.ellipse(x, y, 6, 8, 0.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      break;
    case BUILDING.FEEDING:
      chamber(48, 52, 36, 28, '#2a1c10');
      ctx.fillStyle = 'rgba(120,180,220,0.4)';
      ctx.beginPath(); ctx.ellipse(48, 52, 20, 13, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(230,190,120,0.55)';
      ctx.beginPath(); ctx.ellipse(44, 48, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(54, 55, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
      break;
    case BUILDING.BARRACKS:
      chamber(48, 50, 40, 32, '#2a1a12');
      ctx.strokeStyle = '#b6553d'; ctx.lineWidth = 3.4;
      for (let i = 0; i < 5; i++) {
        const x = 26 + i * 11;
        ctx.beginPath(); ctx.moveTo(x, 58); ctx.lineTo(x + 3, 34); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + 7, 58); ctx.lineTo(x + 4, 36); ctx.stroke();
      }
      break;
    case BUILDING.EXIT: {
      // monte de terra com buraco escuro (visão de cima)
      ctx.fillStyle = '#6a4a2c';
      ctx.beginPath(); ctx.ellipse(48, 48, 40, 36, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#7d5a36';
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(48 + Math.cos(a) * 32, 48 + Math.sin(a) * 28, 3.4, 0, Math.PI * 2); ctx.fill();
      }
      const g = ctx.createRadialGradient(48, 48, 3, 48, 48, 26);
      g.addColorStop(0, '#0a0704'); g.addColorStop(1, '#2a1c10');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(48, 48, 25, 22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,210,150,0.18)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(48, 50, 18, 14, 0, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case BUILDING.WATCHTOWER: {
      ctx.fillStyle = '#6b5136';
      ctx.strokeStyle = '#33240f';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(30, 80); ctx.lineTo(38, 26); ctx.lineTo(58, 26); ctx.lineTo(66, 80); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8a6a45';
      ctx.beginPath(); ctx.ellipse(48, 24, 26, 10, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3a2a18';
      ctx.beginPath(); ctx.ellipse(48, 24, 16, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,220,160,0.4)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(20, 44); ctx.lineTo(30, 40); ctx.stroke();
      break;
    }
    case BUILDING.FUNGUS:
      chamber(48, 50, 40, 32, '#241a12');
      for (let i = 0; i < 5; i++) {
        const x = 26 + i * 12;
        const y = 44 + (i % 3) * 8;
        ctx.strokeStyle = '#d7cbb2'; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(x, y + 12); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = i % 2 ? '#c98bd8' : '#e0b570';
        ctx.beginPath(); ctx.ellipse(x, y - 1, 6.5, 4, 0, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case BUILDING.SHRINE: {
      // câmara circular com brilho real
      const g = ctx.createRadialGradient(48, 48, 4, 48, 48, 44);
      g.addColorStop(0, 'rgba(200,120,200,0.45)');
      g.addColorStop(1, 'rgba(60,30,50,0.0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(48, 48, 44, 0, Math.PI * 2); ctx.fill();
      chamber(48, 48, 42, 38, '#2a1626');
      ctx.strokeStyle = 'rgba(220,150,220,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(48, 48, 30, 0, Math.PI * 2); ctx.stroke();
      // coroa da rainha
      ctx.fillStyle = '#e9b47c';
      ctx.beginPath();
      ctx.moveTo(36, 54); ctx.lineTo(42, 38); ctx.lineTo(48, 50); ctx.lineTo(54, 36); ctx.lineTo(60, 54);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#9c552f'; ctx.lineWidth = 1.3; ctx.stroke();
      break;
    }
    default:
      chamber(48, 48, 40, 34);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- recursos
function drawResource(ctx, size, kind) {
  const s = size / 32;
  ctx.save(); ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (kind) {
    case RESOURCE.LEAF:
      ctx.fillStyle = '#6fbf4a';
      ctx.strokeStyle = '#3f7a2a';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(5, 24); ctx.quadraticCurveTo(4, 7, 25, 6); ctx.quadraticCurveTo(26, 22, 8, 26);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(220,255,190,0.65)';
      ctx.beginPath(); ctx.moveTo(8, 23); ctx.quadraticCurveTo(15, 16, 23, 9); ctx.stroke();
      break;
    case RESOURCE.SEED:
      ctx.fillStyle = '#d7b45a';
      ctx.strokeStyle = '#9c7a2c';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(16, 17, 6.5, 9, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,240,190,0.7)';
      ctx.beginPath(); ctx.ellipse(14, 13.5, 2.2, 3.4, 0.3, 0, Math.PI * 2); ctx.fill();
      break;
    case RESOURCE.FRUIT:
      ctx.fillStyle = '#e0645a';
      ctx.strokeStyle = '#a33c33';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(13, 19, 6.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(21, 18, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,220,210,0.7)';
      ctx.beginPath(); ctx.arc(12, 16.5, 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#4f7a2c'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(17, 12); ctx.quadraticCurveTo(20, 6, 24, 5); ctx.stroke();
      break;
    case RESOURCE.INSECT:
      ctx.fillStyle = '#b98356';
      ctx.strokeStyle = '#6f4527';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(16, 18, 9, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(25, 17, 3.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#6f4527';
      for (let i = 0; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(12 + i * 4, 23); ctx.lineTo(10 + i * 4, 28); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(12 + i * 4, 13); ctx.lineTo(10 + i * 4, 8); ctx.stroke();
      }
      break;
    case RESOURCE.WATER:
      ctx.fillStyle = 'rgba(74,168,216,0.75)';
      ctx.strokeStyle = 'rgba(180,235,255,0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(16, 20, 12, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(220,250,255,0.8)';
      ctx.beginPath(); ctx.ellipse(12, 18, 4, 2, 0, 0, Math.PI * 2); ctx.stroke();
      break;
    case RESOURCE.MATERIAL:
      ctx.fillStyle = '#9c8f7a';
      ctx.strokeStyle = '#6a6053';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(12, 20, 7, 5.5, 0.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#b5a894';
      ctx.beginPath(); ctx.ellipse(21, 17, 5.5, 4.5, -0.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8a7d69';
      ctx.beginPath(); ctx.ellipse(19, 24, 4, 3, 0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      break;
    case RESOURCE.SPORE:
      ctx.fillStyle = 'rgba(199,123,255,0.85)';
      ctx.strokeStyle = 'rgba(240,210,255,0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(16, 18, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(16 + Math.cos(a) * 10, 18 + Math.sin(a) * 8, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    default:
      ctx.fillStyle = '#999'; ctx.beginPath(); ctx.arc(16, 18, 7, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- API
export function buildTextures(scene) {
  // formigas — 4 frames, cada papel
  const roles = [
    { role: ROLE.WORKER, key: 'worker' },
    { role: ROLE.SCOUT, key: 'scout' },
    { role: ROLE.SOLDIER, key: 'soldier' },
    { role: ROLE.QUEEN, key: 'queen' },
  ];
  for (const { role, key } of roles) {
    for (let f = 0; f < ANT_FRAMES; f++) {
      const c = canvasOf(48, 48);
      const ctx = c.getContext('2d');
      drawAnt(ctx, 48, role, f);
      addTexture(scene, `ant_${key}_${f}`, c);
    }
  }
  const larva = canvasOf(48, 48);
  drawLarva(larva.getContext('2d'), 48);
  addTexture(scene, 'ant_larva_0', larva);
  const egg = canvasOf(48, 48);
  drawEgg(egg.getContext('2d'), 48);
  addTexture(scene, 'egg', egg);

  // predadores
  for (const kind of ['beetle', 'spider', 'wasp', 'termite', 'lizard', 'antlion']) {
    const c = canvasOf(64, 64);
    drawPredator(c.getContext('2d'), 64, kind);
    addTexture(scene, `pred_${kind}`, c);
  }

  // estruturas
  const sizes = { [BUILDING.TUNNEL]: 1, [BUILDING.EXIT]: 1, [BUILDING.WATCHTOWER]: 1 };
  for (const [typeStr, info] of Object.entries(BUILDING_INFO)) {
    const type = Number(typeStr);
    const px = info.size * 96;
    const c = canvasOf(px, px);
    drawStructure(c.getContext('2d'), px, type);
    addTexture(scene, `struct_${info.key}`, c);
  }

  // recursos
  for (let k = 0; k < 7; k++) {
    const c = canvasOf(32, 32);
    drawResource(c.getContext('2d'), 32, k);
    addTexture(scene, `res_${k}`, c);
  }

  // marcadores e efeitos
  const dot = canvasOf(16, 16);
  const dctx = dot.getContext('2d');
  const g = dctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  dctx.fillStyle = g;
  dctx.fillRect(0, 0, 16, 16);
  addTexture(scene, 'glow', dot);

  const ring = canvasOf(64, 64);
  const rctx = ring.getContext('2d');
  rctx.strokeStyle = 'rgba(255,255,255,0.9)';
  rctx.lineWidth = 3;
  rctx.beginPath(); rctx.arc(32, 32, 26, 0, Math.PI * 2); rctx.stroke();
  addTexture(scene, 'ring', ring);

  const playerRing = canvasOf(48, 48);
  const pctx = playerRing.getContext('2d');
  pctx.strokeStyle = 'rgba(255,220,150,0.95)';
  pctx.lineWidth = 2.5;
  pctx.setLineDash([5, 4]);
  pctx.beginPath(); pctx.arc(24, 24, 18, 0, Math.PI * 2); pctx.stroke();
  addTexture(scene, 'player-ring', playerRing);

  const rain = canvasOf(8, 28);
  const rainctx = rain.getContext('2d');
  const rg = rainctx.createLinearGradient(0, 0, 0, 28);
  rg.addColorStop(0, 'rgba(200,230,255,0)');
  rg.addColorStop(0.5, 'rgba(200,230,255,0.55)');
  rg.addColorStop(1, 'rgba(200,230,255,0)');
  rainctx.fillStyle = rg;
  rainctx.fillRect(3, 0, 2, 28);
  addTexture(scene, 'rain', rain);

  const dust = canvasOf(8, 8);
  const dustctx = dust.getContext('2d');
  const dg = dustctx.createRadialGradient(4, 4, 0, 4, 4, 4);
  dg.addColorStop(0, 'rgba(220,200,160,0.9)');
  dg.addColorStop(1, 'rgba(220,200,160,0)');
  dustctx.fillStyle = dg; dustctx.fillRect(0, 0, 8, 8);
  addTexture(scene, 'dust', dust);

  // retângulo branco para overlays
  const white = canvasOf(4, 4);
  const wctx = white.getContext('2d');
  wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, 4, 4);
  addTexture(scene, 'white', white);
}

export { drawAnt, drawPredator, drawStructure, drawResource };
