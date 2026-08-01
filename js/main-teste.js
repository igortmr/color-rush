// ponto de entrada carregado por teste.html — bootstrap.js importa (direto
// ou em cadeia) todos os módulos de domínio do jogo; este arquivo em si fica
// deliberadamente vazio além do import, pra poder ser espelhado 1:1 por
// js/main.js quando a produção (index.html/game.js) for cortada pra cá
// também (ver P15 no plano de refatoração).
//
// window.IS_TESTE = true é a ÚNICA diferença deliberada em relação a
// main.js: alguns módulos de domínio (ranking-cache.js, ranking.js,
// daily-ranking.js) são compartilhados 1:1 entre index.html e teste.html
// (ao contrário do CSS, que tem arquivo -teste separado), mas precisam
// saber se estão em produção pra esconder contas admin do ranking (em
// teste.html o admin aparece de propósito, pra dar pra testar/depurar com
// a própria conta admin). Setado ANTES do import: os top-levels de
// ranking-cache.js etc. só rodam de fato dentro de funções chamadas depois
// (ex.: abrir a tela de ranking), nunca no carregamento do módulo em si,
// então a ordem aqui não é um problema de timing.
window.IS_TESTE = true;
import './bootstrap.js';
