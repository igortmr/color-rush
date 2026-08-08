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
// paleta do modo Mosaico (3x3, 9 quadrados) — as 8 cores normais (COLORS) +
// 4 novas, mesmos hex já usados na paleta de 12 cores do desafio diário (ver
// DAILY_PALETTE_OVERRIDE mais abaixo), só que aqui é fixa (não muda por dia)
export const COLORS_12 = [
  ...COLORS,
  { key: 'brown', name: { pt: 'MARROM', en: 'BROWN', es: 'MARRÓN' }, hex: '#73421c' },
  { key: 'gray',  name: { pt: 'CINZA',  en: 'GRAY',  es: 'GRIS'   }, hex: '#8a8a8a' },
  { key: 'white', name: { pt: 'BRANCO', en: 'WHITE', es: 'BLANCO' }, hex: '#ffffff' },
  { key: 'black', name: { pt: 'PRETO',  en: 'BLACK', es: 'NEGRO'  }, hex: '#1a1a1a' },
];
// quantidade de quadrados por modo — só o Mosaico foge do padrão (SQUARES=4);
// squaresFor() é o jeito seguro de ler isso (cai pro padrão se o modo não
// estiver aqui), em vez de espalhar "MODE_SQUARES[m] || SQUARES" pelo código
export const MODE_SQUARES = { mosaic: 9 };
export const squaresFor = m => MODE_SQUARES[m] || SQUARES;
export const SHAPES = [
  { name: { pt: 'CÍRCULO',    en: 'CIRCLE',   es: 'CÍRCULO'   }, shapeClass: 'shape-circle' },
  { name: { pt: 'QUADRADO',   en: 'SQUARE',   es: 'CUADRADO'  }, shapeClass: 'shape-square-shape' },
  { name: { pt: 'TRIÂNGULO',  en: 'TRIANGLE', es: 'TRIÁNGULO' }, shapeClass: 'shape-triangle' },
  { name: { pt: 'LOSANGO',    en: 'DIAMOND',  es: 'ROMBO'     }, shapeClass: 'shape-diamond' },
  { name: { pt: 'ESTRELA',    en: 'STAR',     es: 'ESTRELLA'  }, shapeClass: 'shape-star' },
  { name: { pt: 'CRUZ',       en: 'CROSS',    es: 'CRUZ'      }, shapeClass: 'shape-cross' },
];
export const poolFor = m => (m === 'shapes' || m === 'shapes-reverse') ? SHAPES : (m === 'mosaic') ? COLORS_12 : COLORS;
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
export const PLAYED_FIELD = { classic: 'playedClassic', reverse: 'playedReverse', shapes: 'playedShapes', 'shapes-reverse': 'playedShapesReverse', trio: 'playedTrio', caos: 'playedCaos', mosaic: 'playedMosaic' };
export const ALL_MODES = ['classic', 'reverse', 'shapes', 'shapes-reverse', 'trio', 'caos', 'mosaic'];
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
  // amanhã (01/08/2026) reaproveita a MESMA paleta de 12 cores de hoje, a
  // pedido — só a paleta muda de dia (dailyLocalDateStr), o modo forçado
  // pra Clássico é o DAILY_MODE_OVERRIDE (ver game-teste.js)
  '2026-08-01': [
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
  // 04/08/2026: paleta "tons neutros" a pedido — branco/preto/cinza sólidos
  // + zebra (listrado), que usa "pattern" em vez de "hex" pro fundo real do
  // quadrado (ver bg.pattern || bg.hex em daily-challenge.js/replay.js —
  // já suportado há tempo, só nunca tinha sido usado). "hex" da zebra ainda
  // precisa existir pra dar cor ao brilho (box-shadow), que não entende
  // gradiente — branco escolhido por ser a listra mais clara/visível.
  '2026-08-04': [
    { key: 'white',  name: { pt: 'BRANCO', en: 'WHITE', es: 'BLANCO' }, hex: '#ffffff' },
    { key: 'black',  name: { pt: 'PRETO',  en: 'BLACK', es: 'NEGRO'  }, hex: '#1a1a1a' },
    { key: 'gray',   name: { pt: 'CINZA',  en: 'GRAY',  es: 'GRIS'   }, hex: '#8a8a8a' },
    {
      key: 'zebra',
      name: { pt: 'ZEBRA', en: 'ZEBRA', es: 'CEBRA' },
      hex: '#ffffff',
      pattern: 'repeating-linear-gradient(45deg, #1a1a1a 0px, #1a1a1a 10px, #ffffff 10px, #ffffff 20px)',
    },
  ],
  // 08/08/2026: reaproveita a MESMA paleta de 12 cores de 31/07 e 01/08 a
  // pedido — sem a zebra dessa vez (diferente de 04/08, que era só tons
  // neutros). Sem DAILY_MODE_OVERRIDE correspondente em
  // js/daily-challenge.js: o sorteio normal (DAILY_ROTATION_MODES) já cai
  // em Reverso nesse dia sozinho, então não precisa forçar.
  '2026-08-08': [
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
// DAILY_SHAPES_OVERRIDE: mesma ideia do DAILY_PALETTE_OVERRIDE (acima), só
// que pro pool de FORMAS do desafio diário -- força um dia específico a usar
// outro conjunto de "formas" em vez do SHAPES padrão, sem mexer no modo
// Formas do jogo livre (ver dailyPoolFor em daily-challenge.js).
//
// Cada item tem "glyph" em vez de "shapeClass" com clip-path: os naipes de
// baralho (copas/ouros/espadas/paus) têm curvas complexas demais pra
// aproximar bem com polygon() -- a técnica usada nas 6 formas normais (ver
// .shape-fill no CSS) -- sem arriscar ficar torto. Em vez disso usam o
// glyph Unicode de verdade como conteúdo (♥♦♠♣), preenchido com o mesmo
// gradiente neon via background-clip:text (ver .shape-fill.shape-glyph no
// CSS) -- garantidamente correto (é a fonte do sistema desenhando, não uma
// aproximação nossa), e ainda consistente visualmente com as outras formas.
// shapeClass aqui só serve de identificador único (poolItemId/replay), não
// tem CSS de clip-path correspondente.
export const DAILY_SHAPES_OVERRIDE = {
  '2026-08-02': [
    { name: { pt: 'COPAS',   en: 'HEARTS',   es: 'CORAZONES' }, shapeClass: 'shape-naipe-copas',   glyph: '♥' },
    { name: { pt: 'OUROS',   en: 'DIAMONDS', es: 'DIAMANTES' }, shapeClass: 'shape-naipe-ouros',   glyph: '♦' },
    { name: { pt: 'ESPADAS', en: 'SPADES',   es: 'PICAS'     }, shapeClass: 'shape-naipe-espadas', glyph: '♠' },
    { name: { pt: 'PAUS',    en: 'CLUBS',    es: 'TRÉBOLES'  }, shapeClass: 'shape-naipe-paus',    glyph: '♣' },
  ],
  // 03/08/2026: as 6 formas padrão (mesmas de SHAPES acima) + 3 novas —
  // coração reaproveita a técnica de glyph Unicode de 02/08 (curva complexa
  // demais pra clip-path, mesmo motivo de lá), trapézio e pentágono são
  // simples o bastante pra clip-path normal (ver .shape-fill.shape-trapezoid/
  // .shape-fill.shape-pentagon em style.css/style-teste.css).
  '2026-08-03': [
    { name: { pt: 'CÍRCULO',    en: 'CIRCLE',    es: 'CÍRCULO'   }, shapeClass: 'shape-circle' },
    { name: { pt: 'QUADRADO',   en: 'SQUARE',    es: 'CUADRADO'  }, shapeClass: 'shape-square-shape' },
    { name: { pt: 'TRIÂNGULO',  en: 'TRIANGLE',  es: 'TRIÁNGULO' }, shapeClass: 'shape-triangle' },
    { name: { pt: 'LOSANGO',    en: 'DIAMOND',   es: 'ROMBO'     }, shapeClass: 'shape-diamond' },
    { name: { pt: 'ESTRELA',    en: 'STAR',      es: 'ESTRELLA'  }, shapeClass: 'shape-star' },
    { name: { pt: 'CRUZ',       en: 'CROSS',     es: 'CRUZ'      }, shapeClass: 'shape-cross' },
    { name: { pt: 'CORAÇÃO',    en: 'HEART',     es: 'CORAZÓN'   }, shapeClass: 'shape-heart', glyph: '♥' },
    { name: { pt: 'TRAPÉZIO',   en: 'TRAPEZOID', es: 'TRAPECIO'  }, shapeClass: 'shape-trapezoid' },
    { name: { pt: 'PENTÁGONO',  en: 'PENTAGON',  es: 'PENTÁGONO' }, shapeClass: 'shape-pentagon' },
  ],
  // 07/08/2026: as 6 formas padrão + trapézio/pentágono (sem o coração desta
  // vez) -- ambas já usadas em clip-path normal no dia 03/08, sem glyph.
  '2026-08-07': [
    { name: { pt: 'CÍRCULO',    en: 'CIRCLE',    es: 'CÍRCULO'   }, shapeClass: 'shape-circle' },
    { name: { pt: 'QUADRADO',   en: 'SQUARE',    es: 'CUADRADO'  }, shapeClass: 'shape-square-shape' },
    { name: { pt: 'TRIÂNGULO',  en: 'TRIANGLE',  es: 'TRIÁNGULO' }, shapeClass: 'shape-triangle' },
    { name: { pt: 'LOSANGO',    en: 'DIAMOND',   es: 'ROMBO'     }, shapeClass: 'shape-diamond' },
    { name: { pt: 'ESTRELA',    en: 'STAR',      es: 'ESTRELLA'  }, shapeClass: 'shape-star' },
    { name: { pt: 'CRUZ',       en: 'CROSS',     es: 'CRUZ'      }, shapeClass: 'shape-cross' },
    { name: { pt: 'TRAPÉZIO',   en: 'TRAPEZOID', es: 'TRAPECIO'  }, shapeClass: 'shape-trapezoid' },
    { name: { pt: 'PENTÁGONO',  en: 'PENTAGON',  es: 'PENTÁGONO' }, shapeClass: 'shape-pentagon' },
  ],
};
