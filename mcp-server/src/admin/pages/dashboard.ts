import { dailyDigest } from "@mytime/db";
import type { Request } from "express";
import { adminWriteDb, adminWritePool } from "../../writePool.js";

// ── Data gathering ──────────────────────────────────────────────────────────

interface NameRow {
  id: string;
  name: string;
}
interface CountRow {
  target_id: string;
  n: string;
}
interface DiscRow {
  target_id: string;
  name: string;
  brand: string | null;
  category: string | null;
  gender: string | null;
  reg: number | null;
  sale: number | null;
  pct: number | null;
}
interface MoveRow {
  target_id: string;
  name: string;
  brand: string | null;
  gender: string | null;
  from_price: number | null;
  to_price: number | null;
}
interface StockRow {
  target_id: string;
  name: string;
  gender: string | null;
}
interface AdRow {
  target_id: string;
  ad_title: string | null;
  days_running: number | null;
  media_url: string | null;
  media_type: string | null;
  link_url: string | null;
  snapshot_url: string | null;
}

/** Gather everything the dashboard needs: the digest block + fuller drill-down lists. */
async function gather(): Promise<unknown> {
  const db = adminWriteDb();
  const pool = adminWritePool();

  const [digest, names, counts, disc, ads, moves, stock] = await Promise.all([
    dailyDigest(db),
    pool.query<NameRow>("SELECT id, name FROM targets WHERE is_self = false"),
    pool.query<CountRow>(`
      SELECT p.target_id, count(*)::text AS n FROM products p
      WHERE p.active = true
        AND p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
      GROUP BY p.target_id`),
    pool.query<DiscRow>(`
      WITH latest AS (
        SELECT p.target_id, max(pr.captured_date) d
        FROM prices pr JOIN products p ON p.id = pr.product_id
        WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        GROUP BY p.target_id
      ),
      onsale AS (
        SELECT p.target_id, p.name, p.brand, p.category, p.gender,
               pr.price::float8 AS reg, pr.sale_price::float8 AS sale, pr.discount_pct::float8 AS pct,
               ROW_NUMBER() OVER (PARTITION BY p.target_id ORDER BY pr.discount_pct DESC NULLS LAST) AS rn
        FROM prices pr
        JOIN products p ON p.id = pr.product_id
        JOIN latest l ON l.target_id = p.target_id AND pr.captured_date = l.d
        WHERE pr.discount_pct > 0
      )
      SELECT target_id, name, brand, category, gender, reg, sale, pct FROM onsale WHERE rn <= 100
      ORDER BY target_id, pct DESC`),
    pool.query<AdRow>(`
      WITH latest AS (
        SELECT target_id, max(captured_date) d FROM ad_observations
        WHERE target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
        GROUP BY target_id
      ),
      a AS (
        SELECT ao.target_id, ao.ad_title, ao.days_running, ao.media_url, ao.media_type,
               ao.link_url, ao.snapshot_url,
               ROW_NUMBER() OVER (PARTITION BY ao.target_id ORDER BY ao.days_running DESC NULLS LAST) AS rn
        FROM ad_observations ao
        JOIN latest l ON l.target_id = ao.target_id AND ao.captured_date = l.d
      )
      SELECT target_id, ad_title, days_running, media_url, media_type, link_url, snapshot_url
      FROM a WHERE rn <= 40 ORDER BY target_id, days_running DESC NULLS LAST`),
    pool.query<MoveRow>(`
      WITH ranked AS (
        SELECT pr.product_id, p.target_id, p.name, p.brand, p.gender, pr.price::float8 AS price,
               ROW_NUMBER() OVER (PARTITION BY pr.product_id ORDER BY pr.captured_date DESC) AS rn
        FROM prices pr JOIN products p ON p.id = pr.product_id
        WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
          AND pr.captured_date >= (CURRENT_DATE - INTERVAL '21 days')
      ),
      piv AS (
        SELECT target_id, name, brand, gender,
               max(price) FILTER (WHERE rn = 1) AS to_p,
               max(price) FILTER (WHERE rn = 2) AS from_p
        FROM ranked WHERE rn <= 2 GROUP BY product_id, target_id, name, brand, gender
      ),
      m AS (
        SELECT target_id, name, brand, gender, from_p, to_p,
               ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY abs(to_p - from_p)/NULLIF(from_p,0) DESC) AS rn
        FROM piv WHERE from_p IS NOT NULL AND from_p > 0 AND abs(to_p - from_p)/from_p > 0.05
      )
      SELECT target_id, name, brand, gender, from_p AS from_price, to_p AS to_price
      FROM m WHERE rn <= 60 ORDER BY target_id`),
    pool.query<StockRow>(`
      WITH ranked AS (
        SELECT inv.product_id, p.target_id, p.name, p.gender, inv.stock_status,
               ROW_NUMBER() OVER (PARTITION BY inv.product_id ORDER BY inv.captured_date DESC) AS rn
        FROM inventory_snapshots inv JOIN products p ON p.id = inv.product_id
        WHERE p.target_id NOT IN (SELECT id FROM targets WHERE is_self = true)
          AND inv.captured_date >= (CURRENT_DATE - INTERVAL '21 days')
      ),
      piv AS (
        SELECT target_id, name, gender,
               max(stock_status::text) FILTER (WHERE rn = 1) AS now_s,
               max(stock_status::text) FILTER (WHERE rn = 2) AS prior_s
        FROM ranked WHERE rn <= 2 GROUP BY product_id, target_id, name, gender
      )
      SELECT target_id, name, gender FROM (
        SELECT target_id, name, gender,
               ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY name) AS rk
        FROM piv WHERE now_s = 'out_of_stock' AND prior_s = 'in_stock'
      ) z WHERE rk <= 60 ORDER BY target_id`),
  ]);

  const nameOf = new Map(names.rows.map((r) => [r.id, r.name]));
  const countOf = new Map(counts.rows.map((r) => [r.target_id, Number(r.n)]));

  // New-ad + best-ad snapshot sets per competitor (from the digest) to flag ad cards.
  const newSnaps = new Map<string, Set<string>>();
  const bestSnap = new Map<string, string>();
  for (const c of digest.competitors) {
    const s = new Set<string>();
    for (const a of c.ads.new) if (a.snapshotUrl) s.add(a.snapshotUrl);
    newSnaps.set(c.targetId, s);
    if (c.ads.longestRunning?.snapshotUrl) {
      bestSnap.set(c.targetId, c.ads.longestRunning.snapshotUrl);
    }
  }

  const competitors = digest.competitors.map((c) => ({
    id: c.targetId,
    name: nameOf.get(c.targetId) ?? c.targetId,
    products: countOf.get(c.targetId) ?? 0,
    onSale: c.sales.onSaleToday,
    avgPct: c.sales.avgPct,
    newlyDiscounted: c.sales.newlyDiscounted,
    newAds: c.ads.new.length,
    activeAds: c.ads.activeToday,
    followerDelta: Object.values(c.social.followers).reduce((a, b) => a + b, 0),
    newProducts: c.inventory.newProducts,
    stockouts: c.inventory.newStockouts,
    priceMoves: c.inventory.priceMoves,
    byBrand: c.sales.byBrand,
    byCategory: c.sales.byCategory,
  }));

  const discounts = disc.rows.map((r) => ({
    competitor: r.target_id,
    name: r.name,
    brand: r.brand,
    category: r.category,
    gender: r.gender,
    reg: r.reg,
    sale: r.sale,
    pct: r.pct,
  }));

  const priceMoves = moves.rows.map((r) => ({
    competitor: r.target_id,
    name: r.name,
    brand: r.brand,
    gender: r.gender,
    from: r.from_price,
    to: r.to_price,
  }));
  const stockouts = stock.rows.map((r) => ({
    competitor: r.target_id,
    name: r.name,
    gender: r.gender,
  }));

  const adList = ads.rows.map((r) => ({
    competitor: r.target_id,
    title: r.ad_title,
    days: r.days_running,
    mediaUrl: r.media_url,
    mediaType: r.media_type,
    linkUrl: r.link_url,
    snapshotUrl: r.snapshot_url,
    isNew: r.snapshot_url != null && (newSnaps.get(r.target_id)?.has(r.snapshot_url) ?? false),
    isBest: r.snapshot_url != null && bestSnap.get(r.target_id) === r.snapshot_url,
  }));

  const totals = {
    onSale: competitors.reduce((a, c) => a + c.onSale, 0),
    activeAds: competitors.reduce((a, c) => a + c.activeAds, 0),
    newAds: competitors.reduce((a, c) => a + c.newAds, 0),
    deepest: Math.round(Math.max(0, ...discounts.map((d) => d.pct ?? 0))),
  };

  return {
    date: digest.generatedFor,
    totals,
    competitors,
    discounts,
    ads: adList,
    priceMoves,
    stockouts,
  };
}

// ── Page ────────────────────────────────────────────────────────────────────

export async function render(_req: Request): Promise<string> {
  let payload: unknown;
  try {
    payload = await gather();
  } catch (err) {
    return `<p class="error">Dashboard failed to load: ${(err as Error).message}</p>`;
  }
  // Embed safely inside a <script> tag.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `${DASH_CSS}
  <div class="dash">
    <div class="tabbar">
      <button class="dtab on" data-tab="overview">Overview</button>
      <button class="dtab" data-tab="discounts">Discounts</button>
      <button class="dtab" data-tab="ads">Ads</button>
      <button class="dtab" data-tab="pricing">Pricing &amp; inventory</button>
      <span id="filter-chip" class="chip" style="display:none;"></span>
    </div>
    <div id="panel-overview" class="panel"></div>
    <div id="panel-discounts" class="panel" hidden></div>
    <div id="panel-ads" class="panel" hidden></div>
    <div id="panel-pricing" class="panel" hidden></div>
  </div>
  <script type="application/json" id="dash-data">${json}</script>
  <script>${DASH_JS}</script>`;
}

// ── Dashboard CSS (scoped under .dash) ────────────────────────────────────────

const DASH_CSS = `<style>
  .dash { margin-top: -.5rem; }
  .tabbar { display:flex; gap:4px; border-bottom:1px solid var(--border); margin-bottom:1.1rem; flex-wrap:wrap; align-items:center; }
  .dtab { font-family:'Roboto Condensed',sans-serif; font-weight:700; text-transform:uppercase; font-size:.78rem; letter-spacing:.04em;
    color:var(--muted); background:none; border:none; padding:.6rem .85rem; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; }
  .dtab:hover { color:var(--ink); }
  .dtab.on { color:var(--accent); border-bottom-color:var(--accent); }
  .chip { margin-left:auto; font-size:.78rem; background:rgba(41,82,128,.08); color:var(--accent); border-radius:999px; padding:.25rem .65rem; cursor:pointer; }
  .chip:hover { background:rgba(41,82,128,.16); }
  .kgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:.75rem; margin-bottom:1.25rem; }
  .kc { background:var(--surface); border-radius:var(--radius); padding:.9rem 1rem; }
  .kc .n { font-family:'Roboto Condensed',sans-serif; font-weight:700; font-size:1.7rem; color:var(--ink); line-height:1; }
  .kc .l { font-size:.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-top:.3rem; }
  table.dt { width:100%; border-collapse:separate; border-spacing:0; font-size:.82rem; background:var(--bg); border:1px solid var(--border);
    border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow); }
  table.dt th { font-family:'Roboto Condensed',sans-serif; font-weight:700; text-transform:uppercase; font-size:.68rem; letter-spacing:.04em;
    color:var(--ink); background:var(--surface); text-align:right; padding:.55rem .6rem; border-bottom:1px solid var(--border); cursor:pointer; white-space:nowrap; }
  table.dt th.l, table.dt td.l { text-align:left; }
  table.dt td { padding:.5rem .6rem; border-bottom:1px solid #eef0f3; text-align:right; color:var(--slate); }
  table.dt tr:last-child td { border-bottom:none; }
  table.dt tbody tr.clk:hover td { background:#fafbfc; cursor:pointer; }
  .nm { font-weight:500; color:var(--ink); }
  .bartrack { display:inline-block; width:46px; height:7px; border-radius:4px; background:#f0e2e0; vertical-align:middle; margin-right:6px; }
  .bar { display:inline-block; height:7px; border-radius:4px; background:var(--danger); vertical-align:middle; }
  .badge-off { font-family:'Roboto Condensed',sans-serif; font-weight:700; font-size:.66rem; padding:.1rem .4rem; border-radius:999px; background:var(--err-bg); color:var(--danger); }
  .badge-new { background:rgba(41,82,128,.1); color:var(--accent); }
  .badge-best { background:var(--ok-bg); color:var(--ok-fg); }
  .miniwrap { display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-bottom:1.25rem; }
  .h3 { font-family:'Roboto Condensed',sans-serif; font-weight:700; color:var(--ink); font-size:.95rem; margin:0 0 .5rem; }
  .filters { display:flex; gap:.5rem; flex-wrap:wrap; margin-bottom:.9rem; align-items:center; }
  .filters select, .filters input { padding:.4rem .6rem; border:1px solid var(--border); border-radius:8px; font:inherit; font-size:.8rem; background:var(--bg); margin:0; width:auto; }
  .adgrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:.85rem; }
  .adcard { border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; background:var(--bg); box-shadow:var(--shadow); display:flex; flex-direction:column; }
  .adthumb { width:100%; height:130px; background:var(--surface); object-fit:cover; display:block; }
  .adthumb.ph { display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:.72rem; }
  .adbody { padding:.55rem .65rem; }
  .adtitle { font-size:.78rem; color:var(--ink); font-weight:500; line-height:1.3; max-height:2.6em; overflow:hidden; }
  .admeta { font-size:.7rem; color:var(--muted); margin-top:.3rem; display:flex; gap:.35rem; align-items:center; flex-wrap:wrap; }
  .vidtag { font-size:.62rem; background:var(--ink); color:#fff; border-radius:4px; padding:0 .25rem; }
  .secnote { font-size:.78rem; color:var(--muted); margin:.2rem 0 1rem; }
  @media (max-width:640px){ .miniwrap{ grid-template-columns:1fr; } }
</style>`;

// ── Dashboard JS (no backticks / no ${} so it nests safely in the page string) ─

const DASH_JS = String.raw`
(function(){
  var D = JSON.parse(document.getElementById('dash-data').textContent);
  var nameOf = {}; D.competitors.forEach(function(c){ nameOf[c.id] = c.name; });
  var state = { tab:'overview', comp:null, gender:'', sort:{ key:'onSale', dir:-1 } };

  function fmt(n){ if(n==null) return '—'; return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.'); }
  function pct(n){ return n==null ? '—' : Math.round(n)+'%'; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function bar(p){ if(p==null) return '—'; var w=Math.max(2,Math.round(p*0.9)); return '<span class="bartrack"><span class="bar" style="width:'+w+'px"></span></span>'+Math.round(p)+'%'; }

  var GLAB={mens:'Men',womens:'Women',unisex:'Unisex',kids:'Kids'};
  function gmatch(g,f){ if(!f) return true; if(f==='__none') return !g; return g===f; }
  function vendorSel(){ var o='<option value="">All vendors</option>';
    D.competitors.slice().sort(function(a,b){return a.name.localeCompare(b.name);}).forEach(function(c){
      o+='<option value="'+c.id+'"'+(state.comp===c.id?' selected':'')+'>'+esc(c.name)+'</option>'; });
    return '<select class="f-vendor">'+o+'</select>'; }
  function genderSel(){ var opts=[['','All genders'],['mens','Men'],['womens','Women'],['unisex','Unisex'],['kids','Kids'],['__none','Unknown']];
    return '<select class="f-gender">'+opts.map(function(o){ return '<option value="'+o[0]+'"'+(state.gender===o[0]?' selected':'')+'>'+o[1]+'</option>'; }).join('')+'</select>'; }
  // Wire the global vendor/gender selects in a panel: changing either re-renders the tab.
  function wireGlobals(el){
    var v=el.querySelector('.f-vendor'); if(v) v.onchange=function(){ setComp(v.value||null); show(state.tab); };
    var g=el.querySelector('.f-gender'); if(g) g.onchange=function(){ state.gender=g.value; show(state.tab); };
  }

  function renderOverview(){
    var t=D.totals;
    var k='<div class="kgrid">'
      +'<div class="kc"><div class="n">'+fmt(t.onSale)+'</div><div class="l">Items on sale</div></div>'
      +'<div class="kc"><div class="n">'+fmt(t.activeAds)+'</div><div class="l">Active ads</div></div>'
      +'<div class="kc"><div class="n">'+fmt(t.newAds)+'</div><div class="l">New ads</div></div>'
      +'<div class="kc"><div class="n">'+pct(t.deepest)+'</div><div class="l">Deepest discount</div></div>'
      +'</div>';
    var cols=[['name','Competitor','l'],['products','Products'],['onSale','On sale'],['avgPct','Avg disc.'],
      ['activeAds','Ads'],['newAds','New'],['followerDelta','Followers'],['newProducts','New prod.'],['stockoutN','Stockouts']];
    var data=D.competitors.map(function(c){ return Object.assign({}, c, { stockoutN:(c.stockouts||[]).length }); });
    var sk=state.sort.key, dir=state.sort.dir;
    data.sort(function(a,b){ var x=a[sk], y=b[sk]; if(sk==='name'){return dir*String(x).localeCompare(String(y));} return dir*((x||0)-(y||0)); });
    var h='<table class="dt"><thead><tr>'+cols.map(function(c){
      var ar = sk===c[0] ? (dir<0?' ▾':' ▴') : ''; return '<th class="'+(c[2]||'')+'" data-k="'+c[0]+'">'+c[1]+ar+'</th>';
    }).join('')+'</tr></thead><tbody>'+data.map(function(c){
      return '<tr class="clk" data-comp="'+c.id+'">'
        +'<td class="l nm">'+esc(c.name)+'</td><td>'+fmt(c.products)+'</td><td>'+fmt(c.onSale)+'</td>'
        +'<td>'+(c.avgPct==null?'—':bar(c.avgPct))+'</td><td>'+fmt(c.activeAds)+'</td>'
        +'<td>'+(c.newAds?'<span class="badge-off badge-new">'+c.newAds+'</span>':'0')+'</td>'
        +'<td>'+(c.followerDelta>0?'+':'')+fmt(c.followerDelta)+'</td><td>'+fmt(c.newProducts)+'</td><td>'+fmt(c.stockoutN)+'</td></tr>';
    }).join('')+'</tbody></table>';
    var el=document.getElementById('panel-overview');
    el.innerHTML=k+h+'<p class="secnote">Click a competitor to drill into its discounts, ads &amp; pricing. Click a column to sort.</p>';
    el.querySelectorAll('th[data-k]').forEach(function(th){ th.onclick=function(){ var key=th.getAttribute('data-k');
      if(state.sort.key===key){state.sort.dir*=-1;}else{state.sort.key=key;state.sort.dir=(key==='name'?1:-1);} renderOverview(); }; });
    el.querySelectorAll('tr[data-comp]').forEach(function(tr){ tr.onclick=function(){ setComp(tr.getAttribute('data-comp')); show('discounts'); }; });
  }

  function renderDiscounts(){
    var items=D.discounts.filter(function(d){ return (!state.comp || d.competitor===state.comp) && gmatch(d.gender,state.gender); });
    var brands={}, cats={};
    D.competitors.forEach(function(c){ if(state.comp && c.id!==state.comp) return;
      (c.byBrand||[]).forEach(function(b){ var key=b.brand; if(!brands[key])brands[key]={count:0,sum:0}; brands[key].count+=b.count; brands[key].sum+=(b.avgPct||0)*b.count; });
      (c.byCategory||[]).forEach(function(b){ var key=b.category; if(!cats[key])cats[key]={count:0,sum:0}; cats[key].count+=b.count; cats[key].sum+=(b.avgPct||0)*b.count; });
    });
    function miniTable(obj,label){ var arr=Object.keys(obj).map(function(k){return {k:k,count:obj[k].count,avg:obj[k].sum/obj[k].count};});
      arr.sort(function(a,b){return b.count-a.count;}); arr=arr.slice(0,8);
      if(!arr.length) return '<div><div class="h3">'+label+'</div><p class="secnote">No discounts.</p></div>';
      return '<div><div class="h3">'+label+'</div><table class="dt"><tbody>'+arr.map(function(r){
        return '<tr><td class="l nm">'+esc(r.k)+'</td><td>'+r.count+'</td><td>'+bar(r.avg)+'</td></tr>';
      }).join('')+'</tbody></table></div>'; }
    var mini='<div class="miniwrap">'+miniTable(brands,'Most-discounted brands')+miniTable(cats,'Most-discounted categories')+'</div>';

    // Brand options (present in the current competitor filter) + a high-level category group.
    var brandList=[], seenB={};
    items.forEach(function(d){ if(d.brand && !seenB[d.brand]){ seenB[d.brand]=1; brandList.push(d.brand); } });
    brandList.sort(function(a,b){ return a.localeCompare(b); });
    var fbar='<div class="filters">'+vendorSel()+genderSel()
      +'<select id="f-brand"><option value="">All brands ('+brandList.length+')</option>'
      +brandList.map(function(b){ return '<option>'+esc(b)+'</option>'; }).join('')+'</select>'
      +'<select id="f-group"><option value="">All categories</option><option>Watches</option>'
      +'<option>Jewelry</option><option>Accessories</option><option>Other</option></select></div>';
    var panel=document.getElementById('panel-discounts');
    panel.innerHTML=mini+fbar+'<div class="h3" id="disc-count"></div><div id="disc-items"></div>';
    wireGlobals(panel);
    function drawItems(){
      var fb=document.getElementById('f-brand').value, fg=document.getElementById('f-group').value;
      var list=items.filter(function(d){ return (!fb||d.brand===fb) && (!fg||groupOf(d.category,d.name)===fg); });
      document.getElementById('disc-count').textContent='On-sale items ('+list.length+')';
      var rows=list.slice(0,400).map(function(d){
        return '<tr><td class="l nm">'+esc(d.name)+'</td><td class="l">'+esc(d.brand||'—')+'</td><td class="l">'+esc(d.category||'—')+'</td>'
          +'<td>'+fmt(d.reg)+'</td><td>'+fmt(d.sale)+'</td><td><span class="badge-off">-'+Math.round(d.pct||0)+'%</span></td></tr>';
      }).join('');
      document.getElementById('disc-items').innerHTML='<table class="dt"><thead><tr>'
        +'<th class="l">Product</th><th class="l">Brand</th><th class="l">Category</th><th>Was</th><th>Now</th><th>Off</th></tr></thead><tbody>'
        +(rows||'<tr><td class="l" colspan="6">No items match.</td></tr>')+'</tbody></table>';
    }
    document.getElementById('f-brand').onchange=drawItems;
    document.getElementById('f-group').onchange=drawItems;
    drawItems();
  }

  // High-level category classifier — raw categories are granular & Macedonian.
  function groupOf(cat,name){
    var s=((cat||'')+' '+(name||'')).toLowerCase();
    if(/часовник|\bwatch/.test(s)) return 'Watches';
    if(/накит|прстен|обетк|ѓердан|белегз|приврзок|синџир|алк[аи]|jewel|ring|necklace|bracelet|earring|pendant|chain/.test(s)) return 'Jewelry';
    if(/ремен|ремч|каиш|strap|band|додаток|додатоци|accessor|кутиј|пишување|пенкало/.test(s)) return 'Accessories';
    return 'Other';
  }

  function renderAds(){
    var el=document.getElementById('panel-ads');
    var ads=D.ads.filter(function(a){ return !state.comp || a.competitor===state.comp; });
    var ctrl='<div class="filters">'+vendorSel()
      +'<label style="font-size:.8rem;color:var(--muted);margin:0;"><input type="checkbox" id="ad-new"> New only</label>'
      +'<label style="font-size:.8rem;color:var(--muted);margin:0;"><input type="checkbox" id="ad-best"> Best only</label></div>';
    function draw(){
      var newOnly=document.getElementById('ad-new').checked, bestOnly=document.getElementById('ad-best').checked;
      var list=ads.filter(function(a){ return (!newOnly||a.isNew)&&(!bestOnly||a.isBest); });
      var grid=list.map(function(a){
        var thumb;
        if(a.mediaUrl && a.mediaType!=='VIDEO'){
          thumb='<img class="adthumb" src="'+esc(a.mediaUrl)+'" loading="lazy" onerror="this.className=\'adthumb ph\';this.removeAttribute(\'src\');this.textContent=\'image expired\';">';
        } else if(a.mediaType==='VIDEO'){
          thumb='<div class="adthumb ph">video <span class="vidtag">PLAY</span></div>';
        } else { thumb='<div class="adthumb ph">no media</div>'; }
        var badges=(a.isBest?'<span class="badge-off badge-best">Best</span> ':'')+(a.isNew?'<span class="badge-off badge-new">New</span> ':'');
        var title=a.title && a.title.indexOf('{{')<0 ? a.title : '(dynamic product ad)';
        return '<div class="adcard">'+thumb+'<div class="adbody"><div class="adtitle">'+esc(title)+'</div>'
          +'<div class="admeta">'+badges+esc(nameOf[a.competitor]||a.competitor)+' · '+(a.days!=null?a.days+'d':'?')
          +(a.snapshotUrl?' · <a href="'+esc(a.snapshotUrl)+'" target="_blank" rel="noopener">library ↗</a>':'')+'</div></div></div>';
      }).join('');
      document.getElementById('ad-grid').innerHTML = grid || '<p class="secnote">No ads for this filter.</p>';
    }
    el.innerHTML=ctrl+'<div id="ad-grid" class="adgrid"></div>';
    wireGlobals(el);
    document.getElementById('ad-new').onchange=draw; document.getElementById('ad-best').onchange=draw; draw();
  }

  function renderPricing(){
    function f(arr){ return arr.filter(function(x){ return (!state.comp||x.competitor===state.comp) && gmatch(x.gender,state.gender); }); }
    var moves=f(D.priceMoves), stock=f(D.stockouts);
    var comps=D.competitors.filter(function(c){ return !state.comp || c.id===state.comp; });
    var bar2='<div class="filters">'+vendorSel()+genderSel()+'</div>';
    var mv='<div class="h3">Price moves (&gt;5%, '+moves.length+')</div><table class="dt"><thead><tr><th class="l">Product</th><th class="l">Vendor</th><th class="l">Gender</th><th>From</th><th>To</th><th>Δ</th></tr></thead><tbody>'
      +(moves.slice(0,200).map(function(m){ var d=m.from?Math.round((m.to-m.from)/m.from*100):0;
        return '<tr><td class="l nm">'+esc(m.name)+'</td><td class="l">'+esc(nameOf[m.competitor]||m.competitor)+'</td><td class="l">'+(GLAB[m.gender]||'—')+'</td><td>'+fmt(m.from)+'</td><td>'+fmt(m.to)+'</td><td style="color:'+(d<0?'var(--ok-fg)':'var(--danger)')+'">'+(d>0?'+':'')+d+'%</td></tr>';
      }).join('')||'<tr><td class="l" colspan="6">No notable price moves.</td></tr>')+'</tbody></table>';
    var sl='<div class="h3" style="margin-top:1.25rem;">Recent stockouts ('+stock.length+')</div><table class="dt"><thead><tr><th class="l">Product</th><th class="l">Vendor</th><th class="l">Gender</th></tr></thead><tbody>'
      +(stock.slice(0,200).map(function(s){return '<tr><td class="l nm">'+esc(s.name)+'</td><td class="l">'+esc(nameOf[s.competitor]||s.competitor)+'</td><td class="l">'+(GLAB[s.gender]||'—')+'</td></tr>';}).join('')||'<tr><td class="l" colspan="3">No recent stockouts.</td></tr>')+'</tbody></table>';
    var newp='<div class="h3" style="margin-top:1.25rem;">New products (per vendor)</div><table class="dt"><thead><tr><th class="l">Vendor</th><th>New products</th></tr></thead><tbody>'
      +comps.map(function(c){ return '<tr><td class="l nm">'+esc(c.name)+'</td><td>'+fmt(c.newProducts)+'</td></tr>'; }).join('')+'</tbody></table>';
    var panel=document.getElementById('panel-pricing');
    panel.innerHTML=bar2+mv+sl+newp;
    wireGlobals(panel);
  }

  function show(tab){
    state.tab=tab;
    ['overview','discounts','ads','pricing'].forEach(function(t){ document.getElementById('panel-'+t).hidden = (t!==tab); });
    document.querySelectorAll('.dtab').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-tab')===tab); });
    if(tab==='overview')renderOverview(); else if(tab==='discounts')renderDiscounts(); else if(tab==='ads')renderAds(); else renderPricing();
  }
  function setComp(id){ state.comp=id; var chip=document.getElementById('filter-chip');
    if(id){ chip.style.display='inline-block'; chip.innerHTML='Filter: '+esc(nameOf[id]||id)+' ✕'; } else { chip.style.display='none'; } }
  document.getElementById('filter-chip').onclick=function(){ setComp(null); show(state.tab); };
  document.querySelectorAll('.dtab').forEach(function(b){ b.onclick=function(){ show(b.getAttribute('data-tab')); }; });

  renderOverview();
})();
`;
