import { Timestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { functions, callable } from './firebase.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { show } from './nav.js';
import { T, cName } from './i18n.js';
import { track, shuffle, pick, getLocalRecord, setLocalRecord } from './utils.js';
import {
  COLORS, CONFETTI_COLORS, SQUARES, CAOS_POOL, isColorItem, poolItemId,
  PLAYED_FIELD, poolFor
} from './constants.js';
import {
  levelFromXp, myXp, xpInfo, xpStreakMultiplier, modeUnlocked, blockIfBanned
} from './levels.js';
import { renderTrioSquare, renderCaosSquare, saveMatchReplayWithRetry } from './replay.js';
import { renderMiniRankings } from './ranking-cache.js';
import { equippedConfetti } from './shop.js';
import { dailyPlaying, dailyReplayMouse, dailyReplayStartMs } from './daily-challenge.js';

// chamadas ao servidor: a pontuação final agora é validada lá,
// não é mais um simples write direto no Firestore vindo do navegador.
const callStartSession = callable('startGameSession');
const callSubmitResult = callable('submitGameResult');
// chamada "dispare e esqueça" a cada acerto: roda em segundo plano, não
// passa pelo wrapper callable() de propósito (senão uma sequência rápida de
// acertos deixaria pendingServerCalls sempre positivo, travando outros
// cliques da interface à toa). O jogo continua 100% local e instantâneo.
const callSyncProgress = httpsCallable(functions, 'syncRoundProgress');

function todayStr() { return new Date().toLocaleDateString('sv-SE'); } // YYYY-MM-DD local

// exportadas como bindings ao vivo (mesmo padrão de tutMode/tutStep em
// tutorial.js e equippedSfx/etc em shop.js) — lidas por domínios que ainda
// não são módulos próprios: mode/score no compartilhamento (share.js
// futuro) e no window.showRanking (ranking, ainda em game-teste.js);
// playing no checkForUpdate (auto-atualização, ainda em game-teste.js)
export let mode, score, target, nextTarget, duration, timerStart, rafId, playing;
// estado do modo Trio (ver newTrioRound/handleTrioClick): trioColorA/trioColorB
// são as 2 cores ATIVAS (o par que a pessoa precisa achar nesta rodada — ou
// já decorado na rodada anterior, ou sorteado do zero na primeira rodada).
// trioNextPairA/trioNextPairB são os 2 novos valores (tirados dos atributos
// que NÃO deram o match no quadrado certo desta rodada) que virão a ser o
// próximo par assim que o clique certo acontecer (ver handleTrioClick)
let trioColorA, trioColorB, trioNextPairA, trioNextPairB;
// estado do modo Caos (ver newCaosRound/handleCaosClick): mesma ideia do Trio
// acima, só que os itens podem ser cor OU forma (CAOS_POOL) em vez de só cor
let caosItemA, caosItemB, caosNextPairA, caosNextPairB;
let xpGain = 0; // XP acumulada na partida atual
// promessas dos sinais de progresso (ver callSyncProgress) desta
// partida — gameOver() espera todas "assentarem" no servidor antes de
// mandar o resultado final, senão o envio pode chegar antes de alguns
// sinais ainda em trânsito (ver conversa sobre a corrida entre os dois)
let pendingRoundSync = [];

// "filme" da partida atual (modo livre), pra tela de "assistir replay" —
// só é enviado ao servidor se a partida bater recorde pessoal (ver
// persistGameResult mais abaixo); senão fica só em memória e some quando a
// pessoa sai da tela. replayRounds guarda o que apareceu em cada rodada
// (ver newRound); replayMouse guarda o rastro do mouse (ver o listener de
// mousemove mais abaixo), em % do tamanho do tabuleiro — assim funciona em
// qualquer tamanho de tela na hora de reproduzir.
let replayRounds = [];
let replayMouse = [];
let replayStartMs = 0; // referência (performance.now()) pro tempo relativo de cada amostra do rastro

/* ================== recordes locais (modo sem conta) ================== */
export function myRecord(m) {
  return state.offline ? getLocalRecord(m) : (state.myData[m] || 0);
}

// confete cosmético da loja ao bater um novo recorde — camada leve (sem
// biblioteca), some sozinha depois da animação. "confettiId" explícito permite
// reusar a mesma função tanto pro confete realmente equipado quanto pra prévia
// da loja (que precisa funcionar mesmo sem nada equipado ainda).
function spawnConfettiVariant(confettiId) {
  if (!confettiId) return;
  const colors = CONFETTI_COLORS[confettiId] || ['#ffd700'];
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  for (let i = 0; i < 28; i++) {
    const bit = document.createElement('span');
    bit.className = 'confetti-bit';
    bit.style.left = Math.random() * 100 + '%';
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = (Math.random() * 0.5) + 's';
    bit.style.animationDuration = (1.6 + Math.random() * 0.9) + 's';
    bit.style.setProperty('--drift', Math.round(Math.random() * 70 - 35) + 'px');
    layer.appendChild(bit);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 2800);
}
// exposta em window pra js/shop.js poder disparar a mesma animação na prévia
// do item "confete", sem esperar os efeitos visuais ganharem seu próprio
// módulo (fase futura)
window.spawnConfettiVariant = spawnConfettiVariant;
export function spawnConfetti() { spawnConfettiVariant(equippedConfetti); }

window.playAgain = () => window.startGame(mode);

window.startGame = (m) => {
  if (blockIfBanned()) return; // conta suspensa não joga nenhum modo
  if (!modeUnlocked(m)) return; // modo ainda bloqueado pelo nível
  track('game_start', { mode: m });
  mode = m;
  score = 0;
  xpGain = 0;
  duration = 10000;
  playing = true;
  target = pick(poolFor(mode));
  $('score').textContent = 0;
  $('record-hud').textContent = myRecord(mode);
  replayRounds = [];
  replayMouse = [];
  replayStartMs = performance.now();
  show('game-screen');
  newRound(true);

  // abre uma sessão no servidor (timestamp confiável) pra poder validar a
  // pontuação no fim da partida — só quem tem conta precisa disso
  state.currentSessionId = null;
  if (!state.offline && state.currentUser && state.myData.nick) {
    callStartSession({ mode: m }).then(res => {
      state.currentSessionId = res.data.sessionId;
    }).catch(() => { state.currentSessionId = null; });
  }
};

// rastro do mouse pra tela de replay — throttlado (não grava cada micro-
// movimento) e guardado em % do tamanho do tabuleiro (não pixel bruto), pra
// funcionar igual em qualquer tamanho de tela na hora de reproduzir. É só
// cosmético, nunca entra na validação de pontuação. No celular não existe
// "mousemove" contínuo (só toque discreto), então esse rastro simplesmente
// fica vazio lá — o replay
// mostra os cliques certos, sem cursor se movendo entre eles.
const REPLAY_MOUSE_SAMPLE_MS = 30; // ~33 amostras/seg
const REPLAY_MOUSE_CAP = 8000; // mesmo teto do servidor (MAX_REPLAY_MOUSE_SAMPLES) — a ~33/seg dá pra guardar uns 4min de rastro, e o documento final fica bem abaixo do limite de 1MB do Firestore mesmo assim
let lastReplayMouseSampleAt = 0;
function recordReplayMouseSample(clientX, clientY) {
  const now = performance.now();
  if (now - lastReplayMouseSampleAt < REPLAY_MOUSE_SAMPLE_MS) return;
  lastReplayMouseSampleAt = now;
  let gridEl = null, arr = null, startMs = 0;
  if (playing) { gridEl = $('grid'); arr = replayMouse; startMs = replayStartMs; }
  else if (dailyPlaying) { gridEl = $('daily-grid'); arr = dailyReplayMouse; startMs = dailyReplayStartMs; }
  else return;
  if (!gridEl || arr.length >= REPLAY_MOUSE_CAP) return;
  const rect = gridEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const xPct = (clientX - rect.left) / rect.width;
  const yPct = (clientY - rect.top) / rect.height;
  arr.push([Math.round(xPct * 1000) / 1000, Math.round(yPct * 1000) / 1000, Math.round(now - startMs)]);
}
window.addEventListener('mousemove', e => recordReplayMouseSample(e.clientX, e.clientY));

// Modo Trio: cada quadrado tem 3 cores independentes (fundo/bg, cor da
// palavra/tc, e a palavra em si/word — que também é o nome de uma cor). A
// pessoa decora um PAR de cores (trioColorA/trioColorB); o quadrado certo é
// o ÚNICO em que uma dessas 2 cores aparece em QUALQUER uma das 3 partes; os
// outros 3 quadrados não podem referenciar nenhuma das 2 de jeito nenhum. Ao
// acertar, o novo par a decorar são os 2 OUTROS atributos (os que não deram
// o match) do quadrado que acabou de ser clicado — ver handleTrioClick.
//
// Viabilidade: como só é preciso excluir 2 cores por vez das 8 existentes
// (COLORS), sempre sobram 6 cores livres — de sobra pros 2 preenchimentos do
// quadrado certo (2 de 6) e pras 3 cores distintas de cada quadrado errado (3
// de 6), incluindo a reserva de até 4 fundos distintos entre si (ver
// bgAssignment) — então NENHUMA cor nova precisou ser adicionada à paleta.
function newTrioRound(first) {
  const pool = COLORS;
  let colorA, colorB;
  if (first || !trioColorA || !trioColorB) {
    // shuffle() ordena IN PLACE (ver "const shuffle = a => a.sort(...)") — nunca
    // pode receber a constante COLORS direto, ou embaralharia pra sempre a ordem
    // fixa que o tutorial de outros modos depende (COLORS[0], COLORS[1]...); por
    // isso passamos uma CÓPIA (.slice()) aqui, igual o resto do arquivo já faz
    // indiretamente sempre que chama shuffle(pool.filter(...)) (filter também
    // sempre devolve array novo)
    const shuffled = shuffle(pool.slice());
    colorA = shuffled[0];
    colorB = shuffled[1];
  } else {
    colorA = trioColorA;
    colorB = trioColorB;
  }
  trioColorA = colorA;
  trioColorB = colorB;

  const targetIdx = Math.floor(Math.random() * SQUARES);
  const matchColor = Math.random() < 0.5 ? colorA : colorB;
  const SLOTS = ['bg', 'tc', 'word'];
  const matchSlot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
  const fillerPool = pool.filter(c => c !== colorA && c !== colorB); // sempre 6 cores

  // fundo NUNCA se repete entre os 4 quadrados da rodada — reserva antes de
  // tudo uma cor de fundo distinta por quadrado (se o quadrado certo "gastar"
  // o match no próprio fundo, ele já sai direto com matchColor; os outros 3,
  // ou os 4, tiram fundos distintos do fillerPool). Isso não muda nenhuma
  // regra: continua sendo o único jeito de saber qual é o certo (procurar as
  // 2 cores decoradas nas 3 partes), só deixa o tabuleiro mais legível.
  const bgShuffled = shuffle(fillerPool.slice());
  const bgAssignment = [];
  let bgCursor = 0;
  for (let i = 0; i < SQUARES; i++) {
    bgAssignment[i] = (i === targetIdx && matchSlot === 'bg') ? matchColor : bgShuffled[bgCursor++];
  }

  const grid = $('grid');
  grid.innerHTML = '';
  const roundSnapshot = [];
  let newPairA = null, newPairB = null;

  for (let i = 0; i < SQUARES; i++) {
    const bg = bgAssignment[i];
    let sq;
    if (i === targetIdx) {
      if (matchSlot === 'bg') {
        // fundo já é matchColor — tc/word são 2 cores distintas entre si (o
        // fundo nunca entra nessa comparação, já não pode repetir por
        // construção: matchColor nunca está no fillerPool)
        const fillers = shuffle(fillerPool.slice()).slice(0, 2);
        sq = { bg, tc: fillers[0], word: fillers[1], isTarget: true };
        newPairA = fillers[0];
        newPairB = fillers[1];
      } else {
        // matchSlot é tc OU word — esse vira matchColor; o slot restante
        // (o outro entre tc/word) fica com mais uma cor do fillerPool,
        // diferente do fundo já reservado pra esse quadrado
        const otherSlot = SLOTS.find(s => s !== 'bg' && s !== matchSlot);
        const otherFiller = shuffle(fillerPool.filter(c => c !== bg))[0];
        const attrs = { bg };
        attrs[matchSlot] = matchColor;
        attrs[otherSlot] = otherFiller;
        sq = { bg: attrs.bg, tc: attrs.tc, word: attrs.word, isTarget: true };
        newPairA = bg;
        newPairB = otherFiller;
      }
    } else {
      const fillers = shuffle(fillerPool.filter(c => c !== bg)).slice(0, 2);
      sq = { bg, tc: fillers[0], word: fillers[1], isTarget: false };
    }
    const el = document.createElement('div');
    el.className = 'square';
    renderTrioSquare(el, sq);
    el.onclick = (e) => handleTrioClick(sq.isTarget, e);
    grid.appendChild(el);
    roundSnapshot.push({
      bg: sq.bg.key, tc: sq.tc.key, word: sq.word.key, isTarget: sq.isTarget,
      // o par inicial só existe (e só faz sentido gravar) na primeira rodada —
      // é o que a tela de replay usa pra montar a instrução "decore X e Y"
      // sem precisar adivinhar a cor que nunca apareceu desenhada em lugar
      // nenhum (ver renderReplaySquares)
      ...(first ? { pairA: colorA.key, pairB: colorB.key } : {}),
    });
  }
  if (replayRounds.length < 400) replayRounds.push({ t: Math.round(performance.now() - replayStartMs), sq: roundSnapshot });

  trioNextPairA = newPairA;
  trioNextPairB = newPairB;

  $('instruction').textContent = first
    ? T[state.lang].instr_first_trio(cName(colorA), cName(colorB))
    : T[state.lang].instr_next_trio;
  $('speed').textContent = `⏱️ ${(duration / 1000).toFixed(1)}s`;

  startTimer();
}

function handleTrioClick(isCorrect, e) {
  if (!playing) return;
  if (isCorrect) {
    score++;
    if (state.currentSessionId) pendingRoundSync.push(callSyncProgress({ sessionId: state.currentSessionId, trusted: !e || e.isTrusted }).catch(() => {}));
    const elapsed = (performance.now() - timerStart) / 1000;
    xpGain += Math.max(0, 3 - 0.2 * elapsed) * xpStreakMultiplier(score);
    window.sfx.correct(score);
    $('score').textContent = score;
    trioColorA = trioNextPairA;
    trioColorB = trioNextPairB;
    duration *= 0.95;
    newTrioRound(false);
  } else {
    window.sfx.wrong();
    gameOver(T[state.lang].reason_wrong);
  }
}

// Modo Caos: cada quadrado tem 3 atributos independentes — a FORMA (shape),
// a COR de preenchimento dela (color) e a PALAVRA escrita nela (word, que
// pode nomear tanto uma cor quanto uma forma — vem de CAOS_POOL). A pessoa
// decora um PAR de itens (caosItemA/caosItemB — podendo ser 2 cores, 2
// formas ou 1 de cada); o quadrado certo é o ÚNICO em que um desses 2 itens
// aparece em QUALQUER um dos 3 atributos. Ao acertar, o novo par a decorar
// são os 2 OUTROS atributos (os que não deram o match) do quadrado que
// acabou de ser clicado — mesma mecânica do Trio (ver newTrioRound), só que
// com um pool misto de cor+forma em vez de só cor.
//
// Diferença-chave pro Trio: lá os 3 atributos aceitam QUALQUER uma das 8
// cores. Aqui só a palavra (word) aceita qualquer item do pool misto — forma
// só aceita forma, cor só aceita cor (domínio fixo) — por isso matchSlot só
// pode ser sorteado entre os slots cujo domínio aceita o item sorteado (ver
// matchableSlots abaixo), e o preenchimento de cada quadrado trata os 3
// casos (match na forma / na cor / na palavra) separadamente.
//
// Viabilidade: forma e cor nunca se repetem entre os 4 quadrados (ver
// shapeAssignment/colorAssignment abaixo). Pior caso é quando os 2 itens
// memorizados são as 2 formas sorteadas E o match cai na palavra (não
// "gasta" nenhuma forma do fillerPool) — sobram exatamente 4 formas livres
// (6 - 2) pros 4 quadrados, just certo. Cor nunca fica tão apertada (mínimo
// 6 livres de 8, sempre dá pras até 4 necessárias).
function newCaosRound(first) {
  let itemA, itemB;
  if (first || !caosItemA || !caosItemB) {
    const shuffled = shuffle(CAOS_POOL.slice());
    itemA = shuffled[0];
    itemB = shuffled[1];
  } else {
    itemA = caosItemA;
    itemB = caosItemB;
  }
  caosItemA = itemA;
  caosItemB = itemB;

  const targetIdx = Math.floor(Math.random() * SQUARES);
  const matchItem = Math.random() < 0.5 ? itemA : itemB;
  const matchableSlots = isColorItem(matchItem) ? ['color', 'word'] : ['shape', 'word'];
  const matchSlot = matchableSlots[Math.floor(Math.random() * matchableSlots.length)];

  const fillerPool = CAOS_POOL.filter(x => x !== itemA && x !== itemB); // sempre 12 itens
  const shapeFillerPool = fillerPool.filter(x => !isColorItem(x));
  const colorFillerPool = fillerPool.filter(x => isColorItem(x));

  // forma E cor NUNCA se repetem entre os 4 quadrados da rodada — reserva
  // antes de tudo uma forma distinta e uma cor distinta por quadrado (mesma
  // ideia do "fundo nunca se repete" do Trio — ver newTrioRound — só que
  // aplicada aos 2 atributos visuais aqui, já que são os mais visíveis). Se
  // o quadrado certo "gastar" o match na própria forma/cor, ele já sai
  // direto com matchItem nesse atributo; os outros, com valores distintos
  // dos respectivos fillerPools (sempre cabe: colorFillerPool nunca tem
  // menos que 6 cores livres, contra no máximo 4 necessárias).
  const shapeShuffled = shuffle(shapeFillerPool.slice());
  const colorShuffled = shuffle(colorFillerPool.slice());
  const shapeAssignment = [];
  const colorAssignment = [];
  let shapeCursor = 0, colorCursor = 0;
  for (let i = 0; i < SQUARES; i++) {
    shapeAssignment[i] = (i === targetIdx && matchSlot === 'shape') ? matchItem : shapeShuffled[shapeCursor++];
    colorAssignment[i] = (i === targetIdx && matchSlot === 'color') ? matchItem : colorShuffled[colorCursor++];
  }

  const grid = $('grid');
  grid.innerHTML = '';
  const roundSnapshot = [];
  let newPairA = null, newPairB = null;

  for (let i = 0; i < SQUARES; i++) {
    const shape = shapeAssignment[i];
    const color = colorAssignment[i];
    const isTarget = (i === targetIdx);
    let word;
    if (isTarget && matchSlot === 'word') {
      word = matchItem;
      newPairA = shape; newPairB = color;
    } else {
      word = shuffle(fillerPool.filter(x => x !== shape && x !== color))[0];
      if (isTarget) {
        // matchSlot é 'shape' ou 'color' — já ficou reservado direto no
        // Assignment acima; o outro atributo (não-match) + a palavra são o
        // novo par a memorizar
        newPairA = (matchSlot === 'shape') ? color : shape;
        newPairB = word;
      }
    }
    const sq = { shape, color, word, isTarget };
    const el = document.createElement('div');
    renderCaosSquare(el, sq);
    el.onclick = (e) => handleCaosClick(sq.isTarget, e);
    grid.appendChild(el);
    roundSnapshot.push({
      shape: poolItemId(sq.shape), color: sq.color.key, word: poolItemId(sq.word), isTarget: sq.isTarget,
      // par inicial (ver pairA/pairB do Trio) — só existe na primeira rodada,
      // é o que a tela de replay usa pra montar a instrução "decore X e Y"
      ...(first ? { pairA: poolItemId(itemA), pairB: poolItemId(itemB) } : {}),
    });
  }
  if (replayRounds.length < 400) replayRounds.push({ t: Math.round(performance.now() - replayStartMs), sq: roundSnapshot });

  caosNextPairA = newPairA;
  caosNextPairB = newPairB;

  $('instruction').textContent = first
    ? T[state.lang].instr_first_caos(cName(itemA), cName(itemB))
    : T[state.lang].instr_next_caos;
  $('speed').textContent = `⏱️ ${(duration / 1000).toFixed(1)}s`;

  startTimer();
}

function handleCaosClick(isCorrect, e) {
  if (!playing) return;
  if (isCorrect) {
    score++;
    if (state.currentSessionId) pendingRoundSync.push(callSyncProgress({ sessionId: state.currentSessionId, trusted: !e || e.isTrusted }).catch(() => {}));
    const elapsed = (performance.now() - timerStart) / 1000;
    xpGain += Math.max(0, 3 - 0.2 * elapsed) * xpStreakMultiplier(score);
    window.sfx.correct(score);
    $('score').textContent = score;
    caosItemA = caosNextPairA;
    caosItemB = caosNextPairB;
    duration *= 0.95;
    newCaosRound(false);
  } else {
    window.sfx.wrong();
    gameOver(T[state.lang].reason_wrong);
  }
}

function newRound(first) {
  if (mode === 'trio') return newTrioRound(first);
  if (mode === 'caos') return newCaosRound(first);
  const pool = poolFor(mode);
  nextTarget = pick(pool);
  const others = shuffle(pool.filter(c => c !== target)).slice(0, SQUARES - 1);
  const items = shuffle([target, ...others]); // clássico: fundos | reverso: palavras | formas: ícones
  const distractors = shuffle(pool.filter(c => c !== nextTarget)).slice(0, SQUARES - 1);
  let d = 0;

  const grid = $('grid');
  grid.innerHTML = '';
  // "foto" desta rodada pra tela de replay — cada quadrado na MESMA ordem em
  // que é exibido (ver poolItemId/replayRounds lá em cima); só isso já basta
  // pra reconstruir o tabuleiro inteiro depois, sem precisar re-sortear nada
  const roundSnapshot = [];
  items.forEach(item => {
    const paired = (item === target) ? nextTarget : distractors[d++];
    roundSnapshot.push({ id: poolItemId(item), paired: poolItemId(paired), isTarget: item === target });
    const el = document.createElement('div');
    el.className = 'square';
    if (mode === 'shapes' || mode === 'shapes-reverse') {
      // formas: shapeSide = qual delas vira a silhueta do azulejo | wordSide = qual delas tem o nome escrito
      const shapeSide = (mode === 'shapes') ? item : paired;
      const wordSide  = (mode === 'shapes') ? paired : item;
      el.classList.add('shape-square', shapeSide.shapeClass);
      el.innerHTML = `<span class="shape-fill ${shapeSide.shapeClass}"></span><span class="word">${cName(wordSide)}</span>`;
    } else {
      const bg   = (mode === 'classic') ? item : paired;
      const word = (mode === 'classic') ? paired : item;
      el.style.background = bg.hex;
      el.style.boxShadow = `0 0 18px ${bg.hex}99, 0 0 40px ${bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
      el.innerHTML = `<span class="word">${cName(word)}</span>`;
    }
    el.onclick = (e) => handleClick(item, e);
    grid.appendChild(el);
  });
  // "t" é o instante (relativo a replayStartMs) em que ESTA rodada apareceu
  // na tela — é o que a tela de replay usa pra saber quando trocar de
  // rodada e sincronizar com o rastro do mouse (ver renderReplayFrame)
  if (replayRounds.length < 400) replayRounds.push({ t: Math.round(performance.now() - replayStartMs), sq: roundSnapshot }); // teto de sanidade — mesma ideia do HARD_SCORE_CAP do servidor

  const INSTR_FIRST = {
    classic: () => T[state.lang].instr_first_classic(cName(target)),
    reverse: () => T[state.lang].instr_first_reverse(cName(target)),
    shapes: () => T[state.lang].instr_first_shapes(cName(target)),
    'shapes-reverse': () => T[state.lang].instr_first_shapes_reverse(cName(target)),
  };
  const INSTR_NEXT = {
    classic: T[state.lang].instr_next_classic,
    reverse: T[state.lang].instr_next_reverse,
    shapes: T[state.lang].instr_next_shapes,
    'shapes-reverse': T[state.lang].instr_next_shapes_reverse,
  };
  $('instruction').textContent = first ? INSTR_FIRST[mode]() : INSTR_NEXT[mode];
  $('speed').textContent = `⏱️ ${(duration / 1000).toFixed(1)}s`;

  startTimer();
}

function startTimer() {
  cancelAnimationFrame(rafId);
  timerStart = performance.now();
  let lastTick = 0;
  const tick = now => {
    if (!playing) return;
    const left = 1 - (now - timerStart) / duration;
    $('timer-fill').style.width = Math.max(0, left * 100) + '%';
    if (left <= 0) { window.sfx.timeout(); return gameOver(T[state.lang].reason_timeout); }
    if (left < 0.35 && now - lastTick > 250) { lastTick = now; window.sfx.tick(); } // tic-tac no fim do tempo
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function handleClick(item, e) {
  if (!playing) return;
  if (item === target) {
    score++;
    if (state.currentSessionId) pendingRoundSync.push(callSyncProgress({ sessionId: state.currentSessionId, trusted: !e || e.isTrusted }).catch(() => {}));
    // XP da rodada: quanto mais rápido acertar, mais ganha — e quanto mais longa a sequência, maior o bônus
    const elapsed = (performance.now() - timerStart) / 1000;
    xpGain += Math.max(0, 3 - 0.2 * elapsed) * xpStreakMultiplier(score);
    window.sfx.correct(score);
    $('score').textContent = score;
    target = nextTarget;
    duration *= 0.95;
    newRound(false);
  } else {
    window.sfx.wrong();
    gameOver(T[state.lang].reason_wrong);
  }
}

// trava (ou destrava) os botões de ação da tela de fim de jogo — usado
// enquanto o placar ainda está sendo confirmado com o servidor, pra ninguém
// clicar "jogar de novo"/"menu"/"compartilhar" no meio da conta (ver
// gameOver abaixo)
function setOverButtonsEnabled(enabled) {
  document.querySelectorAll('#over-screen .btn-row button, #signup-cta').forEach(b => { b.disabled = !enabled; });
}

// pede a avaliação nativa da loja (SKStoreReviewController no iOS, In-App
// Review no Android) num momento positivo -- logo que a pessoa bate um novo
// recorde (ver isNewRecord em gameOver). Só a 1ª vez por sessão: o próprio
// StoreKit/Play já decide sozinho se realmente mostra o modal (tem limite de
// poucas vezes por ano, e não reaparece se já apareceu recentemente) -- não
// faz sentido reimplementar esse controle aqui, só evitar chamar toda hora.
//
// Checa window.Capacitor.Plugins.InAppReview antes de usar em vez de
// assumir que existe: o plugin @capacitor-community/in-app-review só passa
// a existir no binário nativo a partir da versão que o adicionar, mas o
// site (carregado remoto pelo WebView) atualiza na hora pra QUALQUER versão
// instalada -- sem essa checagem, quem estiver com um binário mais antigo
// receberia .requestReview() em undefined (mesma causa do bug corrigido em
// d96cc6b pros Universal Links).
let reviewRequestedThisSession = false;
function maybeRequestAppReview() {
  if (reviewRequestedThisSession) return;
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (!isNative) return;
  const InAppReview = window.Capacitor.Plugins && window.Capacitor.Plugins.InAppReview;
  if (!InAppReview) return;
  reviewRequestedThisSession = true;
  InAppReview.requestReview().catch(() => {});
}

async function gameOver(reason) {
  playing = false;
  cancelAnimationFrame(rafId);
  const record = myRecord(mode);
  const isNewRecord = score > record;
  // XP só pra quem está logado com conta
  const xpEarned = (!state.offline && state.currentUser && state.myData.nick) ? Math.round(xpGain) : 0;
  const xpBefore = myXp();
  const xpAfter = xpBefore + xpEarned;
  const leveledUp = levelFromXp(xpAfter) > levelFromXp(xpBefore);
  track('game_over', { mode, score, new_record: isNewRecord, xp_earned: xpEarned });

  $('over-reason').textContent = reason;
  $('final-score').textContent = score;
  $('record-over').textContent = Math.max(score, record);
  $('new-record').classList.toggle('show', isNewRecord);
  $('sync-status').textContent = '';
  $('share-status').textContent = '';
  if (isNewRecord) { window.sfx.record(); spawnConfetti(); maybeRequestAppReview(); }
  show('over-screen');

  // trava os botões e espera os sinais de progresso desta partida
  // "assentarem" no servidor (ver pendingRoundSync/callSyncProgress)
  // antes de mandar o resultado final — fecha a corrida entre o envio final
  // chegar antes de algum sinal ainda em trânsito pela rede
  setOverButtonsEnabled(false);
  if (!state.offline && state.currentUser && state.myData.nick) $('sync-status').textContent = T[state.lang].sync_calculating;
  await Promise.allSettled(pendingRoundSync);
  pendingRoundSync = [];
  $('sync-status').textContent = ''; // volta a ficar vazio — persistGameResult decide se mostra sucesso/erro

  // XP ganho + animação da barra subindo
  if (xpEarned > 0) {
    $('xp-gain').style.display = '';
    $('over-xp-wrap').style.display = '';
    animateXpGain(xpEarned, xpBefore, xpAfter, leveledUp);
  } else {
    $('xp-gain').style.display = 'none';
    $('over-xp-wrap').style.display = 'none';
  }

  if (state.offline) {
    if (isNewRecord) setLocalRecord(mode, score);
  } else if (state.currentUser && state.myData.nick) {
    await persistGameResult(xpEarned);
  }
  setOverButtonsEnabled(true);

  // convite para quem joga sem conta
  $('signup-cta').style.display = 'none';
  if (state.offline && score > 0) {
    state.pendingScore = { mode, score };
    $('signup-cta').style.display = '';
  }

  renderMiniRankings(mode, score);
}

// anima o número de XP subindo e a barra de progresso enchendo (com virada de nível se houver)
function animateXpGain(earned, before, after, leveledUp) {
  const durMs = 1100;
  const start = performance.now();
  const numEl = $('xp-gain-num');
  const lvEl = $('over-xp-lv');
  const numsEl = $('over-xp-nums');
  const fillEl = $('over-xp-fill');
  fillEl.style.transition = 'none'; // a animação aqui é frame a frame

  const step = now => {
    const t = Math.min(1, (now - start) / durMs);
    const eased = 1 - Math.pow(1 - t, 3); // desacelera no final
    const xpNow = Math.round(before + (after - before) * eased);
    const xi = xpInfo(xpNow);
    numEl.textContent = Math.round(earned * eased);
    lvEl.textContent = `Lv ${xi.lv}`;
    numsEl.textContent = `${xi.into}/${xi.need}`;
    fillEl.style.width = Math.min(100, (xi.into / xi.need) * 100) + '%';
    if (t < 1) requestAnimationFrame(step);
    else if (leveledUp) showLevelUp(levelFromXp(after));
  };
  requestAnimationFrame(step);
}

function showLevelUp(newLv) {
  track('level_up', { level: newLv });
  $('levelup-title').textContent = T[state.lang].levelup_title;
  $('levelup-lv').textContent = `Lv ${newLv}`;
  $('levelup-banner').classList.add('show');
  window.sfx.levelUp();
  setTimeout(() => $('levelup-banner').classList.remove('show'), 3200);
}
window.dismissLevelUp = () => $('levelup-banner').classList.remove('show');

async function persistGameResult(xpEarned = 0) {
  // a pontuação final agora é validada no servidor (Cloud Function), que checa
  // se o tempo real de jogo é compatível com a pontuação alegada antes de gravar.
  if (!state.currentSessionId) {
    // sem sessão validada (ex.: caiu a internet bem no início da partida) —
    // não há como confirmar no servidor, então não grava essa partida.
    $('sync-status').textContent = T[state.lang].sync_fail;
    return;
  }
  const sessionId = state.currentSessionId;
  state.currentSessionId = null; // cada sessão só pode ser usada uma vez

  try {
    const res = await callSubmitResult({ sessionId, mode, score, xpGain: xpEarned });
    const d = res.data || {};
    state.myData.lastPlayedDate = todayStr();
    state.myData.currentStreak = d.currentStreak;
    state.myData.bestStreak = d.bestStreak;
    state.myData.gamesPlayed = (state.myData.gamesPlayed || 0) + 1;
    state.myData.totalPoints = (state.myData.totalPoints || 0) + score;
    state.myData.xp = (state.myData.xp || 0) + xpEarned;
    state.myData[PLAYED_FIELD[mode]] = true;
    if (d.isNewRecord) {
      state.myData[mode] = score;
      // servidor grava [mode]+"At" com serverTimestamp() (ver submitGameResult em
      // functions/index.js), mas o valor resolvido não volta na resposta — sem
      // atualizar isso aqui, o ranking de prévia (mini-ranking do fim de jogo)
      // ordenava o empate usando o carimbo do recorde ANTERIOR (ou nenhum),
      // não o de agora, e o critério "quem fez primeiro" saía errado bem na
      // hora que mais importa: logo após bater um recorde novo
      state.myData[mode + 'At'] = Timestamp.now();
      if (d.total !== undefined) { state.myData.total = d.total; state.myData.totalAt = Timestamp.now(); } // mesmo motivo, pro ranking "Geral" (soma dos recordes)
      $('sync-status').textContent = T[state.lang].sync_success;
      // sobe o "filme" da partida (ver replayRounds/replayMouse lá em cima)
      // só agora que virou recorde — em segundo plano, não atrasa a tela de
      // resultado. state.myData[mode+'ReplaySessionId'] atualiza na hora, sem
      // esperar o próximo carregamento do ranking, mesmo motivo do +'At' acima
      state.myData[mode + 'ReplaySessionId'] = sessionId;
      saveMatchReplayWithRetry({ sessionId, mode, rounds: replayRounds, mouseTrail: replayMouse }).catch(() => {}); // já logou dentro; aqui só evita unhandled rejection
    }
  } catch (e) {
    $('sync-status').textContent = T[state.lang].sync_fail;
  }
}
