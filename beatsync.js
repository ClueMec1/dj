/* Quad Deck beat engine (v3)
 *
 *  Layer 1  Offline onset analysis (Web Worker): zero-phase 20-150 Hz kick band, STFT with
 *           rectified complex-domain + spectral-flux onset functions, peak picking, then
 *           sample-level transient timing (max-slope tangent, parabolic sub-sample refinement).
 *  Layer 2  Tempo: onset-function autocorrelation and inter-onset-interval histogram,
 *           cross-validated; dynamic-programming beat tracking; weighted least-squares
 *           grid fit for fractional BPM; Viterbi (HMM) downbeat decoding; 4-bar phrase offset.
 *  Layer 3  Live verification (AudioWorklet): a causal kick detector, calibrated offline
 *           against the same track, checks the grid while the track plays and trims it.
 *  Layer 4  Sync control: tempo from the leader's beat rate, PI phase controller with
 *           bounded micro pitch-bend, sample-accurate quantized jumps for large errors.
 *
 *  Shared by index.html through the global `BeatSync`.
 */
'use strict';
const BeatSync = (() => {
  const VERSION = 4;

  /* ------------------------------------------------------------------------------------
   * Causal kick detector. The same source runs in the AudioWorklet (live) and offline
   * (to measure this detector's delay on each track, so live residuals are unbiased).
   * ---------------------------------------------------------------------------------- */
  function kickDetectorFactory() {
    return function KickDetector(sr) {
      const bq = (hp, f, Q) => {
        const w = 2 * Math.PI * f / sr, c = Math.cos(w), a = Math.sin(w) / (2 * Q), a0 = 1 + a;
        const b0 = hp ? (1 + c) / 2 : (1 - c) / 2, b1 = hp ? -(1 + c) : 1 - c;
        return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: -2 * c / a0, a2: (1 - a) / a0, z1: 0, z2: 0 };
      };
      const run = (f, x) => { const y = f.b0 * x + f.z1; f.z1 = f.b1 * x - f.a1 * y + f.z2; f.z2 = f.b2 * x - f.a2 * y; return y; };
      const F = [bq(true, 30, 0.7071), bq(false, 150, 0.7071), bq(false, 150, 0.7071)];
      const aE = 1 - Math.exp(-1 / (0.004 * sr)), aS = 1 - Math.exp(-1 / (1.5 * sr));
      const D = Math.max(2, Math.round(0.012 * sr)), ring = new Float64Array(D);
      const REFR = Math.round(0.11 * sr), WIN = Math.round(0.02 * sr), TH = 1.2;
      let ri = 0, env = 0, slow = 1e-9, prevD = 0, lastOn = -1e12, cand = null;
      return {
        /* x: one mono sample, n: its absolute sample index. Returns {i, s} or null. */
        push(x, n) {
          const y = run(F[2], run(F[1], run(F[0], x)));
          env += (y * y - env) * aE; slow += (env - slow) * aS;
          const old = ring[ri]; ring[ri] = env; ri = ri + 1 === D ? 0 : ri + 1;
          const d = Math.log((env + 1e-12) / (old + 1e-12));
          let out = null;
          if (cand) {
            if (d > cand.y0) { cand.ym = prevD; cand.y0 = d; cand.n = n; cand.yp = null; }
            else if (cand.yp === null) cand.yp = d;
            if (n - cand.n >= WIN || d < cand.y0 * 0.4) {
              const ym = cand.ym, y0 = cand.y0, yp = cand.yp === null ? d : cand.yp, den = ym - 2 * y0 + yp;
              const fr = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (ym - yp) / den)) : 0;
              out = { i: cand.n + fr, s: y0 }; lastOn = cand.n; cand = null;
            }
          } else if (d > TH && env > slow * 0.25 && n - lastOn > REFR) {
            cand = { n, y0: d, ym: prevD, yp: null };
          }
          prevD = d;
          return out;
        }
      };
    };
  }

  /* ------------------------------------------------------------------------------------
   * Offline analysis core. Pure functions on a mono Float32Array; runs inside a Worker.
   * ---------------------------------------------------------------------------------- */
  function coreFactory() {
    const KickDetector = kickDetectorFactory();
    const LN2 = Math.log(2);

    function makeFFT(N) {
      const lv = Math.round(Math.log2(N)), rev = new Uint32Array(N), cs = new Float64Array(N / 2), sn = new Float64Array(N / 2);
      for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < lv; b++) r |= ((i >> b) & 1) << (lv - 1 - b); rev[i] = r; }
      for (let i = 0; i < N / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / N); sn[i] = -Math.sin(2 * Math.PI * i / N); }
      return (re, im) => {
        for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
        for (let size = 2; size <= N; size <<= 1) {
          const half = size >> 1, step = N / size;
          for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half, tr = re[b] * cs[k] - im[b] * sn[k], ti = re[b] * sn[k] + im[b] * cs[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      };
    }
    function biq(hp, f, Q, sr) {
      const w = 2 * Math.PI * Math.min(f, sr * 0.49) / sr, c = Math.cos(w), a = Math.sin(w) / (2 * Q), a0 = 1 + a;
      const b0 = hp ? (1 + c) / 2 : (1 - c) / 2, b1 = hp ? -(1 + c) : 1 - c;
      return [b0 / a0, b1 / a0, b0 / a0, -2 * c / a0, (1 - a) / a0];
    }
    function iir(x, c) { const [b0, b1, b2, a1, a2] = c; let z1 = 0, z2 = 0; for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + z1; z1 = b1 * v - a1 * y + z2; z2 = b2 * v - a2 * y; x[i] = y; } }
    /* forward-backward filtering: squared magnitude response, zero phase, no group delay */
    function filtfilt(x, cs) { for (const c of cs) iir(x, c); x.reverse(); for (const c of cs) iir(x, c); x.reverse(); return x; }
    const BW4 = [0.5412, 1.3066]; /* Q values of a 4th-order Butterworth as two biquads */
    function onePoleZP(x, tauS) { const a = 1 - Math.exp(-1 / tauS); let s = 0; for (let i = 0; i < x.length; i++) { s += (x[i] - s) * a; x[i] = s; } s = 0; for (let i = x.length - 1; i >= 0; i--) { s += (x[i] - s) * a; x[i] = s; } }
    const parab = (a, b, c) => { const d = a - 2 * b + c; return d < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d)) : 0; };
    function median(a) { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; }
    function prep(a, w) { /* remove local mean, half-wave rectify, unit std */
      const n = a.length, cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + a[i];
      const o = new Float32Array(n); let s2 = 0;
      for (let i = 0; i < n; i++) { const lo = Math.max(0, i - w), hi = Math.min(n, i + w + 1), m = (cs[hi] - cs[lo]) / (hi - lo), v = Math.max(0, a[i] - m); o[i] = v; s2 += v * v; }
      const sd = Math.sqrt(s2 / Math.max(1, n)) || 1; for (let i = 0; i < n; i++) o[i] /= sd; return o;
    }
    const zs = a => { let m = 0; for (const v of a) m += v; m /= a.length || 1; let s = 0; for (const v of a) s += (v - m) * (v - m); s = Math.sqrt(s / (a.length || 1)) || 1; return a.map(v => (v - m) / s); };
    const maxNear = (arr, c, w) => { let m = 0; for (let i = Math.max(0, c - w); i <= Math.min(arr.length - 1, c + w); i++) if (arr[i] > m) m = arr[i]; return m; };

    function analyze(x, sr) {
      const dur = x.length / sr;
      if (dur < 4) return { v: VERSION, bpm: 120, grid: 0, conf: 0, beats: null, bi: 0, phr: 0, bias: null, lc: null, lc0: 0, kickHz: 0, stats: { short: true } };

      /* normalise level so thresholds are level-independent */
      let pk = 0; for (let i = 0; i < x.length; i += 7) { const a = Math.abs(x[i]); if (a > pk) pk = a; }
      if (pk < 1e-5) return { v: VERSION, bpm: 120, grid: 0, conf: 0, beats: null, bi: 0, phr: 0, bias: null, lc: null, lc0: 0, kickHz: 0, stats: { silent: true } };

      /* ---- decimate to ~11 kHz with a zero-phase anti-alias filter ---- */
      const DEC = Math.max(1, Math.round(sr / 11025)), fs = sr / DEC;
      const aa = Float32Array.from(x); for (let i = 0; i < aa.length; i++) aa[i] /= pk;
      if (DEC > 1) filtfilt(aa, BW4.map(q => biq(false, 0.42 * fs, q, sr)));
      const L = Math.floor(aa.length / DEC), y = new Float32Array(L); for (let i = 0; i < L; i++) y[i] = aa[i * DEC];

      /* ---- kick band 20-150 Hz, zero phase (no filter delay in the timing) ---- */
      const lb = Float32Array.from(y);
      filtfilt(lb, [...BW4.map(q => biq(true, 20, q, fs)), ...BW4.map(q => biq(false, 150, q, fs))]);

      /* ---- STFT: complex-domain + spectral flux (low band) + spectral flux (broadband) ---- */
      const N = 512, H = 64, fr = fs / H, binHz = fs / N, M = Math.max(0, Math.floor((L - N) / H) + 1);
      const fft = makeFFT(N), win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
      const k0 = Math.max(1, Math.round(20 / binHz)), k1 = Math.max(k0 + 1, Math.round(150 / binHz)), kB = Math.min(N / 2 - 1, Math.round(5000 / binHz));
      const kC0 = Math.round(60 / binHz), kC1 = Math.min(kB, Math.round(2000 / binHz));
      const pc = new Int8Array(N / 2).fill(-1); for (let k = Math.max(1, kC0); k <= kC1; k++) pc[k] = ((Math.round(12 * Math.log2(k * binHz / 440)) % 12) + 12) % 12;
      const CD = new Float32Array(M), SFL = new Float32Array(M), SFB = new Float32Array(M);
      const NL = k1 - k0 + 1, lowMag = new Float32Array(M * NL), CH = new Float32Array(M * 12); /* chroma per frame */
      const re = new Float64Array(N), im = new Float64Array(N);
      const m1 = new Float64Array(kB + 1), p1 = new Float64Array(kB + 1), p2 = new Float64Array(kB + 1), l1 = new Float64Array(kB + 1);
      const G = 100 / N;
      for (let n = 0; n < M; n++) {
        const o = n * H; for (let i = 0; i < N; i++) { re[i] = y[o + i] * win[i]; im[i] = 0; }
        fft(re, im);
        let cd = 0, sfl = 0, sfb = 0;
        for (let k = 1; k <= kB; k++) {
          const mg = Math.hypot(re[k], im[k]), lg = Math.log1p(G * mg);
          if (k >= k0 && k <= k1) {
            if (n >= 2 && mg >= m1[k]) { const tp = 2 * p1[k] - p2[k]; cd += Math.hypot(re[k] - m1[k] * Math.cos(tp), im[k] - m1[k] * Math.sin(tp)); }
            sfl += Math.max(0, lg - l1[k]); lowMag[n * NL + k - k0] = mg;
            p2[k] = p1[k]; p1[k] = Math.atan2(im[k], re[k]);
          } else sfb += Math.max(0, lg - l1[k]);
          if (pc[k] >= 0) CH[n * 12 + pc[k]] += lg;
          m1[k] = mg; l1[k] = lg;
        }
        CD[n] = cd; SFL[n] = sfl; SFB[n] = sfb;
      }
      const fTime = n => (n * H + N / 2) / fs;
      const W = Math.round(0.5 * fr), cdN = prep(CD, W), sflN = prep(SFL, W), sfbN = prep(SFB, W);
      const O = new Float32Array(M), OL = new Float32Array(M);
      for (let n = 0; n < M; n++) { O[n] = 0.45 * cdN[n] + 0.3 * sflN[n] + 0.25 * sfbN[n]; OL[n] = 0.6 * cdN[n] + 0.4 * sflN[n]; }

      /* ---- transient markers on the kick-band onset function ---- */
      const pw = Math.max(2, Math.round(0.05 * fr)), coarse = [];
      for (let n = 1; n < M - 1; n++) {
        const v = OL[n]; if (v < 1) continue; let ok = true;
        for (let j = Math.max(0, n - pw); j <= Math.min(M - 1, n + pw); j++) if (OL[j] > v || (OL[j] === v && j < n)) { ok = false; break; }
        if (ok) coarse.push(n);
      }
      /* kick fundamental from the interpolated spectral peak bin (sets envelope smoothing) */
      const f0s = [];
      for (const n of coarse) {
        let bk = 0, bv = -1; for (let k = 0; k < NL; k++) { const v = lowMag[n * NL + k]; if (v > bv) { bv = v; bk = k; } }
        if (bk > 0 && bk < NL - 1) { const a = Math.log(lowMag[n * NL + bk - 1] + 1e-9), b = Math.log(bv + 1e-9), c = Math.log(lowMag[n * NL + bk + 1] + 1e-9); f0s.push((bk + k0 + parab(a, b, c)) * binHz); }
      }
      const kickHz = Math.min(140, Math.max(35, median(f0s) || 60));
      /* sample-accurate transient time: analytic-signal (Hilbert) envelope of the zero-phase kick
         band around each coarse onset; with no filter delay, the steepest rise marks the hit.
         Parabolic interpolation of the slope peak gives the fractional-sample position. */
      const HN = 2048, hfft = makeFFT(HN), hr = new Float64Array(HN), hi = new Float64Array(HN), hw = new Float64Array(HN);
      for (let i = 0; i < HN; i++) hw[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / HN);
      const w30 = Math.round(0.03 * fs), markers = [], sm = Math.max(1, Math.round(fs / (4 * kickHz)));
      for (const n of coarse) {
        const tc = (n + parab(OL[n - 1], OL[n], OL[n + 1])) * H + N / 2; /* sub-frame position, samples at fs */
        const o = Math.round(tc) - HN / 2;
        for (let i = 0; i < HN; i++) { const j = o + i; hr[i] = j >= 0 && j < L ? lb[j] * hw[i] : 0; hi[i] = 0; }
        hfft(hr, hi); for (let k = 1; k < HN / 2; k++) { hr[k] *= 2; hi[k] *= 2; } for (let k = HN / 2 + 1; k < HN; k++) { hr[k] = 0; hi[k] = 0; }
        for (let k = 0; k < HN; k++) hi[k] = -hi[k]; hfft(hr, hi); /* inverse via conjugation */
        const E = new Float64Array(HN); for (let i = 0; i < HN; i++) E[i] = Math.hypot(hr[i], hi[i]) / HN;
        const Es = new Float64Array(HN); { let s = 0; for (let i = 0; i < HN; i++) { s += E[i]; if (i >= sm) s -= E[i - sm]; Es[i] = s / sm; } }
        const c = HN / 2, sh = sm >> 1; let j = -1, dm = 0;
        for (let i = Math.max(2, c - w30); i <= Math.min(HN - 3, c + w30); i++) { const d = Es[i + 1] - Es[i - 1]; if (d > dm) { dm = d; j = i; } }
        if (j < 0) continue;
        const jf = j + parab(Es[j] - Es[j - 2], dm, Es[j + 2] - Es[j]) - sh + (sm % 2 ? 0 : 0.5);
        markers.push({ t: (o + jf) / fs, s: OL[n] });
      }

      /* ---- tempo, method A: autocorrelation of the onset function (log-Gaussian prior) ---- */
      const prior = bpm => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.9, 2));
      const lagMin = Math.floor(fr * 60 / 200), lagMax = Math.ceil(fr * 60 / 60), acf = new Float64Array(lagMax + 2);
      for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) { let s = 0; for (let n = 0; n + lag < M; n++) s += O[n] * O[n + lag]; acf[lag] = s / Math.max(1, M - lag); }
      let acfMax = 0; for (let lag = lagMin; lag <= lagMax; lag++) acfMax = Math.max(acfMax, acf[lag]);
      const acfAt = P => { const l = P * fr; if (l < lagMin || l > lagMax) return 0; const i = Math.floor(l), f = l - i; return (acf[i] * (1 - f) + acf[i + 1] * f) / (acfMax || 1); };
      const acfCands = [];
      for (let lag = lagMin; lag <= lagMax; lag++) if (acf[lag] > acf[lag - 1] && acf[lag] >= acf[lag + 1]) { const l = lag + parab(acf[lag - 1], acf[lag], acf[lag + 1]); acfCands.push({ P: l / fr, w: acf[lag] * prior(60 * fr / l) }); }
      acfCands.sort((a, b) => b.w - a.w);

      /* ---- tempo, method B: inter-onset-interval histogram of the transient markers ---- */
      const HB = 0.0005, h0 = 0.3, hn = Math.ceil((1.0 - h0) / HB) + 1, hist = new Float64Array(hn);
      for (let i = 0; i < markers.length; i++) for (let j = i + 1; j < markers.length; j++) {
        const dt = markers[j].t - markers[i].t; if (dt > 2.5) break; if (dt < 0.2) continue;
        for (let k = 1; k <= 4; k++) { const p = dt / k; if (p < h0 || p > 1.0) continue; const c = (p - h0) / HB, w = markers[i].s * markers[j].s / k;
          for (let q = Math.max(0, Math.floor(c) - 6); q <= Math.min(hn - 1, Math.ceil(c) + 6); q++) hist[q] += w * Math.exp(-0.5 * Math.pow((q - c) / 2.5, 2)); }
      }
      let hMax = 0; for (const v of hist) hMax = Math.max(hMax, v);
      const ioiAt = P => { const c = (P - h0) / HB; if (c < 0 || c > hn - 2) return 0; const i = Math.floor(c), f = c - i; return (hist[i] * (1 - f) + hist[i + 1] * f) / (hMax || 1); };
      const ioiCands = [];
      for (let q = 1; q < hn - 1; q++) if (hist[q] > hist[q - 1] && hist[q] >= hist[q + 1]) ioiCands.push({ P: h0 + (q + parab(hist[q - 1], hist[q], hist[q + 1])) * HB, w: hist[q] * prior(60 / (h0 + q * HB)) });
      ioiCands.sort((a, b) => b.w - a.w);

      /* ---- cross-validate: score every candidate (and its octave relatives) with both methods ---- */
      const pool = [];
      for (const c of [...acfCands.slice(0, 4), ...ioiCands.slice(0, 4)]) for (const m of [1, 2, 0.5, 1.5, 2 / 3]) { const P = c.P * m, bpm = 60 / P; if (bpm >= 70 && bpm <= 185) pool.push(P); }
      if (!pool.length) pool.push(0.5);
      let P = pool[0], bestS = -1;
      for (const p of pool) { const s = (0.5 * acfAt(p) + 0.5 * ioiAt(p)) * (0.6 + 0.4 * prior(60 / p)); if (s > bestS) { bestS = s; P = p; } }
      const agreeWith = cands => { if (!cands.length) return false; for (const m of [1, 2, 0.5]) if (Math.abs(cands[0].P * m - P) / P < 0.015) return true; return false; };
      const agree = (agreeWith(acfCands) ? 1 : 0) + (agreeWith(ioiCands) ? 1 : 0);

      /* ---- dynamic-programming beat tracking (global optimum over the whole track) ---- */
      const Tf = P * fr, alpha = 400, tMin = Math.max(1, Math.round(Tf / 2)), tMax = Math.round(Tf * 2);
      const gw = Math.max(1, Math.round(Tf / 32)), LS = new Float32Array(M);
      for (let n = 0; n < M; n++) { let s = 0; for (let k = -2 * gw; k <= 2 * gw; k++) { const j = n + k; if (j >= 0 && j < M) s += O[j] * Math.exp(-0.5 * (k / gw) * (k / gw)); } LS[n] = s; }
      const pen = new Float64Array(tMax + 1); for (let t = tMin; t <= tMax; t++) pen[t] = -alpha * Math.pow(Math.log(t / Tf), 2);
      const C = new Float64Array(M), back = new Int32Array(M).fill(-1);
      for (let n = 0; n < M; n++) {
        let best = -Infinity, bi = -1;
        for (let t = tMin; t <= tMax && n - t >= 0; t++) { const v = C[n - t] + pen[t]; if (v > best) { best = v; bi = n - t; } }
        C[n] = LS[n] + (bi >= 0 ? Math.max(0, best) : 0); back[n] = bi >= 0 && best > 0 ? bi : -1;
      }
      let end = M - 1, eb = -Infinity; for (let n = Math.max(0, M - Math.round(2 * Tf)); n < M; n++) if (C[n] > eb) { eb = C[n]; end = n; }
      const dpFrames = []; for (let n = end; n >= 0; n = back[n]) dpFrames.push(n); dpFrames.reverse();

      /* snap DP beats to precise transient markers where one is close */
      const mt = markers.map(m => m.t);
      const nearest = t => { let lo = 0, hi = mt.length - 1; if (hi < 0) return -1; while (lo < hi) { const mid = (lo + hi) >> 1; if (mt[mid] < t) lo = mid + 1; else hi = mid; } let b = lo; if (lo > 0 && Math.abs(mt[lo - 1] - t) < Math.abs(mt[lo] - t)) b = lo - 1; return b; };
      const beats = dpFrames.map(n => {
        const tb = (n + (n > 0 && n < M - 1 ? parab(O[n - 1], O[n], O[n + 1]) : 0)) * H / fs + N / 2 / fs, j = nearest(tb);
        return j >= 0 && Math.abs(mt[j] - tb) < 0.04 ? { t: mt[j], w: markers[j].s, hit: 1 } : { t: tb, w: 0.05, hit: 0 };
      });

      /* ---- weighted least-squares grid fit (robust, iterated) => fractional BPM ---- */
      let t0 = beats.length ? beats[0].t : 0, rms = 1, inl = [];
      const fit = (Pfix) => {
        for (let it = 0; it < 4; it++) {
          const idx = beats.map(b => Math.round((b.t - t0) / P));
          const res = beats.map((b, i) => b.t - (t0 + idx[i] * P)), ad = res.filter((_, i) => beats[i].hit).map(Math.abs);
          const lim = Math.max(0.004, 3 * 1.4826 * median(ad));
          let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0; inl = [];
          beats.forEach((b, i) => { if (Math.abs(res[i]) > lim) return; const w = b.hit ? b.w : 0.02; sw += w; sx += w * idx[i]; sy += w * b.t; sxx += w * idx[i] * idx[i]; sxy += w * idx[i] * b.t; inl.push(i); });
          if (sw <= 0) break;
          if (Pfix) { t0 = (sy - Pfix * sx) / sw; P = Pfix; }
          else { const den = sw * sxx - sx * sx; if (Math.abs(den) < 1e-9) break; const sl = (sw * sxy - sx * sy) / den; if (sl > 0.25 && sl < 1.2) P = sl; t0 = (sy - P * sx) / sw; }
        }
        let s = 0, c = 0; for (const i of inl) if (beats[i].hit) { const r = beats[i].t - (t0 + Math.round((beats[i].t - t0) / P) * P); s += r * r; c++; }
        rms = c ? Math.sqrt(s / c) : 1; return rms;
      };
      fit(0);
      let bpm = 60 / P; const P0 = P, t00 = t0, rms0 = rms;
      /* keep an exact round tempo only when it fits the data as well as the free fit */
      for (const r of [Math.round(bpm), Math.round(bpm * 2) / 2, Math.round(bpm * 10) / 10]) {
        if (Math.abs(r - bpm) > 0.02 || Math.abs(r - bpm) < 1e-9) continue;
        fit(60 / r); if (rms <= rms0 * 1.03 + 0.0002) { bpm = r; break; } P = P0; t0 = t00; rms = rms0;
      }
      P = 60 / bpm;

      /* ---- constant or variable tempo? compare segment-wise local periods ---- */
      let variable = false;
      if (rms > 0.006 && beats.length > 64) {
        const hitB = beats.filter(b => b.hit);
        for (let s = 0; s + 32 <= hitB.length; s += 16) { const a = hitB[s], b = hitB[s + 31], n = Math.round((b.t - a.t) / P); if (n > 0 && Math.abs((b.t - a.t) / n - P) / P > 0.004) { variable = true; break; } }
      }
      let bt; /* final beat times */
      if (variable) {
        bt = beats.map(b => b.t); const hit = beats.map(b => b.hit);
        for (let i = 0; i < bt.length; i++) if (!hit[i]) { let a = i - 1, b = i + 1; while (a >= 0 && !hit[a]) a--; while (b < bt.length && !hit[b]) b++; if (a >= 0 && b < bt.length) bt[i] = bt[a] + (bt[b] - bt[a]) * (i - a) / (b - a); }
        for (let i = 1; i < bt.length; i++) if (bt[i] <= bt[i - 1] + 0.2 * P) bt[i] = bt[i - 1] + P;
        /* smooth the tempo curve: local linear fit over +/-8 beats, so rate follows the music, not per-beat jitter */
        const raw = bt.slice(), sw8 = 8;
        for (let i = 0; i < bt.length; i++) {
          let w = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
          for (let k = Math.max(0, i - sw8); k <= Math.min(raw.length - 1, i + sw8); k++) { const wk = (hit[k] ? 1 : 0.1) * (1 - Math.abs(k - i) / (sw8 + 1)), d = k - i; w += wk; sx += wk * d; sy += wk * raw[k]; sxx += wk * d * d; sxy += wk * d * raw[k]; }
          const den = w * sxx - sx * sx; bt[i] = den > 1e-9 ? (sy * sxx - sx * sxy) / den : raw[i];
        }
        for (let i = 1; i < bt.length; i++) if (bt[i] <= bt[i - 1] + 0.2 * P) bt[i] = bt[i - 1] + P;
        const iv = []; for (let i = 1; i < bt.length; i++) iv.push(bt[i] - bt[i - 1]); P = median(iv); bpm = Math.round(60 / P * 1000) / 1000;
      } else {
        const iMin = Math.ceil((0 - t0) / P), iMax = Math.floor((dur - t0) / P); bt = [];
        for (let i = iMin; i <= iMax; i++) bt.push(t0 + i * P);
        bpm = Math.round(bpm * 1000) / 1000;
      }
      const nb = bt.length;
      if (nb < 8) return { v: VERSION, bpm: Math.round(60 / P * 100) / 100, grid: Math.max(0, t0), conf: 0.1, beats: null, bi: 0, phr: 0, bias: null, lc: null, lc0: 0, kickHz, stats: { few: true } };

      /* ---- key: Krumhansl-Schmuckler profiles against the whole-track chroma (pitch class 0 = A) ---- */
      /* high-resolution chroma (4096-point FFT, ~2.7 Hz bins) so low notes resolve to the right semitone */
      const tot = new Float64Array(12);
      { const KN = 4096, kf = makeFFT(KN), kr = new Float64Array(KN), ki = new Float64Array(KN), kw = new Float64Array(KN), kh = Math.round(0.1 * fs), kb = fs / KN;
        for (let i = 0; i < KN; i++) kw[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / KN);
        const kLo = Math.ceil(80 / kb), kHi = Math.floor(2000 / kb), kpc = new Int8Array(kHi + 1), kwt = new Float64Array(kHi + 1);
        for (let k = kLo; k <= kHi; k++) { const m = 12 * Math.log2(k * kb / 440), r = Math.round(m); kpc[k] = ((r % 12) + 12) % 12; kwt[k] = Math.cos(Math.PI * (m - r)) ** 2; }
        for (let o = 0; o + KN <= L; o += kh) {
          for (let i = 0; i < KN; i++) { kr[i] = y[o + i] * kw[i]; ki[i] = 0; } kf(kr, ki);
          for (let k = kLo; k <= kHi; k++) tot[kpc[k]] += kwt[k] * Math.log1p(100 * Math.hypot(kr[k], ki[k]) / KN);
        } }
      const KMAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], KMIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
      const corr = (prof, r) => { let ma = 0, mb = 0; for (let k = 0; k < 12; k++) { ma += tot[(k + r) % 12]; mb += prof[k]; } ma /= 12; mb /= 12; let sab = 0, sa = 0, sb = 0; for (let k = 0; k < 12; k++) { const a = tot[(k + r) % 12] - ma, b = prof[k] - mb; sab += a * b; sa += a * a; sb += b * b; } return sab / (Math.sqrt(sa * sb) || 1); };
      const keys = []; for (let r = 0; r < 12; r++) { keys.push({ root: r, minor: false, c: corr(KMAJ, r) }); keys.push({ root: r, minor: true, c: corr(KMIN, r) }); }
      keys.sort((a, b) => b.c - a.c);
      const key = { root: keys[0].root, minor: keys[0].minor, conf: Math.round(Math.max(0, Math.min(1, (keys[0].c - keys[1].c) * 4 + keys[0].c * 0.5)) * 100) / 100 };

      /* ---- beat-synchronous features ---- */
      const fIdx = t => Math.max(0, Math.min(M - 1, Math.round((t - N / 2 / fs) * fr)));
      const w3 = Math.max(1, Math.round(0.03 * fr));
      const kick = new Float64Array(nb), flux = new Float64Array(nb), hitB = new Uint8Array(nb), chroma = [];
      for (let i = 0; i < nb; i++) {
        const c = fIdx(bt[i]); kick[i] = maxNear(OL, c, w3); flux[i] = maxNear(sfbN, c, w3);
        const j = nearest(bt[i]); hitB[i] = j >= 0 && Math.abs(mt[j] - bt[i]) < 0.025 ? 1 : 0;
        const a = c, b = i + 1 < nb ? fIdx(bt[i + 1]) : Math.min(M, c + Math.round(P * fr)), v = new Float64Array(12);
        for (let n = a; n < Math.max(a + 1, b); n++) { if (n >= M) break; for (let k = 0; k < 12; k++) v[k] += CH[n * 12 + k]; }
        let nr = 0; for (let k = 0; k < 12; k++) nr += v[k] * v[k]; nr = Math.sqrt(nr) || 1; for (let k = 0; k < 12; k++) v[k] /= nr;
        chroma.push(v);
      }
      const hchg = new Float64Array(nb);
      for (let i = 1; i < nb; i++) { let d = 0; for (let k = 0; k < 12; k++) d += chroma[i][k] * chroma[i - 1][k]; hchg[i] = 1 - d; }

      /* ---- Viterbi downbeat decoding: 4 bar positions, strict 4/4 with rare resets ---- */
      const zH = zs(Array.from(hchg)), zK = zs(Array.from(kick));
      const beta = 1.2, eps = 0.002, lStay = Math.log(1 - eps), lJump = Math.log(eps / 3);
      let V = [0, 0, 0, 0]; const bp = [];
      for (let i = 0; i < nb; i++) {
        const em = beta * (0.75 * zH[i] + 0.25 * zK[i]); /* harmonic change + kick; backbeat flux and bass-level jumps (ghost kicks) are not downbeat evidence */
        const nv = [0, 0, 0, 0], nbk = [0, 0, 0, 0];
        for (let s = 0; s < 4; s++) { let best = -Infinity, arg = 0; for (let r = 0; r < 4; r++) { const v = V[r] + ((r + 1) % 4 === s ? lStay : lJump); if (v > best) { best = v; arg = r; } } nv[s] = best + (s === 0 ? em : 0); nbk[s] = arg; }
        if (i === 0) for (let s = 0; s < 4; s++) nv[s] = s === 0 ? em : 0;
        V = nv; bp.push(nbk);
      }
      let st = 0; for (let s = 1; s < 4; s++) if (V[s] > V[st]) st = s;
      const pos = new Int8Array(nb); for (let i = nb - 1; i >= 0; i--) { pos[i] = st; st = bp[i][st]; }
      const votes = [0, 0, 0, 0]; for (let i = 0; i < nb; i++) votes[(((i - pos[i]) % 4) + 4) % 4] += 1 + kick[i] * 0.1;
      let dOff = 0; for (let o = 1; o < 4; o++) if (votes[o] > votes[dOff]) dOff = o;

      /* ---- grid anchor: the downbeat that starts the music ---- */
      let firstHit = hitB.indexOf(1); if (firstHit < 0) firstHit = 0;
      let gi = firstHit - ((((firstHit - dOff) % 4) + 4) % 4); if (gi < 0 || bt[gi] < -0.002) gi += 4; if (gi >= nb) gi = dOff;
      const grid = Math.max(0, bt[gi]);

      /* ---- 4-bar phrase offset from bar-level novelty ---- */
      const barNov = [], barStart = [];
      for (let b = gi, j = 0; b + 4 <= nb; b += 4, j++) {
        const v = new Float64Array(12); let e = 0; for (let k = b; k < b + 4; k++) { for (let q = 0; q < 12; q++) v[q] += chroma[k][q]; e += kick[k] + flux[k]; }
        barStart.push({ v, e });
        if (j === 0) { barNov.push(0); continue; } const pv = barStart[j - 1]; let d = 0, na = 0, nb2 = 0;
        for (let q = 0; q < 12; q++) { d += v[q] * pv.v[q]; na += v[q] * v[q]; nb2 += pv.v[q] * pv.v[q]; }
        barNov.push((1 - d / (Math.sqrt(na * nb2) || 1)) + Math.abs(e - pv.e) / (Math.abs(e) + Math.abs(pv.e) + 1e-9));
      }
      const ps = [0, 0, 0, 0]; barNov.forEach((v, j) => { ps[j % 4] += v; });
      let pOff = 0; for (let q = 1; q < 4; q++) if (ps[q] > ps[pOff] * 1.05) pOff = q;
      const phr = (pOff * 4) % 16;

      /* ---- confidence: hit ratio, fit residual, cross-method agreement ---- */
      let lastHit = nb - 1; while (lastHit > 0 && !hitB[lastHit]) lastHit--;
      let hs = 0, hc = 0; for (let i = firstHit; i <= lastHit; i++) { hs += hitB[i]; hc++; }
      const hitRatio = hc ? hs / hc : 0;
      const conf = Math.max(0, Math.min(1, 0.5 * hitRatio + 0.3 * Math.exp(-rms / 0.008) + 0.1 * agree));

      /* local confidence per beat (smoothed hit density) for breakdown detection */
      const lc = new Uint8Array(nb);
      for (let i = 0; i < nb; i++) { let s = 0, c = 0; for (let k = i - 4; k <= i + 4; k++) if (k >= 0 && k < nb) { s += hitB[k]; c++; } lc[i] = Math.round(255 * s / c); }

      /* ---- calibrate the live (causal) kick detector against this grid ---- */
      const det = KickDetector(sr), diffs = []; let bj = 0;
      for (let i = 0; i < x.length; i++) {
        const o = det.push(x[i] / pk, i); if (!o) continue; const t = o.i / sr;
        while (bj + 1 < nb && bt[bj + 1] <= t) bj++;
        for (const k of [bj, bj + 1]) if (k < nb && hitB[k]) { const d = t - bt[k]; if (d > -0.01 && d < 0.06) diffs.push(d); }
      }
      let bias = null;
      if (diffs.length >= 12) { const m = median(diffs), mad = median(diffs.map(d => Math.abs(d - m))); if (mad < 0.006) bias = m; }

      return {
        v: VERSION, bpm, grid, conf: Math.round(conf * 1000) / 1000,
        beats: variable ? Float64Array.from(bt) : null, bi: variable ? gi : 0, phr,
        bias, lc, lc0: -gi, kickHz: Math.round(kickHz * 10) / 10, key,
        stats: { acfBpm: acfCands.length ? 60 / acfCands[0].P : 0, ioiBpm: ioiCands.length ? 60 / ioiCands[0].P : 0, rmsMs: rms * 1000, hit: hitRatio, agree, markers: markers.length, variable }
      };
    }
    return { analyze };
  }

  /* ------------------------------------------------------------------------------------
   * Worker plumbing (falls back to the main thread if Workers from Blob URLs are blocked)
   * ---------------------------------------------------------------------------------- */
  let worker = null, jid = 0, localCore = null; const jobs = new Map(), cache = new WeakMap();
  function getWorker() {
    if (worker !== null) return worker;
    try {
      const src = `'use strict';const VERSION=${VERSION};const kickDetectorFactory=${kickDetectorFactory};const coreFactory=${coreFactory};const core=coreFactory();
onmessage=e=>{const {id,x,sr}=e.data;try{const r=core.analyze(x,sr);postMessage({id,r});}catch(err){postMessage({id,err:String(err&&err.message||err)});}};`;
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = e => { const j = jobs.get(e.data.id); if (!j) return; jobs.delete(e.data.id); e.data.err ? j.rej(new Error(e.data.err)) : j.res(e.data.r); };
      worker.onerror = () => { const pend = [...jobs.values()]; jobs.clear(); worker.terminate(); worker = false; pend.forEach(j => j.retry()); };
    } catch (e) { worker = false; }
    return worker;
  }
  function mono(buf, maxSec = 600) {
    const n = Math.min(buf.length, Math.floor(buf.sampleRate * maxSec)), out = new Float32Array(n), ch = buf.numberOfChannels;
    for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
    return out;
  }
  function runLocal(buf) { return new Promise((res, rej) => setTimeout(() => { try { localCore = localCore || coreFactory(); res(localCore.analyze(mono(buf), buf.sampleRate)); } catch (e) { rej(e); } }, 0)); }
  /** Analyse an AudioBuffer. Resolves with {bpm, grid, conf, beats, bi, phr, bias, lc, lc0, kickHz, stats}. */
  function analyzeBuffer(buf) {
    if (cache.has(buf)) return cache.get(buf);
    const w = getWorker();
    const p = !w ? runLocal(buf) : new Promise((res, rej) => {
      const id = ++jid, x = mono(buf);
      jobs.set(id, { res, rej, retry: () => runLocal(buf).then(res, rej) });
      w.postMessage({ id, x, sr: buf.sampleRate }, [x.buffer]);
    });
    cache.set(buf, p); p.catch(() => cache.delete(buf));
    return p;
  }

  /* ------------------------------------------------------------------------------------
   * Live kick tap (AudioWorklet). Reports onsets with frame-accurate context time.
   * ---------------------------------------------------------------------------------- */
  let wl = null; const sinks = new WeakMap();
  function ensureWorklet(ctx) {
    if (wl) return wl;
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return (wl = Promise.resolve(false));
    const src = `const KickDetector=(${kickDetectorFactory})();
class QDKickTap extends AudioWorkletProcessor{constructor(){super();this.d=KickDetector(sampleRate);}
process(inputs){const inp=inputs[0];if(!inp||!inp.length)return true;const a=inp[0],b=inp[1]||a,f0=currentFrame;
for(let k=0;k<a.length;k++){const o=this.d.push((a[k]+b[k])*.5,f0+k);if(o)this.port.postMessage({t:o.i/sampleRate,s:o.s});}return true;}}
registerProcessor('qd-kick-tap',QDKickTap);`;
    wl = ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))).then(() => true, () => false);
    return wl;
  }
  function createKickTap(ctx, onOnset) {
    const node = new AudioWorkletNode(ctx, 'qd-kick-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' });
    node.port.onmessage = e => onOnset(e.data.t, e.data.s);
    let sink = sinks.get(ctx); if (!sink) { sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination); sinks.set(ctx, sink); }
    node.connect(sink); /* keeps the node pulled by the graph; its output is silent */
    return node;
  }

  /* ------------------------------------------------------------------------------------
   * Beat model: constant grid or beat map, plus a live trim offset (seconds)
   * m = {bpm, grid, beats|null, bi, off}
   * ---------------------------------------------------------------------------------- */
  function seg(B, p) { const n = B.length; if (p <= B[0]) return 0; if (p >= B[n - 1]) return n - 2; let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (B[m] <= p) lo = m; else hi = m; } return lo; }
  function beatAt(m, p) {
    p -= m.off || 0; const B = m.beats;
    if (B && B.length > 1) { const i = seg(B, p); return i + (p - B[i]) / (B[i + 1] - B[i]) - m.bi; }
    return (p - m.grid) * m.bpm / 60;
  }
  function posAtBeat(m, b) {
    const B = m.beats;
    if (B && B.length > 1) { const n = B.length, j = b + m.bi, i = Math.max(0, Math.min(n - 2, Math.floor(j))); return B[i] + (j - i) * (B[i + 1] - B[i]) + (m.off || 0); }
    return m.grid + b * 60 / m.bpm + (m.off || 0);
  }
  function period(m, p) { const B = m.beats; if (B && B.length > 1) { const i = seg(B, p - (m.off || 0)); return B[i + 1] - B[i]; } return 60 / m.bpm; }
  const mod = (x, n) => ((x % n) + n) % n;

  /* ------------------------------------------------------------------------------------
   * Phase controller: PI loop on phase error (seconds) -> playback-rate multiplier.
   * Small errors use at most +/-0.35 % (about 6 cents: below the pitch-change threshold);
   * medium errors use up to +/-1.2 %; large errors ask for a quantized jump.
   * ---------------------------------------------------------------------------------- */
  class PhaseController {
    constructor(o = {}) { Object.assign(this, { kp: 0.6, ki: 0.08, dead: 0.0004, fine: 0.0035, coarse: 0.012, fineBand: 0.015, jumpTh: 0.07 }, o); this.reset(); }
    reset() { this.i = 0; this.t = null; }
    update(e, t) {
      const dt = this.t === null ? 0 : Math.min(0.1, Math.max(0, t - this.t)); this.t = t;
      if (Math.abs(e) > this.jumpTh) { this.i = 0; return { jump: true, bend: 1 }; }
      if (Math.abs(e) < this.dead) { this.i *= Math.exp(-dt / 2); return { bend: 1 + Math.max(-this.fine, Math.min(this.fine, this.ki * this.i)) }; }
      this.i = Math.max(-0.03, Math.min(0.03, this.i + e * dt));
      const cap = Math.abs(e) < this.fineBand ? this.fine : this.coarse;
      return { bend: 1 + Math.max(-cap, Math.min(cap, this.kp * e + this.ki * this.i)) };
    }
  }

  /* ------------------------------------------------------------------------------------
   * Live grid tracker: compares live kick onsets with the grid, decides LIVE/GRID/TAP.
   * ---------------------------------------------------------------------------------- */
  class LiveTracker {
    constructor() { this.reset(); }
    reset() { this.hits = new Map(); this.last = null; this.conf = 0; this.med = 0; this.mad = 0; this.since = 0; this.mode = 'GRID'; this.live = false; }
    observe(k, r) { const h = this.hits.get(k); if (h === undefined || Math.abs(r) < Math.abs(h)) this.hits.set(k, r); }
    /** call often; returns a grid trim (seconds) to add, usually 0 */
    beat(k, anaConf, localConf) {
      if (k === this.last) return 0; this.last = k;
      const rs = []; for (let j = k - 16; j < k; j++) { const h = this.hits.get(j); if (h !== undefined) rs.push(h); }
      for (const key of [...this.hits.keys()]) if (key < k - 40 || key > k + 4) this.hits.delete(key);
      this.conf = rs.length / 16;
      if (rs.length) { const s = rs.slice().sort((a, b) => a - b); this.med = s[s.length >> 1]; this.mad = s.map(v => Math.abs(v - this.med)).sort((a, b) => a - b)[s.length >> 1]; }
      this.live = this.live ? this.conf >= 0.35 && this.mad < 0.006 : this.conf >= 0.5 && this.mad < 0.004;
      let trim = 0;
      if (this.live) {
        this.mode = 'LIVE';
        if (++this.since >= 8 && Math.abs(this.med) > 0.0012) {
          trim = Math.max(-0.003, Math.min(0.003, this.med * 0.3)); this.since = 0;
          for (const [key, v] of this.hits) this.hits.set(key, v - trim);
        }
      } else { this.since = 0; this.mode = anaConf >= 0.4 && localConf > 0.15 ? 'GRID' : anaConf >= 0.4 ? 'HOLD' : 'TAP'; }
      return trim;
    }
  }

  /* ------------------------------------------------------------------------------------
   * Tap tempo: least-squares fit over the taps. With track positions (deck playing) it
   * also returns the beat phase in track time.
   * ---------------------------------------------------------------------------------- */
  function tapFit(taps) {
    if (taps.length < 4) return null;
    const lsq = ys => { const n = ys.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; ys.forEach((y, i) => { sx += i; sy += y; sxx += i * i; sxy += i * y; }); const sl = (n * sxy - sx * sy) / (n * sxx - sx * sx), ic = (sy - sl * sx) / n; let r = 0; ys.forEach((y, i) => { r += (y - ic - sl * i) ** 2; }); return { sl, ic, rms: Math.sqrt(r / n) }; };
    const w = lsq(taps.map(t => t.w / 1000));
    const pos = taps.every(t => t.p != null) ? lsq(taps.map(t => t.p)) : null;
    return { period: w.sl, rms: w.rms, pos };
  }

  return { VERSION, analyzeBuffer, ensureWorklet, createKickTap, beatAt, posAtBeat, period, mod, PhaseController, LiveTracker, tapFit, _core: coreFactory };
})();
if (typeof module !== 'undefined') module.exports = BeatSync;
