// link de compartilhamento pode vir com ?lang=en — se vier, abre já traduzido
// e lembra a escolha (senão cai no idioma salvo, ou português por padrão)
function detectInitialLang() {
  try {
    const urlLang = new URLSearchParams(location.search).get('lang');
    if (urlLang === 'en' || urlLang === 'pt' || urlLang === 'es') {
      localStorage.setItem('colorRushLang', urlLang);
      return urlLang;
    }
    const saved = localStorage.getItem('colorRushLang');
    return (saved === 'en' || saved === 'es') ? saved : 'pt';
  } catch { return 'pt'; }
}

// Objeto único de estado mutável compartilhado entre os módulos do jogo.
// Em vez de `let` exportado (que outros módulos só enxergam como leitura),
// cada módulo importa `{ state }` e lê/escreve `state.campo` diretamente —
// igual à mutação de variável global que o código já fazia antes da divisão
// em módulos, só que agora com um único lugar de origem.
export const state = {
  // contador de chamadas ao servidor em andamento (ver callable() em
  // game-teste.js) + instante até quando o travamento genérico de clique
  // duplo continua valendo (ver js/nav.js) — os dois viajam juntos porque o
  // travamento de clique lê os dois pra decidir se libera o clique atual.
  pendingServerCalls: 0,
  clickLockedUntil: 0,
  // idioma atual (pt/en/es) — lido por praticamente toda função de
  // renderização (T[state.lang]), por isso vive aqui e não num módulo de
  // domínio específico.
  lang: detectInitialLang(),
  // usuário logado no Firebase (ou null offline/deslogado) e se está no
  // modo "jogar sem conta" — lidos por quase todo módulo de feature
  // (perfil, amigos, ranking, loja, pvp...), por isso vivem aqui também
  currentUser: null,
  offline: false,
  // true entre clicar "Jogar" na tela da Batalha de Clã (ver js/guild-battle.js)
  // e voltar pro menu — faz a tela de fim de partida mostrar um aviso da
  // Batalha em vez do mini-ranking normal do modo (ver gameOver em
  // js/game-core.js). Reseta em showMenu() (js/menu.js), não logo após o
  // resultado, de propósito: "jogar de novo" direto do fim de partida
  // continua contando como partida da Batalha até a pessoa voltar ao menu.
  playingForGuildBattle: false,
  // pontuação feita sem conta, aguardando cadastro pra ser reivindicada
  // (ver claimPendingScore em functions/index.js)
  pendingScore: null,
  // sessão validada pelo servidor pra partida em andamento
  currentSessionId: null,
  // true se algum 'touchstart' disparou durante a partida atual (mesmo em
  // dispositivo com mouse E touch, ex: notebook 2-em-1) — reseta no início
  // de cada partida (ver window.startGame em game-core.js e o reset
  // equivalente em daily-challenge.js). Vai junto no payload de
  // saveMatchReplay (campo "inputTouch") pra registrar no replay se o
  // mouseTrail dessa partida é confiável pra checagens geométricas
  // (teleporte de cursor etc.) — touch dispara só 1 mousemove sintético por
  // toque (sem trajeto real), então um mouseTrail esparso é ESPERADO nesse
  // caso, não suspeito; sem essa flag não dá pra distinguir os dois motivos
  // depois dos fatos.
  sawTouchThisMatch: false,
  // perfil completo da conta logada (scores/{uid} no Firestore) — o mesmo
  // objeto que alimenta ranking, badges, loja, perfil etc.
  myData: {
    nick: null, classic: 0, reverse: 0, shapes: 0, 'shapes-reverse': 0,
    gamesPlayed: 0, totalPoints: 0, bestStreak: 0, currentStreak: 0, lastPlayedDate: null,
    playedClassic: false, playedReverse: false, playedShapes: false, playedShapesReverse: false, playedTrio: false, playedCaos: false, referrals: 0, bestRank: null, refCode: null, total: 0, xp: 0, dailyWins: 0, pigmentos: 0, ownedItems: [], equipped: {}, equippedBadge: null, equippedBadgeTier: null, badgesSeenTiers: {},
  },
};
