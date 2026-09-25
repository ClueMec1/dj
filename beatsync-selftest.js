/* Offline self-test for the analysis core. Run: node tools/beatsync-selftest.js
   Builds synthetic tracks with known beat times (ghost kicks, snares, hats, off-beat tones,
   a breakdown, tempo drift, noise) and reports tempo, downbeat and timing error. */
const BS=require('../beatsync.js');const core=BS._core();
function synth({bpm,sr=44100,dur=180,off=0.5,swing=0,ghost=true,breakdown=null,drift=0,seed=1}){
  let r=seed;const rnd=()=>{r=(r*16807)%2147483647;return r/2147483647;};
  const n=Math.floor(sr*dur),x=new Float32Array(n);const truth=[];
  let t=off,k=0;
  while(t<dur-1){const P=60/(bpm*(1+drift*t/dur));
    const inBreak=breakdown&&t>breakdown[0]&&t<breakdown[1];
    if(!inBreak){truth.push(t);const i0=Math.round(t*sr);
      for(let i=0;i<0.25*sr&&i0+i<n;i++){const tt=i/sr;const f=50+120*Math.exp(-tt*30);const ph=2*Math.PI*(50*tt+120*(1-Math.exp(-tt*30))/30);x[i0+i]+=0.8*Math.sin(ph)*Math.exp(-tt*12)*(k%4===0?1:0.9);}
      // ghost kick syncopation 16th before beat 3
      if(ghost&&k%4===2){const g=Math.round((t-P/4)*sr);for(let i=0;i<0.1*sr&&g+i<n;i++){const tt=i/sr;x[g+i]+=0.35*Math.sin(2*Math.PI*60*tt)*Math.exp(-tt*25);}}
      // snare on 2,4
      if(k%2===1){for(let i=0;i<0.15*sr&&i0+i<n;i++)x[i0+i]+=0.3*(rnd()*2-1)*Math.exp(-i/sr*25);}
    }
    // hats every 8th incl breakdown, loud cymbal
    for(const h of [0,0.5]){const i0=Math.round((t+h*P)*sr);for(let i=0;i<0.04*sr&&i0+i<n;i++){x[i0+i]+=0.25*(rnd()*2-1)*Math.exp(-i/sr*90)*(i%2?1:-1);}}
    // pad chord that changes on every downbeat (follows the beats, so it drifts with them)
    {const f=[220,196,174.6,164.8][Math.floor(k/4)%4],i0=Math.round(t*sr);for(let i=0;i<P*sr&&i0+i<n;i++)x[i0+i]+=0.05*Math.sin(2*Math.PI*f*(i0+i)/sr)+0.04*Math.sin(2*Math.PI*f*1.26*(i0+i)/sr);}
    t+=P;k++;}
  // vocals-ish loud tone bursts off-beat
  for(let s=10;s<dur-2;s+=7.3){const i0=Math.round(s*sr);for(let i=0;i<1.5*sr&&i0+i<n;i++)x[i0+i]+=0.4*Math.sin(2*Math.PI*(330+30*Math.sin(i/sr*6))*i/sr)*Math.min(1,i/sr*20);}
  return {x,sr,truth};
}
function test(name,o){const s=synth(o);const t0=Date.now();const r=core.analyze(s.x,s.sr);const ms=Date.now()-t0;
  // error vs truth: grid beats
  const m={bpm:r.bpm,grid:r.grid,beats:r.beats,bi:r.bi};const errs=[];
  for(const tt of s.truth){const b=BS.beatAt(m,tt);const k=Math.round(b);errs.push((tt-BS.posAtBeat(m,k))*1000);}
  errs.sort((a,b)=>Math.abs(a)-Math.abs(b));
  const med=errs[errs.length>>1],p95=errs[Math.floor(errs.length*.95)],mean=errs.reduce((a,b)=>a+b,0)/errs.length;
  const downOk=Math.abs(BS.mod(Math.round(BS.beatAt(m,o.off)),4))<1e-9;
  console.log(name.padEnd(22),'bpm',r.bpm,'(true',o.bpm+')','grid',r.grid.toFixed(4),'conf',r.conf,'down',downOk?'OK':'WRONG('+BS.mod(Math.round(BS.beatAt(m,o.off)),4)+')','|err| med',Math.abs(med).toFixed(3),'ms p95',Math.abs(p95).toFixed(3),'mean',mean.toFixed(3),'bias',r.bias&&(r.bias*1000).toFixed(2),'var',!!r.beats,ms+'ms',JSON.stringify(r.stats));}
test('124.32',{bpm:124.32,off:0.713});
test('128 exact',{bpm:128,off:1.25});
test('174 dnb',{bpm:174,off:0.3});
test('90 hiphop',{bpm:90.5,off:2.02,sr:48000});
test('breakdown',{bpm:126.7,off:0.4,breakdown:[60,100]});
test('drift 120→122.4',{bpm:120,off:0.9,drift:0.02});
test('no ghost',{bpm:140.25,off:0.05,ghost:false});
// ambient: only pad + vocal bursts, no drums
{const sr=44100,n=sr*60,x=new Float32Array(n);for(let i=0;i<n;i++){const t=i/sr;x[i]=0.1*Math.sin(2*Math.PI*220*t)*(0.6+0.4*Math.sin(t*0.7))+0.05*Math.sin(2*Math.PI*277*t);}
 const r=core.analyze(x,sr);console.log('ambient conf',r.conf,'bpm',r.bpm,'bias',r.bias);}
// noisy
{const s=synth({bpm:122.8,off:0.33,seed:5});let r=7;for(let i=0;i<s.x.length;i++){r=(r*16807)%2147483647;s.x[i]+=0.15*(r/2147483647*2-1);}
 const a=core.analyze(s.x,s.sr);const m={bpm:a.bpm,grid:a.grid,beats:a.beats,bi:a.bi};const e=s.truth.map(t=>(t-BS.posAtBeat(m,Math.round(BS.beatAt(m,t))))*1000);console.log('noisy bpm',a.bpm,'conf',a.conf,'err mean',(e.reduce((p,q)=>p+q)/e.length).toFixed(2),'max',Math.max(...e.map(Math.abs)).toFixed(2));
 // live detector simulation: residual after bias correction
 const KD=eval('('+require('fs').readFileSync(require('path').join(__dirname,'../beatsync.js'),'utf8').match(/function kickDetectorFactory\(\) \{[\s\S]*?\n  \}\n/)[0]+')')();
 const d=KD(s.sr);const res=[];for(let i=0;i<s.x.length;i++){const o=d.push(s.x[i],i);if(o){const t=o.i/s.sr-a.bias;const b=BS.beatAt(m,t),k=Math.round(b);if(Math.abs(b-k)*60/a.bpm<.045)res.push((b-k)*60/a.bpm*1000);}}
 res.sort((p,q)=>p-q);console.log('live residual median',res[res.length>>1].toFixed(3),'ms  n',res.length);}
