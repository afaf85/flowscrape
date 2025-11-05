import { Page } from "playwright";
import { upsertProfile } from "./learn.js";

export type TeachLogger = {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
};

const defaultLogger: TeachLogger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn(...args),
  debug: (...args: any[]) => console.debug(...args),
};

export async function enableTeachMode(
  page: Page,
  url: string,
  logger: TeachLogger = defaultLogger
) {
  const log = logger ?? defaultLogger;

  await page.exposeFunction("FS_HOST_SAVE", async (payload: any) => {
    try {
      const host = new URL(url).host;
      const picks = payload?.picks || {};
      const fields: Record<string, { sel: string; attr?: string }> = {};
      for (const [k, v] of Object.entries(picks)) {
        const vv = v as any;
        if (vv?.selector) fields[k] = { sel: vv.selector, attr: vv.attr };
      }
      upsertProfile(host, url, "", {
        id: undefined,
        buckets: {
          list: [],
          anchors: [],
          containers: [],
          broad: [],
          candidates: [],
          fields,
        },
        metrics: { items: 0 },
      });
      log.info("[teach] saved picks:", Object.keys(fields));
      (globalThis as any).__FS_TEACH_SAVED__ = true;
    } catch (e: any) {
      log.warn("[teach] save failed:", e?.message || String(e));
    }
  });

  const overlayJS = `
(function () {
  if (window.__FS_TEACH_LOADED__) return; window.__FS_TEACH_LOADED__ = true;
  const picks = {};
  const ui = document.createElement('div');
  ui.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:#111;color:#fff;font:12px system-ui;padding:10px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:grid;gap:6px;min-width:220px';
  ui.innerHTML='<b style="font-weight:700">Teach Mode</b>\\
  <div style="display:grid;gap:4px;grid-template-columns:1fr 1fr">\\
    <button data-f="card">Card</button>\\
    <button data-f="title">Title</button>\\
    <button data-f="href">Link</button>\\
    <button data-f="price">Price</button>\\
    <button data-f="image">Image</button>\\
    <button data-f="desc">Description</button>\\
  </div>\\
  <button id="fs-test">Test</button>\\
  <button id="fs-save">Save</button>';
  ui.querySelectorAll('button').forEach(b=>{b.style.cssText='background:#222;color:#fff;border:1px solid #333;border-radius:8px;padding:6px;cursor:pointer'});
  document.documentElement.appendChild(ui);

  let current=null;
  const hoverBox=document.createElement('div');
  hoverBox.style.cssText='position:absolute;border:2px solid #4ade80;pointer-events:none;z-index:2147483646;background:rgba(74,222,128,.12);display:none';
  document.documentElement.appendChild(hoverBox);

  function cssEscape(s){return String(s).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\\]^\\`{|}~])/g,'\\\\$1')}
  function stableSeg(el){
    if (!el || el.nodeType!==1) return 'div';
    const id=el.getAttribute('id');
    if (id && !/^react-/.test(id)) return '#'+cssEscape(id);
    let seg=el.tagName.toLowerCase();
    const attrs=el.attributes||[];
    for (let i=0;i<attrs.length;i++){
      const n=attrs[i].name, v=attrs[i].value;
      if (/^(data-|itemprop|aria-)/i.test(n)) { seg+='['+n+'="'+cssEscape(v)+'"]'; return seg; }
    }
    const cls=(el.getAttribute('class')||'').split(/\\s+/).filter(Boolean)
      .filter(c=>!/^(css|sc-|chakra|tw-)/i.test(c) && !/^\\d+$/.test(c) && c.length>2).slice(0,2);
    if (cls.length) seg+='.'+cls.map(cssEscape).join('.');
    return seg;
  }
  function toSelector(el){
    const parts=[]; let cur=el;
    while(cur && cur.nodeType===1 && parts.length<5){
      const seg=stableSeg(cur); parts.unshift(seg);
      if (seg.startsWith('#')) break;
      cur=cur.parentElement;
    }
    return parts.join(' > ');
  }
  function guessAttr(field, el){
    if (field==='image') return el.getAttribute('data-src') ? 'data-src' : (el.getAttribute('srcset') ? 'srcset:first' : 'src');
    if (field==='href') return 'href';
    if (field==='price') return 'text';
    if (field==='title'||field==='desc') return 'text';
    return null;
  }
  function startPick(field){
    current=field;
    document.addEventListener('mousemove', onHover, true);
    document.addEventListener('click', onClick, true);
  }
  function onHover(e){
    const el=e.target; if (!el || ui.contains(el)) return;
    const r=el.getBoundingClientRect();
    Object.assign(hoverBox.style,{top:(scrollY+r.top)+'px',left:(scrollX+r.left)+'px',width:r.width+'px',height:r.height+'px',display:'block'});
  }
  function onClick(e){
    e.preventDefault(); e.stopPropagation();
    const el=e.target; if (!el || ui.contains(el)) return;
    hoverBox.style.display='none';
    document.removeEventListener('mousemove', onHover, true);
    document.removeEventListener('click', onClick, true);
    const sel=toSelector(el); const attr=guessAttr(current, el);
    picks[current]={ selector: sel, attr };
    console.log('[teach] picked', current, picks[current]);
    current=null;
  }
  ui.querySelectorAll('[data-f]').forEach(btn=>{
    btn.addEventListener('click',()=>startPick(btn.getAttribute('data-f')));
  });
  document.getElementById('fs-test').addEventListener('click',()=>{ console.table(picks); alert('Check console (F12) for picks.'); });
  document.getElementById('fs-save').addEventListener('click',()=>{
    const payload={ host: location.host, url: location.href, picks };
    try { window.FS_HOST_SAVE && window.FS_HOST_SAVE(payload); } catch(e){}
    window.postMessage({ type: 'FS_TEACH_SAVE', payload }, '*');
    window.__FS_TEACH_SAVED__ = true;
    alert('Saved.');
  });
  window.__FS_TEACH_READY__ = true;
  console.log('[teach] overlay ready');
})();`;

  await page.addInitScript({ content: overlayJS });
  log.info("[teach] overlay script added");
}

export async function waitForTeachOverlay(page: Page, logger: TeachLogger = defaultLogger) {
  try {
    await page.waitForFunction(() => (window as any).__FS_TEACH_READY__ === true, { timeout: 5000 });
    logger.info("[teach] overlay ready on page");
  } catch (err: any) {
    logger.warn("[teach] overlay not confirmed via flag (may still be visible)");
  }
}
