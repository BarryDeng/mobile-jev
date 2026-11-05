import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { deflateSync, crc32 } from 'node:zlib';
import { resolveEnemy, resolveRect } from './layout.mjs';
import { enemyBars, healthFill } from './routines.mjs';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Nearest-neighbour downscale to RGB and a fast PNG: the run loop shares this thread, so a frame
// must encode in a few milliseconds, and only when a viewer asks for it.
export function thumbnailPng(image, factor = 3) {
  const width = Math.floor(image.width / factor),
    height = Math.floor(image.height / factor);
  const ch = image.channels,
    src = image.pixels;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const row = y * factor * image.width;
    let o = y * stride + 1;
    for (let x = 0; x < width; x++) {
      const i = (row + x * factor) * ch;
      if (ch >= 3) {
        raw[o++] = src[i];
        raw[o++] = src[i + 1];
        raw[o++] = src[i + 2];
      } else {
        raw[o++] = raw[o++] = raw[o++] = src[i];
      }
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// What the detectors see on a frame: enemy HP bars and the active character's HP bar.
export function frameOverlay(layout, image) {
  const dims = { width: image.width, height: image.height };
  const boxes = [];
  let health = null;
  if (layout?.enemy) {
    const enemy = resolveEnemy(layout.enemy, dims, layout.reference);
    if (enemy.bounds) {
      boxes.push({ kind: 'enemy_area', ...rectBox(enemy.bounds) });
      for (const bar of enemyBars(image, enemy.bounds, dims, enemy, enemy.scale))
        boxes.push({
          kind: 'enemy_bar',
          x: bar.x - bar.w / 2,
          y: bar.y - bar.h / 2,
          w: bar.w,
          h: bar.h,
        });
    }
  }
  if (layout?.healthBar) {
    const bounds = resolveRect(layout.healthBar, dims, layout.reference);
    if (bounds) {
      boxes.push({ kind: 'health_bar', ...rectBox(bounds) });
      health = healthFill(image, dims, { ...layout.healthBar, bounds });
    }
  }
  return { width: image.width, height: image.height, boxes, health };
}

const rectBox = (b) => ({ x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top });

const short = (value, max = 300) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
};

// Turn a trace event into the few fields a person watching the run needs; undefined = skip.
export function summarizeEvent(event) {
  switch (event.event) {
    case 'observation': {
      const o = event.observation ?? {};
      const texts = Object.fromEntries(
        (o.elements ?? [])
          .filter((e) => e.id?.startsWith('layout-text.') && e.text)
          .map((e) => [e.id.slice('layout-text.'.length), short(e.text, 80)]),
      );
      const routines = (o.elements ?? [])
        .filter((e) => e.id?.startsWith('layout-routine.'))
        .map((e) => e.id.slice('layout-routine.'.length));
      return {
        kind: 'state',
        step: event.step,
        app: o.phone?.packageName ?? null,
        screen: o.layout?.screen ?? null,
        threat: o.layout?.threat ?? null,
        description: short(o.layout?.description ?? null, 600),
        texts,
        routines,
      };
    }
    case 'decision':
      return {
        kind: 'decision',
        step: event.step,
        cycle: event.cycle,
        by: event.supervised ? 'supervisor' : event.status === 'action' ? 'Jev' : 'loop',
        status: event.status,
        operation: event.operation ?? null,
        choice: event.choice ?? null,
        confidence: event.confidence,
        reason: short(event.reason ?? event.label ?? event.message ?? null, 400),
      };
    case 'action_executed':
      return {
        kind: 'action',
        step: event.step,
        operation: event.operation,
        choice: event.action?.elementId ?? event.action?.type ?? null,
        routine: event.routine ?? null,
        executedMs: event.executedMs,
      };
    case 'model_request':
    case 'model_response':
    case 'request_timing':
    case 'frame':
      return undefined;
    default: {
      const { event: name, at: _at, videoMs: _v, ...rest } = event;
      return { kind: 'event', name, detail: short(rest, 400) };
    }
  }
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Jev 调试</title>
<style>
body{margin:0;font:13px/1.45 system-ui,"Microsoft YaHei",sans-serif;background:#111;color:#ddd;display:grid;grid-template-columns:minmax(420px,1.3fr) 1fr;grid-template-rows:auto 1fr;height:100vh}
header{grid-column:1/3;display:flex;gap:18px;align-items:center;padding:6px 12px;background:#1d1d1d;border-bottom:1px solid #333}
#clock{font:600 18px ui-monospace,Consolas,monospace;color:#fff}
.tag{padding:2px 8px;border-radius:4px;background:#333;font-weight:600}
.threat{background:#8a1f1f}.ok{background:#1f5a2a}.warn{background:#7a5a10}
main{overflow:auto;padding:8px}
aside{overflow:auto;padding:8px;border-left:1px solid #333}
#wrap{position:relative;display:inline-block;max-width:100%}
#img{max-width:100%;display:block;background:#000;min-height:120px}
#ov{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
#frameinfo{color:#aaa;margin:4px 0}
h3{margin:10px 0 4px;color:#9cf;font-size:13px}
table{border-collapse:collapse}td{padding:1px 8px 1px 0;vertical-align:top}
td:first-child{color:#999;white-space:nowrap}
#log div{border-bottom:1px solid #222;padding:2px 0;white-space:pre-wrap;word-break:break-all}
.t{color:#888;font-family:ui-monospace,Consolas,monospace;margin-right:6px}
.k-decision{color:#ffd479}.k-action{color:#8fd18f}.k-state{color:#9cf}.k-event{color:#c9a0ff}.k-touch{color:#777}.k-routine{color:#ff9f6b}
</style></head><body>
<header><span id="clock">--</span><span>画面: <span id="screen" class="tag">-</span></span>
<span>威胁: <span id="threat" class="tag">-</span></span><span>当前策略: <span id="doing" class="tag warn">-</span></span>
<span id="conn" class="tag">连接中</span></header>
<main><div id="wrap"><img id="img" alt="等待画面"><canvas id="ov"></canvas></div>
<div id="frameinfo"></div>
<label><input type="checkbox" id="live" checked> 实时画面</label>
<label><input type="checkbox" id="boxes" checked> 显示识别框(红=敌人血条 黄=敌人搜索区 绿=我方血条)</label>
<label><input type="checkbox" id="marks" checked> 显示动作(红圈=按钮 蓝线=摇杆/镜头拖动 紫=Jev点击，粗圈=按住中)</label>
<div>最近按下: <b id="lastpress">-</b></div>
<h3>最新观察</h3><table id="state"></table>
<h3>最近决策</h3><table id="decision"></table></main>
<aside><h3>事件流</h3><div id="log"></div></aside>
<script>
const $=id=>document.getElementById(id);
const fmt=t=>{const d=new Date(t);const p=(n,w=2)=>String(n).padStart(w,'0');return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())+'.'+p(d.getMilliseconds(),3)};
setInterval(()=>{$('clock').textContent=new Date().toLocaleString('zh-CN',{hour12:false})},200);
const table=(el,obj)=>{el.innerHTML='';for(const[k,v]of Object.entries(obj)){if(v===undefined||v===null||v==='')continue;const tr=el.insertRow();tr.insertCell().textContent=k;tr.insertCell().textContent=typeof v==='object'?JSON.stringify(v):v}};
const zh={combat:'战斗',approach:'接近敌人',navigate:'前往任务',explore:'随机游走',dialogue:'推进对话',teleport:'传送',heal:'回血',track_quest:'追踪任务'};
let frameId=0,loaded=0,busy=false,overlay=null;
function line(at,kind,text){const d=document.createElement('div');d.innerHTML='<span class="t"></span><span class="k-'+kind+'"></span>';d.firstChild.textContent=fmt(at);d.lastChild.textContent=text;const log=$('log');log.prepend(d);while(log.childNodes.length>400)log.lastChild.remove()}
function show(m){
 if(m.kind==='frame'){frameId=m.id;$('frameinfo').textContent='帧 #'+m.id+' 采集于 '+fmt(m.capturedAt)+' 来源 '+m.source+' 画面 '+m.screen+(m.health!=null?' 血量 '+m.health:'')+(m.damaged?' 受击 '+m.damaged.from+'→'+m.damaged.to:'');$('screen').textContent=m.screen;if(m.damaged)line(m.at,'routine','受到伤害 血条 '+m.damaged.from+' → '+m.damaged.to);pull();return}
 if(m.kind==='state'){$('screen').textContent=m.screen;$('threat').textContent=m.threat?(m.threat.kind||JSON.stringify(m.threat)):'无';$('threat').className='tag '+(m.threat?'threat':'ok');table($('state'),{时间:fmt(m.at),步骤:m.step,前台应用:m.app,画面:m.screen,威胁:m.threat,描述:m.description,文字:m.texts,可用例程:m.routines.join(', ')});line(m.at,'state','观察: '+m.screen+(m.threat?' 威胁='+JSON.stringify(m.threat):'')+(m.texts.active_health?' 血量='+m.texts.active_health:''));return}
 if(m.kind==='decision'){table($('decision'),{时间:fmt(m.at),步骤:m.step,轮次:m.cycle,决策者:m.by==='supervisor'?'监督器(代码强制)':m.by,状态:m.status,操作:m.operation,选择:m.choice,置信度:m.confidence,理由:m.reason});const r=(m.choice||'').replace('layout-routine.','');$('doing').textContent=(m.by==='supervisor'?'[监督] ':'[Jev] ')+(zh[r]||m.choice||m.operation||m.status);line(m.at,'decision',(m.by==='supervisor'?'监督器决定: ':'Jev 决定: ')+(m.operation||m.status)+' '+(m.choice||'')+(m.reason?'  — '+m.reason:''));return}
 if(m.kind==='action'){line(m.at,'action','执行完成: '+(m.choice||m.operation)+(m.routine?' 结果='+m.routine.status+' '+JSON.stringify(m.routine):''));return}
 if(m.kind==='routine_start'){$('doing').textContent='执行中: '+(zh[m.routine]||m.routine);line(m.at,'routine','开始例程 '+(zh[m.routine]||m.routine)+' ('+m.kind2+')');return}
 if(m.kind==='routine_end'){line(m.at,'routine','例程结束 '+(zh[m.routine]||m.routine)+': '+m.status+' '+JSON.stringify(m.detail));return}
 if(m.kind==='touch'){touch(m);return}
 line(m.at,'event',m.name+' '+(m.detail||''));
}
function draw(){const c=$('ov'),img=$('img');c.width=img.clientWidth;c.height=img.clientHeight;const g=c.getContext('2d');g.clearRect(0,0,c.width,c.height);if(!overlay)return;const s=c.width/overlay.width;if($('boxes').checked){g.lineWidth=2;for(const b of overlay.boxes){g.strokeStyle=b.kind==='enemy_bar'?'#ff3030':b.kind==='health_bar'?'#40ff60':'rgba(255,220,0,.6)';g.strokeRect(b.x*s,b.y*s,Math.max(2,b.w*s),Math.max(2,b.h*s))}g.fillStyle='#fff';g.font='12px sans-serif';const n=overlay.boxes.filter(b=>b.kind==='enemy_bar').length;g.fillText('敌人血条 '+n+'  我方血条 '+(overlay.health==null?'-':overlay.health.toFixed(2)),6,14)}if($('marks').checked)drawTouches(g,s)}
const zhBtn=l=>{const m=(l||'').match(/[\\u4e00-\\u9fff][^]*$/);return m?m[0]:l};
let touches=[],gest=null,pressCount=0;
function touch(m){
 const now=m.at||Date.now();
 if(m.phase==='down'||m.phase==='tap'){if(gest&&gest.end===null)gest.end=now;pressCount++;gest={id:pressCount,at:now,end:m.phase==='tap'?now:null,x:m.x,y:m.y,path:[[m.x,m.y]],name:m.label?zhBtn(m.label):(m.target==='joystick'?'摇杆':'拖动镜头'),btn:!!m.label,src:m.routine};touches.push(gest);if(touches.length>60)touches.shift();line(m.at,'touch','  #'+pressCount+' 按下 '+gest.name+' ('+m.x+','+m.y+')'+(m.phase==='tap'?' [Jev点击]':''));$('lastpress').textContent='#'+pressCount+' '+gest.name+' @'+fmt(m.at)}
 else if(gest){gest.path.push([m.x,m.y]);if(m.phase==='up')gest.end=now}
}
function drawTouches(g,s){
 const now=Date.now(),keep=3000;for(const t of touches)if(t.end===null&&now-t.at>30000)t.end=t.at;touches=touches.filter(t=>t.end===null||now-t.end<keep);
 for(const t of touches){const age=t.end===null?0:(now-t.end)/keep;const a=Math.max(.15,1-age);const held=t.end===null;
  const col=t.src==='jev'?'255,80,255':t.btn?'255,60,60':'0,200,255';
  g.strokeStyle='rgba('+col+','+a+')';g.fillStyle='rgba('+col+','+a*0.35+')';g.lineWidth=held?5:3;
  const [x0,y0]=t.path[0];
  if(t.path.length>1){g.beginPath();g.moveTo(x0*s,y0*s);for(const[x,y]of t.path)g.lineTo(x*s,y*s);g.stroke();const[xe,ye]=t.path.at(-1);g.beginPath();g.arc(xe*s,ye*s,8,0,7);g.stroke()}
  const r=held?26:18+age*14;g.beginPath();g.arc(x0*s,y0*s,r,0,7);g.fill();g.stroke();
  g.font='bold 15px "Microsoft YaHei",sans-serif';const label='#'+t.id+' '+t.name+(held?' (按住)':'');const w=g.measureText(label).width;const lx=Math.min(Math.max(2,x0*s-w/2),g.canvas.width-w-4),ly=Math.max(18,y0*s-r-8);
  g.fillStyle='rgba(0,0,0,'+a*0.75+')';g.fillRect(lx-3,ly-15,w+6,20);g.fillStyle='rgba(255,255,255,'+a+')';g.fillText(label,lx,ly)}
}
setInterval(draw,100);
async function pull(){if(busy||!$('live').checked||loaded===frameId)return;busy=true;const id=frameId;try{const r=await fetch('/frame.png?id='+id);if(r.ok){overlay=JSON.parse(r.headers.get('x-overlay')||'null');const b=await r.blob();const u=URL.createObjectURL(b);await new Promise(ok=>{$('img').onload=ok;$('img').src=u});URL.revokeObjectURL(u);loaded=id;draw()}}finally{busy=false}if(loaded!==frameId)setTimeout(pull,50)}
$('boxes').onchange=draw;$('live').onchange=pull;window.onresize=draw;
const es=new EventSource('/events');es.onopen=()=>{$('conn').textContent='已连接';$('conn').className='tag ok'};es.onerror=()=>{$('conn').textContent='断开';$('conn').className='tag threat'};
es.onmessage=e=>{for(const m of JSON.parse(e.data))show(m)};
</script></body></html>`;

/**
 * Live run viewer: a local page (127.0.0.1 only) with the clock, the detected screen and threat,
 * Jev's and the supervisor's decisions, routine progress and touches, and the latest frame with
 * the detector boxes. Frames are kept by reference and encoded only when the page asks.
 */
export async function startDebugUi({ layout, port = 0, host = '127.0.0.1', open = true } = {}) {
  const clients = new Set();
  const history = [];
  let latest,
    encoded,
    frames = 0;
  const send = (message) => {
    history.push(message);
    if (history.length > 300) history.shift();
    const data = `data: ${JSON.stringify([message])}\n\n`;
    for (const res of clients) res.write(data);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(PAGE);
    } else if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(history)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (url.pathname === '/frame.png') {
      if (!latest) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (encoded?.id !== latest.id) {
        const start = performance.now();
        let overlay = null;
        try {
          overlay = frameOverlay(layout, latest.image);
        } catch {
          overlay = null;
        }
        encoded = { id: latest.id, png: thumbnailPng(latest.image), overlay };
        encoded.ms = Math.round(performance.now() - start);
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'x-frame-id': String(encoded.id),
        'x-encode-ms': String(encoded.ms),
        'x-overlay': JSON.stringify(encoded.overlay),
      });
      res.end(encoded.png);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, host);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const url = `http://${host}:${server.address().port}/`;
  if (open) openBrowser(url);
  return {
    url,
    // Trace events from the CLI (observation, decision, action_executed, rest, cycle...).
    publish(event) {
      const summary = summarizeEvent(event);
      if (summary) send({ at: Date.now(), ...summary });
    },
    // Device hooks used by withLayout: every captured frame and routine progress.
    device: {
      frame({ image, capturedAt, screen, source, health, damaged }) {
        latest = { id: ++frames, image };
        send({
          at: Date.now(),
          kind: 'frame',
          id: frames,
          capturedAt: capturedAt ?? Date.now(),
          screen,
          source,
          ...(health !== undefined ? { health } : {}),
          ...(damaged ? { damaged } : {}),
        });
      },
      event({ type, ...rest }) {
        if (type === 'touch') {
          // Moves only update the live drawing; presses are also kept in the event history.
          const message = { at: Date.now(), kind: 'touch', ...rest };
          if (rest.phase === 'down' || rest.phase === 'tap') send(message);
          else {
            const data = `data: ${JSON.stringify([message])}\n\n`;
            for (const res of clients) res.write(data);
          }
        } else if (type === 'routine_start')
          send({ at: Date.now(), kind: 'routine_start', routine: rest.routine, kind2: rest.kind });
        else if (type === 'routine_end') {
          const { routine, status, ...detail } = rest;
          send({ at: Date.now(), kind: 'routine_end', routine, status, detail });
        } else send({ at: Date.now(), kind: type, ...rest });
      },
    },
    async close() {
      for (const res of clients) res.end();
      clients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: process.platform === 'win32',
    }).unref();
  } catch {
    // The URL is printed too; a missing opener must not stop the run.
  }
}
