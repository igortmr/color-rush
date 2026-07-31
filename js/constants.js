// tem que bater com DAILY_MAX_ATTEMPTS do servidor (functions/index.js)
export const DAILY_MAX_ATTEMPTS = 3;

export const COLORS = [
  { key: 'blue',   name: { pt: 'AZUL',     en: 'BLUE',   es: 'AZUL'      }, hex: '#1e90ff' },
  { key: 'red',    name: { pt: 'VERMELHO', en: 'RED',    es: 'ROJO'      }, hex: '#ff3c3c' }, // um pouco mais puro/forte que antes (#ff4757), pra diferenciar melhor do rosa (#ff6b9d) — hue quase idêntico ao original antes puxava pro lado do rosa
  { key: 'green',  name: { pt: 'VERDE',    en: 'GREEN',  es: 'VERDE'     }, hex: '#2ed573' },
  { key: 'yellow', name: { pt: 'AMARELO',  en: 'YELLOW', es: 'AMARILLO'  }, hex: '#ffd32a' },
  { key: 'purple', name: { pt: 'ROXO',     en: 'PURPLE', es: 'MORADO'    }, hex: '#a55eea' },
  { key: 'orange', name: { pt: 'LARANJA',  en: 'ORANGE', es: 'NARANJA'   }, hex: '#ff7f24' },
  { key: 'pink',   name: { pt: 'ROSA',     en: 'PINK',   es: 'ROSA'      }, hex: '#ff6b9d' },
  { key: 'cyan',   name: { pt: 'CIANO',    en: 'CYAN',   es: 'CIAN'      }, hex: '#00d2d3' },
];
export const CONFETTI_COLORS = { confetti_gold: ['#ffd700', '#ffe93c', '#fff2a8'] };
export const SQUARES = 4;
export const SHAPES = [
  { name: { pt: 'CÍRCULO',    en: 'CIRCLE',   es: 'CÍRCULO'   }, shapeClass: 'shape-circle' },
  { name: { pt: 'QUADRADO',   en: 'SQUARE',   es: 'CUADRADO'  }, shapeClass: 'shape-square-shape' },
  { name: { pt: 'TRIÂNGULO',  en: 'TRIANGLE', es: 'TRIÁNGULO' }, shapeClass: 'shape-triangle' },
  { name: { pt: 'LOSANGO',    en: 'DIAMOND',  es: 'ROMBO'     }, shapeClass: 'shape-diamond' },
  { name: { pt: 'ESTRELA',    en: 'STAR',     es: 'ESTRELLA'  }, shapeClass: 'shape-star' },
  { name: { pt: 'CRUZ',       en: 'CROSS',    es: 'CRUZ'      }, shapeClass: 'shape-cross' },
];
export const poolFor = m => (m === 'shapes' || m === 'shapes-reverse') ? SHAPES : COLORS;
// modo Caos: pool combinado de cores + formas — cada quadrado pode "bater"
// com um item memorizado seja ele uma cor ou uma forma, então o sorteio
// precisa dos dois universos juntos num só array
export const CAOS_POOL = [...COLORS, ...SHAPES];
export const isColorItem = item => COLORS.includes(item);
// identificador estável (string curta) de um item de cor/forma — usado só
// pra gravar/reconstruir o "filme" da tela de replay; nunca participa da
// pontuação nem da validação, é puramente visual
export const poolItemId = item => item.key || item.shapeClass;
export const poolItemById = (pool, id) => pool.find(x => (x.key || x.shapeClass) === id) || pool[0];
export const PLAYED_FIELD = { classic: 'playedClassic', reverse: 'playedReverse', shapes: 'playedShapes', 'shapes-reverse': 'playedShapesReverse', trio: 'playedTrio', caos: 'playedCaos' };
export const ALL_MODES = ['classic', 'reverse', 'shapes', 'shapes-reverse', 'trio', 'caos'];
// o desafio diário sorteia só entre Clássico e Reverso — de propósito uma
// lista separada de ALL_MODES, pra um modo novo (como o Trio) poder entrar
// no jogo livre/ranking sem precisar reconstruir também a tela do desafio
// diário (grid/replay dele têm o próprio código de render). Formas/Formas
// Reverso saíram do sorteio a pedido (ficou só entre os 2 modos de cor, que
// agora usam a paleta estendida DAILY_COLORS abaixo).
export const DAILY_ROTATION_MODES = ['classic', 'reverse'];
// paleta exclusiva do desafio diário: só 4 tons quentes próximos (Amarelo,
// Laranja, Marrom e Vermelho), de propósito bem mais difícil de diferenciar
// que as 8 cores normais — o jogo livre (Clássico/Reverso/Trio) continua só
// com as 8 cores de COLORS, sem mudança. Precisa de um "kind: 'daily'"
// gravado no replay (ver saveMatchReplay em functions/index.js e
// dailyGameOver) pra tela de replay saber que deve reconstruir com esta
// paleta em vez da COLORS normal (ver renderReplaySquares).
// Como o pool tem exatamente 4 cores e cada rodada mostra exatamente 4
// quadrados (ver SQUARES), dailyNewRound() sempre usa as 4 de uma vez
// (embaralhadas) — nunca duas cores de fundo repetidas na mesma rodada.
export const DAILY_COLORS = [
  { key: 'yellow', name: { pt: 'AMARELO',  en: 'YELLOW',  es: 'AMARILLO'   }, hex: '#ffd32a' },
  { key: 'orange', name: { pt: 'LARANJA',  en: 'ORANGE',  es: 'NARANJA'    }, hex: '#ff7f24' },
  { key: 'brown',  name: { pt: 'MARROM',   en: 'BROWN',   es: 'MARRÓN'     }, hex: '#73421c' },
  { key: 'red',    name: { pt: 'VERMELHO', en: 'RED',     es: 'ROJO'       }, hex: '#ff3c3c' },
];
// DAILY_PALETTE_OVERRIDE: mesma ideia do DAILY_MODE_OVERRIDE (ver
// game-teste.js) só que pra paleta — força um dia específico a usar outras
// cores em vez da paleta padrão do desafio diário (DAILY_COLORS), sem mexer
// no sorteio de verdade dos outros dias. Precisa de PELO MENOS 4 cores (==
// SQUARES) — dailyNewRound() sorteia 4 distintas a cada rodada dentro da
// paleta do dia, igual o Clássico/Reverso normal já faz com as 8 cores de
// COLORS (ver poolFor); só quando a paleta tem EXATAMENTE 4 (caso de
// 2026-07-30 abaixo) é que as mesmas 4 acabam aparecendo toda rodada.
export const DAILY_PALETTE_OVERRIDE = {
  '2026-07-30': [
    { key: 'blue',   name: { pt: 'AZUL',  en: 'BLUE',   es: 'AZUL'   }, hex: '#1e90ff' },
    { key: 'cyan',   name: { pt: 'CIANO', en: 'CYAN',   es: 'CIAN'   }, hex: '#00d2d3' },
    { key: 'green',  name: { pt: 'VERDE', en: 'GREEN',  es: 'VERDE'  }, hex: '#2ed573' },
    { key: 'purple', name: { pt: 'ROXO',  en: 'PURPLE', es: 'MORADO' }, hex: '#a55eea' },
  ],
  // 12 cores a pedido — inclui as 8 do jogo livre (COLORS) + marrom (já usado
  // na paleta padrão do diário, DAILY_COLORS) + 3 novas exclusivas do diário
  // (cinza/branco/preto, nunca usadas em nenhuma outra paleta do jogo).
  // "preto" usa #1a1a1a (quase preto) em vez de #000 puro: o brilho do
  // quadrado (box-shadow) usa a mesma hex, e um brilho literalmente preto não
  // apareceria — assim o quadrado ainda "acende" como os outros, só mais escuro.
  '2026-07-31': [
    { key: 'yellow', name: { pt: 'AMARELO',  en: 'YELLOW', es: 'AMARILLO' }, hex: '#ffd32a' },
    { key: 'blue',   name: { pt: 'AZUL',     en: 'BLUE',   es: 'AZUL'     }, hex: '#1e90ff' },
    { key: 'green',  name: { pt: 'VERDE',    en: 'GREEN',  es: 'VERDE'    }, hex: '#2ed573' },
    { key: 'purple', name: { pt: 'ROXO',     en: 'PURPLE', es: 'MORADO'   }, hex: '#a55eea' },
    { key: 'cyan',   name: { pt: 'CIANO',    en: 'CYAN',   es: 'CIAN'     }, hex: '#00d2d3' },
    { key: 'red',    name: { pt: 'VERMELHO', en: 'RED',    es: 'ROJO'     }, hex: '#ff3c3c' },
    { key: 'orange', name: { pt: 'LARANJA',  en: 'ORANGE', es: 'NARANJA'  }, hex: '#ff7f24' },
    { key: 'pink',   name: { pt: 'ROSA',     en: 'PINK',   es: 'ROSA'     }, hex: '#ff6b9d' },
    { key: 'brown',  name: { pt: 'MARROM',   en: 'BROWN',  es: 'MARRÓN'   }, hex: '#73421c' },
    { key: 'gray',   name: { pt: 'CINZA',    en: 'GRAY',   es: 'GRIS'     }, hex: '#8a8a8a' },
    { key: 'white',  name: { pt: 'BRANCO',   en: 'WHITE',  es: 'BLANCO'   }, hex: '#ffffff' },
    { key: 'black',  name: { pt: 'PRETO',    en: 'BLACK',  es: 'NEGRO'    }, hex: '#1a1a1a' },
  ],
};
