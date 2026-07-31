import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import {
  initializeAppCheck, ReCaptchaV3Provider
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js';
import { state } from './state.js';

const firebaseConfig = {
  apiKey: "AIzaSyAQUvnXszefkF1gQzQCdf_C21FNmJc7YLo",
  authDomain: "auth.colorrush.com.br",
  projectId: "color-rush-474ee",
  storageBucket: "color-rush-474ee.firebasestorage.app",
  messagingSenderId: "988545815222",
  appId: "1:988545815222:web:f0cae8432b04550ca60c17"
};

export const app = initializeApp(firebaseConfig);

// App Check: prova pro backend que a chamada vem mesmo do site oficial, não
// de um script externo batendo direto na API. Preencha com a site key
// gerada em Firebase Console > App Check > reCAPTCHA v3. Enquanto ficar com
// o valor de exemplo, isso fica desligado (não faz nada, não quebra nada).
// Só ative "Enforce" nas Cloud Functions DEPOIS de confirmar no Console que
// as chamadas estão chegando "verified" — senão o jogo para pra todo mundo.
const APP_CHECK_SITE_KEY = '6Lfa3GAtAAAAABb7d8QcGR41xZ8gmhoKbQS1elkd';
if (APP_CHECK_SITE_KEY && APP_CHECK_SITE_KEY !== 'COLOQUE_SUA_SITE_KEY_AQUI') {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  } catch {}
}

export const auth = getAuth(app);
// localStorage em vez de deixar o Firebase escolher sozinho (IndexedDB por
// padrão) — mais previsível entre navegadores; sem isso alguns fluxos de
// sessão já se mostraram frágeis em Safari/Chrome iOS.
setPersistence(auth, browserLocalPersistence).catch(() => {});
export const db = getFirestore(app);
export const functions = getFunctions(app);
// contador de chamadas ao servidor em andamento — o travamento global de
// clique (ver js/nav.js) usa isso pra travar QUALQUER clique novo enquanto uma
// chamada ainda não recebeu resposta do servidor (em vez de só um tempo fixo
// — ver o comentário no nav.js pra entender por quê: clicar duas vezes rápido
// no "resgatar" da caixa de entrada, por exemplo, já chegou a resgatar o
// mesmo prêmio duas vezes). touchActivity fica de fora de propósito: é um
// "batimento" de presença automático, não vem de clique do usuário, não deve
// travar nada.
export function callable(name) {
  const fn = httpsCallable(functions, name);
  return (...args) => {
    state.pendingServerCalls++;
    return fn(...args).finally(() => { state.pendingServerCalls--; });
  };
}
