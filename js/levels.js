import { $ } from './dom.js';
import { state } from './state.js';
import { T } from './i18n.js';
import { COLORS } from './constants.js';

export function xpStreakMultiplier(streak) {
  if (streak <= 10) return 1;
  if (streak <= 25) return 1.25;
  if (streak <= 50) return 1.5;
  return 2;
}
export const MODE_UNLOCK = { reverse: 5, shapes: 10, 'shapes-reverse': 15, trio: 20, caos: 25, mosaic: 30 }; // nível mínimo pra jogar cada modo
export const xpForNext = lv => lv * 100;
export const totalXpForLevel = lv => 50 * lv * (lv - 1); // XP total acumulada ao atingir o nível lv
export function levelFromXp(xp) {
  let lv = 1;
  while (xp >= totalXpForLevel(lv + 1)) lv++;
  return lv;
}
export function xpInfo(xp) {
  const lv = levelFromXp(xp);
  return { lv, into: xp - totalXpForLevel(lv), need: xpForNext(lv) };
}
export function myXp() { return state.offline ? 0 : (state.myData.xp || 0); } // sem conta não acumula XP nem sobe de nível
// versão genérica de modeUnlocked, pra checar o desbloqueio de QUALQUER
// pessoa (ex.: o amigo sendo desafiado pra um duelo, ver openChallengeModeModal
// em js/pvp.js), não só da própria conta logada
export function modeUnlockedForXp(m, xp, isAdmin) { return isAdmin === true || !MODE_UNLOCK[m] || levelFromXp(xp || 0) >= MODE_UNLOCK[m]; }
export function modeUnlocked(m) { return modeUnlockedForXp(m, myXp(), state.myData.admin === true); }

// clãs (Espectro) — mesmos limites de functions/index.js, espelhados aqui só
// pra validar/mostrar mensagem amigável ANTES de chamar o servidor (que
// sempre reconfere tudo de novo, ver createGuild/requestJoinGuild)
export const GUILD_CREATE_MIN_LEVEL = 10;
export const GUILD_JOIN_MIN_LEVEL = 5;
export const GUILD_MAX_MEMBERS = 10;
// curva de nível do clã — 2x mais lenta que a de jogador (ver
// totalXpForGuildLevel/guildLevelFromXpSrv em functions/index.js); ninguém
// concede XP de clã ainda, todo clã fica em level 1 por enquanto
export const totalXpForGuildLevel = lv => 100 * lv * (lv - 1);
export function guildLevelFromXp(xp) {
  let lv = 1;
  while (xp >= totalXpForGuildLevel(lv + 1)) lv++;
  return lv;
}
// conta banida (campo "banned" setado à mão no Firebase Console, ver
// checkNotBanned em functions/index.js) não pode jogar NENHUM modo — isso
// aqui é só a trava do client (mensagem amigável antes de nem tentar); o
// servidor já rejeitaria qualquer sessão/pontuação de uma conta banida de
// qualquer forma, isso aqui só evita deixar a pessoa jogar a partida
// inteira só pra descobrir no fim que não vai valer nada
export function isBanned() { return state.myData.banned === true; }
export function blockIfBanned() {
  if (!isBanned()) return false;
  alert(T[state.lang].banned_msg);
  return true;
}

// cor do emblema de nível é um único degradê contínuo por toda a subida: começa
// verde no nível 5, passa por azul, roxo, branco, amarelo e laranja, e termina
// vermelho no nível 95 (ver LV_SPECTRUM/lvSpectrumColor — interpolação linear
// de RGB entre os "stops" da paleta da marca); cada chip mostra 3 tons vizinhos
// desse degradê centrados na sua própria faixa de 5 níveis (ver lvChipGradient),
// então a cor muda suave e continuamente de faixa pra faixa sem nunca repetir; e
// o nível 100 vira "master" — arco-íris animado, igual (mesmo ciclo de cores e
// duração) a moldura arco-íris da loja (ver .lv-chip-master no CSS)
const LV_SPECTRUM = ['#21e6a1', '#2dd6ff', '#b14dff', '#ffffff', '#ffe93c', '#ff9f1c', '#ff2d6b'];
const LV_MAX_BAND = 19; // faixa do nível 95-99, o último degrau antes do "master" no nível 100
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mixHex(hexA, hexB, f) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * f).toString(16).padStart(2, '0')).join('');
}
export function lvSpectrumColor(t) {
  const segs = LV_SPECTRUM.length - 1;
  const scaled = Math.min(Math.max(t, 0), 1) * segs;
  const i = Math.min(Math.floor(scaled), segs - 1);
  return mixHex(LV_SPECTRUM[i], LV_SPECTRUM[i + 1], scaled - i);
}
export function lvChipGradient(band) {
  const t = Math.min(Math.max(band / LV_MAX_BAND, 0), 1);
  const d = 0.035;
  return [lvSpectrumColor(Math.max(0, t - d)), lvSpectrumColor(t), lvSpectrumColor(Math.min(1, t + d))];
}
export function lvChip(xp) {
  const lv = levelFromXp(xp || 0);
  if (lv >= 100) return `<span class="lv-chip lv-chip-master">Lv ${lv}</span>`;
  const band = Math.floor(lv / 5);
  const [c1, c2, c3] = lvChipGradient(band);
  return `<span class="lv-chip" style="background:linear-gradient(90deg, ${c1}, ${c2}, ${c3}); -webkit-background-clip:text; background-clip:text; color:transparent; border-color:${c2}88; text-shadow:0 0 6px ${c2}80">Lv ${lv}</span>`;
}
// moldura da loja ao redor do nick — "equipped" é público (mesmo doc de
// scores/{uid} que já alimenta o ranking), então aparece pra QUALQUER um que
// tiver comprado e equipado, não só pra você mesmo
export function applyNickFrame(el, stats) {
  const frame = stats && stats.equipped && stats.equipped.frame;
  el.classList.remove('nick-frame-gold', 'nick-frame-rainbow');
  if (frame === 'frame_gold') el.classList.add('nick-frame-gold');
  else if (frame === 'frame_rainbow') el.classList.add('nick-frame-rainbow');
}
// cor/animação da [TAG] do clã, comprada no Cofre do Clã (ver
// buyGuildTagStyle em functions/index.js) — campo público (scores/{uid}.
// guildTagStyle, espelhado em todo membro igual guildTag), então funciona
// pra QUALQUER [TAG] renderizada, não só a sua. As 8 cores básicas são as
// mesmas de COLORS (aplicadas via style inline, sem precisar de 8 classes
// CSS); a especial (espectro) usa classe + animação (ver .tag-style-espectro
// em css/style.css). "gold"/"rgb" existiram e foram removidos (gold ficava
// parecido com yellow, rgb com espectro) — se algum clã ainda tiver um dos
// dois salvo de antes, cai no fallback (sem cor) em vez de quebrar.
export function applyGuildTagStyle(el, tagStyle) {
  el.classList.remove('tag-style-espectro');
  el.style.color = '';
  el.style.textShadow = '';
  if (!tagStyle) return;
  const basic = COLORS.find(c => c.key === tagStyle);
  if (basic) {
    el.style.color = basic.hex;
    el.style.textShadow = `0 0 6px ${basic.hex}99`;
    return;
  }
  if (tagStyle === 'espectro') el.classList.add('tag-style-espectro');
}
// linha temática da loja — fundo diferenciado na <tr> do jogador nas tabelas
// de ranking, pra se destacar na lista. Mesmo raciocínio da moldura: campo
// público (stats.equipped), então funciona pra QUALQUER linha (não só a sua).
// id do item -> classe CSS (ver tbody tr.row-theme-* em style.css/
// style-teste.css); padrão (linha) fica só na 1000, itens "premium" (1500,
// com padrão/animação, ver ROW_THEME_CLASS) marcados como tal só pra
// referência de quem for revisar o catálogo, não afeta o código.
const ROW_THEME_CLASS = {
  row_ocean: 'row-theme-ocean',
  row_galaxy: 'row-theme-galaxy',
  row_forest: 'row-theme-forest',
  row_sunset: 'row-theme-sunset',
  row_frost: 'row-theme-frost',
  row_yellow: 'row-theme-yellow',
  row_pink: 'row-theme-pink',
  row_starfield: 'row-theme-starfield',
  row_holo: 'row-theme-holo',
  row_stripes_gold: 'row-theme-stripes-gold',
  row_storm: 'row-theme-storm',
  row_confetti_dots: 'row-theme-confetti-dots',
  // linhas com arte de fundo real -- "testOnly" em js/shop.js as esconde da
  // loja em index.html, mas o item ainda existe no catálogo (mesmo padrão
  // de avatar/frame/confetti/sfx). A classe CSS correspondente só existe em
  // style-teste.css, então mesmo que uma delas fosse equipada via API
  // direta em produção (não pela UI), não teria efeito visual nenhum lá.
  row_unicorn3: 'row-theme-unicorn3',
  row_forest2: 'row-theme-forest2',
  row_yinyang: 'row-theme-yinyang',
  row_meteor: 'row-theme-meteor',
  row_dragon: 'row-theme-dragon',
  row_cyberpunk: 'row-theme-cyberpunk',
  row_cosmos: 'row-theme-cosmos',
  row_lava: 'row-theme-lava',
};
const ROW_THEME_CLASSES = Object.values(ROW_THEME_CLASS);
export function applyRowTheme(el, stats) {
  const theme = stats && stats.equipped && stats.equipped.rowTheme;
  el.classList.remove(...ROW_THEME_CLASSES);
  const cls = ROW_THEME_CLASS[theme];
  if (cls) el.classList.add(cls);
}
// avatares da loja — desenhados em SVG (sem imagem externa), um ícone
// circular por personagem. "glyph" é só o miolo do desenho, sempre
// centralizado em (0,0); avatarSvg() monta o círculo + halo em volta.
const AVATAR_SHAPES = {
  avatar_robot: { color: '#2dd6ff', glyph: '<rect x="-26" y="-26" width="52" height="52" rx="10" fill="#2dd6ff"/><line x1="0" y1="-26" x2="0" y2="-38" stroke="#2dd6ff" stroke-width="3"/><circle cx="0" cy="-40" r="4" fill="#2dd6ff"/><rect x="-18" y="-8" width="36" height="16" rx="4" fill="#0a0e1e"/><circle cx="-9" cy="0" r="4" fill="#e8ecfa"/><circle cx="9" cy="0" r="4" fill="#e8ecfa"/>' },
  avatar_ninja: { color: '#b14dff', glyph: '<circle r="30" fill="#b14dff"/><rect x="-30" y="-6" width="60" height="12" fill="#0a0e1e"/><ellipse cx="-11" cy="0" rx="7" ry="5" fill="#e8ecfa"/><ellipse cx="11" cy="0" rx="7" ry="5" fill="#e8ecfa"/><circle cx="-11" cy="0" r="2.5" fill="#0a0e1e"/><circle cx="11" cy="0" r="2.5" fill="#0a0e1e"/>' },
  avatar_ghost: { color: '#e8ecfa', glyph: '<path d="M -26 6 C -26 -22 26 -22 26 6 L 26 20 L 17 12 L 8 20 L 0 12 L -8 20 L -17 12 L -26 20 Z" fill="#e8ecfa"/><ellipse cx="-10" cy="-4" rx="4.5" ry="6" fill="#0a0e1e"/><ellipse cx="10" cy="-4" rx="4.5" ry="6" fill="#0a0e1e"/>' },
  avatar_cat: { color: '#ff9f1c', glyph: '<polygon points="-26,-14 -14,-32 -4,-12" fill="#ff9f1c"/><polygon points="26,-14 14,-32 4,-12" fill="#ff9f1c"/><circle r="28" fill="#ff9f1c"/><ellipse cx="-9" cy="-2" rx="6" ry="7" fill="#e8ecfa"/><ellipse cx="9" cy="-2" rx="6" ry="7" fill="#e8ecfa"/><circle cx="-9" cy="0" r="2.5" fill="#0a0e1e"/><circle cx="9" cy="0" r="2.5" fill="#0a0e1e"/><polygon points="-4,10 4,10 0,15" fill="#ff6b9d"/>' },
  avatar_alien: { color: '#21e6a1', glyph: '<ellipse rx="26" ry="32" fill="#21e6a1"/><line x1="-10" y1="-30" x2="-16" y2="-42" stroke="#21e6a1" stroke-width="3"/><line x1="10" y1="-30" x2="16" y2="-42" stroke="#21e6a1" stroke-width="3"/><circle cx="-16" cy="-42" r="3.5" fill="#21e6a1"/><circle cx="16" cy="-42" r="3.5" fill="#21e6a1"/><ellipse cx="-10" cy="-2" rx="7" ry="9" fill="#0a0e1e"/><ellipse cx="10" cy="-2" rx="7" ry="9" fill="#0a0e1e"/>' },
  avatar_flame: { color: '#ff2d6b', glyph: '<path d="M 0 -34 C 14 -18 24 0 14 18 C 20 8 16 -2 8 -6 C 12 6 4 20 -6 24 C -22 18 -22 0 -12 -12 C -16 -4 -12 6 -6 8 C -10 -6 -8 -22 0 -34 Z" fill="#ff2d6b"/><path d="M -8 -8 L -2 -14 L 4 -8" fill="none" stroke="#0a0e1e" stroke-width="2.5" stroke-linecap="round"/><circle cx="-6" cy="0" r="2.5" fill="#0a0e1e"/><circle cx="6" cy="0" r="2.5" fill="#0a0e1e"/>' },
  avatar_crystal: { color: '#00d2d3', glyph: '<polygon points="-16,-28 16,-28 26,-4 0,30 -26,-4" fill="#00d2d3"/><line x1="-16" y1="-28" x2="0" y2="30" stroke="#0a0e1e" stroke-width="1.5" opacity="0.5"/><line x1="16" y1="-28" x2="0" y2="30" stroke="#0a0e1e" stroke-width="1.5" opacity="0.5"/><line x1="-26" y1="-4" x2="26" y2="-4" stroke="#0a0e1e" stroke-width="1.5" opacity="0.5"/><circle cx="14" cy="-18" r="2.5" fill="#e8ecfa"/>' },
  avatar_star: { color: '#ffe93c', glyph: '<polygon points="0,-30 7.5,-10.3 28.5,-9.3 12.1,3.9 17.7,24.3 0,12.7 -17.7,24.3 -12.1,3.9 -28.5,-9.3 -7.5,-10.3" fill="#ffe93c"/><circle cx="-6" cy="-2" r="2.5" fill="#0a0e1e"/><circle cx="6" cy="-2" r="2.5" fill="#0a0e1e"/><path d="M -6 6 Q 0 11 6 6" fill="none" stroke="#0a0e1e" stroke-width="2" stroke-linecap="round"/>' },
};
export function avatarSvg(id, size = 32) {
  const a = AVATAR_SHAPES[id];
  if (!a) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;"><circle cx="60" cy="60" r="56" fill="${a.color}" opacity="0.22"/><circle cx="60" cy="60" r="48" fill="#131a33" stroke="${a.color}" stroke-width="4"/><g transform="translate(60,60)">${a.glyph}</g></svg>`;
}
// devolve o avatar equipado (SVG, markup fixo/confiável) ou o emoji padrão de
// "pessoa" se nada foi comprado/equipado ainda — mesmo raciocínio de
// fallback gracioso dos outros cosméticos da loja (glow/tema já removidos,
// frame/confetti seguem esse mesmo padrão)
export function avatarOrDefaultIcon(avatarId, size = 20) {
  return avatarId && AVATAR_SHAPES[avatarId] ? avatarSvg(avatarId, size) : '👤';
}
// ícone dos Pigmentos (moeda do desafio diário) — uma gota com as cores do
// jogo se misturando, pra remeter ao tema sem precisar de nenhum arquivo de
// imagem externo. Markup fixo/confiável (sem dado de usuário), inserido só
// via insertAdjacentHTML/template literal mesmo mais abaixo.
// contador só pra dar um id único de gradiente a cada ícone renderizado —
// com o mesmo id "pigGrad" repetido em vários <svg> na mesma página (menu,
// loja, legenda de prêmio, botão de compra...), o navegador às vezes usa a
// cor errada (ou vira sólida) por causa do id duplicado. Cada ícone agora
// tem seu próprio gradiente, sempre com as mesmas cores.
let pigmentIconSeq = 0;
export function pigmentIconSvg(size = 18) {
  const gradId = `pigGrad${pigmentIconSeq++}`;
  return `<svg class="pigment-icon" width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a55eea"/>
        <stop offset="35%" stop-color="#1e90ff"/>
        <stop offset="65%" stop-color="#2ed573"/>
        <stop offset="100%" stop-color="#ffd32a"/>
      </linearGradient>
    </defs>
    <path d="M12 2C12 2 5 11 5 15.5C5 19.6 8.13 22 12 22C15.87 22 19 19.6 19 15.5C19 11 12 2 12 2Z" fill="url(#${gradId})" stroke="rgba(255,255,255,0.4)" stroke-width="1"/>
    <ellipse cx="9.5" cy="14" rx="1.6" ry="2.2" fill="rgba(255,255,255,0.35)"/>
  </svg>`;
}
// legenda de premiação do ranking diário — uma linha por faixa, com o ícone
// colorido de Pigmentos (igual ao resto do jogo) do lado do valor
export function renderDailyPrizesLegend() {
  const el = $('daily-prizes-legend');
  if (!el) return;
  const cfg = T[state.lang].daily_prizes_legend;
  const rows = cfg.rows.map(r => `
    <div style="display:flex; justify-content:space-between; align-items:center; max-width:220px; margin:2px auto;">
      <span>${r.label}</span>
      <span style="display:inline-flex; align-items:center; gap:3px; font-weight:700;">${r.amount} ${pigmentIconSvg(14)}</span>
    </div>`).join('');
  el.innerHTML = `<div style="margin-bottom:4px;">${cfg.title}</div>${rows}`;
}
export const MODE_ICON = { classic: '🎨', reverse: '🔄', shapes: '🔶', 'shapes-reverse': '🔸', trio: '🔺', caos: '🌀', mosaic: '🧩' };
export function modeLabel(m) {
  return m === 'classic' ? T[state.lang].mode_name_classic
    : m === 'reverse' ? T[state.lang].mode_name_reverse
    : m === 'shapes' ? T[state.lang].mode_name_shapes
    : m === 'shapes-reverse' ? T[state.lang].mode_name_shapes_reverse
    : m === 'caos' ? T[state.lang].mode_name_caos
    : m === 'mosaic' ? T[state.lang].mode_name_mosaic
    : T[state.lang].mode_name_trio;
}
