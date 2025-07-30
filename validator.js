const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const MessageFormat = require('@messageformat/core');
const { parse: mfParse } = require('@messageformat/parser');
const ExcelJS = require('exceljs');

// ---- CLI args ----
const inputDir = process.argv[2];
const toolTypeInput = process.argv[3];
if (!inputDir || !toolTypeInput) {
  console.error('Usage: node validator.js <input_directory> <tool_type>');
  process.exit(1);
}
const toolType = toolTypeInput.toLowerCase();

// ---- paths ----
const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
const validationReportFile = path.join(__dirname, `icu_validation_report_${timestamp}.xlsx`);
const outputAggregatedFile = path.join(__dirname, 'aggregated_translations.json');
const tempExtractDir = path.join(__dirname, 'extracted_xlf');
if (!fs.existsSync(tempExtractDir)) fs.mkdirSync(tempExtractDir);

// ---- plural rules ----
const pluralRulesDataPath = path.join(__dirname, 'pluralRulesData.json');
let pluralRulesData = {};
try {
  pluralRulesData = JSON.parse(fs.readFileSync(pluralRulesDataPath, 'utf-8'));
} catch (err) {
  console.error('Error loading plural rules data:', err);
}

// ---- helpers ----
function recursiveExtractText(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && node) {
    let t = node['#text'] || '';
    for (const key of Object.keys(node)) {
      if (key === '#text') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(c => { t += recursiveExtractText(c); });
      else t += recursiveExtractText(child);
    }
    return t;
  }
  return '';
}

function unifyLocale(l) { return l.split(/[-_]/)[0].toLowerCase(); }
function getLanguageRulesDisplay(lang) {
  const n = unifyLocale(lang);
  const d = pluralRulesData[n];
  const cats = d && d.rules && d.rules.cardinal ? Object.keys(d.rules.cardinal) : [];
  return cats.length ? cats.join(', ') : '(None)';
}
function sourceHasPlural(src) { return /{[^}]+,\s*plural,/.test(src); }

function categorizeError(msg, base) {
  if (msg.includes('leading apostrophe')) return `${base} Apostrophe Error`;
  if (msg.includes('HTML tag')) return `${base} HTML Tag Mismatch`;
  if (msg.includes('Placeholder')) return `${base} Placeholder Mismatch`;
  if (msg.includes('MessageFormat compilation failed')) return `${base} Compilation Error`;
  return `${base} ICU Error`;
}

function transformErrorMessage(msg, lang) {
  if (/The plural case (\w+) is not valid/.test(msg)) {
    const m = msg.match(/The plural case (\w+)/);
    return `${lang} does not recognize the plural category "${m[1]}". Expected categories: ${getLanguageRulesDisplay(lang)}.`;
  }
  if (/Variable \[.*\] missing in target/.test(msg)) return msg.replace('Variable', 'Missing placeholders');
  if (/Variable \[.*\] not found in source/.test(msg)) return msg.replace('Variable', 'Extra placeholders');
  return msg;
}

function checkPlaceholders(src, tgt) {
  const r = /\{([\w-]+)\}/g;
  const s = new Set();
  const t = new Set();
  let m;
  while ((m = r.exec(src))) s.add(m[1]);
  while ((m = r.exec(tgt))) t.add(m[1]);
  if ([...s].sort().join() !== [...t].sort().join()) {
    throw new Error(`Placeholder mismatch. Source: [${[...s].join(', ')}], Target: [${[...t].join(', ')}]`);
  }
}

function checkHTMLTags(src, tgt) {
  const r = /<\/?[a-zA-Z0-9-]+(?:\s+[^>]*)?>/g;
  const s = src.match(r) || [];
  const t = tgt.match(r) || [];
  if (s.length !== t.length || s.join() !== t.join()) {
    throw new Error(`HTML tag count/order mismatch. Source: ${s.join(', ')}, Target: ${t.join(', ')}`);
  }
}

function checkLeadingApostrophe(src, tgt) {
  if (src.trim().startsWith("'") !== tgt.trim().startsWith("'")) {
    throw new Error('Mismatch in leading apostrophe usage between source and target.');
  }
}

function checkSelectOptions(ast) {
  (function walk(n){
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && n.type === 'selectFormat') {
      const keys = n.options.map(o => o.key);
      if (!keys.includes('other')) throw new Error("Your ICU select is missing the required 'other' branch.");
    }
    if (n && typeof n === 'object') Object.values(n).forEach(walk);
  })(ast);
}

function checkExtraneousPluralCategories(ast, locale) {
  const valid = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  (function walk(n){
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && n.type === 'pluralFormat') {
      n.options.forEach(o => {
        if (!valid.includes(o.key) && !o.key.startsWith('=')) throw new Error(`The plural case ${o.key} is not valid for this locale.`);
      });
    }
    if (n && typeof n === 'object') Object.values(n).forEach(walk);
  })(ast);
}

function checkMissingPluralCategories(ast, locale) {
  const required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  (function walk(n){
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && n.type === 'pluralFormat') {
      const present = n.options.map(o => o.key);
      const missing = required.filter(c => !present.includes(c));
      if (missing.length) throw new Error(`Missing plural categories [${missing.join(', ')}] for locale "${locale}".`);
    }
    if (n && typeof n === 'object') Object.values(n).forEach(walk);
  })(ast);
}

function checkIdenticalPluralForms(ast) {
  function flat(n){
    if (Array.isArray(n)) return n.map(flat).join('');
    if (n && n.type === 'content') return n.value || '';
    if (n && typeof n === 'object') return Object.values(n).map(flat).join('');
    return String(n);
  }
  (function walk(n){
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && n.type === 'pluralFormat') {
      const branches = n.options.map(o => ({key:o.key,text:flat(o.value).trim()}));
      for (let i=0;i<branches.length;i++) {
        for (let j=i+1;j<branches.length;j++) {
          if (branches[i].key!==branches[j].key && branches[i].text && branches[i].text===branches[j].text) {
            throw new Error(`Identical text in plural branches "${branches[i].key}" and "${branches[j].key}": "${branches[i].text}"`);
          }
        }
      }
    }
    if (n && typeof n === 'object') Object.values(n).forEach(walk);
  })(ast);
}

function checkAgainstExpectedPluralCategories(ast, locale) {
  const expected = getLanguageRulesDisplay(locale);
  const cats = ['(None)','(No data)','(Rules not loaded)'].includes(expected) ? [] : expected.split(',').map(s=>s.trim());
  (function walk(n){
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && n.type === 'pluralFormat') {
      n.options.forEach(o => { if (!o.key.startsWith('=') && !cats.includes(o.key)) throw new Error(`The plural case ${o.key} is not valid for this locale.`); });
    }
    if (n && typeof n === 'object') Object.values(n).forEach(walk);
  })(ast);
}

function validateMessage(source, target, locale) {
  if (target == null || !target.trim()) throw new Error('Message is empty.');
  checkPlaceholders(source, target);
  checkHTMLTags(source, target);
  checkLeadingApostrophe(source, target);
  const mf = new MessageFormat(locale);
  try { mf.compile(target); } catch (e) { throw new Error(`MessageFormat compilation failed: ${e.message}`); }
  let ast;
  try { ast = mfParse(target); } catch (e) { throw new Error(`Parsing target message failed: ${e.message}`); }
  checkSelectOptions(ast);
  checkExtraneousPluralCategories(ast, locale);
  checkMissingPluralCategories(ast, locale);
  checkIdenticalPluralForms(ast);
  checkAgainstExpectedPluralCategories(ast, locale);
}

// ---- XML ----
const parserOptions = { ignoreAttributes:false, attributeNamePrefix:'@_', allowBooleanAttributes:true, ignoreNameSpace:true };
const xmlParser = new XMLParser(parserOptions);
function parseXLF(content){
  content = content.replace(/<!--[\s\S]*?-->/g,'');
  return xmlParser.parse(content);
}

function extractTransUnits(jsonObj, packageName){
  const units=[];
  let files=[];
  if (jsonObj.xliff && jsonObj.xliff.file) files = Array.isArray(jsonObj.xliff.file)?jsonObj.xliff.file:[jsonObj.xliff.file];
  else if (jsonObj.file) files = Array.isArray(jsonObj.file)?jsonObj.file:[jsonObj.file];
  files.forEach(file=>{
    const srcLang = file['@_source-language']||'';
    const tgtLang = file['@_target-language']||'';
    let tus = file.body && file.body['trans-unit'] ? file.body['trans-unit'] : file['trans-unit'];
    if (!tus) return;
    if (!Array.isArray(tus)) tus=[tus];
    tus.forEach(u=>{
      const id = u['@_id']||'';
      const src = typeof u.source==='string'?u.source:recursiveExtractText(u.source);
      const tgt = typeof u.target==='string'?u.target:recursiveExtractText(u.target);
      if (!src.trim() && !tgt.trim()) return;
      units.push({unit_id:id,source:src.trim(),target:tgt.trim(),source_language:srcLang,target_language:tgtLang,packageFile:packageName});
    });
  });
  return units;
}

function getFilesRecursively(dir, ext){
  let res=[];
  fs.readdirSync(dir).forEach(f=>{
    const p=path.join(dir,f);
    const st=fs.statSync(p);
    if(st.isDirectory()) res=res.concat(getFilesRecursively(p,ext));
    else if(f.toLowerCase().endsWith(ext.toLowerCase())) res.push(p);
  });
  return res;
}

async function processWSXZFile(filePath){
  const data=fs.readFileSync(filePath);
  const zip=await JSZip.loadAsync(data);
  let all=[];
  const pkg=path.basename(filePath);
  for(const rel of Object.keys(zip.files)){
    if(rel.toLowerCase().endsWith('.xlf')||rel.toLowerCase().endsWith('.xliff')){
      const fileData=await zip.file(rel).async('string');
      fs.writeFileSync(path.join(tempExtractDir,path.basename(rel)),fileData,'utf-8');
      const xlfObj=parseXLF(fileData);
      all=all.concat(extractTransUnits(xlfObj,pkg));
    }
  }
  return all;
}

function aggregateTransUnits(units){
  const agg={};
  units.forEach(u=>{
    if(!u.source||u.source.toLowerCase()==='undefined')return;
    const key=u.source+'||'+u.packageFile;
    if(!agg[key]){agg[key]={unit_ids:new Set(),source_language:u.source_language,source_string:u.source,targets:[],packageFile:u.packageFile};}
    agg[key].unit_ids.add(u.unit_id);
    if(u.target&&u.target.toLowerCase()!=='undefined'){
      if(!agg[key].targets.some(t=>t.target_language===u.target_language&&t.target_string===u.target)){
        agg[key].targets.push({target_language:u.target_language,target_string:u.target});
      }
    }
  });
  return Object.values(agg).map(e=>({unit_id:[...e.unit_ids].join(', '),source_language:e.source_language,source_string:e.source_string,targets:e.targets,packageFile:e.packageFile}));
}

function validateAggregated(aggregated){
  const errorLog=[]; const results=[];
  aggregated.forEach((entry,i)=>{
    const res={hasSourceError:false,targetErrors:{}};
    const src=entry.source_string;
    try{ new MessageFormat('en').compile(src);} catch(err){
      res.hasSourceError=true;
      errorLog.push({id:`msg_${i+1}`,type:categorizeError(err.message,'Source'),language:entry.source_language,packageFile:entry.packageFile,message:transformErrorMessage(err.message,entry.source_language),source:src});
    }
    entry.targets.forEach(t=>{
      try{validateMessage(src,t.target_string,t.target_language);}catch(err){
        res.targetErrors[t.target_language]=true;
        const expected=sourceHasPlural(src)?getLanguageRulesDisplay(t.target_language):'';
        errorLog.push({id:`msg_${i+1}`,type:categorizeError(err.message,'Target'),language:t.target_language,packageFile:entry.packageFile,message:transformErrorMessage(err.message,t.target_language),source:src,target:t.target_string,expectedPluralCases:expected});
      }});
    results[i]=res;
  });
  return {errorLog,validationResults:results};
}

async function writeExcelReport(aggregated, results, errors, file){
  const workbook=new ExcelJS.Workbook();
  const pkgHeader=toolType==='ws'?'WSXZ Package':'CATS-I Package';
  const errorSheet=workbook.addWorksheet('Validation Errors');
  errorSheet.columns=[
    {header:'Message ID',key:'id',width:15},
    {header:'Error Type',key:'type',width:25},
    {header:'Language',key:'language',width:10},
    {header:pkgHeader,key:'packageFile',width:25},
    {header:'Source',key:'source',width:50},
    {header:'Target',key:'target',width:50},
    {header:'Error Message',key:'message',width:60},
    {header:'Expected Plural Cases',key:'expectedPluralCases',width:30}
  ];
  errors.forEach(e=>errorSheet.addRow(e));

  const statsSheet=workbook.addWorksheet('Stats');
  statsSheet.columns=[{header:'Message Type',key:'type',width:10},{header:'Language',key:'language',width:10},{header:'Total Strings',key:'total',width:15},{header:'Errors',key:'errors',width:10},{header:'Valid',key:'valid',width:10},{header:'% Errors',key:'percentErrors',width:12},{header:'% Valid',key:'percentValid',width:12}];
  const sourceStats={};
  aggregated.forEach((e,i)=>{const l=e.source_language||'unknown';sourceStats[l]=sourceStats[l]||{total:0,errors:0};sourceStats[l].total++;if(results[i].hasSourceError)sourceStats[l].errors++;});
  Object.entries(sourceStats).forEach(([l,s])=>{const valid=s.total-s.errors;statsSheet.addRow({type:'Source',language:l,total:s.total,errors:s.errors,valid,percentErrors:`${((s.errors/s.total)*100).toFixed(2)}%`,percentValid:`${((valid/s.total)*100).toFixed(2)}%`});});
  const targetStats={};
  aggregated.forEach((e,i)=>{e.targets.forEach(t=>{const l=t.target_language||'unknown';targetStats[l]=targetStats[l]||{total:0,errors:0};targetStats[l].total++;if(results[i].targetErrors[l])targetStats[l].errors++;});});
  Object.entries(targetStats).forEach(([l,s])=>{const valid=s.total-s.errors;statsSheet.addRow({type:'Target',language:l,total:s.total,errors:s.errors,valid,percentErrors:`${((s.errors/s.total)*100).toFixed(2)}%`,percentValid:`${((valid/s.total)*100).toFixed(2)}%`});});

  await workbook.xlsx.writeFile(file);
  console.log(`Saved Excel report to ${file}`);
}

function distributePackages(processed,errorLog){
  const okDir=path.join(__dirname,'ready to deliver');
  const errDir=path.join(__dirname,'packages with errors');
  if(!fs.existsSync(okDir))fs.mkdirSync(okDir);
  if(!fs.existsSync(errDir))fs.mkdirSync(errDir);
  const errPkgs=new Set();
  errorLog.forEach(e=>{e.packageFile.split(',').forEach(p=>errPkgs.add(p.trim()));});
  processed.forEach(p=>{const base=path.basename(p);const dest=errPkgs.has(base)?errDir:okDir;fs.copyFileSync(p,path.join(dest,base));});
}

// ---- main ----
(async function(){
  let all=[]; let processed=[];
  if(toolType==='ws' || toolType==='cats'){
    const files=getFilesRecursively(inputDir,'.wsxz');
    processed=files;
    for(const f of files){
      try{all=all.concat(await processWSXZFile(f));}catch(e){console.error(`Error processing ${f}:`,e);}
    }
  } else { console.error('Invalid tool type specified. Use \"ws\" or \"cats\".'); process.exit(1); }

  const aggregated=aggregateTransUnits(all);
  fs.writeFileSync(outputAggregatedFile,JSON.stringify(aggregated,null,2));
  const {errorLog,validationResults}=validateAggregated(aggregated);
  await writeExcelReport(aggregated,validationResults,errorLog,validationReportFile);
  distributePackages(processed,errorLog);
  if(errorLog.length){process.exit(1);} else console.log('All ICU strings validated successfully.');
})();
