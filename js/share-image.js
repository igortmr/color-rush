// Gera a imagem de compartilhamento de pontuação (cartão 1080x1920, formato
// "story") desenhada 100% em <canvas>, replicando à mão os efeitos visuais
// que no resto do app vêm de CSS (gradiente/sombra 3D do h1, o "degrau"
// colorido + sombra dos quadrados do tabuleiro, o botão neon com brilho
// glass) — canvas não tem acesso a nada disso, então cada efeito é
// redesenhado aqui com fill/shadow/gradiente manuais. Usado por
// window.shareScore em js/share.js.
import { T } from './i18n.js';
import { state } from './state.js';

const W = 1080, H = 1920;

// lê as cores neon direto das custom properties do :root (css/style.css)
// em vez de duplicar os hex aqui, pra nunca ficar dessincronizado se a
// paleta do jogo mudar.
function neonColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = name => cs.getPropertyValue(name).trim();
  return {
    red: v('--neon-red') || '#ff2d6b',
    orange: v('--neon-orange') || '#ff9f1c',
    green: v('--neon-green') || '#21e6a1',
    blue: v('--neon-blue') || '#2dd6ff',
    purple: v('--neon-purple') || '#b14dff',
    yellow: v('--neon-yellow') || '#ffe93c',
    bgDeep: v('--bg-deep') || '#050810',
  };
}

function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/.{1,2}/g) || ['05', '08', '10'];
  return m.map(h => parseInt(h, 16));
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// mede/desenha texto com letter-spacing manual (canvas não tem
// letter-spacing confiável entre navegadores/plataformas) — se `draw` for
// false só calcula a largura total, sem tocar no canvas.
function spacedText(ctx, text, font, spacing, draw, x, y, align = 'center') {
  ctx.font = font;
  const chars = [...text];
  const widths = chars.map(c => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
  if (!draw) return total;
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], cx, y);
    cx += widths[i] + spacing;
  }
  return total;
}

function drawBackground(ctx, C) {
  ctx.fillStyle = C.bgDeep;
  ctx.fillRect(0, 0, W, H);

  // os mesmos três brilhos radiais do fundo do app (#scroll-area em
  // css/style.css), só reescalados pro tamanho do card
  const blobs = [
    { x: W * 0.12, y: -H * 0.03, r: W * 0.85, color: rgba(C.purple, 0.28) },
    { x: W * 1.0, y: H * 0.1, r: W * 0.85, color: rgba(C.blue, 0.2) },
    { x: W * 0.5, y: H * 1.05, r: W * 0.75, color: rgba(C.red, 0.16) },
  ];
  for (const b of blobs) {
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, b.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // grade quadriculada bem sutil, igual ao repeating-linear-gradient do fundo
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
}

// mesmo padrão visual dos .square do tabuleiro: "degrau" sólido da própria
// cor embaixo (0 3px 0 var(--sq-color)) + sombra difusa preta, tile flat por
// cima, e um brilho "de vidro" diagonal (o ::before) por cima de tudo.
function drawTile(ctx, x, y, size, color) {
  const r = size * 0.115;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = size * 0.05;
  ctx.shadowOffsetY = size * 0.045;
  roundRectPath(ctx, x, y + size * 0.02, size, size, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  roundRectPath(ctx, x, y, size, size, r);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.save();
  roundRectPath(ctx, x, y, size, size, r);
  ctx.clip();
  const glass = ctx.createLinearGradient(x, y, x + size, y + size);
  glass.addColorStop(0, 'rgba(255,255,255,0.42)');
  glass.addColorStop(0.45, 'rgba(255,255,255,0)');
  glass.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = glass;
  ctx.fillRect(x, y, size, size);
  ctx.restore();

  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  roundRectPath(ctx, x, y, size, size, r);
  ctx.stroke();
}

// título "COLOR RUSH": mesmo gradiente 90deg (vermelho→laranja→verde→
// azul→roxo) e as mesmas camadas de sombra/extrusão + brilho do h1 em
// css/style.css — encolhe a fonte até caber numa linha só sem quebrar.
function drawLogo(ctx, cx, baseline, C, maxWidth) {
  const text = 'COLOR RUSH';
  const spacing = 6;
  let fontSize = 150;
  let font = `900 ${fontSize}px Orbitron, sans-serif`;
  let width = spacedText(ctx, text, font, spacing, false);
  while (width > maxWidth && fontSize > 40) {
    fontSize -= 2;
    font = `900 ${fontSize}px Orbitron, sans-serif`;
    width = spacedText(ctx, text, font, spacing, false);
  }
  const startX = cx - width / 2;

  ctx.save();
  ctx.font = font;
  // extrusão diagonal (as 3 camadas de text-shadow do h1)
  for (const [dx, dy, a] of [[3, 3, 0.18], [6, 6, 0.14], [9, 9, 0.12]]) {
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    spacedText(ctx, text, font, spacing, true, startX + dx, baseline + dy, 'left');
  }
  ctx.restore();

  const gradient = ctx.createLinearGradient(startX, 0, startX + width, 0);
  gradient.addColorStop(0, C.red);
  gradient.addColorStop(0.25, C.orange);
  gradient.addColorStop(0.5, C.green);
  gradient.addColorStop(0.75, C.blue);
  gradient.addColorStop(1, C.purple);

  // duas passadas de brilho (equivalente aos dois drop-shadow do filter do h1)
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.shadowColor = rgba(C.purple, 0.6);
  ctx.shadowBlur = fontSize * 0.16;
  spacedText(ctx, text, font, spacing, true, startX, baseline, 'left');
  ctx.shadowColor = rgba(C.blue, 0.4);
  ctx.shadowBlur = fontSize * 0.32;
  spacedText(ctx, text, font, spacing, true, startX, baseline, 'left');
  ctx.restore();
}

function drawCta(ctx, x, y, w, h, C, icon, label) {
  const r = h / 2;

  ctx.save();
  ctx.shadowColor = rgba(C.red, 0.5);
  ctx.shadowBlur = h * 0.32;
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = C.red;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = h * 0.08;
  ctx.shadowOffsetY = h * 0.045;
  roundRectPath(ctx, x, y + h * 0.03, w, h, r);
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fill();
  ctx.restore();

  roundRectPath(ctx, x, y, w, h, r);
  const grad = ctx.createLinearGradient(x, y, x + w, y);
  grad.addColorStop(0, C.red);
  grad.addColorStop(1, C.orange);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.clip();
  const glass = ctx.createLinearGradient(x, y, x + w * 0.3, y + h);
  glass.addColorStop(0, 'rgba(255,255,255,0.42)');
  glass.addColorStop(0.45, 'rgba(255,255,255,0)');
  glass.addColorStop(1, 'rgba(0,0,0,0.14)');
  ctx.fillStyle = glass;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  // ícone + texto centralizados como um único bloco no meio do botão (em vez
  // de ícone fixo na borda esquerda + texto solto) — mede a largura do texto
  // primeiro pra poder centralizar o conjunto [ícone][gap][texto] inteiro
  const iconSize = h * 0.66;
  const iconTextGap = h * 0.18;
  const labelFont = `900 ${Math.round(h * 0.32)}px Orbitron, sans-serif`;
  ctx.font = labelFont;
  const labelWidth = ctx.measureText(label).width;
  const groupWidth = iconSize + iconTextGap + labelWidth;
  const groupX = x + (w - groupWidth) / 2;

  const iconX = groupX;
  const iconY = y + (h - iconSize) / 2;
  if (icon) {
    ctx.save();
    roundRectPath(ctx, iconX, iconY, iconSize, iconSize, iconSize * 0.24);
    ctx.clip();
    ctx.drawImage(icon, iconX, iconY, iconSize, iconSize);
    ctx.restore();
  }

  ctx.font = labelFont;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#0a0e1e';
  ctx.fillText(label, iconX + iconSize + iconTextGap, y + h / 2 + h * 0.02);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export async function buildShareImageBlob(score) {
  const t = T[state.lang];
  const C = neonColors();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  await Promise.allSettled([
    document.fonts.load('900 130px Orbitron'),
    document.fonts.load('800 50px Orbitron'),
    document.fonts.load('700 42px Rajdhani'),
    document.fonts.load('600 42px Rajdhani'),
    document.fonts.ready,
  ]);
  let icon = null;
  try { icon = await loadImage('icons/icon-192.png'); } catch {}

  drawBackground(ctx, C);

  // tagline
  ctx.save();
  ctx.fillStyle = C.yellow;
  ctx.shadowColor = rgba(C.yellow, 0.5);
  ctx.shadowBlur = 14;
  spacedText(ctx, t.share_img_tagline1, "800 48px Orbitron, sans-serif", 2, true, W / 2, 210, 'center');
  spacedText(ctx, t.share_img_tagline2, "800 48px Orbitron, sans-serif", 2, true, W / 2, 270, 'center');
  ctx.restore();

  // tabuleiro 2x2 — só simbólico/decorativo (bem menor que o card inteiro),
  // não é o foco da imagem
  const gap = 22, size = 170, gridX = (W - (size * 2 + gap)) / 2, gridY = 400;
  const tiles = [
    { color: C.purple, x: gridX, y: gridY },
    { color: C.blue, x: gridX + size + gap, y: gridY },
    { color: C.red, x: gridX, y: gridY + size + gap },
    { color: C.green, x: gridX + size + gap, y: gridY + size + gap },
  ];
  for (const tl of tiles) drawTile(ctx, tl.x, tl.y, size, tl.color);

  // logo
  drawLogo(ctx, W / 2, 1020, C, 950);

  // "Fiz {score} pontos."
  const prefixFont = "600 54px Rajdhani, sans-serif";
  const scoreFont = "900 78px Orbitron, sans-serif";
  const suffixFont = prefixFont;
  const prefix = t.share_img_prefix;
  const scoreStr = String(score);
  const suffix = t.share_img_suffix(score);
  const wPrefix = spacedText(ctx, prefix, prefixFont, 0, false);
  const wScore = spacedText(ctx, scoreStr, scoreFont, 1, false);
  const wSuffix = spacedText(ctx, suffix, suffixFont, 0, false);
  const totalW = wPrefix + wScore + wSuffix;
  let cursorX = W / 2 - totalW / 2;
  const scoreBaseline = 1260;
  ctx.fillStyle = '#eef1ff';
  spacedText(ctx, prefix, prefixFont, 0, true, cursorX, scoreBaseline, 'left');
  cursorX += wPrefix;
  ctx.save();
  ctx.fillStyle = C.yellow;
  ctx.shadowColor = rgba(C.yellow, 0.55);
  ctx.shadowBlur = 16;
  spacedText(ctx, scoreStr, scoreFont, 1, true, cursorX, scoreBaseline + 4, 'left');
  ctx.restore();
  cursorX += wScore;
  ctx.fillStyle = '#eef1ff';
  spacedText(ctx, suffix, suffixFont, 0, true, cursorX, scoreBaseline, 'left');

  // "Consegue me vencer?"
  ctx.fillStyle = '#eef1ff';
  spacedText(ctx, t.share_img_question, "700 48px Rajdhani, sans-serif", 0, true, W / 2, 1345, 'center');

  // CTA
  drawCta(ctx, (W - 820) / 2, 1480, 820, 150, C, icon, t.share_img_cta);

  // domínio
  ctx.save();
  ctx.fillStyle = C.yellow;
  ctx.shadowColor = rgba(C.yellow, 0.5);
  ctx.shadowBlur = 12;
  spacedText(ctx, 'colorrush.com.br', "700 40px Rajdhani, sans-serif", 2, true, W / 2, 1840, 'center');
  ctx.restore();

  // JPEG, não PNG: o share sheet nativo do iOS (Web Share API) não gera
  // miniatura de preview pra arquivos PNG — só mostra o ícone genérico de
  // "documento". Com JPEG a preview da imagem aparece certinho, e como o
  // cartão não tem transparência (fundo sempre opaco) não perde nada trocar
  // — só fica mais leve.
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.92));
}
