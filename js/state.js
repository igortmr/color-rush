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
};
