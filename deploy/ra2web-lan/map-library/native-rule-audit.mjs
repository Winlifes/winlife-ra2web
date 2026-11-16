// Source-backed rules checks and byte-preserving removal of proven dormant overrides.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const sha = value => createHash('sha256').update(value).digest('hex');
function slice(source, start, end) {
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  if(a<0||b<0)throw new Error('Native rule audit signature changed: '+start);
  return source.slice(a,b);
}

export function auditNativeRuleReaders(source) {
  const registryReader=slice(source,'readObjectTypes(e,t){','readColors(){');
  const objectReader=slice(source,'readObjects(e,t,i){','readCountries(){');
  if(!registryReader.includes('i.entries.forEach(')||!objectReader.includes('t.forEach(')||!objectReader.includes('this.ini.getSection(r)'))throw new Error('Native registry enumeration needs re-audit');
  if(!source.includes('this.readObjects(Ai.ObjectType.Building,this.buildingTypes,this.buildingRules)'))throw new Error('Native building registration path changed');
  const propertyKeys=new Set([...source.matchAll(/this\.ini\.get(?:String|Number|Bool|Fixed|Array|Enum|ClampedNumber)\("([^"\n]+)"/g)].map(match=>match[1].toUpperCase()));
  const buildTimeExpression='this.buildTimeMultiplier=this.ini.getFixed("BuildTimeMultiplier",1)';
  if(!source.includes(buildTimeExpression))throw new Error('Native build time property reader changed');
  const directSectionNames=[...new Set([...source.matchAll(/\.get(?:OrCreate)?Section\("([^"\n]+)"/g)].map(match=>match[1].toUpperCase()))];
  return {propertyKeys,evidence:{appSha256:sha(source),registryReaderSha256:sha(registryReader),objectReaderSha256:sha(objectReader),directSectionNames,
    propertyKeys:[...propertyKeys].sort(),buildTimeExpression,registryReader,objectReader}};
}

export function inactiveEditorMetadata(ini,native) {
  const ignored=new Set();
  for(const name of ['FA2SPVERSIONCONTROL','TIME']){
    if(!ini.has(name)||!native.ruleReaderEvidence||native.ruleReaderEvidence.directSectionNames.includes(name)||native.rules.has(name)||native.activeModRules?.has(name))continue;
    if(name==='TIME'&&[...ini.get(name)].some(([key,value])=>!/^\d+$/.test(key)||!/^\d+$/.test(value)))continue;
    let referenced=false;
    for(const [other,entries]of ini)if(other!==name)for(const value of entries.values())if((String(value).toUpperCase().match(/[A-Z_][A-Z0-9_]*/g)||[]).includes(name))referenced=true;
    if(!referenced)ignored.add(name);
  }
  return ignored;
}

// Only these known, unused cross-game object overrides are candidates. A
// registered, placed or referenced type is NEVER treated as dormant.
const DORMANT_CANDIDATES=new Set(['YAYARD','CAMACH','CASLAB','YABRCK','YACNST','YAPOWR','YAREFN','FAYARD']);
export function dormantTypeOverrides(ini,native) {
  if(!native.ruleReaderEvidence||native.activeModAudit?.complete===false)return new Set();
  const registered=new Set([...Object.values(native.registries).flatMap(types=>[...types]),...(native.activeModObjectTypes||[])]);
  const candidates=new Set([...DORMANT_CANDIDATES].filter(name=>ini.has(name)&&!registered.has(name)&&!native.rules.has(name)&&!native.ruleReaderEvidence.directSectionNames.includes(name)));
  const references=[];
  for(const sections of [native.rules,native.activeModRules||new Map(),ini])for(const[name,entries]of sections){
    for(const value of entries.values())for(const token of String(value).toUpperCase().match(/[A-Z_][A-Z0-9_]*/g)||[])if(candidates.has(token))references.push([name,token]);
  }
  // Reach a fixed point: retaining one referenced candidate must also retain
  // every candidate it references. Map-local registries are outside this group.
  let changed;
  do {changed=false;for(const [owner,target]of references)if(!candidates.has(owner)&&candidates.delete(target))changed=true;}while(changed);
  return candidates;
}

export function cleanDormantOverrides(bytes,ini,native) {
  const names=dormantTypeOverrides(ini,native);
  if(!names.size)return null;
  // Latin-1 supplies a one-to-one byte offset, preserving UTF-8/legacy Chinese
  // bytes, BOMs, line endings and every unremoved section verbatim.
  const text=bytes.toString('latin1'),headers=[];
  const lines=/[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for(const line of text.matchAll(lines)){
    if(!line[0])continue;
    const bom=line.index===0&&bytes.subarray(0,3).equals(Buffer.from([239,187,191]))?3:0;
    const header=line[0].slice(bom).replace(/[\r\n]+$/,'').match(/^\s*\[([^\]]+)\]\s*(?:(?:\/\/|;|#).*)?$/);
    if(header)headers.push({name:header[1].trim().toUpperCase(),start:line.index+bom});
  }
  const removed=headers.flatMap((header,index)=>names.has(header.name)?[{...header,end:headers[index+1]?.start??bytes.length}]:[]);
  if([...names].some(name=>!removed.some(span=>span.name===name)))throw new Error('Cannot locate complete dormant section bytes');
  let at=0;const chunks=[];
  for(const span of removed){chunks.push(bytes.subarray(at,span.start));at=span.end;}
  chunks.push(bytes.subarray(at));
  const cleaned=Buffer.concat(chunks);
  return {bytes:cleaned,removedSections:[...names].sort(),removedSpans:removed.map(span=>({...span,bytes:span.end-span.start,sha256:sha(bytes.subarray(span.start,span.end))})),sourceSha256:sha(bytes),sha256:sha(cleaned),method:'remove-unregistered-unreferenced-sections-v1'};
}

export function readRootZipEntry(bytes,wanted,crc32) {
  let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-65557);at--)if(bytes.readUInt32LE(at)===0x06054b50){end=at;break;}
  if(end<0)throw new Error('Missing ZIP directory');
  const count=bytes.readUInt16LE(end+10);let at=bytes.readUInt32LE(end+16);
  if(count>2000)throw new Error('Mod ZIP entry bound exceeded');
  for(let i=0;i<count;i++){
    if(at+46>bytes.length||bytes.readUInt32LE(at)!==0x02014b50)throw new Error('Invalid ZIP directory');
    const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),size=bytes.readUInt32LE(at+20),decodedSize=bytes.readUInt32LE(at+24);
    const nameSize=bytes.readUInt16LE(at+28),extraSize=bytes.readUInt16LE(at+30),commentSize=bytes.readUInt16LE(at+32),local=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameSize).toString('utf8');at+=46+nameSize+extraSize+commentSize;
    if(name.toLowerCase()!==wanted.toLowerCase())continue;
    if(flags&1||decodedSize>8*1024*1024||![0,8].includes(method)||local+30>bytes.length||bytes.readUInt32LE(local)!==0x04034b50)throw new Error('Unsupported mod INI ZIP entry');
    const dataAt=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    if(dataAt+size>bytes.length)throw new Error('ZIP entry outside archive');
    const encoded=bytes.subarray(dataAt,dataAt+size),decoded=method===0?encoded:inflateRawSync(encoded,{maxOutputLength:8*1024*1024});
    if(decoded.length!==decodedSize||crc32(decoded)!==crc)throw new Error('Mod INI ZIP integrity mismatch');
    return decoded;
  }
  throw new Error('Missing root ZIP entry '+wanted);
}
