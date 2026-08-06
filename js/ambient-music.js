// música ambiente de fundo — só teste.html por enquanto (ver script no fim
// de teste.html, que é quem importa/liga isso e também decide QUANDO pausa/
// retoma — pausa ao entrar em #game-screen, retoma em qualquer outra tela;
// index.html não importa este arquivo). 100% sintetizada via Web Audio
// (mesmo padrão do resto dos sons do jogo, ver "sons (Web Audio, sem
// arquivos)" em bootstrap.js) — sem nenhum arquivo de áudio, então sem
// risco nenhum de direito autoral: cada nota é gerada na hora por
// osciladores, não uma gravação de terceiro.
//
// Grade rítmica de verdade (BPM fixo) em vez da versão anterior (acordes
// soltos sem pulso): PAD segura a harmonia, um PULSO DE BAIXO marca o tempo
// a cada 2 batidas e um ARPEJO cruzado (contratempo) corre por cima —
// isso que dá a sensação "animada" que faltava na v1 (só pad + nota solta
// de vez em quando). Progressão C-G-Am-F (I-V-vi-IV), a mesma fórmula
// "animada"/anthemic de synthwave e pop em geral.
import { audioContext, isMuted } from './utils.js';

const BPM = 128;
const BEAT_SEC = 60 / BPM;
const BEATS_PER_CHORD = 8; // 2 compassos (4/4) por acorde
const CHORDS = [
  [261.63, 329.63, 392.00], // C  (C4 E4 G4)
  [196.00, 246.94, 293.66], // G  (G3 B3 D4)
  [220.00, 261.63, 329.63], // Am (A3 C4 E4)
  [174.61, 220.00, 261.63], // F  (F3 A3 C4)
];
// índice dentro do acorde (0=raiz,1=terça,2=quinta) que o arpejo visita a
// cada batida — raiz-terça-quinta-terça repetido dá aquele "bounce" simples
const ARP_PATTERN = [0, 1, 2, 1];

const PAD_PEAK_GAIN = 0.026;  // por oscilador (3 por nota) — ver playPadChord
const BASS_PEAK_GAIN = 0.07;
const ARP_PEAK_GAIN = 0.05;
const GAIN_RAMP_SEC = 0.15;   // rampa de volume ao mutar/pausar/retomar — evita estalo
const SCHEDULE_LOOKAHEAD_SEC = 1;
const SCHEDULE_INTERVAL_MS = 200;

let started = false;
let stopped = true; // true até o scheduler realmente começar a rodar — ver startAmbientMusic/applyPauseState
let masterGain = null;
let beatIndex = 0;
let nextBeatAt = 0;
// motivos independentes de pausa (partida em andamento, aba em 2º plano —
// ver 'match'/'hidden' no fim de teste.html): um Set, não um bool só, PORQUE
// os dois podem se sobrepor (ex.: trocar de aba NO MEIO de uma partida) — se
// fosse um bool só, tirar QUALQUER um dos dois motivos religava a música
// mesmo com o outro ainda valendo (era exatamente esse o bug: tocar durante
// a partida assim que a aba ficava em primeiro plano de novo). Só toca de
// verdade quando o Set está vazio.
const pauseReasons = new Set();

function ensureMasterGain() {
  if (masterGain) return masterGain;
  const ctx = audioContext();
  masterGain = ctx.createGain();
  masterGain.gain.value = isMuted() ? 0 : 1;
  masterGain.connect(ctx.destination);
  return masterGain;
}

function rampGainTo(target) {
  if (!masterGain) return;
  const ctx = audioContext();
  masterGain.gain.linearRampToValueAtTime(target, ctx.currentTime + GAIN_RAMP_SEC);
}

// 3 osciladores por nota (afinação levemente diferente cada um) somados no
// mesmo envelope = timbre "coral", mais quente que um oscilador só
function playPadChord(chord, startTime, beats) {
  const ctx = audioContext();
  const duration = beats * BEAT_SEC;
  chord.forEach((freq) => {
    [0, -6, 6].forEach((detune) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(PAD_PEAK_GAIN, startTime + 0.3); // ataque rápido, não mais 1.5s — entra na hora
      gain.gain.linearRampToValueAtTime(0, startTime + duration);
      osc.connect(gain); gain.connect(masterGain);
      osc.start(startTime); osc.stop(startTime + duration + 0.1);
    });
  });
}

// pulso curto e percussivo na fundamental (1 oitava abaixo do pad) — o que
// dá a sensação de "batida" marcando o tempo
function playBassPulse(freq, startTime) {
  const ctx = audioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq / 2;
  gain.gain.setValueAtTime(BASS_PEAK_GAIN, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + BEAT_SEC * 1.6);
  osc.connect(gain); gain.connect(masterGain);
  osc.start(startTime); osc.stop(startTime + BEAT_SEC * 1.7);
}

function playArpNote(freq, startTime) {
  const ctx = audioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(ARP_PEAK_GAIN, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + BEAT_SEC * 0.9);
  osc.connect(gain); gain.connect(masterGain);
  osc.start(startTime); osc.stop(startTime + BEAT_SEC);
}

// o mute geral do jogo (isMuted()/toggleMute em bootstrap.js) não é reativo
// (é só uma variável), então precisa ficar checando aqui a cada ciclo do
// scheduler pra reagir ao vivo enquanto a música está tocando de verdade
// (pause/resumeAmbientMusic tratam o próprio volume na hora, não dependem
// disso — ver mais abaixo)
function syncMuteState() {
  if (isMuted() && masterGain.gain.value !== 0) rampGainTo(0);
  else if (!isMuted() && !stopped && masterGain.gain.value !== 1) rampGainTo(1);
}

function scheduler() {
  if (stopped) return;
  const ctx = audioContext();
  const now = ctx.currentTime;
  syncMuteState();

  while (nextBeatAt < now + SCHEDULE_LOOKAHEAD_SEC) {
    const chordIdx = Math.floor(beatIndex / BEATS_PER_CHORD) % CHORDS.length;
    const beatInChord = beatIndex % BEATS_PER_CHORD;
    const chord = CHORDS[chordIdx];

    if (beatInChord === 0) playPadChord(chord, nextBeatAt, BEATS_PER_CHORD);
    if (beatInChord % 2 === 0) playBassPulse(chord[0], nextBeatAt);
    // contratempo (meia batida depois） + 1 oitava acima do pad — separa o
    // arpejo do resto texturalmente, em vez de tocar em cima do pulso
    const arpFreq = chord[ARP_PATTERN[beatIndex % ARP_PATTERN.length] % chord.length] * 2;
    playArpNote(arpFreq, nextBeatAt + BEAT_SEC / 2);

    nextBeatAt += BEAT_SEC;
    beatIndex++;
  }
  setTimeout(scheduler, SCHEDULE_INTERVAL_MS);
}

// decide se TOCA (pauseReasons vazio) ou PAUSA (qualquer motivo presente) e
// aplica de verdade: corta/religa o ganho na hora (rampa de 0.15s, não
// espera as notas já agendadas acabarem sozinhas — senão a música ainda
// tocaria por alguns segundos depois da partida já ter começado) e, ao
// religar, RECOMEÇA a grade de tempo no instante atual em vez de tentar
// "recuperar o atraso" tocando de uma vez tudo que passou enquanto esteve
// pausado
function applyPauseState() {
  const shouldPlay = pauseReasons.size === 0;
  if (shouldPlay) {
    if (!isMuted()) rampGainTo(1);
    if (stopped) {
      stopped = false;
      nextBeatAt = audioContext().currentTime;
      scheduler();
    }
  } else {
    stopped = true;
    rampGainTo(0);
  }
}

// chamar de dentro de um gesto do usuário (clique/toque) — navegador não
// deixa tocar áudio sozinho antes disso; ver listener 'pointerdown'/
// 'keydown' com {once:true} no fim do teste.html. Passa por applyPauseState
// em vez de simplesmente ligar o scheduler — se a aba já começou escondida
// (pauseReasons já tem 'hidden' antes do primeiro gesto — raro, mas
// possível), nasce pausada certo, em vez de tocar um instante e cortar.
export function startAmbientMusic() {
  if (started) return;
  started = true;
  ensureMasterGain();
  beatIndex = 0;
  applyPauseState();
}

// reason: string livre ('match', 'hidden', ...) — cada motivo só cancela a
// SI PRÓPRIO; a música só volta quando NENHUM motivo de pausa restar.
export function pauseAmbientMusic(reason = 'default') {
  pauseReasons.add(reason);
  if (started) applyPauseState();
}
export function resumeAmbientMusic(reason = 'default') {
  if (!started) return;
  pauseReasons.delete(reason);
  applyPauseState();
}
