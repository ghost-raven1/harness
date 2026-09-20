import type { BenchmarkScenario } from './types.js';

// Этот модуль целиком исполняется внутри VM: в проверяемый код не передаются функции Node.
const assertions = `
const calls=[];
const equal=(actual,expected)=>{ if(!Object.is(actual,expected)) throw new Error('Значения различаются'); };
const same=(a,b)=>{
  if(Object.is(a,b)) return true;
  if(!a || !b || typeof a!=='object' || typeof b!=='object') return false;
  const keys=Object.keys(a); return keys.length===Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));
};
export const trusted=Object.freeze({equal,deepEqual:(a,b)=>{if(!same(a,b))throw new Error('Структуры различаются');}});
const assert=Object.freeze({equal:(actual,expected)=>{equal(actual,expected); calls.push([actual,expected]);}});
export const assertionCalls=()=>calls.map(pair=>[...pair]);
export default assert;
`;

/** Создаёт проверяющую программу вне workspace: гостевые модули не получают stdout, process или Node-импорты. */
export function verificationSource(scenario: BenchmarkScenario): string {
  const names = [
    ...new Set([
      ...Object.keys(scenario.files),
      ...Object.keys(scenario.finalWrites),
      ...scenario.parts.flatMap((part) => Object.keys(part.writes)),
    ]),
  ];
  const checks = scenario.checks.map((check) => ({
    title: check.title,
    assertion: check.assertion,
  }));
  return `
import {readFile,lstat} from 'node:fs/promises';
import {join,posix} from 'node:path';
import {createContext,SourceTextModule,runInContext} from 'node:vm';
const root=process.argv[2];
const checks=${JSON.stringify(checks)};
const names=${JSON.stringify(names)};
const sources={};
const failed=()=>checks.map(({title})=>({title,passed:false,error:'Доверенная проверка не пройдена'}));

// Отдельный контекст не содержит ссылок на объекты основного Node-процесса.
async function verify(values) {
  const context=createContext(Object.create(null), {codeGeneration:{strings:false,wasm:false}});
  runInContext(
    "for(const name of ['Object','Array','Function','Promise','JSON','Reflect','Error']) {const value=globalThis[name]; Object.defineProperty(globalThis,name,{value,writable:false,configurable:false}); if(value.prototype) Object.freeze(value.prototype); Object.freeze(value);} globalThis.console=undefined;",
    context, {timeout:1000},
  );
  const modules=new Map();
  const shim=new SourceTextModule(${JSON.stringify(assertions)}, {context,identifier:'assert-shim'});
  modules.set('assert-shim',shim);
  const javascript=names.filter(name=>name.endsWith('.js'));
  for(const name of javascript) {
    if(typeof values[name]!=='string') throw new Error('Исходник недоступен');
    modules.set(name,new SourceTextModule(values[name], {context,identifier:name}));
  }
  const imports=javascript.map((name,index)=>'import * as file'+index+' from '+JSON.stringify('fixture:'+name)+';').join('\\n');
  const lookup='{'+javascript.map((name,index)=>JSON.stringify(name)+':file'+index).join(',')+'}';
  const trustedSource=imports+'\\nimport {trusted as assert,assertionCalls} from "trusted:assert";\\n'+
    'const modules=Object.freeze('+lookup+');const files=Object.freeze('+JSON.stringify(values)+');'+
    'const load=async name=>modules[name]; const text=async name=>files[name];const results=[];\\n'+
    checks.map(check=>'try{'+check.assertion+' results.push({title:'+JSON.stringify(check.title)+',passed:true});}catch{results.push({title:'+JSON.stringify(check.title)+',passed:false});}').join('\\n')+
    '\\nexport const result=JSON.stringify(results);';
  const main=new SourceTextModule(trustedSource,{context,identifier:'trusted-checks'});
  await main.link((specifier,reference)=>{
    if(specifier==='node:assert/strict' || (reference===main && specifier==='trusted:assert')) return shim;
    const name=reference===main && specifier.startsWith('fixture:') ? specifier.slice(8)
      : specifier.startsWith('./') ? posix.normalize(posix.join(posix.dirname(reference.identifier),specifier)) : undefined;
    if(!name || !modules.has(name) || name==='assert-shim') throw new Error('Импорт не разрешён стендом');
    return modules.get(name);
  });
  let timer;
  try {
    await Promise.race([
      main.evaluate({timeout:1000}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Проверка не завершилась')),1500);}),
    ]);
    return JSON.parse(main.namespace.result);
  } finally {clearTimeout(timer);}
}

let results;
try {
  for(const name of names) {
    const path=join(root,name);
    const info=await lstat(path);
    if(!info.isFile() || info.isSymbolicLink() || info.size>1048576) throw new Error('Файл недоступен');
    sources[name]=await readFile(path,'utf8');
  }
  results=await verify(sources);
  ${
    scenario.id === 'test-repair'
      ? `
  // Исправленный тест обязан обнаружить ошибку реализации, а не проверить константу или комментарий.
  let detectsMutation=false;
  try {await verify({...sources,'add.js':'export const add=(a,b)=>a+b+1;'});} catch {detectsMutation=true;}
  if(!detectsMutation) results[1].passed=false;
  `
      : ''
  }
} catch {results=failed();}
console.log(JSON.stringify({checks:results}));
process.exitCode=results.every(check=>check.passed)?0:1;
`;
}
