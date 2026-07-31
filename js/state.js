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
};
