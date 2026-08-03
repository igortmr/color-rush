import { doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { state } from './state.js';
import { db } from './firebase.js';
import { $ } from './dom.js';

/* ================== conquistas (badges) ================== */
export const TIER_COLORS = ['#cd7f32', '#c0c0c0', '#ffd700', '#66ccff', '#a55eea', '#ff4757']; // bronze, prata, ouro, platina, diamante, rubi

export const BADGE_DEFS = {
  points: {
    icon: '⭐',
    label: { pt: 'Pontos Totais', en: 'Total Points', es: 'Puntos Totales' },
    tiers: [500, 2000, 5000, 15000, 50000, 150000],
    names: {
      pt: ['Brilhante', 'Radiante', 'Estelar', 'Supernova', 'Hipernova', 'Quasar'],
      en: ['Shining', 'Radiant', 'Stellar', 'Supernova', 'Hypernova', 'Quasar'],
      es: ['Brillante', 'Radiante', 'Estelar', 'Supernova', 'Hipernova', 'Quasar'],
    },
    metric: u => u.totalPoints || 0,
    desc: n => state.lang === 'en' ? `Accumulate ${n} points (sum of all games)`
      : state.lang === 'es' ? `Acumula ${n} puntos (suma de todas las partidas)`
      : `Acumule ${n} pontos (soma de todas as partidas)`,
  },
  games: {
    icon: '🎮',
    label: { pt: 'Partidas Jogadas', en: 'Games Played', es: 'Partidas Jugadas' },
    tiers: [10, 50, 100, 250, 500, 1000],
    names: {
      pt: ['Iniciante', 'Frequente', 'Dedicado', 'Veterano', 'Lenda', 'Imortal'],
      en: ['Beginner', 'Regular', 'Dedicated', 'Veteran', 'Legend', 'Immortal'],
      es: ['Principiante', 'Habitual', 'Dedicado', 'Veterano', 'Leyenda', 'Inmortal'],
    },
    metric: u => u.gamesPlayed || 0,
    desc: n => state.lang === 'en' ? `Play ${n} games`
      : state.lang === 'es' ? `Juega ${n} partidas`
      : `Jogue ${n} partidas`,
  },
  streak: {
    icon: '🔥',
    label: { pt: 'Sequência de Dias', en: 'Day Streak', es: 'Racha de Días' },
    tiers: [3, 7, 14, 30, 100, 365],
    names: {
      pt: ['Faísca', 'Chama', 'Fogueira', 'Fornalha', 'Inferno', 'Eterna'],
      en: ['Spark', 'Flame', 'Bonfire', 'Furnace', 'Inferno', 'Eternal'],
      es: ['Chispa', 'Llama', 'Fogata', 'Horno', 'Infierno', 'Eterna'],
    },
    metric: u => u.bestStreak || 0,
    desc: n => state.lang === 'en' ? `Play ${n} days in a row`
      : state.lang === 'es' ? `Juega ${n} días seguidos`
      : `Jogue ${n} dias seguidos`,
  },
  sharer: {
    icon: '📣',
    label: { pt: 'Divulgador', en: 'Promoter', es: 'Promotor' },
    tiers: [1, 5, 15, 30, 50, 100],
    names: {
      pt: ['Recruta', 'Influencer', 'Viral', 'Embaixador', 'Celebridade', 'Fenômeno'],
      en: ['Word of Mouth', 'Influencer', 'Viral', 'Ambassador', 'Celebrity', 'Phenomenon'],
      es: ['Recluta', 'Influencer', 'Viral', 'Embajador', 'Celebridad', 'Fenómeno'],
    },
    metric: u => u.referrals || 0,
    desc: n => state.lang === 'en'
      ? `Have ${n} friend${n > 1 ? 's' : ''} sign up through your invite link`
      : state.lang === 'es'
      ? `Consigue que ${n} amigo${n > 1 ? 's' : ''} se registre${n > 1 ? 'n' : ''} con tu enlace de invitación`
      : `Tenha ${n} amigo${n > 1 ? 's' : ''} cadastrado${n > 1 ? 's' : ''} pelo seu link de compartilhamento`,
  },
  pvp: {
    icon: '⚔️',
    label: { pt: 'Vitórias em Duelo', en: 'Duel Wins', es: 'Victorias en Duelo' },
    tiers: [1, 10, 25, 50, 100, 250],
    // nomes curtos (1 palavra, até 10 caracteres) pra não quebrar a pill no
    // ranking — mesma restrição que as outras categorias já respeitam
    names: {
      pt: ['Tingido', 'Vívido', 'Radioso', 'Cromático', 'Luminoso', 'Espectral'],
      en: ['Tinted', 'Vivid', 'Beaming', 'Chromatic', 'Luminous', 'Spectral'],
      es: ['Teñido', 'Vívido', 'Radioso', 'Cromático', 'Luminoso', 'Espectral'],
    },
    metric: u => u.pvpWins || 0,
    desc: n => state.lang === 'en' ? `Win ${n} duel${n > 1 ? 's' : ''} (challenge a friend)`
      : state.lang === 'es' ? `Gana ${n} duelo${n > 1 ? 's' : ''} (desafía a un amigo)`
      : `Vença ${n} duelo${n > 1 ? 's' : ''} (desafiar amigo)`,
  },
  replays: {
    icon: '🎬',
    label: { pt: 'Replays Assistidos', en: 'Watched Replays', es: 'Replays Vistos' },
    tiers: [1, 25, 75, 150, 250, 500],
    // nomes curtos (1 palavra, até 10 caracteres) pra não quebrar a pill no ranking
    names: {
      pt: ['Visto', 'Notado', 'Admirado', 'Aclamado', 'Reluzente', 'Ícone'],
      en: ['Seen', 'Noticed', 'Admired', 'Acclaimed', 'Glowing', 'Iconic'],
      es: ['Visto', 'Notado', 'Admirado', 'Aclamado', 'Reluciente', 'Icónico'],
    },
    metric: u => u.replaysWatchedCount || 0,
    desc: n => state.lang === 'en' ? `Have your replays watched ${n} time${n > 1 ? 's' : ''} by other players`
      : state.lang === 'es' ? `Haz que tus replays sean vistos ${n} ve${n > 1 ? 'ces' : 'z'} por otros jugadores`
      : `Tenha seus replays assistidos ${n} ve${n > 1 ? 'zes' : 'z'} por outras pessoas`,
  },
};
export const BADGE_ORDER = ['points', 'games', 'streak', 'sharer', 'pvp', 'replays'];

export function unlockedTier(def, stats) {
  const val = def.metric(stats);
  let tier = -1;
  for (let i = 0; i < def.tiers.length; i++) {
    const ok = def.inverse ? val <= def.tiers[i] : val >= def.tiers[i];
    if (ok) tier = i;
  }
  return tier;
}
// pill com ícone + nome da ÚNICA medalha escolhida pra aparecer ao lado do
// nick no ranking (ver setEquippedBadgeTier, no perfil próprio). Sem escolha
// feita ainda, não mostra nada — só passa a exibir depois que a própria
// pessoa vai no perfil e equipa uma. Sempre reconfere unlockedTier() contra
// as stats REAIS, então forjar equippedBadge/equippedBadgeTier não mostra
// nada que a pessoa não tenha de verdade — equippedBadgeTier escolhe QUAL
// nível já desbloqueado aparece (não precisa ser o mais alto: alguém que já
// tem "Imortal" pode preferir mostrar "Lenda"), null cai no comportamento
// antigo (sempre o mais alto).
// pill exata que aparece no ranking pra um nível de uma categoria — extraída
// à parte pra poder reusar a MESMA marcação como prévia no perfil (ver
// renderBadgeCard), assim a pessoa vê exatamente como vai aparecer antes de
// equipar.
export function badgePillHtml(def, tier) {
  const color = TIER_COLORS[tier] || TIER_COLORS[TIER_COLORS.length - 1];
  const name = def.names[state.lang][tier];
  return `<span class="class-pill" style="color:${color}; border-color:${color}88; text-shadow:0 0 6px ${color}80" title="${def.label[state.lang]}: ${name}">${def.icon} ${name}</span>`;
}
export function equippedBadgeLabel(stats) {
  const key = stats.equippedBadge;
  if (!key || !BADGE_DEFS[key]) return ''; // ninguém escolheu ainda — não mostra nada até a pessoa ir no perfil e equipar uma
  const def = BADGE_DEFS[key];
  const maxTier = unlockedTier(def, stats);
  if (maxTier < 0) return ''; // reconfere contra as stats reais — se não desbloqueou de verdade, não mostra
  const chosen = stats.equippedBadgeTier;
  const t = (typeof chosen === 'number' && chosen >= 0 && chosen <= maxTier) ? chosen : maxTier;
  return badgePillHtml(def, t);
}
// nome da classe de divulgador (ex.: "Viral") com a cor da medalha — usado só no ranking de divulgador
export function sharerTierLabel(stats) {
  const def = BADGE_DEFS.sharer;
  const t = unlockedTier(def, stats);
  if (t < 0) return '';
  const color = TIER_COLORS[t] || TIER_COLORS[TIER_COLORS.length - 1];
  const name = def.names[state.lang][t];
  return `<span class="class-pill" style="color:${color}; border-color:${color}88; text-shadow:0 0 6px ${color}80" title="${def.label[state.lang]}: ${name}">${name}</span>`;
}

// aviso de "medalha nova, ainda não vista" — como as medalhas não aparecem
// mais sozinhas no ranking (a pessoa precisa ir no perfil e equipar se
// quiser), essa bolinha avisa que tem uma categoria com nível desbloqueado
// que ainda não foi conferido. Guardado em scores/{uid}.badgesSeenTiers (ver
// firestore.rules), não no navegador — assim funciona certo mesmo trocando
// de dispositivo/navegador pra entrar na mesma conta. Sem valor de jogo: é
// puramente uma marcação de "já olhei", então o cliente pode escrever direto
// sem precisar de Cloud Function (mesmo raciocínio do equippedBadge). Como o
// registro começa vazio pra todo mundo, quem já tinha medalha desbloqueada
// antes dessa funcionalidade existir também recebe o aviso na primeira vez.
export function hasNewBadgeFor(key) {
  return newBadgeCountFor(key) > 0;
}
// quantos NÍVEIS novos essa categoria desbloqueou desde a última vez que a
// pessoa viu o perfil (normalmente 1, mas pode ser mais se ela pulou vários
// níveis de uma vez sem abrir o perfil) — usado pra mostrar o número dentro
// da bolinha de notificação, em vez de só um sinal de "tem novidade"
export function newBadgeCountFor(key) {
  if (state.offline || !state.currentUser || !state.myData.nick) return 0;
  const tier = unlockedTier(BADGE_DEFS[key], state.myData);
  if (tier < 0) return 0;
  const seen = state.myData.badgesSeenTiers || {};
  const seenTier = seen[key] != null ? seen[key] : -1;
  return Math.max(0, tier - seenTier);
}
export function hasAnyNewBadge() {
  return BADGE_ORDER.some(hasNewBadgeFor);
}
// soma de novidades em todas as categorias — número mostrado na bolinha do
// nick, na tela principal
export function totalNewBadgeCount() {
  return BADGE_ORDER.reduce((n, key) => n + newBadgeCountFor(key), 0);
}
// chamada depois que a pessoa vê o próprio perfil (onde todas as categorias
// aparecem) — marca o nível atual de cada uma como "visto", até a próxima
// vez que desbloquear algo novo
export async function markAllBadgesSeen() {
  if (state.offline || !state.currentUser || !state.myData.nick) return;
  const seen = {};
  BADGE_ORDER.forEach(key => { seen[key] = unlockedTier(BADGE_DEFS[key], state.myData); });
  state.myData.badgesSeenTiers = seen; // atualiza local na hora, antes mesmo do Firestore confirmar
  refreshBadgeNotifDot();
  try {
    await setDoc(doc(db, 'scores', state.currentUser.uid), { badgesSeenTiers: seen, updatedAt: serverTimestamp() }, { merge: true });
  } catch (e) {
    // não foi possível salvar agora — a marcação fica só localmente até a próxima tentativa
  }
}
export function refreshBadgeNotifDot() {
  const dot = $('user-label-badge');
  if (!dot) return;
  const n = totalNewBadgeCount();
  dot.textContent = n;
  dot.style.display = n > 0 ? '' : 'none';
}
