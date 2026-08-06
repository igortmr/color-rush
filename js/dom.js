export const $ = id => document.getElementById(id);

// feedback visual de "carregando" pra botões que disparam uma ação
// assíncrona (function/Firestore) sem nenhuma outra mudança na tela
// enquanto espera — sem isso, numa conexão lenta o botão fica clicável e
// parado, parecendo travado. Troca o conteúdo do botão por um spinner
// (preservando largura/altura pra não pular o layout) e trava novos
// cliques até a promise terminar; sempre restaura o conteúdo original,
// mesmo se `fn` rejeitar (quem chamou continua tratando o erro normalmente).
// Exposta em window pra poder ser usada direto de onclick="" inline (ex.:
// onclick="withBtnLoading(this, () => minhaAcao())"), não só de módulos.
export function withBtnLoading(btn, fn) {
  if (!btn) return fn();
  if (btn.dataset.btnLoading === '1') return; // já em andamento, ignora clique duplicado
  const origHtml = btn.innerHTML;
  const rect = btn.getBoundingClientRect();
  btn.dataset.btnLoading = '1';
  btn.disabled = true;
  btn.classList.add('btn-loading');
  btn.style.minWidth = rect.width + 'px';
  btn.style.minHeight = rect.height + 'px';
  btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>';
  const restore = () => {
    btn.innerHTML = origHtml;
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    btn.style.minWidth = '';
    btn.style.minHeight = '';
    delete btn.dataset.btnLoading;
  };
  let result;
  try {
    result = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (result && typeof result.finally === 'function') {
    result.finally(restore);
  } else {
    restore();
  }
  return result;
}
window.withBtnLoading = withBtnLoading;
