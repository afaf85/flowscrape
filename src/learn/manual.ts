import { Page } from "playwright";
import { upsertProfile } from "./learn.js";

/* ========================= types & logger ========================= */

export type TeachLogger = {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
};

const defaultLogger: TeachLogger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn(...args),
  debug: (...args: any[]) => console.debug?.(...args),
};

type FieldFlat = { sel: string; attr?: string };
type FieldRich = { rel?: string; abs?: string; attr?: string };

type OverlayPayload = {
  url?: string;
  host?: string;
  // Optional repeated-card selector chosen in the overlay
  card?: { sel?: string | null };
  // Flat ({ sel, attr }) from overlay or rich ({ abs, rel, attr }) in future versions
  fields?: Record<string, FieldFlat | FieldRich>;
  // legacy button picks
  picks?: Record<string, { selector: string; attr?: string }>;
  samples?: any[];
};

declare global {
  interface Window {
    __FS_TEACH_SAVED__?: boolean;
    __FS_TEACH_READY__?: boolean;
    __FS_TEACH_LAST__?: any;
    __FS_TEACH_LOADED__?: boolean;
    __FS_SAVE_BOUND__?: boolean;
    __FS_HTTP_ROUTE_BOUND__?: boolean;
    __FS_TEACH_READY_LOGGED__?: boolean;
  }
}

/* ========================= helpers ========================= */

function safeHostFromUrl(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Normalize overlay payload → learned profile doc
 * Ensures we ALWAYS end up with a usable `href` field so teach items can be persisted.
 *
 * Call this from your FS_HOST_SAVE handler once you have:
 *  - payload: OverlayPayload from the page
 *  - html: current page HTML
 */
export async function applyTeachOverlayPayload(
  payload: OverlayPayload,
  html: string,
  log: TeachLogger = defaultLogger
) {
  const url = payload.url;
  const host =
    payload.host ||
    safeHostFromUrl(url) ||
    "";

  if (!host) {
    log.warn("[fs-teach] missing host on payload; skipping upsert");
    return;
  }

  const cardSel = payload.card?.sel || "";

  const fields: Record<string, FieldRich> = {};

  // New-format fields
  if (payload.fields) {
    for (const [name, f] of Object.entries(payload.fields)) {
      const anyF: any = f;

      const rel: string | undefined = anyF.rel;
      const absOrSel: string | undefined = anyF.abs || anyF.sel;

      if (rel) {
        fields[name] = { rel, attr: anyF.attr };
      } else if (absOrSel) {
        fields[name] = { abs: absOrSel, attr: anyF.attr };
      }
    }
  }

  // Legacy picks → absolute selectors
  if (payload.picks) {
    for (const [name, p] of Object.entries(payload.picks)) {
      if (!p?.selector) continue;
      fields[name] = { abs: p.selector, attr: p.attr };
    }
  }

  // 🔗 Ensure an href field exists so teach mode can persist items
  if (!fields.href) {
    if (cardSel) {
      // Best: relative to taught card; first anchor with href
      fields.href = {
        rel: `${cardSel} a[href]`,
        attr: "href",
      };
      log.info("[fs-teach] inferred href field from card:", fields.href.rel);
    } else {
      // Fallback: any product-ish link on the page
      fields.href = {
        abs: "a[href*='/product'], a[href*='/products/']",
        attr: "href",
      };
      log.info("[fs-teach] using fallback href selector:", fields.href.abs);
    }
  }

  const doc = {
    match: { host },
    buckets: {
      // Only fields here; buckets (list/anchors/containers/...) are learned elsewhere
      fields,
    },
    metrics: {},
  };

  await upsertProfile(host, doc as any, html);
  log.info("[fs-teach] host profile saved for", host);
}

/* ========================= 1) Error squelcher ========================= */

export function squelchPageErrors(
  page: Page,
  log: TeachLogger = defaultLogger,
  opts?: {
    onlyTeachLogs?: boolean;
    maxRepeatsPerMessage?: number;
  }
) {
  const onlyTeachLogs = opts?.onlyTeachLogs ?? true;
  const maxRepeats = Math.max(1, opts?.maxRepeatsPerMessage ?? 3);
  const seen = new Map<string, number>();

  const isTeach = (msg: string) => /\[(fs-teach|teach)\]/i.test(msg);

  const shouldLog = (kind: "pageerror" | "console", msg: string) => {
    if (!msg || /^\s*$/.test(msg)) return false;
    if (onlyTeachLogs && !isTeach(msg)) return false;
    const key = `${kind}|${msg}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count <= maxRepeats;
  };

  page.on("pageerror", (err) => {
    const text = String((err as any)?.message ?? err);
    if (!shouldLog("pageerror", text)) return;
    log.warn("[teach] pageerror:", text);
  });

  page.on("console", (msg) => {
    const text = msg.text?.() ?? "";
    if (!shouldLog("console", text)) return;
    const type = msg.type();
    if (type === "error" || type === "warning") {
      log.warn("[teach] console:", text);
    } else {
      log.debug?.("[teach] console:", text);
    }
  });
}

/* ========================= 2) Enable Teach Mode (minimal, generic) ========================= */

export async function enableTeachMode(
  page: Page,
  url: string,
  logger: TeachLogger = defaultLogger
) {
  const log = logger ?? defaultLogger;

  // 1) Mixed-content upgrade (generic best-effort)
  try {
    const routeBound = await page
      .evaluate(() => (window as any).__FS_HTTP_ROUTE_BOUND__ === true)
      .catch(() => false);

    if (!routeBound) {
      await page.route("http://*/*", async (route) => {
        try {
          const mainIsHttps = /^https:\/\//i.test(page.url());
          if (!mainIsHttps) return route.continue();
        } catch {
          return route.continue();
        }

        const reqUrl = route.request().url();
        const httpsUrl = reqUrl.replace(/^http:\/\//i, "https://");
        if (httpsUrl === reqUrl) return route.continue();

        try {
          await route.continue({ url: httpsUrl });
        } catch {
          await route.abort();
        }
      });

      await page.addInitScript(() => {
        (window as any).__FS_HTTP_ROUTE_BOUND__ = true;
      });
    }
  } catch {
    // non-fatal
  }

  // 2) Polyfill __name once (for some libs)
  await page.addInitScript(() => {
    const g: any = window as any;
    if (typeof g.__name !== "function") {
      g.__name = (fn: Function, name: string) => {
        try {
          Object.defineProperty(fn, "name", {
            value: name,
            configurable: true,
          });
        } catch {}
        return fn;
      };
    }
  });

  // 3) FS_HOST_SAVE bridge: normalize overlay payload → upsertProfile()
  try {
    const alreadyBound = await page
      .evaluate(() => !!(window as any).__FS_SAVE_BOUND__)
      .catch(() => false);

    if (!alreadyBound) {
      await page.exposeFunction(
        "FS_HOST_SAVE",
        async (payload: OverlayPayload) => {
          try {
            // Resolve URL + host
            const currentUrl = (() => {
              try {
                return page.url();
              } catch {
                return "";
              }
            })();

            const rawUrl =
              payload?.url || url || currentUrl || "";
            let host = payload?.host || "";
            let baseUrl = "";

            try {
              const u = new URL(rawUrl);
              if (!host) host = u.host;
              baseUrl = u.origin;
            } catch {
              // ignore; host may still come from payload
            }

            if (!host) {
              throw new Error("FS_HOST_SAVE: missing host");
            }
            if (!baseUrl) {
              baseUrl =
                "https://" + host.replace(/\/+$/, "");
            }

            const srcFields =
              (payload.fields ||
                payload.picks ||
                {}) as Record<string, FieldFlat | FieldRich>;

            const richFields: Record<string, FieldRich> = {};
            for (const [key, f] of Object.entries(srcFields)) {
              if (!f) continue;
              const anyF = f as any;

              // Support:
              // - FieldFlat: { sel, attr }
              // - FieldRich: { abs, rel, attr }
              const sel: string | undefined =
                anyF.sel || anyF.abs || anyF.rel;

              if (!sel) continue;

              richFields[key] = {
                abs: sel,
                attr: anyF.attr,
              };
            }

            if (!Object.keys(richFields).length) {
              throw new Error(
                "FS_HOST_SAVE: no valid field selectors"
              );
            }

            const samplesCount =
              Array.isArray(payload.samples) &&
              payload.samples.length > 0
                ? payload.samples.length
                : 0;

            // Grab current HTML snapshot for templateHash / mining
            let html = "";
            try {
              html = await page.content();
            } catch {
              html = "";
            }

            const incoming: any = {
              buckets: {
                fields: richFields,
              },
              metrics: samplesCount
                ? { items: samplesCount }
                : undefined,
            };

            await upsertProfile(
              host,
              incoming,
              html,
              { source: "teach" } as any
            );

            await page.evaluate((last) => {
              (window as any).__FS_TEACH_SAVED__ = true;
              (window as any).__FS_TEACH_LAST__ = last;
            }, payload);

            console.log(
              "[fs-teach] host profile saved for",
              host
            );
            return { ok: true };
          } catch (err: any) {
            console.warn(
              "[fs-teach] FS_HOST_SAVE failed:",
              err
            );
            return {
              ok: false,
              error: String(err),
            };
          }
        }
      );

      await page.addInitScript(() => {
        (window as any).__FS_SAVE_BOUND__ = true;
      });
    }
  } catch (e: any) {
    if (
      !/already registered/i.test(
        String(e?.message || e)
      )
    ) {
      throw e;
    }
  }

  // 4) Inject overlay
  await page.addInitScript(OVERLAY_JS);
  log.info("[teach] overlay script added");
}

/* ========================= 3) Waiters ========================= */

export async function waitForTeachOverlay(
  page: Page,
  logger: TeachLogger = defaultLogger
) {
  try {
    await page.waitForFunction(
      () =>
        (window as any).__FS_TEACH_READY__ === true ||
        !!document.querySelector(
          "#fs-teach-host[data-ready='1']"
        ),
      { timeout: 60_000, polling: "raf" }
    );

    const first = await page.evaluate(() => {
      const w: any = window as any;
      if (w.__FS_TEACH_READY_LOGGED__) return false;
      w.__FS_TEACH_READY_LOGGED__ = true;
      return true;
    });

    if (first) {
      logger.info("[teach] overlay ready on page");
    }
  } catch {
    logger.warn(
      "[teach] overlay not confirmed (it may still be visible)"
    );
  }
}

export async function waitForTeachSave(
  page: Page,
  logger: TeachLogger = defaultLogger,
  timeoutMs = 5 * 60_000
): Promise<OverlayPayload | null> {
  logger.info(
    "[teach] waiting for manual picks... (click Save in the overlay)"
  );

  const viaConsole = page
    .waitForEvent("console", {
      timeout: timeoutMs,
      predicate: (m) =>
        /^\[fs-teach:SAVED]\s+/.test(m.text()),
    })
    .then((m) => {
      const match = m
        .text()
        .match(/^\[fs-teach:SAVED]\s+(.*)$/);
      return match
        ? (JSON.parse(
            match[1]
          ) as OverlayPayload)
        : null;
    })
    .catch(() => null);

  const viaWindow = page
    .waitForFunction(
      () =>
        (window as any).__FS_TEACH_SAVED__ === true,
      { timeout: timeoutMs, polling: "raf" }
    )
    .then(() =>
      page.evaluate(
        () =>
          (window as any).__FS_TEACH_LAST__ ||
          null
      )
    )
    .catch(() => null);

  const result = await Promise.race([
    viaConsole,
    viaWindow,
  ]).catch(() => null);

  if (result) {
    logger.info(
      "[teach] picks received for",
      result.url || "(unknown url)"
    );
  } else {
    logger.warn("[teach] no picks before timeout");
  }

  return result;
}

export async function waitForTeachSaveResilient(
  page: Page,
  logger: TeachLogger = defaultLogger,
  timeoutMs = 10 * 60_000
): Promise<OverlayPayload | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await waitForTeachOverlay(page, logger);
    } catch {
      // ignore
    }

    const timeLeft = Math.max(
      5_000,
      deadline - Date.now()
    );

    const saveP = waitForTeachSave(
      page,
      logger,
      timeLeft
    );

    const navP = new Promise<null>((resolve) => {
      const onNav = (f: any) => {
        if (f === page.mainFrame()) {
          cleanup();
          resolve(null);
        }
      };
      const onClose = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        page.off(
          "framenavigated",
          onNav as any
        );
        page.off("close", onClose);
        page.off("crash", onClose);
      };
      page.on(
        "framenavigated",
        onNav as any
      );
      page.on("close", onClose);
      page.on("crash", onClose);
    });

    const result = await Promise.race([
      saveP,
      navP,
    ]).catch(() => null);

    if (result) return result;

    if (page.isClosed()) {
      throw new Error(
        "Page closed while waiting for save"
      );
    }

    logger.info(
      "[teach] navigation/refresh detected — re-arming save waiters"
    );
  }

  logger.warn(
    "[teach] timed out waiting for manual picks"
  );
  return null;
}

/* ========================= 4) Overlay JS (generic picker) ========================= */

const OVERLAY_JS = String.raw`
(function () {
  if (window.top !== window) return;
  if (window.__FS_TEACH_LOADED__) return;
  window.__FS_TEACH_LOADED__ = true;

  function cssEscape(v){ try { return CSS.escape(v); } catch(_) { return String(v).replace(/["\\]/g,'\\$&'); } }

  function seg(el){
    if (!el || el.nodeType!==1) return 'div';
    if (el.id) return '#'+cssEscape(el.id);
    var tag = el.tagName.toLowerCase();
    var cls=(el.className||'').toString().trim().split(/\\s+/).filter(Boolean).slice(0,2);
    return cls.length ? tag+'.'+cls.map(cssEscape).join('.') : tag;
  }

  function toSel(el){
    var parts=[]; var cur=el;
    while(cur && cur.nodeType===1 && parts.length<6){
      var s=seg(cur);
      var p=cur.parentElement;
      if (p){
        var sib=[]; for (var i=0;i<p.children.length;i++){ if (p.children[i].tagName===cur.tagName) sib.push(p.children[i]); }
        if (sib.length>1){
          var idx=1, n=0;
          for (var j=0;j<p.children.length;j++){
            var ch=p.children[j];
            if (ch.tagName===cur.tagName){ n++; if (ch===cur){ idx=n; break; } }
          }
          s += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(s); cur=p;
    }
    return parts.join(' > ');
  }

  function val(el, attr){
    if (!el) return null;
    if (attr === 'text') return (el.textContent || '').trim().replace(/\\s{2,}/g,' ');
    return el.getAttribute(attr) || null;
  }

  function guessAttr(kind){
    if (kind === 'image') return 'src';
    if (kind === 'href') return 'href';
    return 'text';
  }

  function ensureHost(){
    var host=document.getElementById('fs-teach-host');
    if (host) return host;
    host=document.createElement('div');
    host.id='fs-teach-host';
    host.setAttribute(
      'style',
      'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:auto;'
    );
    document.documentElement.appendChild(host);
    return host;
  }

  function install(){
    var host=ensureHost();
    if (!host.shadowRoot) host.attachShadow({mode:'open'});
    var sh=host.shadowRoot;

    sh.innerHTML = ''
      + '<style>'
      + ':host{all:initial;font:12px system-ui,sans-serif}'
      + '.p{background:#111;color:#fff;border-radius:10px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);width:240px;display:grid;gap:6px}'
      + '.bar{display:flex;justify-content:space-between;align-items:center;font-size:11px;cursor:move}'
      + 'button{all:unset;background:#222;color:#fff;border:1px solid #333;border-radius:4px;padding:3px 5px;cursor:pointer;font-size:10px}'
      + '.grid{display:grid;gap:3px;grid-template-columns:1fr 1fr}'
      + '.row{display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap}'
      + '#x{padding:0 6px}'
      + '#s{font-size:9px;opacity:.85;min-height:10px}'
      + '</style>'
      + '<div class="p" id="p">'
      + '  <div class="bar" id="drag"><span>FlowScrape Teach</span><button id="x">✕</button></div>'
      + '  <div class="grid">'
      + '    <button data-f="title">Title</button><button data-f="href">Href</button>'
      + '    <button data-f="price">Price</button><button data-f="image">Image</button>'
      + '    <button data-f="desc">Desc</button>'
      + '  </div>'
      + '  <div id="s"></div>'
      + '  <div class="row"><button id="test">Test</button><button id="save" style="background:#22c55e;color:#000">Save</button></div>'
      + '</div>';

    var shield=document.getElementById('fs-teach-shield');
    if (!shield){
      shield=document.createElement('div');
      shield.id='fs-teach-shield';
      shield.setAttribute(
        'style',
        'position:fixed;inset:0;z-index:2147483646;background:transparent;display:none;cursor:crosshair;pointer-events:auto;'
      );
      document.documentElement.appendChild(shield);
    }

    var hover=document.getElementById('fs-teach-hover');
    if (!hover){
      hover=document.createElement('div');
      hover.id='fs-teach-hover';
      hover.setAttribute(
        'style',
        'position:absolute;border:2px dashed #22c55e;pointer-events:none;z-index:2147483647;background:rgba(34,197,94,.12);display:none'
      );
      document.documentElement.appendChild(hover);
    }

    var s=sh.getElementById('s');
    function setS(m){ s.textContent = m || ''; }

    var picking=null;
    var fields = {};

    function pickTarget(e){
      var prev = shield.style.pointerEvents;
      shield.style.pointerEvents = 'none';
      var el = document.elementFromPoint(e.clientX, e.clientY);
      shield.style.pointerEvents = prev || 'auto';
      if (!el || host.contains(el)) return null;
      return el;
    }

    function onHover(e){
      var el=pickTarget(e);
      if(!el){ hover.style.display='none'; return; }
      var r=el.getBoundingClientRect();
      hover.style.display='block';
      hover.style.top=(window.scrollY+r.top)+'px';
      hover.style.left=(window.scrollX+r.left)+'px';
      hover.style.width=r.width+'px';
      hover.style.height=r.height+'px';
    }

    function eat(e){
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    function stop(){
      shield.style.display='none';
      shield.removeEventListener('mousemove', onHover, true);
      shield.removeEventListener('click', onClick, true);
      shield.removeEventListener('mousedown', eat, true);
      shield.removeEventListener('mouseup', eat, true);
      shield.removeEventListener('pointerdown', eat, true);
      shield.removeEventListener('pointerup', eat, true);
      hover.style.display='none';
      picking=null;
    }

    function start(kind){
      picking=kind;
      setS('Click element for ' + kind.toUpperCase());
      shield.style.display='block';
      shield.addEventListener('mousemove', onHover, true);
      shield.addEventListener('click', onClick, true);
      shield.addEventListener('mousedown', eat, true);
      shield.addEventListener('mouseup', eat, true);
      shield.addEventListener('pointerdown', eat, true);
      shield.addEventListener('pointerup', eat, true);
    }

    function onClick(e){
      eat(e);
      var el = pickTarget(e);
      if (!el){ stop(); return; }
      var sel = toSel(el);
      var attr = guessAttr(picking);
      fields[picking] = { sel: sel, attr: attr };
      console.log('[fs-teach:PICK]', picking, JSON.stringify(fields[picking]));
      setS(picking.toUpperCase() + ' = ' + sel + ' [' + attr + ']');
      stop();
    }

    // drag
    (function(){
      var drag=sh.getElementById('drag');
      var startX=0,startY=0,startTop=12,startRight=12,dragging=false;
      function onDown(e){
        e.preventDefault();
        dragging=true;
        var r=host.getBoundingClientRect();
        startX=e.clientX; startY=e.clientY;
        startTop=r.top; startRight=window.innerWidth-r.right;
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
      }
      function onMove(e){
        if(!dragging) return;
        var dy=e.clientY-startY;
        var dx=e.clientX-startX;
        var nt=Math.max(0,startTop+dy);
        var nr=Math.max(0,startRight-dx);
        host.style.top=nt+'px';
        host.style.right=nr+'px';
      }
      function onUp(){
        dragging=false;
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
      }
      if(drag) drag.addEventListener('mousedown', onDown, true);
    })();

    // close
    var x=sh.getElementById('x');
    if (x){
      x.addEventListener('click', function(){
        try{ host.style.display='none'; }catch(_){}
        stop();
      });
    }

    // field buttons
    sh.querySelectorAll('[data-f]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var f = btn.getAttribute('data-f');
        if (f) start(f);
      });
    });

    // test
    var testBtn=sh.getElementById('test');
    if (testBtn) testBtn.addEventListener('click', function(){
      var out = {};
      Object.keys(fields).forEach(function(k){
        var f = fields[k];
        var el = document.querySelector(f.sel);
        out[k] = val(el, f.attr || 'text');
      });
      console.log('[fs-teach:TEST]', out);
      alert('Sample logged to console.');
    });

    // save
    var saveBtn=sh.getElementById('save');
    if (saveBtn) saveBtn.addEventListener('click', function(){
      var keys = Object.keys(fields);
      if (!keys.length){
        alert('Pick at least one field.');
        return;
      }

      var sample = {};
      keys.forEach(function(k){
        var f = fields[k];
        var el = document.querySelector(f.sel);
        sample[k] = val(el, f.attr || 'text');
      });

      var payload = {
        host: location.host,
        url: location.href,
        fields: fields,
        samples: [sample]
      };

      saveBtn.setAttribute('disabled','true');
      saveBtn.textContent='Saving…';

      function finish(ok){
        try{
          if (ok) {
            window.__FS_TEACH_LAST__ = payload;
            window.__FS_TEACH_SAVED__ = true;
          }
          console.log('[fs-teach:SAVED] ' + JSON.stringify(payload));
        }catch(_){}
        try{ host.style.display='none'; }catch(_){}
        stop();
        if (!ok){
          alert('Selectors could not be saved. Check console for FS_HOST_SAVE error.');
        }
      }

      try{
        if (window.FS_HOST_SAVE){
          var ret = window.FS_HOST_SAVE(payload);
          if (ret && typeof ret.then === 'function'){
            ret.then(function(){ finish(true); }).catch(function(e){
              console.warn('[fs-teach] FS_HOST_SAVE rejected:', e);
              finish(false);
            });
          } else {
            finish(true);
          }
        } else {
          finish(false);
        }
      }catch(e){
        console.warn('[fs-teach] FS_HOST_SAVE error:', e && e.message ? e.message : e);
        finish(false);
      }
    });

    host.setAttribute('data-ready','1');
    window.__FS_TEACH_READY__ = true;
    console.log('[fs-teach:READY]');
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', install, { once:true, capture:true });
  } else {
    install();
  }

  var mo = new MutationObserver(function(){
    if (!document.getElementById('fs-teach-host')) install();
  });
  try { mo.observe(document.documentElement, { childList:true, subtree:true }); } catch(_){}
})();
`;
