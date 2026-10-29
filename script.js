(() => {
'use strict';


const AudioContextClass = window.AudioContext || window.webkitAudioContext;


if (!AudioContextClass) {
 document.getElementById('app').innerHTML =
   '<p>This browser does not support the Web Audio API.</p>';
 return;
}


const $ = id => document.getElementById(id);
const audioContext = new AudioContextClass();


const noiseBuffer = audioContext.createBuffer(
 1,
 audioContext.sampleRate * 2,
 audioContext.sampleRate
);


{
 const data = noiseBuffer.getChannelData(0);
 for (let i = 0; i < data.length; i++) {
   data[i] = Math.random() * 2 - 1;
 }
}


const masterGain = audioContext.createGain();
masterGain.gain.value = 0.2;


const filter = audioContext.createBiquadFilter();
filter.type = 'allpass';
filter.frequency.value = 5000;
filter.Q.value = 0.7;


const analyser = audioContext.createAnalyser();
analyser.fftSize = 1024;
analyser.smoothingTimeConstant = 0;


masterGain.connect(filter);
filter.connect(analyser);
analyser.connect(audioContext.destination);


const HARMONIC_COUNT = 16;
const harmonicAmplitudes = Array(HARMONIC_COUNT).fill(0);
harmonicAmplitudes[0] = 1;


const envelope = {
 attack: 0.01,
 decay: 0.10,
 sustain: 0.70,
 release: 0.20
};


let sourceMode = 'sine';
let keyboardOctave = 4;
let animationFrameId = null;
let midiAccess = null;
let responseDirty = true;


const activeVoices = new Map();


const KEYBOARD_NOTES = {
 a: {note:0,type:'white'},
 w: {note:1,type:'black'},
 s: {note:2,type:'white'},
 e: {note:3,type:'black'},
 d: {note:4,type:'white'},
 f: {note:5,type:'white'},
 t: {note:6,type:'black'},
 g: {note:7,type:'white'},
 y: {note:8,type:'black'},
 h: {note:9,type:'white'},
 u: {note:10,type:'black'},
 j: {note:11,type:'white'},
 k: {note:12,type:'white'},
 o: {note:13,type:'black'},
 l: {note:14,type:'white'},
 p: {note:15,type:'black'},
 ';': {note:16,type:'white'},
 "'": {note:17,type:'white'}
};


/* =========================================================
  PIANO AND KEYBOARD
  ========================================================= */


const piano = $('piano');
const pianoKeyElements = {};
const blackOffsets = {1:0,3:1,6:3,8:4,10:5};


for (const key in KEYBOARD_NOTES) {
 const info = KEYBOARD_NOTES[key];
 const el = document.createElement('div');


 el.className = 'piano-key ' + info.type;
 el.dataset.key = key;


 const label = document.createElement('div');
 label.className = 'piano-key-label';
 label.textContent = key.toUpperCase();
 el.appendChild(label);


 if (info.type === 'white') {
   piano.appendChild(el);
 } else {
   const octave = Math.floor(info.note / 12);
   const whiteIndex = octave * 7 + blackOffsets[info.note % 12];


   el.style.left = ((whiteIndex + 1) * 48 - 15) + 'px';
   piano.appendChild(el);
 }


 pianoKeyElements[key] = el;
}


function midiToFrequency(midi) {
 return 440 * Math.pow(2, (midi - 69) / 12);
}


function keyToMidi(key) {
 const info = KEYBOARD_NOTES[key];
 return info ? 12 * (keyboardOctave + 1) + info.note : null;
}


function setOctaveDisplay() {
 $('octave-display').textContent =
   'Keyboard: C' + keyboardOctave + '–F' + (keyboardOctave + 1);
}


setOctaveDisplay();


/* =========================================================
  ADSR CONTROLS
  ========================================================= */


function createRangeControl(container, name, property, min, max, step) {
 const wrap = document.createElement('div');
 wrap.className = 'envelope-control';


 const label = document.createElement('label');
 label.textContent = name;


 const slider = document.createElement('input');
 slider.type = 'range';
 slider.min = min;
 slider.max = max;
 slider.step = step;
 slider.value = envelope[property];


 const number = document.createElement('input');
 number.type = 'number';
 number.min = min;
 number.max = max;
 number.step = step;
 number.value = envelope[property];
 number.className = 'envelope-value';


 const update = value => {
   let v = Number(value);


   if (!Number.isFinite(v)) {
     v = envelope[property];
   }


   v = Math.max(Number(min), Math.min(Number(max), v));


   envelope[property] = v;
   slider.value = v;
   number.value = String(v);
 };


 slider.addEventListener('input', () => update(slider.value));
 number.addEventListener('change', () => update(number.value));


 wrap.append(label, slider, number);
 container.appendChild(wrap);
}


createRangeControl($('envelope-controls'), 'Attack (s)', 'attack', 0, 2, 0.01);
createRangeControl($('envelope-controls'), 'Decay (s)', 'decay', 0, 2, 0.01);
createRangeControl($('envelope-controls'), 'Sustain', 'sustain', 0, 1, 0.01);
createRangeControl($('envelope-controls'), 'Release (s)', 'release', 0, 3, 0.01);


/* =========================================================
  HARMONIC SLIDERS
  ========================================================= */


const harmonicControls = [];


for (let i = 0; i < HARMONIC_COUNT; i++) {
 const wrap = document.createElement('div');
 wrap.className = 'harmonic';


 const label = document.createElement('div');
 label.className = 'harmonic-number';
 label.textContent = i + 1;


 const slider = document.createElement('input');
 slider.type = 'range';
 slider.min = 0;
 slider.max = 1;
 slider.step = 0.0001;
 slider.value = harmonicAmplitudes[i];
 slider.setAttribute('aria-label', 'Harmonic ' + (i + 1) + ' amplitude');


 const number = document.createElement('input');
 number.type = 'number';
 number.min = 0;
 number.max = 1;
 number.step = 0.0001;
 number.value = harmonicAmplitudes[i].toFixed(4);
 number.className = 'harmonic-value';


 const update = value => {
   let v = Number(value);


   if (!Number.isFinite(v)) {
     v = harmonicAmplitudes[i];
   }


   v = Math.max(0, Math.min(1, v));


   harmonicAmplitudes[i] = v;
   slider.value = v;
   number.value = v.toFixed(4);


   updateVoiceHarmonic(i, v);
 };


 slider.addEventListener('input', () => update(slider.value));
 number.addEventListener('change', () => update(number.value));


 wrap.append(label, slider, number);
 $('harmonics').appendChild(wrap);


 harmonicControls.push({slider, number});
}


$('reset-harmonics').addEventListener('click', () => {
 harmonicControls.forEach((control, i) => {
   harmonicAmplitudes[i] = 0;
   control.slider.value = 0;
   control.number.value = '0.0000';
   updateVoiceHarmonic(i, 0);
 });
});


/* =========================================================
  MODULATION MODE LOGIC
  ========================================================= */


/*
 The carrier selector is deliberately NOT inside wave-mod-controls.


 mod-controls:
   Entire AM/FM control area.


 carrier-wave:
   Always visible while AM or FM is selected.


 wave-mod-controls:
   Only the second oscillator and its detuning settings.


 adsr-mod-note:
   Explanation shown only when ADSR is the modulation source.
*/


function modulationSource() {
 return $('mod-source').value;
}


function isModulated() {
 return sourceMode === 'am' || sourceMode === 'fm';
}


function detuneRatio() {
 const semitones = Number($('detune-semitones').value);
 const cents = Number($('detune-cents').value);


 return Math.pow(2, (semitones + cents / 100) / 12);
}


function modulatorFrequency(voice) {
 return Math.max(
   0.1,
   Math.min(
     audioContext.sampleRate / 2 - 1,
     voice.baseFreq * detuneRatio()
   )
 );
}


function currentDepth() {
 return Number($('mod-depth').value) / 100;
}


function stopActiveVoices() {
 for (const id of [...activeVoices.keys()]) {
   noteOff(id);
 }
}


function updateModControls() {
 sourceMode = $('source-mode').value;


 const enabled = isModulated();
 const useWave = modulationSource() === 'wave';


 $('mod-controls').hidden = !enabled;


 // This group never contains the carrier selector.
 $('wave-mod-controls').hidden = !enabled || !useWave;


 $('adsr-mod-note').hidden = !enabled || useWave;
}


/*
 Mode changes release existing voices, so new notes use the
 newly selected sound and modulation settings.
*/
$('source-mode').addEventListener('change', () => {
 sourceMode = $('source-mode').value;
 updateModControls();
 stopActiveVoices();
});


$('mod-source').addEventListener('change', () => {
 updateModControls();
 stopActiveVoices();
});


updateModControls();


/* =========================================================
  CONTROL READOUTS AND LIVE PARAMETER UPDATES
  ========================================================= */


function bindOutput(id, outputId, format, apply) {
 const input = $(id);


 const update = () => {
   const value = Number(input.value);
   $(outputId).textContent = format(value);


   if (apply) {
     apply(value);
   }
 };


 input.addEventListener('input', update);
 update();
}


bindOutput(
 'master-volume-slider',
 'master-volume-value',
 value => Math.round(value * 100) + '%',
 value => masterGain.gain.setTargetAtTime(
   value,
   audioContext.currentTime,
   0.004
 )
);


bindOutput(
 'mod-depth',
 'mod-depth-out',
 value => value + '%',
 () => updateActiveModulation()
);


bindOutput(
 'detune-semitones',
 'detune-semitones-out',
 value => value + ' st',
 () => updateActiveModulatorFrequencies()
);


bindOutput(
 'detune-cents',
 'detune-cents-out',
 value => value + ' cents',
 () => updateActiveModulatorFrequencies()
);


/*
 This listener exists independently of the selected modulation source.
 When the user switches back from ADSR to waveform modulation, the
 selected carrier waveform is still the active carrier choice.
*/
$('carrier-wave').addEventListener('change', () => {
 for (const voice of activeVoices.values()) {
   for (const partial of voice.partials) {
     if (partial.carrier && (voice.mode === 'am' || voice.mode === 'fm')) {
       partial.carrier.type = $('carrier-wave').value;
     }
   }
 }
});


$('mod-wave').addEventListener('change', () => {
 for (const voice of activeVoices.values()) {
   for (const partial of voice.partials) {
     if (partial.modulator) {
       partial.modulator.type = $('mod-wave').value;
     }
   }
 }
});


/* =========================================================
  OUTPUT FILTER
  ========================================================= */


function updateFilter() {
 responseDirty = true;


 const type = $('filter-type').value;
 filter.type = type === 'off' ? 'allpass' : type;


 const max = Math.min(20000, audioContext.sampleRate / 2);
 const cutoff = Math.max(
   20,
   Math.min(max, Number($('filter-cutoff').value))
 );


 filter.frequency.setTargetAtTime(
   cutoff,
   audioContext.currentTime,
   0.004
 );


 filter.Q.setTargetAtTime(
   Number($('filter-q').value),
   audioContext.currentTime,
   0.004
 );


 $('filter-cutoff-out').textContent = Math.round(cutoff) + ' Hz';
 ('filter-q').value).toFixed(1);


 if ($('spectrum-toggle').checked) {
   drawSpectrum();
 }
}


$('filter-type').addEventListener('change', updateFilter);
$('filter-cutoff').addEventListener('input', updateFilter);
$('filter-q').addEventListener('input', updateFilter);


/* =========================================================
  AUDIO HELPERS AND ENVELOPES
  ========================================================= */


function resumeAudio() {
 if (audioContext.state === 'suspended') {
   audioContext.resume().catch(() => {});
 }
}


function createOsc(type, frequency) {
 const oscillator = audioContext.createOscillator();
 oscillator.type = type;
 oscillator.frequency.value = Math.max(
   1,
   Math.min(audioContext.sampleRate / 2 - 1, frequency)
 );
 return oscillator;
}


function createGain(value = 1) {
 const gain = audioContext.createGain();
 gain.gain.value = value;
 return gain;
}


function scheduleADSR(param, velocity, now) {
 const attackEnd = now + Math.max(0.001, envelope.attack);
 const decayEnd = attackEnd + Math.max(0.001, envelope.decay);


 param.setValueAtTime(0, now);
 param.linearRampToValueAtTime(velocity, attackEnd);
 param.linearRampToValueAtTime(
   velocity * envelope.sustain,
   decayEnd
 );


 return {attackEnd, decayEnd};
}


/* =========================================================
  BUILD EACH HARMONIC / PARTIAL
  ========================================================= */


function buildPartial(voice, index, amplitude, now) {
 if (amplitude <= 0 || voice.mode === 'noise') {
   return null;
 }


 const partialFrequency = voice.baseFreq * (index + 1);
 const gain = createGain(amplitude);
 gain.connect(voice.voiceGain);


 const partial = {
   index,
   amp: amplitude,
   gain,
   carrier: null,
   modulator: null,
   nodes: [],
   oscillators: [],
   modParam: null,
   modBase: 0,
   mode: voice.mode
 };


 /*
   The carrier waveform is used for AM and FM regardless of whether
   the modulation source is a second oscillator or ADSR.
 */
 const carrierType = isModulated()
   ? $('carrier-wave').value
   : voice.mode;


 const carrier = createOsc(carrierType, partialFrequency);


 partial.carrier = carrier;
 partial.oscillators.push(carrier);
 voice.oscillators.push(carrier);


 const modded = voice.mode === 'am' || voice.mode === 'fm';
 const useWave = modulationSource() === 'wave';
 const depth = currentDepth();


 if (modded && useWave && depth > 0) {
   const modulator = createOsc(
     $('mod-wave').value,
     modulatorFrequency(voice)
   );


   partial.modulator = modulator;
   partial.oscillators.push(modulator);
   voice.oscillators.push(modulator);


   if (voice.mode === 'am') {
     /*
       Unipolar AM:
       output amplitude = carrier * (bias + modulator contribution).
       The modulator is not mixed directly into the output.
     */
     const amGain = createGain(0);
     const depthGain = createGain(depth);


     const bias = audioContext.createConstantSource();
     bias.offset.value = 1 - depth;


     modulator.connect(depthGain);
     depthGain.connect(amGain.gain);
     bias.connect(amGain.gain);


     carrier.connect(amGain);
     amGain.connect(gain);


     bias.start();


     partial.nodes.push(
       {source: bias},
       {gain: depthGain, kind: 'depth'},
       {gain: amGain, kind: 'am'}
     );


     partial.modParam = depthGain.gain;
     partial.modBase = depth;
   } else {
     /*
       FM:
       modulator changes carrier frequency.
     */
     const deviation = createGain(partialFrequency * depth);


     modulator.connect(deviation);
     deviation.connect(carrier.frequency);
     carrier.connect(gain);


     partial.nodes.push({gain: deviation, kind: 'depth'});


     partial.modParam = deviation.gain;
     partial.modBase = partialFrequency * depth;
   }


   modulator.start();
 } else if (modded && !useWave) {
   /*
     ADSR modulation allocates no modulator oscillator.
   */
   if (voice.mode === 'am') {
     const amGain = createGain(0);
     const depthGain = createGain(depth);


     carrier.connect(amGain);
     amGain.connect(depthGain);
     depthGain.connect(gain);


     scheduleADSR(amGain.gain, 1, now);


     partial.nodes.push(
       {gain: amGain, kind: 'adsr-am'},
       {gain: depthGain, kind: 'adsr-am-depth'}
     );


     partial.modParam = depthGain.gain;
     partial.modBase = depth;
   } else {
     const deviation = createGain(0);


     deviation.connect(carrier.frequency);


     scheduleADSR(
       deviation.gain,
       partialFrequency * depth,
       now
     );


     carrier.connect(gain);


     partial.nodes.push({gain: deviation, kind: 'adsr-fm'});


     partial.modParam = deviation.gain;
     partial.modBase = partialFrequency * depth;
   }
 } else {
   carrier.connect(gain);
 }


 carrier.start();
 return partial;
}


/* =========================================================
  NOTE ON / NOTE OFF
  ========================================================= */


function noteOn(id, midi, velocity = 1) {
 if (activeVoices.has(id) || midi == null) {
   return;
 }


 resumeAudio();


 const now = audioContext.currentTime;
 const baseFreq = midiToFrequency(midi);
 const voiceGain = createGain(1);


 const voice = {
   id,
   midi,
   baseFreq,
   voiceGain,
   oscillators: [],
   partials: [],
   mode: sourceMode,
   releaseTimer: null,
   envelopeTimes: null
 };


 /*
   For AM + ADSR, the ADSR shapes each partial's amplitude.
   Avoid applying a second full ADSR to the entire voice.
 */
 if (!(sourceMode === 'am' && modulationSource() === 'adsr')) {
   voice.envelopeTimes = scheduleADSR(
     voiceGain.gain,
     velocity,
     now
   );
 } else {
   voiceGain.gain.setValueAtTime(velocity, now);


   voice.envelopeTimes = {
     attackEnd: now + envelope.attack,
     decayEnd: now + envelope.attack + envelope.decay
   };
 }


 voiceGain.connect(masterGain);


 if (sourceMode === 'noise') {
   const noise = audioContext.createBufferSource();
   noise.buffer = noiseBuffer;
   noise.loop = true;


   const noiseGain = createGain(0.25);


   noise.connect(noiseGain);
   noiseGain.connect(voiceGain);
   noise.start();


   voice.oscillators.push(noise);
 }


 for (let i = 0; i < HARMONIC_COUNT && sourceMode !== 'noise'; i++) {
   if (harmonicAmplitudes[i] <= 0) {
     continue;
   }


   const partial = buildPartial(
     voice,
     i,
     harmonicAmplitudes[i],
     now
   );


   if (partial) {
     voice.partials.push(partial);
   }
 }


 activeVoices.set(id, voice);


 if (pianoKeyElements[id]) {
   pianoKeyElements[id].classList.add('active');
 }


 refreshVisualizerLoop();
}


function noteOff(id) {
 const voice = activeVoices.get(id);


 if (!voice) {
   return;
 }




 const now = audioContext.currentTime;
 const release = Math.max(0.01, envelope.release);
 const end = now + release;


 if (!(voice.mode === 'am' && modulationSource() === 'adsr')) {
   const gain = voice.voiceGain.gain;


   gain.cancelScheduledValues(now);
   gain.setValueAtTime(gain.value, now);
   gain.linearRampToValueAtTime(0, end);
 } else {
   voice.voiceGain.gain.setTargetAtTime(
     0,
     now,
     Math.max(0.005, release / 3)
   );
 }


 for (const partial of voice.partials) {
   for (const node of partial.nodes) {
     if (node.kind === 'adsr-am' || node.kind === 'adsr-fm') {
       const param = node.gain.gain;


       param.cancelScheduledValues(now);
       param.setValueAtTime(param.value, now);
       param.linearRampToValueAtTime(0, end);
     }


     if (node.source) {
       try {
         node.source.stop(end + 0.02);
       } catch (error) {}
     }
   }
 }


 for (const oscillator of voice.oscillators) {
   try {
     oscillator.stop(end + 0.02);
   } catch (error) {}
 }


 activeVoices.delete(id);


 if (pianoKeyElements[id]) {
   pianoKeyElements[id].classList.remove('active');
 }


 setTimeout(() => {
   try {
     voice.voiceGain.disconnect();
   } catch (error) {}
 }, (release + 0.1) * 1000);
}


/* =========================================================
  UPDATE HARMONICS ON ACTIVE VOICES
  ========================================================= */


function updateVoiceHarmonic(index, value) {
 for (const voice of activeVoices.values()) {
   const existing = voice.partials.find(partial => partial.index === index);


   if (existing && value <= 0) {
     for (const oscillator of existing.oscillators) {
       try {
         oscillator.stop();
       } catch (error) {}
     }


     for (const node of existing.nodes) {
       if (node.source) {
         try {
           node.source.stop();
         } catch (error) {}
       }
     }


     try {
       existing.gain.disconnect();
     } catch (error) {}


     voice.partials = voice.partials.filter(partial => partial !== existing);


     voice.oscillators = voice.oscillators.filter(
       oscillator => !existing.oscillators.includes(oscillator)
     );
   } else if (existing && value > 0) {
     existing.amp = value;


     existing.gain.gain.setTargetAtTime(
       value,
       audioContext.currentTime,
       0.003
     );
   } else if (!existing && value > 0) {
     const partial = buildPartial(
       voice,
       index,
       value,
       audioContext.currentTime
     );


     if (partial) {
       voice.partials.push(partial);
     }
   }
 }
}


/* =========================================================
  LIVE MODULATION UPDATES
  ========================================================= */


function updateActiveModulatorFrequencies() {
 for (const voice of activeVoices.values()) {
   for (const partial of voice.partials) {
     if (partial.modulator) {
       partial.modulator.frequency.setTargetAtTime(
         modulatorFrequency(voice),
         audioContext.currentTime,
         0.003
       );
     }
   }
 }
}


function updateActiveModulation() {
 const depth = currentDepth();
 const now = audioContext.currentTime;


 for (const voice of activeVoices.values()) {
   for (const partial of voice.partials) {
     if (partial.modulator && partial.mode === 'am') {
       const depthNode = partial.nodes.find(node => node.kind === 'depth');
       const biasNode = partial.nodes.find(node => node.source);


       if (depthNode) {
         depthNode.gain.gain.setTargetAtTime(depth, now, 0.003);
       }


       if (biasNode) {
         biasNode.source.offset.setTargetAtTime(1 - depth, now, 0.003);
       }
     } else if (partial.modulator && partial.mode === 'fm') {
       if (partial.modParam) {
         partial.modParam.setTargetAtTime(
           voice.baseFreq * (partial.index + 1) * depth,
           now,
           0.003
         );
       }
     } else if (
       !partial.modulator &&
       partial.mode === 'fm' &&
       modulationSource() === 'adsr'
     ) {
       if (partial.modParam) {
         partial.modParam.setTargetAtTime(
           voice.baseFreq * (partial.index + 1) * depth,
           now,
           0.003
         );
       }
     } else if (
       !partial.modulator &&
       partial.mode === 'am' &&
       modulationSource() === 'adsr'
     ) {
       const depthNode = partial.nodes.find(
         node => node.kind === 'adsr-am-depth'
       );


       if (depthNode) {
         depthNode.gain.gain.setTargetAtTime(depth, now, 0.003);
       }
     }
   }
 }
}


/* =========================================================
  COMPUTER KEYBOARD
  ========================================================= */


window.addEventListener('keydown', event => {
 const key = event.key.toLowerCase();


 if (key === 'z' || key === 'x') {
   if (event.repeat) return;


   keyboardOctave = Math.max(
     0,
     Math.min(
       8,
       keyboardOctave + (key === 'z' ? -1 : 1)
     )
   );


   setOctaveDisplay();
   return;
 }


 if (
   !KEYBOARD_NOTES[key] ||
   event.repeat ||
   event.ctrlKey ||
   event.metaKey ||
   event.altKey
 ) {
   return;
 }


 event.preventDefault();
 noteOn(key, keyToMidi(key));
});


window.addEventListener('keyup', event => {
 const key = event.key.toLowerCase();


 if (KEYBOARD_NOTES[key]) {
   event.preventDefault();
   noteOff(key);
 }
});


/* =========================================================
  POINTER / PIANO INPUT
  ========================================================= */


const pointerKeys = new Map();


piano.addEventListener('pointerdown', event => {
 const element = event.target.closest('.piano-key');


 if (!element) return;


 event.preventDefault();


 const id = 'mouse:' + event.pointerId;
 pointerKeys.set(event.pointerId, id);


 noteOn(id, keyToMidi(element.dataset.key));
});


function releasePointer(event) {
 const id = pointerKeys.get(event.pointerId);


 if (id) {
   noteOff(id);
   pointerKeys.delete(event.pointerId);
 }
}


window.addEventListener('pointerup', releasePointer);
window.addEventListener('pointercancel', releasePointer);


window.addEventListener('blur', () => {
 stopActiveVoices();
});


/* =========================================================
  MIDI INPUT
  ========================================================= */


$('midi-connect').addEventListener('click', async () => {
 const status = $('midi-status');


 if (!navigator.requestMIDIAccess) {
   status.textContent =
     'Web MIDI unsupported here; keyboard and piano still work.';
   return;
 }


 try {
   midiAccess = await navigator.requestMIDIAccess();


   const attach = () => {
     for (const input of midiAccess.inputs.values()) {
       input.onmidimessage = onMidiMessage;
     }


     status.textContent = midiAccess.inputs.size
       ? 'MIDI ready: ' + midiAccess.inputs.size + ' input(s)'
       : 'MIDI enabled; no controller detected.';
   };


   midiAccess.onstatechange = attach;
   attach();
 } catch (error) {
   status.textContent =
     'MIDI permission unavailable; keyboard and piano still work.';
 }
});


function onMidiMessage(event) {
 const [statusByte, note, velocity] = event.data;
 const command = statusByte & 0xf0;
 const channel = statusByte & 0x0f;
 const id = 'midi:' + channel + ':' + note;


 if (command === 0x90 && velocity > 0) {
   noteOn(id, note, velocity / 127);
 } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
   noteOff(id);
 }
}


/* =========================================================
  VISUALIZER SETUP
  ========================================================= */


const oscCanvas = $('oscilloscope-canvas');
const specCanvas = $('spectrogram-canvas');
const spectrumCanvas = $('spectrum-canvas');


const oscCtx = oscCanvas.getContext('2d');
const specCtx = specCanvas.getContext('2d');
const spectrumCtx = spectrumCanvas.getContext('2d');


const timeData = new Uint8Array(analyser.fftSize);
const freqData = new Uint8Array(analyser.frequencyBinCount);


const responseFreqs = new Float32Array(512);
const responseMag = new Float32Array(512);
const responsePhase = new Float32Array(512);


function anyVisualizerEnabled() {
 return (
   $('oscilloscope-toggle').checked ||
   $('spectrogram-toggle').checked ||
   $('spectrum-toggle').checked
 );
}


function refreshVisualizerLoop() {
 if (anyVisualizerEnabled() && animationFrameId === null) {
   animationFrameId = requestAnimationFrame(animate);
 }


 if (!anyVisualizerEnabled() && animationFrameId !== null) {
   cancelAnimationFrame(animationFrameId);
   animationFrameId = null;
 }
}


$('oscilloscope-toggle').addEventListener('change', () => {
 ('oscilloscope-toggle').checked;
 refreshVisualizerLoop();
});


$('spectrogram-toggle').addEventListener('change', () => {
 ('spectrogram-toggle').checked;


 if ($('spectrogram-toggle').checked) {
   clearSpectrogram();
 }


 refreshVisualizerLoop();
});


$('spectrum-toggle').addEventListener('change', () => {
 ('spectrum-toggle').checked;


 if ($('spectrum-toggle').checked) {
   drawSpectrum();
 }


 refreshVisualizerLoop();
});


$('log-frequency-toggle').addEventListener('change', clearSpectrogram);
$('log-amplitude-toggle').addEventListener('change', clearSpectrogram);


$('spectrum-log-frequency-toggle').addEventListener('change', () => {
 responseDirty = true;
 drawSpectrum();
});


$('spectrum-log-amplitude-toggle').addEventListener('change', drawSpectrum);


/* =========================================================
  OSCILLOSCOPE
  ========================================================= */


function drawOscilloscope() {
 analyser.getByteTimeDomainData(timeData);


 const width = oscCanvas.width;
 const height = oscCanvas.height;


 oscCtx.fillStyle = '#05070a';
 oscCtx.fillRect(0, 0, width, height);


 oscCtx.strokeStyle = '#343943';
 oscCtx.beginPath();
 oscCtx.moveTo(0, height / 2);
 oscCtx.lineTo(width, height / 2);
 oscCtx.stroke();


 oscCtx.strokeStyle = '#55ff99';
 oscCtx.lineWidth = 2;
 oscCtx.beginPath();


 for (let i = 0; i < timeData.length; i++) {
   const x = i / (timeData.length - 1) * width;
   const y = timeData[i] / 255 * height;


   if (i === 0) {
     oscCtx.moveTo(x, y);
   } else {
     oscCtx.lineTo(x, y);
   }
 }


 oscCtx.stroke();
}


/* =========================================================
  SPECTROGRAM
  ========================================================= */


function colorFor(value) {
 const v = Math.max(0, Math.min(255, value));


 const red = Math.max(0, Math.min(255, (v - 100) * 2.5));
 const green = Math.max(0, Math.min(255, (v - 35) * 1.5));
 const blue = Math.max(0, Math.min(255, 180 - v * 0.6));


 return `rgb({Math.round(green)},${Math.round(blue)})`;
}


function clearSpectrogram() {
 specCtx.fillStyle = '#05070a';
 specCtx.fillRect(0, 0, specCanvas.width, specCanvas.height);
}


function drawSpectrogram() {
 analyser.getByteFrequencyData(freqData);


 const width = specCanvas.width;
 const height = specCanvas.height;
 const nyquist = audioContext.sampleRate / 2;
 const minFrequency = 20;


 specCtx.drawImage(
   specCanvas,
   1, 0, width - 1, height,
   0, 0, width - 1, height
 );


 for (let y = 0; y < height; y++) {
   const position = 1 - y / (height - 1);


   const frequency = $('log-frequency-toggle').checked
     ? minFrequency * Math.pow(nyquist / minFrequency, position)
     : position * nyquist;


   const bin = Math.max(
     0,
     Math.min(
       freqData.length - 1,
       Math.round(frequency / nyquist * (freqData.length - 1))
     )
   );


   const magnitude = freqData[bin] / 255;
   let intensity = magnitude * 255;


   if ($('log-amplitude-toggle').checked) {
     const decibels = magnitude > 0
       ? 20 * Math.log10(magnitude)
       : -Infinity;


     intensity = Math.max(
       0,
       Math.min(255, (decibels + 60) / 60 * 255)
     );
   }


   specCtx.fillStyle = colorFor(intensity);
   specCtx.fillRect(width - 1, y, 1, 1);
 }
}


/* =========================================================
  SPECTRUM AND FILTER RESPONSE
  ========================================================= */


function frequencyToX(frequency, width, logarithmic) {
 const nyquist = audioContext.sampleRate / 2;


 return logarithmic
   ? Math.max(
       0,
       Math.min(
         width,
         Math.log(Math.max(20, frequency) / 20) /
         Math.log(nyquist / 20) * width
       )
     )
   : Math.max(0, Math.min(width, frequency / nyquist * width));
}


function xToFrequency(x, width, logarithmic) {
 const nyquist = audioContext.sampleRate / 2;
 const position = Math.max(0, Math.min(1, x / width));


 return logarithmic
   ? 20 * Math.pow(nyquist / 20, position)
   : position * nyquist;
}


function amplitudeToY(decibels, height, logarithmic) {
 const clipped = Math.max(-60, Math.min(0, decibels));


 return logarithmic
   ? height - ((clipped + 60) / 60) * (height - 22)
   : height - Math.pow(10, clipped / 20) * (height - 22);
}


function calculateFilterResponse() {
 const nyquist = audioContext.sampleRate / 2;
 const logarithmic = $('spectrum-log-frequency-toggle').checked;


 for (let i = 0; i < responseFreqs.length; i++) {
   const position = i / (responseFreqs.length - 1);


   responseFreqs[i] = logarithmic
     ? 20 * Math.pow(nyquist / 20, position)
     : position * nyquist;
 }


 filter.getFrequencyResponse(
   responseFreqs,
   responseMag,
   responsePhase
 );


 responseDirty = false;
}


function drawSpectrum() {
 if (!$('spectrum-toggle').checked) {
   return;
 }


 analyser.getByteFrequencyData(freqData);


 const width = spectrumCanvas.width;
 const height = spectrumCanvas.height;
 const ctx = spectrumCtx;
 const nyquist = audioContext.sampleRate / 2;


 const logFrequency = $('spectrum-log-frequency-toggle').checked;
 const logAmplitude = $('spectrum-log-amplitude-toggle').checked;


 ctx.fillStyle = '#05070a';
 ctx.fillRect(0, 0, width, height);


 ctx.font = '11px Arial';
 ctx.strokeStyle = '#252d3a';
 ctx.fillStyle = '#aab4c4';


 const marks = logFrequency
   ? [20,50,100,200,500,1000,2000,5000,10000,20000]
   : [0,2000,4000,6000,8000,10000,12000,16000,20000];


 for (const frequency of marks) {
   if (frequency > nyquist) continue;


   const x = frequencyToX(frequency, width, logFrequency);


   ctx.beginPath();
   ctx.moveTo(x, 0);
   ctx.lineTo(x, height);
   ctx.stroke();


   const label = frequency >= 1000
     ? (frequency / 1000) + 'k'
     : String(frequency);


   ctx.fillText(label, Math.min(x + 3, width - 30), height - 5);
 }


 for (const decibels of [-60, -45, -30, -15, 0]) {
   const y = amplitudeToY(decibels, height, logAmplitude);


   ctx.strokeStyle = '#252d3a';
   ctx.beginPath();
   ctx.moveTo(0, y);
   ctx.lineTo(width, y);
   ctx.stroke();


   ctx.fillStyle = '#aab4c4';
   ctx.fillText(
     decibels + ' dB',
     3,
     Math.max(11, y - 3)
   );
 }


 /* Actual post-filter output spectrum. */
 ctx.strokeStyle = '#55e6ff';
 ctx.lineWidth = 2;
 ctx.beginPath();


 let started = false;


 for (let i = 0; i < freqData.length; i++) {
   const frequency = i / (freqData.length - 1) * nyquist;


   if (logFrequency && frequency < 20) {
     continue;
   }


   const x = frequencyToX(frequency, width, logFrequency);
   const magnitude = freqData[i] / 255;
   const decibels = magnitude > 0
     ? 20 * Math.log10(magnitude)
     : -60;


   const y = amplitudeToY(decibels, height, logAmplitude);


   if (!started) {
     ctx.moveTo(x, y);
     started = true;
   } else {
     ctx.lineTo(x, y);
   }
 }


 ctx.stroke();


 /* Calculated filter response and draggable cutoff line. */
 if ($('filter-type').value !== 'off') {
   if (responseDirty) {
     calculateFilterResponse();
   }


   ctx.strokeStyle = '#ffb454';
   ctx.lineWidth = 2;
   ctx.beginPath();


   for (let i = 0; i < responseFreqs.length; i++) {
     const frequency = responseFreqs[i];


     if (logFrequency && frequency < 20) {
       continue;
     }


     const x = frequencyToX(frequency, width, logFrequency);


     const decibels = 20 * Math.log10(
       Math.max(1e-6, responseMag[i])
     );


     const y = amplitudeToY(decibels, height, logAmplitude);


     if (i === 0) {
       ctx.moveTo(x, y);
     } else {
       ctx.lineTo(x, y);
     }
   }


   ctx.stroke();


   const cutoff = Number($('filter-cutoff').value);
   const cutoffX = frequencyToX(cutoff, width, logFrequency);


   ctx.strokeStyle = '#f7f7f7';
   ctx.setLineDash([5, 4]);
   ctx.beginPath();
   ctx.moveTo(cutoffX, 0);
   ctx.lineTo(cutoffX, height);
   ctx.stroke();
   ctx.setLineDash([]);


   ctx.fillStyle = '#f7f7f7';
   ctx.fillText(
     'cutoff ' + Math.round(cutoff) + ' Hz',
     Math.min(cutoffX + 5, width - 120),
     15
   );
 }
}


/* Drag the cutoff marker in the spectrum. */


let draggingCutoff = false;


spectrumCanvas.addEventListener('pointerdown', event => {
 if ($('filter-type').value === 'off') {
   return;
 }


 const rect = spectrumCanvas.getBoundingClientRect();


 const x =
   (event.clientX - rect.left) / rect.width * spectrumCanvas.width;


 const cutoffX = frequencyToX(
   Number($('filter-cutoff').value),
   spectrumCanvas.width,
   $('spectrum-log-frequency-toggle').checked
 );


 if (Math.abs(x - cutoffX) < 24) {
   draggingCutoff = true;
   spectrumCanvas.setPointerCapture(event.pointerId);
   setCutoffFromPointer(event);
 }
});


spectrumCanvas.addEventListener('pointermove', event => {
 if (draggingCutoff) {
   setCutoffFromPointer(event);
 }
});


spectrumCanvas.addEventListener('pointerup', () => {
 draggingCutoff = false;
});


spectrumCanvas.addEventListener('pointercancel', () => {
 draggingCutoff = false;
});


function setCutoffFromPointer(event) {
 const rect = spectrumCanvas.getBoundingClientRect();


 const x =
   (event.clientX - rect.left) / rect.width * spectrumCanvas.width;


 const frequency = xToFrequency(
   x,
   spectrumCanvas.width,
   $('spectrum-log-frequency-toggle').checked
 );


 const max = Math.min(20000, audioContext.sampleRate / 2);


 $('filter-cutoff').value = Math.max(20, Math.min(max, frequency));


 updateFilter();
}


/* =========================================================
  VISUALIZER ANIMATION LOOP
  ========================================================= */


function animate() {
 animationFrameId = null;


 if (!anyVisualizerEnabled()) {
   return;
 }


 if ($('oscilloscope-toggle').checked) {
   drawOscilloscope();
 }


 if ($('spectrogram-toggle').checked) {
   drawSpectrogram();
 }


 if ($('spectrum-toggle').checked) {
   drawSpectrum();
 }


 if (anyVisualizerEnabled()) {
   animationFrameId = requestAnimationFrame(animate);
 }
}


/* Initial filter setup and spectrum display. */
updateFilter();
refreshVisualizerLoop();


})();