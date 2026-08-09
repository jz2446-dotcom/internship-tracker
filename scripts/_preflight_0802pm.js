const path=require('path');
const D=path.join(__dirname,'..','data');
const roster=require(path.join(D,'roster.json'));
function norm(s){return (s||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
const rosterByAgent={}; const allRoster=new Set();
for(const [k,v] of Object.entries(roster.agents)){
  rosterByAgent[k]=(v.companies||[]).map(c=>({raw:c,n:norm(c)}));
  v.companies.forEach(c=>allRoster.add(norm(c)));
}
for(const k of ['1','2','3','4','5']){
  const d=require(path.join(D,'agent'+k+'_results.json'));
  const arr=d.internships||[];
  const dataCompanies=new Map();
  arr.forEach(e=>{const n=norm(e.company); if(!dataCompanies.has(n)) dataCompanies.set(n,e.company);});
  const dataNotInRoster=[...dataCompanies.entries()].filter(([n])=>!allRoster.has(n));
  const rosterZero=rosterByAgent[k].filter(x=>!dataCompanies.has(x.n));
  console.log('=== Agent '+k+' ('+roster.agents[k].name+') ===');
  console.log('  roster:'+rosterByAgent[k].length+'  data-companies:'+dataCompanies.size);
  console.log('  [A] data company NOT in any roster: '+dataNotInRoster.length);
  dataNotInRoster.forEach(([n,raw])=>console.log('      + '+raw));
  console.log('  [B reverse] roster company with ZERO data rows: '+rosterZero.length);
  rosterZero.forEach(x=>console.log('      - '+x.raw));
}
