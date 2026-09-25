/* Quad Deck musical FX engine
 *
 * Builds and drops are rendered for the music that is playing: the length is a whole number of
 * bars at the leader's exact tempo, rhythmic layers (gates, snare rolls, echoes) sit on its grid,
 * tonal layers are tuned to the detected key, and every sound has a "land" point (the drop) that
 * the scheduler places on a beat, bar or phrase boundary.
 *
 * Sound design follows the usual production recipes: layered risers (detuned supersaw stack with
 * a rising pitch envelope + filtered noise that peaks slightly earlier + air), grid-quantized snare
 * builds that accelerate 1/4 -> 1/8 -> 1/16 -> 1/32, reversed crashes and reverse-reverb swells
 * timed to peak on the downbeat, and three-part impacts (hit, boom, decay) with a key-tuned sub.
 * Every render is loudness-normalised and soft-limited so the FX sit at a consistent level.
 */
'use strict';
const DropFX = (() => {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) || 1; };

  /* ---------------- reverb impulse: pre-delay, early reflections, decay that darkens over time ---------------- */
  function fillIR(b, { sec = 3, pre = 0.02, damp = 0.6, bright = 0.92 } = {}) {
    const sr = b.sampleRate, n = b.length, P = Math.floor(pre * sr);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c); let lp = 0, lp2 = 0;
      for (let i = P; i < n; i++) {
        const t = (i - P) / sr, env = Math.exp(-6.9 * t / sec), a = 0.03 + (bright - 0.03) * Math.exp(-t * damp * 3 / sec);
        lp += ((rnd() * 2 - 1) - lp) * a; lp2 += (lp - lp2) * Math.min(1, a * 1.6);
        d[i] = lp2 * env * (i - P < sr * 0.003 ? (i - P) / (sr * 0.003) : 1);
      }
      for (let k = 0; k < 10; k++) { const i = P + Math.floor((0.003 + rnd() * 0.06) * sr); if (i < n) d[i] += (rnd() - 0.5) * 1.4 * (1 - k / 12); }
    }
    return b;
  }
  const makeIR = (ac, sec, o = {}) => fillIR(ac.createBuffer(2, Math.floor(ac.sampleRate * (sec + (o.pre ?? 0.02))), ac.sampleRate), { sec, ...o });

  /* ---------------- offline render kit ---------------- */
  function kit(oc) {
    const sr = oc.sampleRate, noise = {};
    const X = {
      oc, sr,
      G: (v = 1) => { const g = oc.createGain(); g.gain.value = v; return g; },
      F: (type, f, Q = 0.707, gain = 0) => { const b = oc.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; b.gain.value = gain; return b; },
      O: (type, f) => { const o = oc.createOscillator(); o.type = type; o.frequency.value = f; return o; },
      N: (brown = false) => {
        const k = brown ? 'b' : 'w';
        if (!noise[k]) { const len = Math.floor(sr * 5), b = oc.createBuffer(2, len, sr); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let l = 0; for (let i = 0; i < len; i++) { const w = rnd() * 2 - 1; if (brown) { l = (l + 0.02 * w) / 1.02; d[i] = l * 3.5; } else d[i] = w; } } noise[k] = b; }
        const s = oc.createBufferSource(); s.buffer = noise[k]; s.loop = true; return s;
      },
      pan: v => { const p = oc.createStereoPanner(); p.pan.value = v; return p; },
      chain: (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; },
      /* draw an automation curve: fn(x in 0..1) -> value */
      curve: (param, t0, dur, fn, n = 2048) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = fn(i / (n - 1)); param.setValueCurveAtTime(a, t0, Math.max(0.001, dur)); },
      sweep: (a, b, shape = 1) => x => a * Math.pow(b / a, Math.pow(x, shape)),
      sat: (drive = 1.5) => { const w = oc.createWaveShaper(), n = 4096, c = new Float32Array(n), k = Math.tanh(drive); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(drive * x) / k; } w.curve = c; w.oversample = '4x'; return w; },
      verb: (sec, o) => { const c = oc.createConvolver(); c.buffer = makeIR(oc, sec, o); return c; },
      /* stereo ping-pong delay with damping */
      pingpong: (time, fb = 0.35, damp = 4500) => {
        const inp = X.G(1), out = X.G(1), mono = oc.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.gain.value = 0.7;
        const dl = oc.createDelay(4), dr = oc.createDelay(4), lL = X.F('lowpass', damp), lR = X.F('lowpass', damp), m = oc.createChannelMerger(2), gLR = X.G(fb), gRL = X.G(fb);
        dl.delayTime.value = dr.delayTime.value = time;
        inp.connect(mono); mono.connect(dl); dl.connect(lL); lL.connect(m, 0, 0); lL.connect(gLR); gLR.connect(dr); dr.connect(lR); lR.connect(m, 0, 1); lR.connect(gRL); gRL.connect(dl); m.connect(out);
        return { input: inp, output: out };
      },
      run: (node, t0, t1) => { node.start(Math.max(0, t0)); if (t1 != null) node.stop(t1); },
      /* hard stop of everything at t (the drop): a 4 ms fade, no tail after the downbeat */
      cutAt: (gain, t) => { gain.gain.setValueAtTime(1, Math.max(0, t - 0.004)); gain.gain.linearRampToValueAtTime(0, t); }
    };
    return X;
  }
  async function offline(sec, sr, build) {
    const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(sec * sr)), sr), X = kit(oc), out = X.G(1); out.connect(oc.destination); X.out = out;
    await build(X);
    return oc.startRendering();
  }
  function reverse(buf) { for (let c = 0; c < buf.numberOfChannels; c++) buf.getChannelData(c).reverse(); return buf; }

  /* musical helpers: pitch class 0 = A. Sub root in 38-76 Hz, mid voicing in 150-300 Hz */
  const noteHz = (p, semi, oct) => 55 * Math.pow(2, ((p.root || 0) + semi) / 12) * Math.pow(2, oct);
  const subHz = p => { const f = noteHz(p, 0, 0); return f > 76 ? f / 2 : f; };
  const midHz = p => { const f = noteHz(p, 0, 2); return f > 300 ? f / 2 : f; };
  const third = p => p.minor ? 3 : 4;

  /* ---------------- shared voices ---------------- */
  function supersaw(X, dest, { f, t0, dur, notes = [0, 7, 12], voices = 7, spread = 18, rise = 0, riseShape = 2.4, level = 0.055 }) {
    const sum = X.G(1); sum.connect(dest);
    notes.forEach(n => {
      for (let v = 0; v < voices; v++) {
        const o = X.O('sawtooth', f * Math.pow(2, n / 12)), c = (v - (voices - 1) / 2) / ((voices - 1) / 2 || 1), det = c * spread + (rnd() - 0.5) * 4;
        if (rise) X.curve(o.detune, t0, dur, x => det + rise * Math.pow(x, riseShape), 1024); else o.detune.value = det;
        const g = X.G(level * (1 - Math.abs(c) * 0.25)), pn = X.pan(c * 0.75);
        o.connect(g); g.connect(pn); pn.connect(sum); X.run(o, t0 + rnd() * 0.004, t0 + dur + 0.02);
      }
    });
    return sum;
  }
  function crash(X, dest, t, len = 2.8, level = 1) {
    const g = X.G(0), hp = X.F('highpass', 5200, 0.6), bp = X.F('bandpass', 9000, 0.5), air = X.F('highshelf', 10000, 0.7, 6);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + 0.002); g.gain.setTargetAtTime(0, t + 0.002, len / 5);
    [205.3, 304.4, 369.6, 522.7, 540, 800].forEach((f, i) => { [-1, 1].forEach(s => { const o = X.O('square', f * (1 + s * 0.013) * 2.1), og = X.G(0.018), pn = X.pan(s * 0.5); o.connect(og); og.connect(pn); pn.connect(hp); X.run(o, t, t + len * 1.6); }); });
    const n = X.N(), ng = X.G(0.9), nh = X.F('highpass', 6500); n.connect(nh); nh.connect(ng); ng.connect(hp); X.run(n, t, t + len * 1.6);
    X.chain(hp, bp, air, g); hp.connect(X.G(0.6)).connect(g); g.connect(dest);
  }
  function snare(X, dest, t, { vel = 1, f = 190, decay = 0.16, pan = 0 }) {
    const out = X.G(vel), pn = X.pan(pan); out.connect(pn); pn.connect(dest);
    const o = X.O('triangle', f * 1.5), og = X.G(0); o.frequency.setValueAtTime(f * 1.5, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.02);
    og.gain.setValueAtTime(0.9, t); og.gain.setTargetAtTime(0, t + 0.004, decay * 0.25); o.connect(og); og.connect(out); X.run(o, t, t + decay + 0.05);
    const o2 = X.O('sine', f * 2.4), og2 = X.G(0); og2.gain.setValueAtTime(0.35, t); og2.gain.setTargetAtTime(0, t + 0.003, decay * 0.15); o2.connect(og2); og2.connect(out); X.run(o2, t, t + decay);
    const n = X.N(), bp = X.F('bandpass', 3200, 0.7), hs = X.F('highshelf', 7000, 0.7, 5), ng = X.G(0);
    ng.gain.setValueAtTime(0.85, t); ng.gain.setTargetAtTime(0, t + 0.002, decay * 0.32);
    n.connect(bp); bp.connect(hs); hs.connect(ng); ng.connect(out); n.start(t, rnd() * 3); n.stop(t + decay + 0.1);
  }

  /* ---------------- recipes ----------------
   * kind: build (lands at its end), drop (lands at its start)
   * render(p) -> {buf, land}; p = {bpm, bars, root, minor, sr}
   */
  const R = {};
  R.riser = { name: 'Riser', kind: 'build', lufs: -15, render: p => {
    const T = p.bars * 4 * 60 / p.bpm, spb = 60 / p.bpm;
    return offline(T + 0.01, p.sr, X => {
      const bus = X.G(1), master = X.G(1), sat = X.sat(1.25), hp = X.F('highpass', 110, 0.7);
      X.chain(bus, sat, hp, master, X.out); X.cutAt(master, T);
      const rv = X.verb(3.4, { pre: 0.03, damp: 0.7 }), rs = X.G(0.28), dl = X.pingpong(0.75 * spb, 0.38, 5000), ds = X.G(0.13);
      X.chain(bus, rs, rv, master); X.chain(bus, ds, dl.input); dl.output.connect(master);
      /* tonal layer: supersaw power chord in key, one octave pitch rise, filter opens, tempo-synced gate accelerates */
      const lp1 = X.F('lowpass', 200, 0.6), lp2 = X.F('lowpass', 200, 0.9), amp = X.G(0), gate = X.G(1);
      supersaw(X, lp1, { f: midHz(p), t0: 0, dur: T, rise: 1200, riseShape: 2.4, level: 0.1 });
      [lp1, lp2].forEach(f => X.curve(f.frequency, 0, T, X.sweep(220, 14000, 1.5)));
      X.chain(lp1, lp2, amp, gate, bus);
      X.curve(amp.gain, 0, T, x => 0.05 + 0.95 * Math.pow(x, 1.8));
      const steps = [[0.75, 2], [0.9, 4], [1.01, 8]]; /* from 50 % of the build: 1/8, then 1/16, then 1/32 */
      const n = Math.min(32768, Math.ceil(T * 500)), gc = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = i / (n - 1), t = x * T, st = steps.find(s => x < s[0]); if (x < 0.5) { gc[i] = 1; continue; } const step = spb / st[1], ph = (((t - T) / step) % 1 + 1) % 1, depth = 0.35 + 0.5 * (x - 0.5) * 2; gc[i] = 1 - depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * ph)); }
      gate.gain.setValueCurveAtTime(gc, 0, T);
      /* noise layer: high-passed at 150 Hz and up, resonant peak sweeping, peaks a little before the drop */
      const nz = X.N(), nhp = X.F('highpass', 150, 0.7), npk = X.F('peaking', 600, 1.4, 10), namp = X.G(0);
      X.curve(nhp.frequency, 0, T, X.sweep(150, 2600, 1.3)); X.curve(npk.frequency, 0, T, X.sweep(600, 9500, 1.2));
      X.curve(namp.gain, 0, T, x => 0.42 * Math.pow(x, 1.5) * (x > 0.94 ? 1 - (x - 0.94) * 3 : 1));
      X.chain(nz, nhp, npk, namp, bus); X.run(nz, 0, T + 0.01);
      /* air on top in the last quarter */
      const air = X.N(), ahs = X.F('highpass', 7000, 0.7), aa = X.G(0); X.curve(aa.gain, 0, T, x => 0.25 * Math.pow(x, 4)); X.chain(air, ahs, aa, bus); X.run(air, 0, T + 0.01);
    }).then(buf => ({ buf, land: T }));
  } };

  R.noiserise = { name: 'Noise sweep', kind: 'build', lufs: -16, render: p => {
    const T = p.bars * 4 * 60 / p.bpm, spb = 60 / p.bpm;
    return offline(T + 0.01, p.sr, X => {
      const bus = X.G(1), master = X.G(1); X.chain(bus, X.F('highpass', 140, 0.7), master, X.out); X.cutAt(master, T);
      const rv = X.verb(2.8, { pre: 0.02, damp: 0.5 }); X.chain(bus, X.G(0.25), rv, master);
      const nz = X.N(), hp = X.F('highpass', 200, 0.7), bp1 = X.F('bandpass', 500, 2.2), bp2 = X.F('bandpass', 700, 3), amp = X.G(0);
      X.curve(hp.frequency, 0, T, X.sweep(160, 3500, 1.4)); X.curve(bp1.frequency, 0, T, X.sweep(450, 11000, 1.3)); X.curve(bp2.frequency, 0, T, X.sweep(700, 13000, 1.5));
      nz.connect(hp); hp.connect(bp1); hp.connect(bp2); const mix = X.G(1); bp1.connect(mix); bp2.connect(X.G(0.7)).connect(mix); hp.connect(X.G(0.25)).connect(mix);
      /* jet: a short comb whose delay closes as it rises */
      const comb = X.oc.createDelay(0.05), cg = X.G(0.55); X.curve(comb.delayTime, 0, T, x => 0.009 * Math.pow(0.03, x)); mix.connect(comb); comb.connect(cg); cg.connect(amp); mix.connect(amp);
      X.curve(amp.gain, 0, T, x => 0.9 * Math.pow(x, 1.7)); X.run(nz, 0, T + 0.01);
      /* last bar: 1/16 gate so it lands on the grid */
      const gate = X.G(1); X.chain(amp, gate, bus);
      const L = Math.min(T, 4 * spb), n = Math.ceil(L * 500), gc = new Float32Array(n); for (let i = 0; i < n; i++) { const t = T - L + i / (n - 1) * L, ph = (((t - T) / (spb / 4)) % 1 + 1) % 1; gc[i] = 1 - 0.6 * (i / n) * (ph > 0.5 ? 1 : 0); }
      gate.gain.setValueCurveAtTime(gc, T - L, L);
    }).then(buf => ({ buf, land: T }));
  } };

  R.snareroll = { name: 'Snare build', kind: 'build', lufs: -15, render: p => {
    const spb = 60 / p.bpm, T = p.bars * 4 * spb, fast = p.bpm > 150 ? 4 : 8;
    return offline(T + 0.01, p.sr, X => {
      const bus = X.G(1), hp = X.F('highpass', 120, 0.7), master = X.G(1); X.chain(bus, hp, X.sat(1.2), master, X.out); X.cutAt(master, T);
      X.curve(hp.frequency, 0, T, X.sweep(120, 900, 2));
      const rv = X.verb(1.5, { pre: 0.012, damp: 0.3, bright: 0.97 }), dl = X.pingpong(spb / 4, 0.25, 6000);
      X.chain(bus, X.G(0.22), rv, master); X.chain(bus, X.G(0.07), dl.input); dl.output.connect(master);
      const hits = [];
      for (let j = 0; j < p.bars; j++) { /* j = bars counted back from the drop */
        const per = j === 0 ? fast : j === 1 ? 4 : j === 2 ? 2 : 1, s = T - (j + 1) * 4 * spb;
        for (let k = 0; k < 4 * per; k++) hits.push(s + k * spb / per);
      }
      if (p.bars === 1) { hits.length = 0; for (let k = 0; k < 8; k++) hits.push(k * spb / 4); for (let k = 0; k < 16; k++) hits.push(2 * spb + k * spb / 8); }
      const f = midHz(p) * 0.75;
      hits.sort((a, b) => a - b).forEach((t, i) => { const x = t / T, gap = (hits[i + 1] ?? T) - t;
        snare(X, bus, t, { vel: 0.22 + 0.78 * Math.pow(x, 1.4), f: f * Math.pow(2, Math.pow(x, 2.2)), decay: Math.min(0.2, Math.max(0.05, gap * 1.6)), pan: (i % 2 ? 0.12 : -0.12) * x }); });
      /* quiet noise bed glues the roll */
      const nz = X.N(), nh = X.F('highpass', 2000), na = X.G(0); X.curve(na.gain, 0, T, x => 0.12 * Math.pow(x, 2)); X.chain(nz, nh, na, bus); X.run(nz, 0, T + 0.01);
    }).then(buf => ({ buf, land: T }));
  } };

  R.revcym = { name: 'Reverse crash', kind: 'build', lufs: -16, render: async p => {
    const spb = 60 / p.bpm, L = Math.min(p.bars * 4 * spb, 8 * spb, 3.2);
    const buf = await offline(L, p.sr, X => { const g = X.G(1); g.connect(X.out); crash(X, g, 0, L * 0.95, 1);
      const rv = X.verb(2, { damp: 0.4, bright: 0.96 }); g.connect(X.G(0.3)).connect(rv); rv.connect(X.out); });
    reverse(buf); const n = buf.length, f = Math.min(n, Math.floor(0.05 * p.sr)); for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < f; i++) d[i] *= i / f; for (let i = n - 64; i < n; i++) d[i] *= (n - i) / 64; }
    return { buf, land: L };
  } };

  R.revswell = { name: 'Reverse swell', kind: 'build', lufs: -16, render: async p => {
    const spb = 60 / p.bpm, L = Math.min(p.bars * 4 * spb, 8 * spb, 3);
    const buf = await offline(L, p.sr, X => {
      const src = X.G(1), rv = X.verb(Math.max(1.5, L * 1.1), { pre: 0.005, damp: 0.5, bright: 0.9 });
      const f = midHz(p) * 2, lp = X.F('lowpass', 3500, 0.7), g = X.G(0); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, 0.004); g.gain.setTargetAtTime(0, 0.02, 0.09);
      [0, 7, 12, third(p) + 12, 19].forEach((n, i) => { const o = X.O('sawtooth', f * Math.pow(2, n / 12)); o.detune.value = (rnd() - 0.5) * 12; const og = X.G(0.12), pn = X.pan((i % 2 ? 1 : -1) * 0.4); X.chain(o, og, pn, lp); X.run(o, 0, 0.5); });
      X.chain(lp, g, src); snare(X, src, 0, { vel: 0.6, f: midHz(p) * 0.75, decay: 0.2 });
      X.chain(src, rv, X.out);
    });
    reverse(buf); const n = buf.length; for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = n - 128; i < n; i++) d[i] *= (n - i) / 128; }
    return { buf, land: L };
  } };

  R.impact = { name: 'Impact', kind: 'drop', lufs: -12, duck: true, render: p => {
    const fs = subHz(p);
    return offline(5, p.sr, X => {
      const master = X.G(1); X.chain(master, X.F('highpass', 24, 0.7), X.out);
      const rv = X.verb(4.2, { pre: 0.02, damp: 0.75 }), rs = X.G(0.3); X.chain(rs, rv, master);
      /* hit: bright transient */
      const h = X.N(), hh = X.F('highpass', 2500), hg = X.G(0); hg.gain.setValueAtTime(0.9, 0); hg.gain.setTargetAtTime(0, 0.002, 0.012); X.chain(h, hh, hg, master); hg.connect(rs); X.run(h, 0, 0.12);
      /* punch: 100-300 Hz body so it survives small speakers */
      const pn = X.N(), pb = X.F('bandpass', 180, 0.9), pg = X.G(0); pg.gain.setValueAtTime(1.4, 0); pg.gain.setTargetAtTime(0, 0.005, 0.03); X.chain(pn, pb, pg, master); X.run(pn, 0, 0.3);
      /* boom: pitched kick falling onto the key's root, saturated for harmonics */
      const o = X.O('sine', 230), og = X.G(0), sat = X.sat(1.7); o.frequency.setValueAtTime(230, 0); o.frequency.exponentialRampToValueAtTime(fs * 1.9, 0.03); o.frequency.exponentialRampToValueAtTime(fs, 0.12); o.frequency.linearRampToValueAtTime(fs * 0.93, 2.6);
      og.gain.setValueAtTime(0, 0); og.gain.linearRampToValueAtTime(1, 0.002); og.gain.setTargetAtTime(0, 0.06, 0.75); X.chain(o, og, sat, X.F('lowpass', 1400, 0.6), X.G(0.9), master); X.run(o, 0, 4.5);
      /* decay: crash + darkening rumble into a big room */
      crash(X, rs, 0, 3, 0.9); const cg = X.G(0.28); crash(X, cg, 0, 3, 1); cg.connect(master);
      const r = X.N(true), rl = X.F('lowpass', 1800, 0.8), rg = X.G(0); X.curve(rl.frequency, 0, 3, X.sweep(1800, 120, 0.7)); rg.gain.setValueAtTime(0.7, 0); rg.gain.setTargetAtTime(0, 0.05, 0.9); X.chain(r, rl, rg, master); rg.connect(rs); X.run(r, 0, 4.5);
    }).then(buf => ({ buf, land: 0 }));
  } };

  R.subdrop = { name: 'Sub drop', kind: 'drop', lufs: -13, duck: true, render: p => {
    const spb = 60 / p.bpm, L = Math.min(Math.max(2, p.bars) * 4 * spb / 2, 4 * spb * 2), fs = subHz(p);
    return offline(L + 0.3, p.sr, X => {
      const o = X.O('sine', fs * 2), o2 = X.O('sine', fs * 4), g = X.G(0), g2 = X.G(0.14), sat = X.sat(1.6);
      X.curve(o.frequency, 0, L, X.sweep(fs * 2, fs / 2, 0.8)); X.curve(o2.frequency, 0, L, X.sweep(fs * 4, fs, 0.8));
      X.curve(g.gain, 0, L + 0.25, x => (x < 0.004 ? x / 0.004 : 1) * Math.pow(1 - x, 1.2));
      o.connect(g); o2.connect(g2); g2.connect(g); X.chain(g, sat, X.F('highpass', 18), X.out); X.run(o, 0, L + 0.3); X.run(o2, 0, L + 0.3);
    }).then(buf => ({ buf, land: 0 }));
  } };

  R.downlifter = { name: 'Downlifter', kind: 'drop', lufs: -16, render: p => {
    const spb = 60 / p.bpm, L = Math.min(Math.max(1, p.bars / 2), 2) * 4 * spb;
    return offline(L + 2.5, p.sr, X => {
      const bus = X.G(1), master = X.G(1); X.chain(bus, X.F('highpass', 60), master, X.out);
      const rv = X.verb(3, { pre: 0.02, damp: 0.6 }), dl = X.pingpong(0.75 * spb, 0.4, 3500); X.chain(bus, X.G(0.3), rv, master); X.chain(bus, X.G(0.14), dl.input); dl.output.connect(master);
      const nz = X.N(), lp = X.F('lowpass', 14000, 1.2), na = X.G(0); X.curve(lp.frequency, 0, L, X.sweep(14000, 180, 0.6)); X.curve(na.gain, 0, L, x => 0.8 * Math.pow(1 - x, 1.4)); X.chain(nz, lp, na, bus); X.run(nz, 0, L + 0.05);
      const slp = X.F('lowpass', 9000, 0.7), sa = X.G(0); supersaw(X, slp, { f: midHz(p) * 2, t0: 0, dur: L, voices: 5, rise: -1200, riseShape: 0.6, level: 0.05 });
      X.curve(slp.frequency, 0, L, X.sweep(9000, 300, 0.8)); X.curve(sa.gain, 0, L, x => Math.pow(1 - x, 1.6)); X.chain(slp, sa, bus);
    }).then(buf => ({ buf, land: 0 }));
  } };

  R.crash = { name: 'Crash', kind: 'drop', lufs: -15, render: p => offline(5, p.sr, X => {
    const g = X.G(1), rv = X.verb(2.6, { damp: 0.5, bright: 0.95 }); crash(X, g, 0, 3.2, 1); g.connect(X.out); X.chain(g, X.G(0.3), rv, X.out);
  }).then(buf => ({ buf, land: 0 })) };

  /* =====================================================================================
   * One-shots, also rendered for the music: rhythms on the song's grid (1/16 horn triplets,
   * tempo echoes, siren cycles per beat), pitches snapped to notes of the song's key.
   * q = where it starts while music plays ('8th', 'beat'); deck = works on the playing song.
   * ===================================================================================== */
  const near = (p, target, degs = [0, 7]) => { let best = target, bd = 1e9; for (let o = -3; o < 9; o++) for (const d of degs) { const f = noteHz(p, d, o), dd = Math.abs(Math.log2(f / target)); if (dd < bd) { bd = dd; best = f; } } return best; };
  const room = (X, dest, sec, wet, o) => { const v = X.verb(sec, o), g = X.G(wet); X.chain(g, v, dest); return g; };
  function hornBlast(X, dest, t, d, f, level = 1) {
    const env = X.G(0), sh = X.sat(2.6), f1 = X.F('peaking', 1250, 1.2, 8), f2 = X.F('peaking', 2600, 2, 6), lp = X.F('lowpass', 5200, 0.7), hp = X.F('highpass', 260, 0.7);
    X.chain(sh, f1, f2, lp, hp, env, dest);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(level, t + 0.009); env.gain.setValueAtTime(level, t + d); env.gain.linearRampToValueAtTime(0, t + d + 0.07);
    [[1, -6, 0.5], [1, 5, 0.5], [2, 3, 0.18]].forEach(([m, c, g]) => {
      const o = X.O('sawtooth', f * m), og = X.G(g); o.detune.setValueAtTime(c - 220, t);
      o.detune.setValueAtTime(c - 220, t); o.detune.linearRampToValueAtTime(c, t + 0.045); o.detune.setValueAtTime(c, t + d - 0.03); o.detune.linearRampToValueAtTime(c - 90, t + d + 0.07);
      X.chain(o, og, sh); X.run(o, t, t + d + 0.1);
    });
    const n = X.N(), nb = X.F('bandpass', 2000, 0.8), ng = X.G(0.08); X.chain(n, nb, ng, env); n.start(t, rnd() * 3); n.stop(t + d + 0.1);
  }
  const hornRender = blasts => p => { const spb = 60 / p.bpm, f = near(p, 470, [0, 7]), L = Math.max(...blasts.map(([a, d]) => (a + d) * spb)) + 2.2;
    return offline(L, p.sr, X => { const bus = X.G(1); bus.connect(X.out); bus.connect(room(X, X.out, 1.6, 0.18, { damp: 0.6 }));
      const dl = X.pingpong(0.75 * spb, 0.3, 3000); bus.connect(X.G(0.12)).connect(dl.input); dl.output.connect(X.out);
      blasts.forEach(([a, d]) => hornBlast(X, bus, a * spb, d * spb, f)); }).then(buf => ({ buf, land: 0 })); };
  R.airhorn = { name: 'Air horn', kind: 'shot', q: 'beat', lufs: -14, render: hornRender([[0, 1.6]]) };
  R.horn3 = { name: 'Horn triple', kind: 'shot', q: 'beat', lufs: -14, render: hornRender([[0, 0.17], [0.25, 0.17], [0.5, 0.17], [0.75, 1.5]]) };
  R.foghorn = { name: 'Foghorn', kind: 'shot', q: 'beat', lufs: -15, render: p => { const spb = 60 / p.bpm, f = near(p, 72, [0]), D = 3 * spb;
    return offline(D + 3.2, p.sr, X => { const lp = X.F('lowpass', 480, 1.8), g = X.G(0), sh = X.sat(1.6); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.9, 0.25); g.gain.setValueAtTime(0.9, D); g.gain.linearRampToValueAtTime(0, D + 0.6);
      [[1, -4], [1, 4], [2, 0], [1.5, 2]].forEach(([m, c]) => { const o = X.O('sawtooth', f * m); o.detune.value = c; o.detune.setValueAtTime(c - 60, 0); o.detune.linearRampToValueAtTime(c, 0.3); X.chain(o, X.G(m === 1.5 ? 0.25 : 0.5), lp); X.run(o, 0, D + 0.7); });
      X.chain(lp, sh, g, X.out); g.connect(room(X, X.out, 3, 0.35, { damp: 0.7, pre: 0.05 })); }).then(buf => ({ buf, land: 0 })); } };
  R.dubsiren = { name: 'Dub siren', kind: 'shot', q: 'beat', lufs: -15, render: p => { const spb = 60 / p.bpm, f = near(p, 520, [0, 7]), D = 4 * spb;
    return offline(D + 4 * spb + 0.5, p.sr, X => { const o = X.O('square', f), lp = X.F('lowpass', 2600, 1), g = X.G(0);
      const n = Math.ceil(D * 400), c = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / (n - 1) * D, st = t < D / 2 ? spb / 2 : spb / 4, ph = (t / st) % 1; c[i] = 700 * Math.pow(ph, 0.6); } o.detune.setValueCurveAtTime(c, 0, D);
      g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.5, 0.01); g.gain.setValueAtTime(0.5, D - 0.02); g.gain.linearRampToValueAtTime(0, D);
      X.chain(o, lp, g, X.out); X.run(o, 0, D + 0.05);
      const dl = X.pingpong(0.75 * spb, 0.58, 2200); g.connect(X.G(0.55)).connect(dl.input); const dlp = X.F('lowpass', 2000, 2); X.curve(dlp.frequency, D, 4 * spb, X.sweep(2400, 500, 0.8)); X.chain(dl.output, dlp, X.out);
      g.connect(room(X, X.out, 2, 0.15)); }).then(buf => ({ buf, land: 0 })); } };
  R.wail = { name: 'Wail siren', kind: 'shot', q: 'beat', lufs: -16, render: p => { const spb = 60 / p.bpm, f = near(p, 560, [0]), D = 4 * spb;
    return offline(D + 1.5, p.sr, X => { const o = X.O('sawtooth', f), o2 = X.O('square', f), bp = X.F('bandpass', 1400, 0.5), g = X.G(0), sh = X.sat(1.8);
      const up = x => 1200 * Math.pow(x, 0.7); [o, o2].forEach(os => X.curve(os.detune, 0, D, x => { const ph = (x * 2) % 1; return x * 2 < 2 && ph < 0.5 ? up(ph * 2) : up(1 - (ph - 0.5) * 2); }));
      g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.4, 0.05); g.gain.setValueAtTime(0.4, D - 0.15); g.gain.linearRampToValueAtTime(0, D);
      o.connect(bp); o2.connect(X.G(0.4)).connect(bp); X.chain(bp, sh, g, X.out); X.run(o, 0, D); X.run(o2, 0, D); g.connect(room(X, X.out, 1.8, 0.25)); }).then(buf => ({ buf, land: 0 })); } };
  R.twotone = { name: 'Two-tone siren', kind: 'shot', q: 'beat', lufs: -16, render: p => { const spb = 60 / p.bpm, lo = near(p, 740, [0]), D = 8 * spb;
    return offline(D + 1, p.sr, X => { const o = X.O('square', lo), bp = X.F('bandpass', 1500, 0.6), g = X.G(0);
      for (let k = 0; k < 8; k++) o.frequency.setValueAtTime(lo * (k % 2 ? 1 : Math.pow(2, 5 / 12)), k * spb);
      o.detune.setValueAtTime(0, 5 * spb); o.detune.linearRampToValueAtTime(-110, D); /* it drives away */
      g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.35, 0.02); g.gain.setValueAtTime(0.35, 5 * spb); g.gain.linearRampToValueAtTime(0, D);
      X.chain(o, bp, X.sat(1.5), g, X.out); X.run(o, 0, D); g.connect(room(X, X.out, 1.6, 0.3)); }).then(buf => ({ buf, land: 0 })); } };
  R.whistle = { name: 'Whistle', kind: 'shot', q: 'beat', lufs: -17, render: p => { const spb = 60 / p.bpm, f = near(p, 3000, [0, 7]), pat = [[0, 0.35], [0.5, 0.35], [1, 1.6]];
    return offline(3 * spb + 1.2, p.sr, X => { const g = X.G(0), o = X.O('sine', f), o2 = X.O('sine', f * 2), tr = X.O('square', 34), trg = X.G(0.35), am = X.G(0.65);
      tr.connect(trg); trg.connect(am.gain); X.chain(o, am, g); o2.connect(X.G(0.08)).connect(am); const n = X.N(), nb = X.F('bandpass', f, 3); X.chain(n, nb, X.G(0.15), am);
      g.gain.setValueAtTime(0, 0); pat.forEach(([a, d]) => { const t = a * spb, e = t + d * spb; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3, t + 0.006); g.gain.setValueAtTime(0.3, e); g.gain.linearRampToValueAtTime(0, e + 0.02); o.frequency.setValueAtTime(f * 0.97, t); o.frequency.linearRampToValueAtTime(f, t + 0.03); });
      g.connect(X.out); g.connect(room(X, X.out, 1.2, 0.2)); [o, o2, tr, n].forEach(x => X.run(x, 0, 3 * spb + 0.2)); }).then(buf => ({ buf, land: 0 })); } };

  /* ---- scratches: an "ahh" vowel sung on the key's root, cut with tempo-locked hand moves ---- */
  const vowelCache = new Map();
  function vowel(p) { const k = p.root + '|' + p.sr; if (vowelCache.has(k)) return vowelCache.get(k);
    const f0 = near(p, 175, [0]), pr = offline(0.8, p.sr, X => { const o = X.O('sawtooth', f0), vib = X.O('sine', 5.5), vg = X.G(12), src = X.G(1), out = X.G(0), sum = X.G(1);
      vib.connect(vg); vg.connect(o.detune); o.detune.setValueAtTime(-40, 0); o.detune.linearRampToValueAtTime(0, 0.08); o.detune.setValueAtTime(0, 0.5); o.detune.linearRampToValueAtTime(-150, 0.75);
      X.chain(o, X.F('lowpass', 1800, 0.5), src); const n = X.N(), ng = X.G(0.06); X.chain(n, ng, src);
      [[730, 8, 1], [1090, 10, 0.55], [2440, 14, 0.25], [3400, 14, 0.12]].forEach(([f, q, a]) => { const b = X.F('bandpass', f, q); X.chain(src, b, X.G(a * 3), sum); });
      out.gain.setValueAtTime(0, 0); out.gain.linearRampToValueAtTime(1, 0.02); out.gain.setValueAtTime(1, 0.62); out.gain.linearRampToValueAtTime(0, 0.78);
      X.chain(sum, out, X.out); out.connect(room(X, X.out, 0.6, 0.12, { damp: 0.4 })); [o, vib, n].forEach(x => X.run(x, 0, 0.8)); });
    vowelCache.set(k, pr); return pr; }
  /* read src at a moving position; the playback speed and direction come from the hand move */
  function scrub(chans, sr, len, posAt, gainAt, outSr = sr) { const n = Math.ceil(len * outSr), out = [0, 1].map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) { const t = i / outSr, g = gainAt(t); if (g <= 0) continue; const x = posAt(t) * sr, j = Math.floor(x), f = x - j;
      for (let c = 0; c < 2; c++) { const d = chans[c] || chans[0]; if (j >= 0 && j + 1 < d.length) out[c][i] = (d[j] * (1 - f) + d[j + 1] * f) * g; } }
    return out; }
  const toBuf = (chans, sr) => { const b = new AudioBuffer({ numberOfChannels: 2, length: chans[0].length, sampleRate: sr }); chans.forEach((d, c) => b.copyToChannel(d, c)); return b; };
  const smooth = u => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;
  const fade = (t, a, b, r = 0.004) => Math.min(1, Math.max(0, (t - a) / r), Math.max(0, (b - t) / r));
  function scratch(p, chop) { const spb = 60 / p.bpm, L = 2 * spb, st = spb / 4, A = 0.24, s0 = 0.03;
    return vowel(p).then(v => { const ch = [v.getChannelData(0), v.getChannelData(1)];
      const pos = t => { const k = Math.floor(t / st), u = t / st - k; return s0 + A * (k % 2 ? 1 - smooth(u) : smooth(u)); };
      const gain = t => { const k = Math.floor(t / st), u = t / st - k, e = Math.min(1, (L - t) / 0.01); if (!chop) return e; return (u < 0.55 ? fade(u * st, 0, 0.55 * st, 0.002) : 0) * e; };
      const o = scrub(ch, v.sampleRate, L, pos, gain); /* a little needle noise while the record moves */
      for (let i = 0; i < o[0].length; i++) { const t = i / v.sampleRate, u = t / st % 1, sp = Math.abs(Math.sin(Math.PI * u)); const nz = (rnd() * 2 - 1) * 0.012 * sp * gain(t); o[0][i] += nz; o[1][i] += nz; }
      return { buf: toBuf(o, v.sampleRate), land: 0 }; }); }
  R.baby = { name: 'Baby scratch', kind: 'shot', q: 'beat', lufs: -15, render: p => scratch(p, false) };
  R.chirp = { name: 'Chirp scratch', kind: 'shot', q: 'beat', lufs: -15, render: p => scratch(p, true) };

  /* ---- tricks on the playing song itself: the rendered sound starts from the exact sample the deck
         is playing, the music is muted under it and comes back on the boundary (bar or phrase) ---- */
  function deckRender(p, D, velAt, gainAt) { const s = p.src, sr = s.sr; let x = s.pos; const n = Math.ceil(D * sr), path = new Float64Array(n);
    for (let i = 0; i < n; i++) { path[i] = x; x += velAt(i / sr) * s.rate / sr; }
    const o = scrub(s.chans, sr, D, t => path[Math.min(n - 1, Math.round(t * sr))], gainAt); return Promise.resolve({ buf: toBuf(o, sr), land: 0 }); }
  R.rewind = { name: 'Rewind', kind: 'shot', deck: true, beats: 2, lufs: null, render: p => { const D = 2 * 60 / p.bpm, g = 0.1;
    return deckRender(p, D, t => t < g ? 1 - 2 * t / g : -Math.min(4, 1 + 5 * Math.pow((t - g) / (D - g), 1.5)), t => Math.min(1, (D - t) / (0.3 * D))); } };
  R.tapestop = { name: 'Tape stop', kind: 'shot', deck: true, beats: 2, lufs: null, render: p => { const D = 2 * 60 / p.bpm, S = 0.75 * D;
    return deckRender(p, D, t => t < S ? Math.pow(1 - t / S, 1.3) : 0, t => Math.min(1, Math.max(0, (S - t) / (0.25 * S)))); } };
  R.glitch = { name: 'Glitch', kind: 'shot', deck: true, beats: 1, lufs: null, render: p => { const spb = 60 / p.bpm, s = p.src, segs = [];
    let t0 = 0; [[spb / 4, 2, 1], [spb / 8, 2, 1], [spb / 16, 4, 1.5]].forEach(([len, n, pitch]) => { for (let k = 0; k < n; k++) { segs.push([t0, len, pitch]); t0 += len; } });
    const seg = t => segs.find(([a, l]) => t >= a && t < a + l) || segs[segs.length - 1];
    const o = scrub(s.chans, s.sr, spb, t => { const [a, , pt] = seg(t); return s.pos + (t - a) * s.rate * pt; }, t => { const [a, l] = seg(t); return fade(t, a, a + l, 0.0015); });
    return Promise.resolve({ buf: toBuf(o, s.sr), land: 0 }); } };

  /* ---- hits ---- */
  R.laser = { name: 'Laser', kind: 'shot', q: '8th', lufs: -16, render: p => { const spb = 60 / p.bpm, hi = near(p, 2400, [0, 7]), lo = near(p, 140, [0]);
    return offline(3 * spb / 4 + 1.5, p.sr, X => { const bus = X.G(1); bus.connect(X.out); const dl = X.pingpong(spb / 4, 0.35, 5000); bus.connect(X.G(0.25)).connect(dl.input); dl.output.connect(X.out);
      for (let k = 0; k < 3; k++) { const t = k * spb / 4, c = X.O('sine', hi), m = X.O('sine', hi * 1.5), mg = X.G(hi * 3), g = X.G(0);
        c.frequency.setValueAtTime(hi, t); c.frequency.exponentialRampToValueAtTime(lo, t + 0.2); m.frequency.setValueAtTime(hi * 1.5, t); m.frequency.exponentialRampToValueAtTime(lo * 1.5, t + 0.2);
        mg.gain.setValueAtTime(hi * 3, t); mg.gain.exponentialRampToValueAtTime(lo * 0.5, t + 0.2); X.chain(m, mg, c.frequency); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.4, t + 0.003); g.gain.setTargetAtTime(0, t + 0.05, 0.06);
        X.chain(c, g, X.pan((k - 1) * 0.5), bus); X.run(c, t, t + 0.4); X.run(m, t, t + 0.4); } }).then(buf => ({ buf, land: 0 })); } };
  R.zap = { name: 'Zap', kind: 'shot', q: '8th', lufs: -16, render: p => { const hi = near(p, 1800, [0, 7]), lo = near(p, 90, [0]);
    return offline(0.8, p.sr, X => { const c = X.O('sine', hi), m = X.O('square', hi * 2), mg = X.G(hi * 2), g = X.G(0);
      c.frequency.setValueAtTime(hi, 0); c.frequency.exponentialRampToValueAtTime(lo, 0.14); m.frequency.setValueAtTime(hi * 2, 0); m.frequency.exponentialRampToValueAtTime(lo * 2, 0.14); mg.gain.setTargetAtTime(0, 0, 0.05);
      X.chain(m, mg, c.frequency); g.gain.setValueAtTime(0.5, 0); g.gain.setTargetAtTime(0, 0.03, 0.06); X.chain(c, g, X.out); g.connect(room(X, X.out, 0.8, 0.15));
      const n = X.N(), ng = X.G(0); ng.gain.setValueAtTime(0.4, 0); ng.gain.setTargetAtTime(0, 0, 0.004); X.chain(n, X.F('highpass', 4000), ng, X.out); [c, m, n].forEach(x => X.run(x, 0, 0.6)); }).then(buf => ({ buf, land: 0 })); } };
  function blast(X, dest, t, p, big) { /* crack + body + key-tuned boom */
    const c = X.N(), cg = X.G(0); cg.gain.setValueAtTime(1.2, t); cg.gain.setTargetAtTime(0, t + 0.001, 0.004); X.chain(c, X.F('highpass', 2500), cg, dest); c.start(t, rnd() * 3); c.stop(t + 0.1);
    const b = X.N(), bg = X.G(0); bg.gain.setValueAtTime(big ? 1 : 0.8, t); bg.gain.setTargetAtTime(0, t + 0.005, big ? 0.2 : 0.05); X.chain(b, X.F('bandpass', big ? 400 : 700, 0.7), X.sat(2), bg, dest); b.start(t, rnd() * 3); b.stop(t + (big ? 2 : 0.5));
    const fs = subHz(p), o = X.O('sine', fs * 3), og = X.G(0); o.frequency.setValueAtTime(fs * 3, t); o.frequency.exponentialRampToValueAtTime(fs, t + 0.08); if (big) o.frequency.linearRampToValueAtTime(fs * 0.9, t + 2);
    og.gain.setValueAtTime(0.9, t); og.gain.setTargetAtTime(0, t + 0.02, big ? 0.6 : 0.12); X.chain(o, X.sat(1.6), og, dest); X.run(o, t, t + (big ? 3 : 0.8)); }
  R.gunshot = { name: 'Gunshot', kind: 'shot', q: 'beat', lufs: -14, render: p => { const spb = 60 / p.bpm;
    return offline(3.5, p.sr, X => { const bus = X.G(1); bus.connect(X.out); bus.connect(room(X, X.out, 2.6, 0.4, { pre: 0.01, damp: 0.6 }));
      const dl = X.pingpong(spb, 0.3, 2500); bus.connect(X.G(0.22)).connect(dl.input); dl.output.connect(X.out); blast(X, bus, 0, p, false); }).then(buf => ({ buf, land: 0 })); } };
  function kaboom(X, dest, t, p) { blast(X, dest, t, p, true);
    const r = X.N(true), rl = X.F('lowpass', 1600, 0.7), rg = X.G(0); X.curve(rl.frequency, t, 3.5, X.sweep(1600, 90, 0.6)); rg.gain.setValueAtTime(0, t); rg.gain.linearRampToValueAtTime(1.1, t + 0.02); rg.gain.setTargetAtTime(0, t + 0.1, 1.1);
    X.chain(r, rl, X.sat(1.5), rg, dest); X.run(r, t, t + 5);
    for (let k = 0; k < 40; k++) { const tt = t + 0.05 + Math.pow(rnd(), 2) * 2, n = X.N(), g = X.G(0), v = 0.25 * (1 - (tt - t) / 2.2); g.gain.setValueAtTime(v, tt); g.gain.setTargetAtTime(0, tt, 0.006);
      X.chain(n, X.F('bandpass', 800 + rnd() * 3000, 2), g, X.pan(rnd() * 1.6 - 0.8), dest); n.start(tt, rnd() * 3); n.stop(tt + 0.05); } }
  R.explosion = { name: 'Explosion', kind: 'shot', q: 'beat', lufs: -13, duck: true, render: p => offline(5.5, p.sr, X => { const bus = X.G(1); X.chain(bus, X.F('highpass', 22), X.out); bus.connect(room(X, X.out, 4, 0.35, { damp: 0.75 })); kaboom(X, bus, 0, p); }).then(buf => ({ buf, land: 0 })) };
  R.bomb = { name: 'Bomb drop', kind: 'build', lufs: -14, duck: true, render: p => { const spb = 60 / p.bpm, L = Math.min(p.bars, 2) * 4 * spb, hi = near(p, 1900, [0, 7]), lo = near(p, 420, [0, 7]);
    return offline(L + 5, p.sr, X => { const bus = X.G(1); X.chain(bus, X.F('highpass', 22), X.out); bus.connect(room(X, X.out, 4, 0.3, { damp: 0.75 }));
      const o = X.O('sine', hi), vib = X.O('sine', 6), vg = X.G(18), g = X.G(0); X.curve(o.frequency, 0, L, X.sweep(hi, lo, 1.3)); X.chain(vib, vg, o.detune);
      X.curve(g.gain, 0, L, x => 0.05 + 0.2 * Math.pow(x, 1.4)); g.gain.setValueAtTime(0, L); X.chain(o, g, X.pan(0), bus); bus.connect(room(X, X.out, 1.5, 0.1)); X.run(o, 0, L); X.run(vib, 0, L);
      kaboom(X, bus, L, p); }).then(buf => ({ buf, land: L })); } };
  R.boom808 = { name: '808 boom', kind: 'shot', q: 'beat', lufs: -13, duck: true, render: p => { const fs = subHz(p), spb = 60 / p.bpm;
    return offline(Math.max(1.6, 3 * spb) + 0.3, p.sr, X => { const o = X.O('sine', fs), g = X.G(0), D = Math.max(1.4, 3 * spb);
      o.frequency.setValueAtTime(fs * Math.pow(2, 7 / 12), 0); o.frequency.exponentialRampToValueAtTime(fs, 0.05); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, 0.002); g.gain.setTargetAtTime(0, 0.05, D / 3.5);
      const fo = X.G(1); fo.gain.setValueAtTime(1, D + 0.1); fo.gain.linearRampToValueAtTime(0, D + 0.28); X.chain(o, g, X.sat(1.8), X.F('highpass', 20), fo, X.out); X.run(o, 0, D + 0.3);
      const c = X.N(), cg = X.G(0); cg.gain.setValueAtTime(0.3, 0); cg.gain.setTargetAtTime(0, 0, 0.003); X.chain(c, X.F('highpass', 3000), cg, X.out); X.run(c, 0, 0.05); }).then(buf => ({ buf, land: 0 })); } };
  R.cowbell = { name: 'Cowbell', kind: 'shot', q: '8th', lufs: -17, render: p => { const f = near(p, 560, [0, 7]);
    return offline(0.9, p.sr, X => { const bp = X.F('bandpass', f * 1.9, 1.4), g = X.G(0), g2 = X.G(0);
      [f, f * 1.482].forEach(fr => { const o = X.O('square', fr); o.connect(bp); X.run(o, 0, 0.8); });
      g.gain.setValueAtTime(0.9, 0); g.gain.setTargetAtTime(0, 0.002, 0.012); g2.gain.setValueAtTime(0.35, 0); g2.gain.setTargetAtTime(0, 0.01, 0.12);
      bp.connect(g); bp.connect(g2); const m = X.G(1); g.connect(m); g2.connect(m); X.chain(m, X.F('highpass', 400), X.out); m.connect(room(X, X.out, 0.9, 0.12)); }).then(buf => ({ buf, land: 0 })); } };

  /* ---- crowd: sung "whoo" voices with moving vowels, babble, finger whistles, in a room ---- */
  R.cheer = { name: 'Crowd cheer', kind: 'shot', q: '8th', lufs: -17, render: p => offline(5, p.sr, X => { const bus = X.G(1), env = X.G(0); X.chain(bus, env, X.out); env.connect(room(X, X.out, 1.8, 0.3, { damp: 0.5, pre: 0.03 }));
    env.gain.setValueAtTime(0, 0); env.gain.linearRampToValueAtTime(1, 0.5); env.gain.setValueAtTime(1, 2.8); env.gain.linearRampToValueAtTime(0, 4.8);
    for (let v = 0; v < 26; v++) { const t = rnd() * 0.5, f = (rnd() < 0.5 ? 160 : 260) * (1 + rnd() * 0.6), d = 2 + rnd() * 1.8, o = X.O('sawtooth', f), vib = X.O('sine', 4.5 + rnd() * 2), vg = X.G(20), g = X.G(0);
      o.frequency.setValueAtTime(f, t); o.frequency.linearRampToValueAtTime(f * (1.25 + rnd() * 0.3), t + 0.35); o.frequency.linearRampToValueAtTime(f * (0.9 + rnd() * 0.2), t + d);
      X.chain(vib, vg, o.detune); const f1 = X.F('bandpass', 320, 6), f2 = X.F('bandpass', 850, 8), mix = X.G(1);
      f1.frequency.setValueAtTime(320, t); f1.frequency.linearRampToValueAtTime(700, t + d * 0.6); f2.frequency.setValueAtTime(850, t); f2.frequency.linearRampToValueAtTime(1150, t + d * 0.6);
      o.connect(f1); o.connect(f2); f1.connect(mix); f2.connect(X.G(0.5)).connect(mix);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.25); g.gain.setValueAtTime(0.09, t + d - 0.8); g.gain.linearRampToValueAtTime(0, t + d);
      X.chain(mix, g, X.pan(rnd() * 1.8 - 0.9), bus); X.run(o, t, t + d + 0.05); X.run(vib, t, t + d + 0.05); }
    const bab = X.N(), bf = X.F('bandpass', 1100, 0.9), bg = X.G(0.18), am = X.G(0.6), n = Math.ceil(4.8 * 60), c = new Float32Array(n); let a = 0.5; for (let i = 0; i < n; i++) { a += (rnd() - 0.5) * 0.35; a = Math.min(1, Math.max(0.2, a)); c[i] = a; }
    am.gain.setValueCurveAtTime(c, 0, 4.8); X.chain(bab, bf, am, bg, bus); X.run(bab, 0, 4.9);
    for (let w = 0; w < 2; w++) { const t = 0.3 + rnd() * 1.2, f = 2200 + rnd() * 700, o = X.O('sine', f), g = X.G(0); o.frequency.setValueAtTime(f * 0.85, t); o.frequency.linearRampToValueAtTime(f * 1.1, t + 0.25); o.frequency.linearRampToValueAtTime(f, t + 0.9);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.05); g.gain.setValueAtTime(0.05, t + 0.8); g.gain.linearRampToValueAtTime(0, t + 1); X.chain(o, g, X.pan(rnd() - 0.5), bus); X.run(o, t, t + 1.1); }
  }).then(buf => ({ buf, land: 0 })) };
  /* applause: 30 people clapping at their own pace; each clap is 2-3 quick bursts through its own hand resonance */
  R.applause = { name: 'Applause', kind: 'shot', q: '8th', lufs: -18, render: p => { const sr = p.sr, L = 4.6, n = Math.ceil(L * sr), out = [new Float32Array(n), new Float32Array(n)];
    for (let c = 0; c < 30; c++) { const buf = new Float32Array(n), rate = 3.4 + rnd() * 2.2, start = rnd() * 0.45, stop = 3 + rnd() * 1.3, fc = 900 + rnd() * 1500, pan = rnd() * 1.6 - 0.8;
      for (let t = start; t < stop; t += 1 / rate + (rnd() - 0.5) * 0.03) { const v = 0.5 + rnd() * 0.5, i0 = Math.floor(t * sr), bursts = 2 + (rnd() < 0.5 ? 1 : 0);
        for (let b = 0; b < bursts; b++) { const o = i0 + Math.floor((b * (0.4 + rnd() * 0.8)) * sr / 1000), dec = (0.005 + rnd() * 0.004) * sr; for (let i = 0; i < dec * 5 && o + i < n; i++) buf[o + i] += (rnd() * 2 - 1) * v * Math.exp(-i / dec); } }
      const w = 2 * Math.PI * fc / sr, al = Math.sin(w) / (2 * 1.2), a0 = 1 + al, b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0; let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
      for (let i = 0; i < n; i++) { const x = buf[i], y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; out[0][i] += y * gl; out[1][i] += y * gr; } }
    const dry = toBuf(out, sr); return offline(L, sr, X => { const s = X.oc.createBufferSource(); s.buffer = dry; s.connect(X.out); s.connect(room(X, X.out, 1.5, 0.35, { damp: 0.5, pre: 0.02 })); s.start(0); }).then(buf => ({ buf, land: 0 })); } };

  /* ---------------- loudness: short-term RMS target + soft ceiling ---------------- */
  function loudnorm(buf, targetDb) {
    const sr = buf.sampleRate, W = Math.floor(0.4 * sr), ch = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c)), n = buf.length;
    let best = 0, acc = 0; const sq = i => { let s = 0; for (const d of ch) s += d[i] * d[i]; return s / ch.length; };
    for (let i = 0; i < n; i++) { acc += sq(i); if (i >= W) acc -= sq(i - W); if (i >= W - 1 && acc > best) best = acc; }
    const rms = Math.sqrt(best / Math.min(W, n)) || 1e-9, g = Math.pow(10, targetDb / 20) / rms;
    for (const d of ch) for (let i = 0; i < n; i++) { const x = d[i] * g, a = Math.abs(x); d[i] = a <= 0.8 ? x : Math.sign(x) * (0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19)); }
    return buf;
  }
  function peaks(buf, n) { const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0, out = new Float32Array(n), step = buf.length / n;
    for (let i = 0; i < n; i++) { let m = 0; const a = Math.floor(i * step), b = Math.min(buf.length, Math.floor((i + 1) * step)); for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(c0[j]), Math.abs(c1[j])); out[i] = m; } return out; }

  /* ---------------- render cache (LRU) ---------------- */
  const cache = new Map(), LIMIT = 28;
  const keyOf = (id, p) => [id, p.bpm.toFixed(2), R[id].kind === 'build' || id === 'subdrop' || id === 'downlifter' ? p.bars : 0, p.root, p.minor ? 1 : 0, p.sr].join('|');
  function render(id, p) {
    if (R[id].deck) { seed = (Math.random() * 1e9) | 0; return R[id].render(p).then(r => ({ ...r, bpm: p.bpm, id, peaks: null })); }
    const k = keyOf(id, p);
    if (cache.has(k)) { const v = cache.get(k); cache.delete(k); cache.set(k, v); return v; }
    seed = hash(k);
    const pr = R[id].render(p).then(r => { if (R[id].lufs != null) loudnorm(r.buf, R[id].lufs); return { ...r, bpm: p.bpm, id, peaks: peaks(r.buf, 240) }; });
    cache.set(k, pr); pr.catch(() => cache.delete(k));
    while (cache.size > LIMIT) cache.delete(cache.keys().next().value);
    return pr;
  }
  const KEYS = ['A', 'A♯', 'B', 'C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯'];
  const keyName = k => k ? KEYS[k.root] + (k.minor ? ' minor' : ' major') : '';
  return { RECIPES: R, render, isMusical: id => !!R[id], fillIR, makeIR, loudnorm, peaks, keyName };
})();
