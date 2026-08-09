const path=require('path'), fs=require('fs');
const D=path.join(__dirname,'..','data');
const OUT="C:\\Users\\justi\\AppData\\Local\\Temp\\claude\\C--Users-justi\\79de2fca-e6d2-4390-9cee-897a53089a39\\scratchpad\\digests";
fs.mkdirSync(OUT,{recursive:true});
function load(f){return JSON.parse(fs.readFileSync(path.join(D,f),'utf8'));}
function companiesOf(arr){const m=new Map();arr.forEach(e=>{if(!m.has(e.company))m.set(e.company,[]);m.get(e.company).push(e);});return m;}
function digestFor(cos,map){
  let lines=[];
  for(const c of cos){
    const es=map.get(c)||[];
    if(!es.length){lines.push(`- ${c}: (no current entries)`);continue;}
    lines.push(`- ${c}:`);
    es.forEach(e=>lines.push(`    · "${e.program}" [${e.status}]${e.term?' {'+e.term+'}':''}`));
  }
  return lines.join('\n');
}
function splitHalf(a){const h=Math.ceil(a.length/2);return [a.slice(0,h),a.slice(h)];}
function write(name,cos,map,note){
  const d=digestFor(cos,map);
  fs.writeFileSync(path.join(OUT,name+'.txt'),`GROUP ${name}\nCOMPANIES (${cos.length}): ${cos.join(', ')}\n\nCURRENT KNOWN PROGRAMS (re-verify exact program text; add new finds):\n${d}\n`);
  console.log(`${name}: ${cos.length} companies`);
}
// core agents
for(const k of ['1','2','3','4','5']){
  const arr=load('agent'+k+'_results.json').internships;
  const map=companiesOf(arr);
  const cos=[...map.keys()];
  if(k==='1'||k==='2'||k==='3'){
    const [a,b]=splitHalf(cos);
    write('G'+k+'A',a,map); write('G'+k+'B',b,map);
  } else {
    write('G'+k,cos,map);
  }
}
// tab files: split into N groups
function tab(file,prefix,n){
  const arr=load(file).internships;
  const map=companiesOf(arr);
  const cos=[...map.keys()];
  const per=Math.ceil(cos.length/n);
  for(let i=0;i<n;i++){
    const slice=cos.slice(i*per,(i+1)*per);
    if(slice.length) write(prefix+(i+1),slice,map);
  }
}
tab('sophomore_results.json','SOPH',2);
tab('fall2026_results.json','FS',3);
tab('libraries_results.json','LIB',4);
tab('environmental_results.json','ENV',4);
tab('realestate_results.json','RE',4);
tab('fellowships_results.json','FEL',2);
tab('china_hk_results.json','CN',2);
tab('ithaca_results.json','ITH',2);
console.log('DIGESTS WRITTEN TO',OUT);
