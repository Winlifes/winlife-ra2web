/** Data-derived thumbnails for generated maps; no simulation data is changed. */
import {deflateSync} from 'node:zlib';
import {crc32} from './build-catalog.mjs';
import {cellToDisplay,isPlayableCell,OVERLAY_IDS,bytesToBase64,encodePacked,setIniValue} from '../map-editor/map-codec.mjs';
const DIGITS=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
function chunk(type,body){const tag=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(Buffer.concat([tag,body])));return Buffer.concat([size,tag,body,crc]);}
export function renderMapPreview(doc){
  const width=640,height=Math.round((2*doc.fullSize.height)/(2*doc.fullSize.width-1)*width/2)*2;
  const sx=width/(2*doc.fullSize.width-1),sy=height/(2*doc.fullSize.height),rgb=Buffer.alloc(width*height*3);
  const pixel=(x,y,color)=>{x=Math.floor(x);y=Math.floor(y);if(x>=0&&y>=0&&x<width&&y<height)rgb.set(color,(y*width+x)*3);};
  const point=(rx,ry)=>{const{dx,dy}=cellToDisplay(doc,rx,ry);return{x:Math.round(dx*sx),y:Math.round(dy*sy)};};
  const cell=(rx,ry,color)=>{const{x,y}=point(rx,ry);for(let dx=-Math.ceil(sx);dx<=Math.ceil(sx);dx++)for(let dy=-Math.ceil(sy/2);dy<=Math.ceil(sy/2);dy++)pixel(x+dx,y+dy,color);};
  for(const tile of doc.tiles)cell(tile.rx,tile.ry,!isPlayableCell(doc,tile.rx,tile.ry)?[18,27,25]:tile.tileNum===314?[29,85,122]:[83,103,54]);
  for(const item of doc.overlays.values())if(item.id===OVERLAY_IDS.GEMS||item.id===OVERLAY_IDS.ORE)cell(item.rx,item.ry,item.id===OVERLAY_IDS.GEMS?[200,77,231]:[225,176,62]);
  for(const item of doc.terrain.values())cell(item.rx,item.ry,item.name==='TIBTRE01'?[255,198,88]:[30,68,35]);
  for(const spawn of doc.spawns){
    const{x,y}=point(spawn.rx,spawn.ry);
    for(let dx=-14;dx<=14;dx++)for(let dy=-14;dy<=14;dy++)if(dx*dx+dy*dy<=196)pixel(x+dx,y+dy,[43,101,160]);
    const digits=String(spawn.number+1),left=x-digits.length*4+1;
    for(let i=0;i<digits.length;i++)for(let row=0;row<5;row++)for(let col=0;col<3;col++)if(DIGITS[+digits[i]][row*3+col]==='1')for(let dx=0;dx<2;dx++)for(let dy=0;dy<2;dy++)pixel(left+i*8+col*2+dx,y-5+row*2+dy,[255,255,225]);
  }
  const header=Buffer.alloc(13),rows=Buffer.alloc((width*3+1)*height);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  for(let y=0;y<height;y++)rows.set(rgb.subarray(y*width*3,(y+1)*width*3),y*(width*3+1)+1);
  return{width,height,rgb,png:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))])};
}
export function embedMapPreview(doc,preview){
  const width=preview.width/2,height=preview.height/2,rgb=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)rgb.set(preview.rgb.subarray((2*y*preview.width+2*x)*3,(2*y*preview.width+2*x)*3+3),(y*width+x)*3);
  setIniValue(doc,'Preview','Size',`0,0,${width},${height}`);
  const packed=bytesToBase64(encodePacked(rgb));
  for(let i=0;i<packed.length;i+=70)setIniValue(doc,'PreviewPack',String(i/70+1),packed.slice(i,i+70));
  return doc;
}
