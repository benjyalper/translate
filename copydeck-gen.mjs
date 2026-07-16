// copydeck-gen.mjs — turn a proofread XLIFF + correction map into an "easy to copy" HTML deck.
// Usage: node copydeck-gen.mjs <in.xliff> <corrections.json> <out.html> [taskId]
// corrections.json: { "<seg>": { "cat": "critical|minor|plural|html", "note": "...", "target": "<optional; derived if absent>" }, ... }
import fs from 'fs';

const [,, xliffPath, corrPath, outPath, taskIdArg] = process.argv;
const xliff = fs.readFileSync(xliffPath, 'utf8');
const CORR = JSON.parse(fs.readFileSync(corrPath, 'utf8'));

// crude but sufficient trans-unit parse
const units = {};
const re = /<trans-unit id="(\d+)">\s*<source>([\s\S]*?)<\/source>\s*<target[^>]*>([\s\S]*?)<\/target>/g;
let m;
const unesc = s => s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
while ((m = re.exec(xliff))) units[m[1]] = { src: unesc(m[2]), tgt: unesc(m[3]) };

// derivations for segments edited in-place (verb-only, tags untouched)
function derive(seg, tgt) {
  if (seg === '17') return tgt.replace('עבור אל','עברו אל').replace('קרא ואשר','קראו ואשרו').replace(/הירשם(?!ה)/,'הירשמו');
  if (seg === '38') return tgt.replace('שלם/י','שלמו');
  if (seg === '39') return tgt.split('שלם/י').join('שלמו');
  return tgt;
}

const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// highlight tokens in an already-escaped string: {{..}}, {..}, <..>, %s, %1$s
function hl(escaped) {
  return escaped
    .replace(/(\{\{[^}]+\}\})/g, '<span class="tok tok-var">$1</span>')
    .replace(/(?<!\{)(\{[^{}]+\})(?!\})/g, '<span class="tok tok-var">$1</span>')
    .replace(/(&lt;\/?[a-zA-Z][^&]*?&gt;)/g, '<span class="tok tok-tag">$1</span>')
    .replace(/(%\d?\$?[sd])/g, '<span class="tok tok-pct">$1</span>');
}

const catMeta = {
  critical: { label: 'Critical', },
  minor:    { label: 'Minor', },
  plural:   { label: 'Plural', },
  html:     { label: 'HTML tags', },
};

const segs = Object.keys(CORR).map(Number).sort((a,b)=>a-b);
const cards = segs.map(segN => {
  const seg = String(segN);
  const meta = CORR[seg];
  const u = units[seg] || { src:'', tgt:'' };
  const target = meta.target != null ? meta.target : derive(seg, u.tgt);
  const cat = meta.cat || 'minor';
  const srcHtml = hl(esc(u.src));
  const tgtHtml = hl(esc(target));
  return `
  <article class="card" data-cat="${cat}" data-seg="${seg}">
    <div class="rail">
      <span class="seg">#${seg}</span>
      <span class="chip chip-${cat}">${catMeta[cat]?.label || cat}</span>
    </div>
    <div class="body">
      ${meta.note ? `<p class="note">${esc(meta.note)}</p>` : ''}
      <div class="src" dir="ltr" lang="en">${srcHtml}</div>
      <div class="tgt" dir="rtl" lang="he">${tgtHtml}</div>
    </div>
    <div class="actions">
      <button class="copy" type="button" data-copy="${esc(target)}" aria-label="Copy corrected translation for segment ${seg}">
        <span class="copy-label">Copy</span>
      </button>
      <label class="done"><input type="checkbox" class="done-cb"> pasted</label>
    </div>
  </article>`;
}).join('\n');

const counts = segs.reduce((a,s)=>{ const c=CORR[String(s)].cat||'minor'; a[c]=(a[c]||0)+1; return a; },{});
const taskId = taskIdArg || 'task';
const total = segs.length;

const legend = ['critical','minor','plural','html'].filter(c=>counts[c]).map(c=>
  `<span class="chip chip-${c}">${catMeta[c].label} · ${counts[c]}</span>`).join('');

const html = `<div class="wrap">
  <header class="head">
    <div class="head-top">
      <h1>Copy deck <span class="task">${esc(taskId)}</span></h1>
      <div class="progress" role="status" aria-live="polite">
        <span id="pcount">0</span>/<span>${total}</span> pasted
        <div class="bar"><i id="pbar"></i></div>
      </div>
    </div>
    <p class="sub">${total} changed segments. Click <strong>Copy</strong>, paste into the Starling cell, tick <strong>pasted</strong>. Placeholders and tags are copied verbatim — Starling re-chips them on paste.</p>
    <div class="legend">${legend}<button id="clear" class="ghost" type="button">Reset ticks</button></div>
  </header>
  <main class="deck">
    ${cards}
  </main>
  <footer class="foot">Generated from ${esc(xliffPath.split(/[\\/]/).pop())} · source shown for reference only — copy the Hebrew.</footer>
</div>

<style>
:root{
  --bg:#f7f8fa; --surface:#ffffff; --surface-2:#f0f2f6; --text:#1b1e26; --muted:#5b616e;
  --border:#e2e5ec; --border-strong:#d1d6df; --accent:#0f8f8f; --accent-ink:#ffffff; --accent-soft:#d6efef;
  --tok-var:#7a3ea8; --tok-var-bg:#f3e9fb; --tok-tag:#1f6feb; --tok-tag-bg:#e6efff; --tok-pct:#b45309; --tok-pct-bg:#fbf0dd;
  --c-critical:#d61f4b; --c-critical-bg:#fce6ec; --c-minor:#b06a00; --c-minor-bg:#fbf0dd;
  --c-plural:#3f4ecc; --c-plural-bg:#e8eafb; --c-html:#7a3ea8; --c-html-bg:#f3e9fb;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#111319; --surface:#191c24; --surface-2:#1f232d; --text:#e7e9f0; --muted:#9aa1b1;
  --border:#2a2f3b; --border-strong:#3a4150; --accent:#3fb9b3; --accent-ink:#08131a; --accent-soft:#123433;
  --tok-var:#cba6ec; --tok-var-bg:#2a2036; --tok-tag:#8bb6ff; --tok-tag-bg:#182740; --tok-pct:#eab765; --tok-pct-bg:#31281a;
  --c-critical:#ff6b8b; --c-critical-bg:#3a1520; --c-minor:#e6a94b; --c-minor-bg:#332612;
  --c-plural:#9aa5ff; --c-plural-bg:#1e2140; --c-html:#cba6ec; --c-html-bg:#291d38;
}}
:root[data-theme="light"]{
  --bg:#f7f8fa; --surface:#ffffff; --surface-2:#f0f2f6; --text:#1b1e26; --muted:#5b616e;
  --border:#e2e5ec; --border-strong:#d1d6df; --accent:#0f8f8f; --accent-ink:#ffffff; --accent-soft:#d6efef;
  --tok-var:#7a3ea8; --tok-var-bg:#f3e9fb; --tok-tag:#1f6feb; --tok-tag-bg:#e6efff; --tok-pct:#b45309; --tok-pct-bg:#fbf0dd;
  --c-critical:#d61f4b; --c-critical-bg:#fce6ec; --c-minor:#b06a00; --c-minor-bg:#fbf0dd;
  --c-plural:#3f4ecc; --c-plural-bg:#e8eafb; --c-html:#7a3ea8; --c-html-bg:#f3e9fb;
}
:root[data-theme="dark"]{
  --bg:#111319; --surface:#191c24; --surface-2:#1f232d; --text:#e7e9f0; --muted:#9aa1b1;
  --border:#2a2f3b; --border-strong:#3a4150; --accent:#3fb9b3; --accent-ink:#08131a; --accent-soft:#123433;
  --tok-var:#cba6ec; --tok-var-bg:#2a2036; --tok-tag:#8bb6ff; --tok-tag-bg:#182740; --tok-pct:#eab765; --tok-pct-bg:#31281a;
  --c-critical:#ff6b8b; --c-critical-bg:#3a1520; --c-minor:#e6a94b; --c-minor-bg:#332612;
  --c-plural:#9aa5ff; --c-plural-bg:#1e2140; --c-html:#cba6ec; --c-html-bg:#291d38;
}
*{box-sizing:border-box}
.wrap{max-width:820px;margin:0 auto;padding:28px 20px 64px;color:var(--text);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5}
.head{position:sticky;top:0;z-index:5;background:linear-gradient(var(--bg),var(--bg) 82%,transparent);
  padding:6px 0 14px;margin-bottom:8px}
.head-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
h1{font-size:20px;font-weight:650;margin:0;letter-spacing:-.01em}
h1 .task{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;font-weight:600;
  color:var(--muted);background:var(--surface-2);padding:2px 8px;border-radius:6px;margin-inline-start:6px}
.progress{font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right;min-width:120px}
.progress .bar{height:5px;border-radius:99px;background:var(--surface-2);margin-top:5px;overflow:hidden}
.progress .bar i{display:block;height:100%;width:0;background:var(--accent);border-radius:99px;transition:width .25s ease}
.sub{font-size:13.5px;color:var(--muted);margin:10px 0 0;max-width:64ch}
.legend{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
.deck{display:flex;flex-direction:column;gap:12px;margin-top:6px}
.card{display:grid;grid-template-columns:96px 1fr auto;gap:14px;align-items:start;
  background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;
  transition:opacity .2s ease,border-color .2s ease}
.card.is-done{opacity:.5}
.card.is-done .tgt{text-decoration:line-through;text-decoration-color:var(--border-strong)}
.rail{display:flex;flex-direction:column;gap:7px;align-items:flex-start}
.seg{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:600;
  color:var(--muted);font-variant-numeric:tabular-nums}
.chip{font-size:11px;font-weight:600;letter-spacing:.02em;padding:2px 8px;border-radius:99px;white-space:nowrap;line-height:1.5}
.chip-critical{color:var(--c-critical);background:var(--c-critical-bg)}
.chip-minor{color:var(--c-minor);background:var(--c-minor-bg)}
.chip-plural{color:var(--c-plural);background:var(--c-plural-bg)}
.chip-html{color:var(--c-html);background:var(--c-html-bg)}
.body{min-width:0}
.note{font-size:12.5px;color:var(--muted);margin:0 0 8px;font-style:italic}
.src{font-size:12.5px;color:var(--muted);direction:ltr;text-align:left;margin-bottom:6px;
  overflow-wrap:anywhere;padding-inline-start:0}
.tgt{font-size:15.5px;line-height:1.7;direction:rtl;text-align:right;overflow-wrap:anywhere;color:var(--text)}
.tgt.picked{background:var(--accent-soft);border-radius:6px;box-shadow:0 0 0 4px var(--accent-soft)}
.tok{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82em;padding:.5px 4px;border-radius:4px;
  unicode-bidi:isolate;white-space:nowrap}
.tok-var{color:var(--tok-var);background:var(--tok-var-bg)}
.tok-tag{color:var(--tok-tag);background:var(--tok-tag-bg)}
.tok-pct{color:var(--tok-pct);background:var(--tok-pct-bg)}
.actions{display:flex;flex-direction:column;gap:8px;align-items:stretch;justify-self:end}
.copy{font:inherit;font-size:13px;font-weight:600;color:var(--accent-ink);background:var(--accent);
  border:none;border-radius:8px;padding:8px 16px;cursor:pointer;transition:transform .08s ease,filter .15s ease;white-space:nowrap}
.copy:hover{filter:brightness(1.07)}
.copy:active{transform:translateY(1px)}
.copy.copied{background:var(--surface-2);color:var(--accent)}
.done{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);cursor:pointer;justify-content:center}
.done input{accent-color:var(--accent);cursor:pointer}
.ghost{font:inherit;font-size:12px;color:var(--muted);background:transparent;border:1px solid var(--border-strong);
  border-radius:7px;padding:3px 10px;cursor:pointer;margin-inline-start:auto}
.ghost:hover{color:var(--text);border-color:var(--muted)}
.foot{margin-top:24px;font-size:12px;color:var(--muted);text-align:center}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
@media (max-width:560px){.card{grid-template-columns:1fr;gap:10px}.rail{flex-direction:row;align-items:center}
  .actions{flex-direction:row;justify-self:stretch}.copy{flex:1}}
</style>

<script>
(function(){
  const KEY='copydeck-${esc(taskId)}';
  let done={};try{done=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
  const cards=[...document.querySelectorAll('.card')];
  const pcount=document.getElementById('pcount'), pbar=document.getElementById('pbar');
  function refresh(){
    let n=0; cards.forEach(c=>{const s=c.dataset.seg; const cb=c.querySelector('.done-cb');
      const d=!!done[s]; cb.checked=d; c.classList.toggle('is-done',d); if(d)n++;});
    pcount.textContent=n; pbar.style.width=(cards.length?(n/cards.length*100):0)+'%';
  }
  cards.forEach(c=>{
    const s=c.dataset.seg;
    c.querySelector('.done-cb').addEventListener('change',e=>{done[s]=e.target.checked;
      if(!done[s])delete done[s]; localStorage.setItem(KEY,JSON.stringify(done)); refresh();});
    const btn=c.querySelector('.copy');
    btn.addEventListener('click',async()=>{
      const text=btn.dataset.copy;
      let ok=false;
      try{ await navigator.clipboard.writeText(text); ok=true; }catch(e){
        try{ const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed';
          ta.style.opacity='0'; document.body.appendChild(ta); ta.select();
          ok=document.execCommand('copy'); document.body.removeChild(ta);}catch(e2){}
      }
      const lbl=btn.querySelector('.copy-label'); const prev=lbl.textContent;
      btn.classList.add('copied'); lbl.textContent= ok?'Copied ✓':'Ctrl+C ↓';
      if(!ok){ // select the visible Hebrew so the user can Ctrl+C
        const tgt=c.querySelector('.tgt'); const sel=window.getSelection(); const rng=document.createRange();
        rng.selectNodeContents(tgt); sel.removeAllRanges(); sel.addRange(rng); tgt.classList.add('picked'); }
      setTimeout(()=>{btn.classList.remove('copied'); lbl.textContent=prev;
        const t=c.querySelector('.tgt'); if(t) t.classList.remove('picked');}, ok?1400:3000);
    });
  });
  document.getElementById('clear').addEventListener('click',()=>{done={};localStorage.removeItem(KEY);refresh();});
  refresh();
})();
</script>`;

fs.writeFileSync(outPath, html, 'utf8');
console.log('Wrote', outPath, '—', segs.length, 'segments');
