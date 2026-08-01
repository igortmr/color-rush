// ponto de entrada carregado por index.html (produção) — espelha
// js/main-teste.js linha por linha de propósito: os dois carregam
// exatamente os mesmos módulos de domínio via bootstrap.js, então
// teste.html e index.html sempre rodam o mesmo código (ver P15 no plano
// de refatoração). Única exceção deliberada: main-teste.js seta
// window.IS_TESTE = true antes do import — aqui fica implicitamente
// undefined/false (ver comentário lá, e uso em ranking-cache.js/
// ranking.js/daily-ranking.js pra esconder admin só em produção).
import './bootstrap.js';
