import { $ } from './dom.js';
import { state } from './state.js';
import { T, cName } from './i18n.js';
import { track } from './utils.js';
import { show } from './nav.js';
import { COLORS, SHAPES } from './constants.js';

/* ================== tutorial passo a passo (modo clássico) ================== */
// dados fixos (não aleatórios) pra ensinar o mecanismo com previsibilidade.
// rodada A: pedem VERMELHO, quadrado certo tem a palavra VERDE (a memorizar).
// rodada B: pedem VERDE (a cor memorizada), quadrado certo tem a palavra AMARELO.
// clássico: o alvo é uma COR (fundo do quadrado certo) — o que se memoriza é a PALAVRA escrita nele.
// reverso: o alvo é uma PALAVRA (escrita no quadrado certo) — o que se memoriza é a COR DE FUNDO dele.
const TUT_DATA = {
  classic: [
    {
      target: COLORS[1], // vermelho
      squares: [
        { bg: COLORS[0], word: COLORS[4] },
        { bg: COLORS[1], word: COLORS[2], correct: true }, // fundo vermelho / palavra verde
        { bg: COLORS[3], word: COLORS[6] },
        { bg: COLORS[4], word: COLORS[7] },
      ],
    },
    {
      target: COLORS[2], // verde (o que foi memorizado na rodada A)
      squares: [
        { bg: COLORS[6], word: COLORS[5] },
        { bg: COLORS[7], word: COLORS[0] },
        { bg: COLORS[2], word: COLORS[3], correct: true }, // fundo verde / palavra amarela (posição diferente da rodada A)
        { bg: COLORS[0], word: COLORS[4] },
      ],
    },
    {
      target: COLORS[3], // amarelo (o que foi memorizado na rodada B)
      squares: [
        { bg: COLORS[5], word: COLORS[6] },
        { bg: COLORS[0], word: COLORS[4] },
        { bg: COLORS[2], word: COLORS[5] },
        { bg: COLORS[3], word: COLORS[7], correct: true }, // fundo amarelo / palavra ciano (posição diferente das anteriores)
      ],
    },
  ],
  reverse: [
    {
      target: COLORS[1], // pedem a palavra "vermelho"
      squares: [
        { bg: COLORS[0], word: COLORS[4] },
        { bg: COLORS[6], word: COLORS[1], correct: true }, // palavra vermelho / fundo rosa (o que se memoriza) — evita verde, que brigava com o brilho do destaque
        { bg: COLORS[3], word: COLORS[6] },
        { bg: COLORS[4], word: COLORS[7] },
      ],
    },
    {
      target: COLORS[6], // pedem a palavra "rosa" (cor memorizada na rodada A)
      squares: [
        { bg: COLORS[6], word: COLORS[5] },
        { bg: COLORS[7], word: COLORS[0] },
        { bg: COLORS[3], word: COLORS[6], correct: true }, // palavra rosa / fundo amarelo (posição diferente da rodada A)
        { bg: COLORS[0], word: COLORS[4] },
      ],
    },
    {
      target: COLORS[3], // pedem a palavra "amarelo" (cor memorizada na rodada B)
      squares: [
        { bg: COLORS[5], word: COLORS[6] },
        { bg: COLORS[0], word: COLORS[4] },
        { bg: COLORS[2], word: COLORS[5] },
        { bg: COLORS[7], word: COLORS[3], correct: true }, // palavra amarelo / fundo ciano (posição diferente das anteriores)
      ],
    },
  ],
  // formas: funciona igual ao clássico — o alvo é a FORMA desenhada no quadrado certo,
  // o que se memoriza é a PALAVRA (nome de outra forma) escrita nele
  shapes: [
    {
      target: SHAPES[0], // círculo
      squares: [
        { shape: SHAPES[3], word: SHAPES[4] },
        { shape: SHAPES[0], word: SHAPES[1], correct: true }, // silhueta círculo / palavra quadrado (a memorizar)
        { shape: SHAPES[2], word: SHAPES[5] },
        { shape: SHAPES[4], word: SHAPES[3] },
      ],
    },
    {
      target: SHAPES[1], // quadrado (o que foi memorizado na rodada A)
      squares: [
        { shape: SHAPES[5], word: SHAPES[0] },
        { shape: SHAPES[4], word: SHAPES[3] },
        { shape: SHAPES[1], word: SHAPES[2], correct: true }, // silhueta quadrado / palavra triângulo (posição diferente da rodada A)
        { shape: SHAPES[3], word: SHAPES[4] },
      ],
    },
    {
      target: SHAPES[2], // triângulo (o que foi memorizado na rodada B)
      squares: [
        { shape: SHAPES[4], word: SHAPES[5] },
        { shape: SHAPES[0], word: SHAPES[3] },
        { shape: SHAPES[3], word: SHAPES[0] },
        { shape: SHAPES[2], word: SHAPES[4], correct: true }, // silhueta triângulo / palavra estrela (posição diferente das anteriores)
      ],
    },
  ],
  // formas reverso: funciona igual ao reverso — o alvo é a PALAVRA pedida (nome de
  // uma forma), o que se memoriza é a FORMA que envolve o quadrado onde essa
  // palavra está escrita (não a forma desenhada nele, essa é só distração)
  'shapes-reverse': [
    {
      target: SHAPES[1], // pedem a palavra "quadrado"
      squares: [
        { shape: SHAPES[0], word: SHAPES[3] },
        { shape: SHAPES[4], word: SHAPES[1], correct: true }, // palavra quadrado / forma estrela (o que se memoriza)
        { shape: SHAPES[2], word: SHAPES[5] },
        { shape: SHAPES[5], word: SHAPES[0] },
      ],
    },
    {
      target: SHAPES[4], // pedem a palavra "estrela" (forma memorizada na rodada A)
      squares: [
        { shape: SHAPES[5], word: SHAPES[3] },
        { shape: SHAPES[0], word: SHAPES[2] },
        { shape: SHAPES[2], word: SHAPES[4], correct: true }, // palavra estrela / forma triângulo (posição diferente da rodada A)
        { shape: SHAPES[3], word: SHAPES[0] },
      ],
    },
    {
      target: SHAPES[2], // pedem a palavra "triângulo" (forma memorizada na rodada B)
      squares: [
        { shape: SHAPES[0], word: SHAPES[3] },
        { shape: SHAPES[1], word: SHAPES[4] },
        { shape: SHAPES[3], word: SHAPES[0] },
        { shape: SHAPES[5], word: SHAPES[2], correct: true }, // palavra triângulo / forma cruz (posição diferente das anteriores)
      ],
    },
  ],
  // trio: cada quadrado tem 3 cores independentes (bg/tc/word — mesmo shape
  // que renderTrioSquare espera). Pedem-se 2 cores (targetA/targetB); o
  // quadrado certo é o único em que UMA delas aparece em QUALQUER das 3
  // partes; o que se memoriza pra rodada seguinte são as OUTRAS 2 cores
  // desse quadrado. As 3 rodadas de exemplo variam de propósito ONDE a cor
  // pedida bate (fundo → cor da palavra → a própria palavra), pra ensinar
  // que vale qualquer uma das 3 partes, não só o fundo.
  trio: [
    {
      targetA: COLORS[1], targetB: COLORS[2], // vermelho e verde
      squares: [
        { bg: COLORS[0], tc: COLORS[6], word: COLORS[7] },
        { bg: COLORS[1], tc: COLORS[5], word: COLORS[4], correct: true }, // bate no FUNDO (vermelho) — memoriza tc=laranja e word=roxo
        { bg: COLORS[3], tc: COLORS[7], word: COLORS[6] },
        { bg: COLORS[7], tc: COLORS[4], word: COLORS[5] },
      ],
    },
    {
      // par memorizado na rodada A: laranja (tc) + roxo (word)
      squares: [
        { bg: COLORS[0], tc: COLORS[7], word: COLORS[1] },
        { bg: COLORS[1], tc: COLORS[6], word: COLORS[7] },
        { bg: COLORS[2], tc: COLORS[5], word: COLORS[3], correct: true }, // bate na COR DA PALAVRA (laranja) — memoriza bg=verde e word=amarelo
        { bg: COLORS[6], tc: COLORS[1], word: COLORS[0] },
      ],
    },
    {
      // par memorizado na rodada B: verde (bg) + amarelo (word)
      squares: [
        { bg: COLORS[0], tc: COLORS[5], word: COLORS[1] },
        { bg: COLORS[1], tc: COLORS[4], word: COLORS[5] },
        { bg: COLORS[4], tc: COLORS[0], word: COLORS[5] },
        { bg: COLORS[7], tc: COLORS[6], word: COLORS[2], correct: true }, // bate na PRÓPRIA PALAVRA (verde) — posição diferente das anteriores
      ],
    },
  ],
  // caos: mesma mecânica do Trio (ver comentário lá em cima), só que cada
  // quadrado tem 3 atributos de domínio misto (shape/color/word — mesmo
  // shape que renderCaosSquare espera) em vez de 3 cores. Pedem-se 2 itens
  // (targetA/targetB, podendo ser cor e/ou forma); o quadrado certo é o
  // único em que UM deles aparece em QUALQUER um dos 3 atributos; o que se
  // memoriza pra rodada seguinte são os OUTROS 2 atributos desse quadrado.
  // As 3 rodadas de exemplo variam de propósito ONDE o item pedido bate
  // (cor da figura → palavra → forma), pra ensinar que vale qualquer um dos
  // 3 — e a rodada A já mistura 1 cor + 1 forma nos itens pedidos, deixando
  // claro que os 2 podem ser de tipos diferentes.
  caos: [
    {
      targetA: COLORS[1], targetB: SHAPES[4], // vermelho e estrela
      squares: [
        { shape: SHAPES[3], color: COLORS[2], word: SHAPES[0] },
        { shape: SHAPES[1], color: COLORS[1], word: COLORS[4], correct: true }, // bate na COR (vermelho) — memoriza shape=quadrado e word=roxo
        { shape: SHAPES[2], color: COLORS[5], word: SHAPES[5] },
        { shape: SHAPES[0], color: COLORS[6], word: COLORS[3] },
      ],
    },
    {
      // par memorizado na rodada A: quadrado (shape) + roxo (word)
      squares: [
        { shape: SHAPES[5], color: COLORS[0], word: SHAPES[2] },
        { shape: SHAPES[3], color: COLORS[7], word: SHAPES[4] },
        { shape: SHAPES[0], color: COLORS[2], word: COLORS[4], correct: true }, // bate na PALAVRA (roxo) — memoriza shape=círculo e color=verde
        { shape: SHAPES[2], color: COLORS[5], word: COLORS[6] },
      ],
    },
    {
      // par memorizado na rodada B: círculo (shape) + verde (color)
      squares: [
        { shape: SHAPES[3], color: COLORS[6], word: SHAPES[5] },
        { shape: SHAPES[4], color: COLORS[1], word: COLORS[3] },
        { shape: SHAPES[2], color: COLORS[5], word: SHAPES[1] },
        { shape: SHAPES[0], color: COLORS[7], word: COLORS[4], correct: true }, // bate na FORMA (círculo) — posição diferente das anteriores
      ],
    },
  ],
};
const TUT_TOTAL = 7;
export let tutMode = 'classic';
export let tutStep = 1;
// quando o tutorial é aberto a partir da tela de introdução do desafio diário
// (botão "Como jogar" ali), "pular"/"terminar" o tutorial deve voltar pra
// essa tela (e terminar deve já iniciar a tentativa), em vez do fluxo normal
// (voltar pro menu / ir pro modo livre) — ver startTutorial/tutBack/tutPlay
let tutFromDaily = false;
let tutTimers = [];
function tutClearTimers() { tutTimers.forEach(clearTimeout); tutTimers = []; }
function tutAfter(ms, fn) { const id = setTimeout(fn, ms); tutTimers.push(id); return id; }

function tutRenderRound(roundIdx, instrText) {
  const round = TUT_DATA[tutMode][roundIdx];
  const grid = $('tut-grid');
  grid.innerHTML = '';
  round.squares.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'square';
    el.dataset.i = i;
    if (tutMode === 'shapes' || tutMode === 'shapes-reverse') {
      el.classList.add('shape-square', s.shape.shapeClass);
      el.innerHTML = `<span class="shape-fill ${s.shape.shapeClass}"></span><span class="word">${cName(s.word)}</span><span class="tut-check">✅</span>`;
    } else if (tutMode === 'trio') {
      // mesmo visual de renderTrioSquare (jogo/replay), só acrescentando o
      // check verde que só o tutorial usa
      el.style.background = s.bg.hex;
      el.style.boxShadow = `0 0 18px ${s.bg.hex}99, 0 0 40px ${s.bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
      el.innerHTML = `<span class="word word-trio" style="color:${s.tc.hex}">${cName(s.word)}</span><span class="tut-check">✅</span>`;
    } else if (tutMode === 'caos') {
      // mesmo visual de renderCaosSquare (jogo/replay), só acrescentando o
      // check verde que só o tutorial usa
      el.classList.add('shape-square', s.shape.shapeClass);
      el.innerHTML = `<span class="shape-fill ${s.shape.shapeClass}" style="background:${s.color.hex}; filter: drop-shadow(0 0 14px ${s.color.hex}88) drop-shadow(0 0 26px ${s.color.hex}44);"></span><span class="word">${cName(s.word)}</span><span class="tut-check">✅</span>`;
    } else {
      el.style.background = s.bg.hex;
      el.style.boxShadow = `0 0 18px ${s.bg.hex}99, 0 0 40px ${s.bg.hex}55, inset 0 0 20px rgba(255,255,255,0.12)`;
      el.innerHTML = `<span class="word">${cName(s.word)}</span><span class="tut-check">✅</span>`;
    }
    grid.appendChild(el);
  });
  $('tut-instruction').textContent = instrText;
}

function tutClearHighlights() {
  $('tut-instruction').classList.remove('tut-glow');
  document.querySelectorAll('#tut-grid .square').forEach(sq => {
    sq.classList.remove('tut-glow', 'tut-correct-flash', 'tut-dim');
    sq.querySelector('.tut-check')?.classList.remove('show');
    sq.querySelector('.word')?.classList.remove('tut-word-glow');
  });
  const ptrEl = $('tut-pointer');
  ptrEl.classList.remove('visible', 'tapping', 'tut-pointer-up');
  ptrEl.textContent = '👉';
  const staticEl = $('tut-pointer-static');
  staticEl.classList.remove('visible', 'tut-pointer-up');
  staticEl.textContent = '👉';
  $('tut-pointer-next').classList.remove('visible');
  $('tut-brain').classList.remove('visible', 'pulsing');
}

function tutPointAt(targetEl, opts = {}) {
  const stage = $('tut-stage');
  const stageRect = stage.getBoundingClientRect();
  const r = targetEl.getBoundingClientRect();
  const el = opts.brain ? $('tut-brain') : opts.static ? $('tut-pointer-static') : $('tut-pointer');
  const xr = opts.xr ?? 0.5, yr = opts.yr ?? 0.42;
  el.style.left = (r.left + r.width * xr - stageRect.left) + 'px';
  el.style.top = (r.top + r.height * yr - stageRect.top) + 'px';
  el.classList.add('visible');
  if (opts.brain) el.classList.add('pulsing');
  return el;
}

function tutCorrectSquare(roundIdx) {
  const idx = TUT_DATA[tutMode][roundIdx].squares.findIndex(s => s.correct);
  return document.querySelectorAll('#tut-grid .square')[idx];
}

function tutSetDots() {
  const wrap = $('tut-dots');
  wrap.innerHTML = '';
  for (let i = 1; i <= TUT_TOTAL; i++) {
    const d = document.createElement('span');
    d.className = 'tut-dot' + (i === tutStep ? ' active' : i < tutStep ? ' done' : '');
    wrap.appendChild(d);
  }
}

function tutSetNav() {
  $('tut-prev-btn').style.visibility = tutStep === 1 ? 'hidden' : 'visible';
  const nextBtn = $('tut-next-btn');
  if (tutStep === TUT_TOTAL) {
    nextBtn.textContent = tutFromDaily ? T[state.lang].tut_play_btn_daily : T[state.lang].tut_play_btn[tutMode];
    nextBtn.onclick = window.tutPlay;
  } else {
    nextBtn.textContent = T[state.lang].tut_next;
    nextBtn.onclick = window.tutNext;
  }
}

export function showTutStep(n) {
  tutClearTimers();
  tutClearHighlights();
  tutStep = n;
  tutSetDots();
  tutSetNav();
  $('tut-caption').innerHTML = T[state.lang][`tut_caption_${tutMode}_${n}`];

  const INSTR_FIRST_BY_TUT_MODE = { classic: T[state.lang].instr_first_classic, reverse: T[state.lang].instr_first_reverse, shapes: T[state.lang].instr_first_shapes, 'shapes-reverse': T[state.lang].instr_first_shapes_reverse, trio: T[state.lang].instr_first_trio, caos: T[state.lang].instr_first_caos };
  const INSTR_NEXT_BY_TUT_MODE = { classic: T[state.lang].instr_next_classic, reverse: T[state.lang].instr_next_reverse, shapes: T[state.lang].instr_next_shapes, 'shapes-reverse': T[state.lang].instr_next_shapes_reverse, trio: T[state.lang].instr_next_trio, caos: T[state.lang].instr_next_caos };
  const instrFirst = INSTR_FIRST_BY_TUT_MODE[tutMode];
  const instrNext = INSTR_NEXT_BY_TUT_MODE[tutMode];
  // trio e caos pedem 2 itens (targetA/targetB) — instrFirst recebe os 2
  // nomes; os outros modos pedem só 1 (target)
  const round0 = () => tutRenderRound(0, (tutMode === 'trio' || tutMode === 'caos')
    ? instrFirst(cName(TUT_DATA[tutMode][0].targetA), cName(TUT_DATA[tutMode][0].targetB))
    : instrFirst(cName(TUT_DATA[tutMode][0].target)));
  const round1 = () => tutRenderRound(1, instrNext);
  const round2 = () => tutRenderRound(2, instrNext);
  // destaca (pisca) o(s) nome(s) da(s) cor(es)/palavra(s) dentro da instrução no
  // topo — aceita mais de um nome (trio pede 2 cores de uma vez só)
  const tutHighlightInstrWord = (...names) => {
    const el = $('tut-instruction');
    const raw = el.textContent;
    const found = names
      .map(name => ({ name, idx: raw.indexOf(name) }))
      .filter(m => m.idx !== -1)
      .sort((a, b) => a.idx - b.idx);
    if (!found.length) return;
    let out = '', cursor = 0;
    found.forEach(({ name, idx }) => {
      out += raw.slice(cursor, idx) + `<span class="tut-instr-color">${name}</span>`;
      cursor = idx + name.length;
    });
    out += raw.slice(cursor);
    el.innerHTML = out;
  };
  // escurece os outros quadrados do grid aos poucos (~2s), deixando só o "sq" em
  // destaque — força um reflow antes de aplicar a classe, senão o navegador pula
  // direto pro estado final sem animar (mesmo problema de sempre com transições)
  const tutFocusSquare = (sq) => {
    const squares = document.querySelectorAll('#tut-grid .square');
    squares.forEach(el => el.classList.remove('tut-dim'));
    void $('tut-grid').offsetWidth;
    squares.forEach(el => { if (el !== sq) el.classList.add('tut-dim'); });
  };
  // mostra o cérebro sobre o que precisa ser memorizado (a palavra no clássico, a cor no reverso)
  const tutShowMemorize = (sq) => {
    tutFocusSquare(sq);
    sq.classList.add('tut-glow');
    if (tutMode === 'reverse' || tutMode === 'shapes-reverse') {
      // no reverso (e no formas reverso) memoriza-se a COR DE FUNDO (ou a FORMA) do quadrado, não a
      // palavra escrita nele — por isso o cérebro fica num canto, longe da palavra centralizada,
      // pra não parecer que é ela
      tutPointAt(sq, { brain: true, xr: 0.8, yr: 0.2 });
    } else {
      sq.querySelector('.word').classList.add('tut-word-glow');
      tutPointAt(sq.querySelector('.word'), { brain: true, yr: 0.32 });
    }
  };
  // mãozinha apontando pra palavra escrita no meio do quadrado, parada logo abaixo dela sem sobrepor
  // (usada no reverso pra deixar claro que é o texto que está sendo procurado, não a cor de fundo)
  const tutPointAtWord = (sq, opts = {}) => {
    const el = opts.static ? $('tut-pointer-static') : $('tut-pointer');
    el.textContent = '👆';
    el.classList.add('tut-pointer-up');
    sq.querySelector('.word').classList.add('tut-word-glow');
    tutPointAt(sq.querySelector('.word'), { static: !!opts.static, xr: opts.xr ?? 0.5, yr: opts.yr ?? 1.35 });
  };
  // mãozinha "chega" deslizando pela esquerda e para bem na borda do alvo, sem entrar no texto
  const tutSlideInFromLeft = (targetEl, opts = {}) => {
    const stage = $('tut-stage');
    const stageRect = stage.getBoundingClientRect();
    const r = targetEl.getBoundingClientRect();
    const el = $('tut-pointer');
    const yr = opts.yr ?? 0.5;
    const gap = opts.gap ?? 0; // px de folga extra entre a ponta do dedo e a borda esquerda do alvo
    // o transform da mãozinha (translate(-38%,...)) desloca o emoji ~62% do seu tamanho pra direita
    // do ponto de ancoragem — compensamos isso aqui pra ponta do dedo parar exatamente na borda
    const rightExtent = el.offsetWidth * 0.62;
    const finalLeft = r.left - stageRect.left - rightExtent - gap;
    const finalTop = r.top + r.height * yr - stageRect.top;
    el.style.left = '-160px';
    el.style.top = finalTop + 'px';
    el.classList.add('visible');
    void el.offsetWidth; // força o navegador a registrar a posição inicial antes de animar
    el.style.left = finalLeft + 'px';
  };
  // mãozinha "chega" deslizando pela direita e para na borda do alvo (usada pra apontar o botão Próximo)
  const tutSlideInFromRight = (targetEl, opts = {}) => {
    const stage = $('tut-stage');
    const stageRect = stage.getBoundingClientRect();
    const r = targetEl.getBoundingClientRect();
    const el = $('tut-pointer-next');
    const yr = opts.yr ?? 0.5;
    const gap = opts.gap ?? 26; // px de folga antes da borda direita do alvo (evita sobrepor o texto/botão)
    const finalLeft = r.right - stageRect.left + gap;
    const finalTop = r.top + r.height * yr - stageRect.top;
    el.style.left = (stageRect.width + 120) + 'px';
    el.style.top = finalTop + 'px';
    el.classList.add('visible');
    void el.offsetWidth; // força o navegador a registrar a posição inicial antes de animar
    el.style.left = finalLeft + 'px';
  };
  // mãozinha tocando o quadrado (lateralizada, embaixo) + flash verde — sem checkmark, a animação da mão já basta
  const tutShowClick = (sq, delay = 500) => {
    tutFocusSquare(sq);
    sq.classList.add('tut-glow');
    tutPointAt(sq, { xr: 0.24, yr: 0.84 });
    tutAfter(delay, () => {
      $('tut-pointer').classList.add('tapping');
      sq.classList.add('tut-correct-flash');
    });
  };

  if (n === 1) {
    // destaca a cor pedida na instrução (piscando) + o quadrado certo, e a mãozinha desliza pela
    // esquerda até chegar na caixa de texto embaixo (reforça que é ali que se deve ler primeiro)
    round0();
    const sq = tutCorrectSquare(0);
    tutFocusSquare(sq);
    if (tutMode === 'trio' || tutMode === 'caos') {
      tutHighlightInstrWord(cName(TUT_DATA[tutMode][0].targetA), cName(TUT_DATA[tutMode][0].targetB));
    } else {
      tutHighlightInstrWord(cName(TUT_DATA[tutMode][0].target));
    }
    if (tutMode === 'reverse' || tutMode === 'shapes-reverse') {
      tutPointAtWord(sq, { static: true }); // no reverso (e no formas reverso), destaca só a palavra (é ela que se procura)
    } else {
      sq.classList.add('tut-glow');
      tutPointAt(sq, { static: true, yr: 0.78 });
    }
    tutSlideInFromLeft($('tut-caption'), { yr: 0.4 });
  } else if (n === 2) {
    // memorize a palavra do meio (clássico) ou a cor de fundo (reverso) do quadrado certo
    round0();
    tutShowMemorize(tutCorrectSquare(0));
  } else if (n === 3) {
    // agora clica, depois de já ter memorizado (mãozinha lateralizada embaixo, sem check)
    round0();
    tutShowClick(tutCorrectSquare(0));
  } else if (n === 4) {
    // rodada 2: destaca o quadrado certo + mãozinha (aponta pra palavra no reverso, pro quadrado no clássico)
    round1();
    const sq = tutCorrectSquare(1);
    tutFocusSquare(sq);
    if (tutMode === 'reverse' || tutMode === 'shapes-reverse') {
      tutPointAtWord(sq); // destaca só a palavra, sem piscar o quadrado inteiro
    } else if (tutMode === 'trio' || tutMode === 'caos') {
      // aqui o match é na COR da palavra (trio) ou na PALAVRA (caos) — aponta
      // pra ela, mas deslocada pra esquerda (xr baixo) pra não sobrepor o
      // texto no meio do quadrado
      sq.classList.add('tut-glow');
      tutPointAtWord(sq, { xr: 0.2 });
    } else {
      sq.classList.add('tut-glow');
      tutPointAt(sq, { yr: 0.42 });
    }
  } else if (n === 5) {
    // memoriza a nova palavra (sem clicar ainda)
    round1();
    tutShowMemorize(tutCorrectSquare(1));
  } else if (n === 6) {
    // igual ao passo 3: clica depois de memorizar, sem check
    round1();
    tutShowClick(tutCorrectSquare(1));
  } else if (n === 7) {
    // recapitulação final: destaca o quadrado amarelo (rodada 3), memoriza e clica, sem check
    round2();
    const sq = tutCorrectSquare(2);
    tutShowMemorize(sq);
    tutShowClick(sq);
  }

  // depois de 4s, uma mãozinha vindo da direita aponta pro botão de avançar;
  // se for a mãozinha que chegou pela esquerda (passo 1), ela some pra não poluir a tela
  // (no último passo o botão vira "jogar", não precisa da dica)
  if (n < TUT_TOTAL) {
    tutAfter(4000, () => {
      tutSlideInFromRight($('tut-next-btn'), { gap: -10 });
      if (n === 1) $('tut-pointer').classList.remove('visible');
    });
  }
}

window.startTutorial = (mode = 'classic', opts = {}) => {
  tutMode = mode;
  tutFromDaily = !!opts.fromDaily;
  track('tutorial_start', { mode, fromDaily: tutFromDaily });
  show('tutorial-screen');
  $('tut-title-el').textContent = T[state.lang].tut_title[tutMode];
  showTutStep(1);
  $('tut-intro-banner').classList.add('show');
  setTimeout(() => $('tut-intro-banner').classList.remove('show'), 1500);
};
window.tutNext = () => { if (tutStep < TUT_TOTAL) showTutStep(tutStep + 1); };
window.tutPrev = () => { if (tutStep > 1) showTutStep(tutStep - 1); };
window.tutBack = () => {
  tutClearTimers();
  track('tutorial_skip', { step: tutStep, fromDaily: tutFromDaily });
  if (tutFromDaily) { tutFromDaily = false; window.showDailyIntro(); } else { window.showMenu(); }
};
window.tutPlay = () => {
  tutClearTimers();
  track('tutorial_complete', { mode: tutMode, fromDaily: tutFromDaily });
  if (tutFromDaily) { tutFromDaily = false; window.startDailyChallenge(); } else { window.startGame(tutMode); }
};
