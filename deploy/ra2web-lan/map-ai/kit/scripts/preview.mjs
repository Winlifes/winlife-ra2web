import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseMap,playableBounds,cellToDisplay} from '../lib/map-codec.mjs';
import {cliArgs} from '../lib/common.mjs';
const xml=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function previewSvg(text){
  const doc=parseMap(text),b=playableBounds(doc),scale=3,width=Math.max(700,(b.width+16)*scale),height=(b.height+16)*scale+100;
  const land=doc.metadata.theater==='SNOW'?'#dbe6e9':'#587253';
  const diamond=(x,y)=>`M${x-1} ${y}l1 -1 1 1 -1 1Z`;
  const layers=new Map();const paint=(color,x,y)=>{if(!layers.has(color))layers.set(color,[]);layers.get(color).push(diamond(x,y));};
  for(const t of doc.tiles)if(t.tileNum===314)paint('#376f9c',t.dx,t.dy);
  for(const o of doc.overlays.values()){const p=cellToDisplay(doc,o.rx,o.ry);paint(o.id===27?'#cf79dd':'#d5ac43',p.dx,p.dy);}
  for(const t of doc.terrain.values()){const p=cellToDisplay(doc,t.rx,t.ry);paint('#153e22',p.dx,p.dy);}
  const structures=[...doc.structures.values()].map(o=>{const p=cellToDisplay(doc,o.rx,o.ry);return `<rect x="${p.dx-1.5}" y="${p.dy-1.5}" width="3" height="3" fill="#faf3ca" stroke="#201b17" stroke-width=".4"><title>${xml(o.name)}</title></rect>`;}).join('');
  const starts=doc.spawns.map(p=>{const v=cellToDisplay(doc,p.rx,p.ry);return `<g><circle cx="${v.dx}" cy="${v.dy}" r="3.6" fill="#f4d85f" stroke="#17252e" stroke-width=".7"/><text x="${v.dx}" y="${v.dy+1.25}" font-size="3.6" font-weight="bold" text-anchor="middle" fill="#10191e">${p.number+1}</text></g>`;}).join('');
  const layersSvg=[...layers].map(([color,segments])=>`<path fill="${color}" d="${segments.join('')}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#15222c"/><text x="20" y="30" fill="#f1f5f7" font-size="20" font-family="sans-serif">${xml(doc.metadata.name)} · ${doc.spawns.length} players</text><text x="20" y="52" fill="#b5c9d7" font-size="12" font-family="sans-serif">Data schematic · not an in-game screenshot · runtime acceptance pending</text><svg x="20" y="70" width="${b.width*scale}" height="${b.height*scale}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}"><rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${land}"/>${layersSvg}${structures}${starts}</svg><text x="20" y="${height-16}" fill="#b5c9d7" font-size="12" font-family="sans-serif">Gold: ore · Purple: gems · Blue: water · Dark green: trees · Cream: neutral structures</text></svg>\n`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const{positional,options}=cliArgs(process.argv.slice(2));if(!positional[0]||!options.out)throw new Error('Usage: node scripts/preview.mjs FILE.map --out preview.svg');fs.writeFileSync(options.out,previewSvg(fs.readFileSync(positional[0],'utf8')));console.log(options.out);}catch(e){console.error(e.message);process.exitCode=1;}
}
