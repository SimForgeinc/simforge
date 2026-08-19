import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const portArg = process.argv.find((value) => value.startsWith('--port='));
const port = Number(portArg?.split('=')[1] ?? 4317);
const serveStatic = process.argv.includes('--static');
const root = fileURLToPath(new URL('../dist', import.meta.url));
const stageDefs = [['00','brief'],['10','route'],['15','precheck'],['20','author'],['30','sites'],['40','cells'],['50','gate'],['60','render2d'],['62','semantic'],['65','render3d'],['75','product'],['90','gallery']];

const jobs = new Map();
function mockJob(id = 'mock-night-crossing', brief = 'A cyclist emerges from behind a stopped delivery van while an oncoming car yields late.') {
  const artifacts = (stage) => stage === '20' ? [0,1,2,3].map((n) => ({ path: `${id}/20-author/action-${n}.png`, type: 'image' })) : stage === '60' ? [{ path: `${id}/60-render2d/cell-a/headline.png`, type: 'image' }, { path: `${id}/60-render2d/cell-a/rollout.mp4`, type: 'video' }] : stage === '65' ? [{ path: `${id}/65-render3d/cell-a/incident.png`, type: 'image' }] : [{ path: `${id}/${stage}-${stageDefs.find(([n]) => n === stage)?.[1]}.json`, type: 'json' }];
  return { jobId:id, brief, engine:'vista2', status:'complete', options:{ engine:'vista2', maps:['yale-street','el-camino-road'], ambient:'city' }, stages:stageDefs.map(([stage,name],i) => ({ stage:`${stage}-${name}`, status:'complete', elapsedMs:(i+1)*1380, artifacts:artifacts(stage), summary: stage === '50' ? { admitted:2, total:3 } : undefined })), cells:[
    { cellId:'yale-junction-01-draw-0', map:'yale-street', gate:{pass:true}, product:{semanticAccepted:true,accepted:true,defectCodes:[],unsupportedReason:null}, artifacts:[{path:`${id}/60-render2d/cell-a/headline.png`,type:'image'},{path:`${id}/60-render2d/cell-a/rollout.mp4`,type:'video'}] },
    { cellId:'el-camino-corridor-04-draw-0', map:'el-camino-road', gate:{pass:true}, product:{semanticAccepted:true,accepted:true,defectCodes:[],unsupportedReason:null} },
    { cellId:'yale-junction-01-draw-1', map:'yale-street', gate:{pass:false,firstFailure:'C3 clearance below 5.0 m'}, product:{semanticAccepted:false,accepted:false,defectCodes:['gate-failed'],unsupportedReason:'never screened by the 2D semantic oracle'} },
  ] };
}
jobs.set('mock-night-crossing', mockJob());

const gallery = () => [...jobs.values()].map((job) => ({ jobId:job.jobId, brief:job.brief, headline:'Late yield at Market Street', engine:job.engine, maps:job.options.maps, admitted:2, total:3, realism:8.2, dynamism:8.0, headlineArtifact:`${job.jobId}/60-render2d/cell-a/headline.png` }));
function sendJson(res, value, status=200) { res.writeHead(status, {'content-type':'application/json','access-control-allow-origin':'*'}); res.end(JSON.stringify(value)); }
function svg(label) { return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#172638"/><stop offset="1" stop-color="#0a0d13"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><path d="M0 570L1280 350M0 670L1280 450" stroke="#34455a" stroke-width="6"/><path d="M0 620L1280 400" stroke="#e8d273" stroke-width="3" stroke-dasharray="30 32"/><rect x="620" y="370" width="210" height="90" rx="18" fill="#99f1c8" transform="rotate(-10 620 370)"/><circle cx="660" cy="460" r="25" fill="#080b10"/><circle cx="800" cy="430" r="25" fill="#080b10"/><circle cx="470" cy="430" r="25" fill="none" stroke="#b8a9ff" stroke-width="10"/><path d="M470 430L520 375L570 420M520 375L495 330" fill="none" stroke="#b8a9ff" stroke-width="10"/><text x="58" y="78" fill="#9af5cb" font-family="sans-serif" font-size="24" letter-spacing="5">UNISCENARIOS · MOCK EVIDENCE</text><text x="58" y="130" fill="#e7edf5" font-family="sans-serif" font-size="32">${label.replace(/[<>&]/g,'')}</text></svg>`; }

const server = createServer(async (req,res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/gallery') return sendJson(res, gallery());
  if (url.pathname === '/api/jobs' && req.method === 'POST') { let body=''; for await (const chunk of req) body += chunk; const input=JSON.parse(body||'{}'); const id=`mock-${Date.now().toString(36)}`; const job=mockJob(id,input.brief); job.engine=input.engine === 'auto' ? 'compiler' : input.engine; job.options={...input}; jobs.set(id,job); return sendJson(res,{jobId:id},202); }
  const full = url.pathname.match(/^\/api\/jobs\/([^/]+)\/full$/);
  if (full) { const job=jobs.get(decodeURIComponent(full[1])); return job ? sendJson(res,job) : sendJson(res,{error:'not found'},404); }
  const stream = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (stream) { const job=jobs.get(decodeURIComponent(stream[1])); if (!job) return sendJson(res,{error:'not found'},404); res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'}); let i=0; const timer=setInterval(() => { const event=job.stages[i++ % job.stages.length]; res.write(`data: ${JSON.stringify(event)}\n\n`); },700); req.on('close',()=>clearInterval(timer)); return; }
  if (url.pathname.startsWith('/artifacts/')) { const path=decodeURIComponent(url.pathname); if (/\.(png|jpg|jpeg)$/i.test(path)) { res.writeHead(200,{'content-type':'image/svg+xml','cache-control':'no-store'}); return res.end(svg(path.split('/').pop())); } if (/\.mp4$/i.test(path)) { res.writeHead(404); return res.end('Mock server uses headline stills; no synthetic video.'); } return sendJson(res,{mock:true,path,generatedAt:'2026-08-17T00:00:00Z'}); }
  if (serveStatic) { let requested=url.pathname === '/' ? 'index.html' : url.pathname.slice(1); requested=normalize(requested).replace(/^\.\.(\/|\\)/,''); let file=join(root,requested); try { if ((await stat(file)).isDirectory()) file=join(file,'index.html'); const data=await readFile(file); const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}; res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream'}); return res.end(data); } catch { try { const data=await readFile(join(root,'index.html')); res.writeHead(200,{'content-type':'text/html'}); return res.end(data); } catch {} } }
  res.writeHead(404); res.end('Not found');
});
server.listen(port,'127.0.0.1',()=>console.log(`showcase mock listening on http://127.0.0.1:${port}${serveStatic?' (static dist)':''}`));
